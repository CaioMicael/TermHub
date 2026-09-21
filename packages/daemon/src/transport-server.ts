import { timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { FRAME_TYPE, PROTOCOL_ERROR_CODE, PROTOCOL_VERSION, ProtocolError } from '@termhub/shared';
import type {
  Frame,
  HandshakeAckMessage,
  HandshakeMessage,
  ProtocolErrorCode,
  ProtocolErrorPayload,
  SessionId,
} from '@termhub/shared';

import { resolvePipeAddress } from './transport-address.js';
import { FramedSocket } from './transport-socket.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  encodeWireControl,
  encodeWireData,
  fromControlMessage,
} from './transport-wire.js';
import type { WireRequest, WireResponse } from './transport-wire.js';

// The daemon side of the transport: a `net` server on a named pipe (or unix
// socket off Windows — see transport-address.ts), speaking the M1.1 wire
// protocol. It is deliberately session-agnostic — see this file's module
// doc in transport.ts for the full boundary — so everything here is generic
// RPC plumbing plus connection/handshake bookkeeping:
//
//   connect -> [handshake timeout running] -> handshake -> ready -> closed
//
// Only a `ready` connection's requests are dispatched to a registered
// handler or its broadcasts delivered; a connection that never completes
// its handshake, sends the wrong token, or declares an incompatible
// protocol version is torn down without ever reaching `ready`.

/**
 * Context passed to every method handler alongside `params`. Not part of
 * the wire protocol — purely local bookkeeping a handler can use to
 * correlate a request with the connection that made it (e.g. a future
 * `session.attach` handler wanting to know which connection to treat as
 * "attached" — see this task's final report for why that's flagged as a
 * design note for M1.5/M1.7 rather than built here).
 */
export interface RequestContext {
  /** Stable per-connection id, generated when the socket connects (before the handshake even completes). */
  clientId: string;
  /** The handshake's optional `clientName`, when the client sent one. */
  clientName?: string;
}

export type MethodHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: RequestContext,
) => TResult | Promise<TResult>;

/** Internal erased form every registered handler is stored as — see `registerMethod`'s doc comment for why the cast down to this is safe. */
type AnyMethodHandler = MethodHandler<unknown, unknown>;

/**
 * Handler invoked for every binary (`type` 1) PTY data frame a client sends
 * once its connection is `ready` — the client->daemon half of PTY input (see
 * protocol.ts's frame-format header comment: `type` 1 now carries both
 * directions). Registered via `registerDataHandler`.
 */
export type DataFrameHandler = (
  sessionId: SessionId,
  data: Uint8Array,
  context: RequestContext,
) => void;

export interface TransportServerOptions {
  /**
   * Shared secret every connecting client must present in its handshake.
   * Generating and persisting this in `daemon.json` is M1.8's job; this
   * server only compares whatever it's given against what the client sent.
   */
  token: string;
  /** Address to listen on. Defaults to `resolvePipeAddress()` (the real per-user pipe/socket). Tests should pass a unique address (see transport-address.ts's `suffix` option) instead of relying on the default. */
  address?: string;
  /** Protocol version this server speaks. A handshake declaring any other version is rejected. Defaults to `PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Milliseconds a freshly-connected socket has to send its handshake before being dropped. Defaults to 5000. */
  handshakeTimeoutMs?: number;
}

type ConnectionState = 'pending-handshake' | 'ready';

interface ConnectionRecord {
  readonly id: string;
  readonly framed: FramedSocket;
  state: ConnectionState;
  handshakeTimer: NodeJS.Timeout | undefined;
  clientName?: string;
}

function tokensMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, and a length mismatch already answers the question, so check it
  // first — this also means the timing-safety guarantee only needs to hold
  // once both buffers are the same length, which is the case that actually
  // matters (an attacker who already knows the length gains nothing new
  // from a fast rejection on a *different* length).
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

function toErrorPayload(err: unknown): ProtocolErrorPayload {
  if (err instanceof ProtocolError) {
    return err.toPayload();
  }
  if (err instanceof Error) {
    return { code: PROTOCOL_ERROR_CODE.INTERNAL_ERROR, message: err.message };
  }
  return { code: PROTOCOL_ERROR_CODE.INTERNAL_ERROR, message: String(err) };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Removes a leftover unix-socket file at `address`, if any. No-op on win32 (named pipes aren't filesystem entries) and when nothing is there. */
async function removeStaleSocketFile(address: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await unlink(address);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}

export class TransportServer {
  readonly protocolVersion: number;
  private readonly server: Server;
  private readonly token: string;
  private readonly address: string;
  private readonly handshakeTimeoutMs: number;
  private readonly handlers = new Map<string, AnyMethodHandler>();
  private dataHandler: DataFrameHandler | undefined;
  private connectionCloseHandler: ((clientId: string) => void) | undefined;
  private readonly connections = new Map<string, ConnectionRecord>();
  private nextConnectionSeq = 1;
  private listening = false;

  constructor(options: TransportServerOptions) {
    this.token = options.token;
    this.address = options.address ?? resolvePipeAddress();
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });
  }

  /** The address this server is listening (or about to listen) on. */
  get pipeAddress(): string {
    return this.address;
  }

  /** Number of currently-open connections, handshaked or not. Mainly for tests. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Registers the handler for `method`. Throws if `method` already has one
   * — the daemon calling this twice for the same name is a programming
   * error, not a runtime condition to tolerate silently.
   *
   * `TParams`/`TResult` give the *caller* type safety at the registration
   * site (e.g. M1.5 registering `session.create` against
   * `SessionCreateParams`/`SessionCreateResult`); internally the handler is
   * erased to `AnyMethodHandler`. That erasure is safe: protocol.ts takes
   * no schema library and validates nothing about `params`/`result` beyond
   * the envelope's `kind` (see its `isControlMessage` doc comment), so this
   * transport already trusts every handler to interpret the `unknown`
   * params it receives off the wire correctly — the cast below just makes
   * that pre-existing trust boundary explicit instead of fighting generic
   * variance for a distinction TypeScript can't check at runtime anyway.
   */
  registerMethod<TParams = unknown, TResult = unknown>(
    method: string,
    handler: MethodHandler<TParams, TResult>,
  ): void {
    if (this.handlers.has(method)) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
        `method "${method}" is already registered`,
      );
    }
    this.handlers.set(method, handler as AnyMethodHandler);
  }

  /**
   * Registers the handler for every binary (`type` 1) PTY data frame a
   * client sends once its connection is `ready` — see `DataFrameHandler`'s
   * doc comment. Called synchronously from `onFrame`, in the exact same
   * per-connection, strict-arrival-order dispatch loop `handleRequest` is
   * invoked from for control frames: no internal queue, `setImmediate`, or
   * `await` sits between a frame becoming decoded and this handler being
   * called for it. That is the property M1.5's ordering requirement rests
   * on — a `session.resize` request and a keystroke frame sent right after
   * it arrive on the same socket in the order the client wrote them, and
   * this dispatch never reorders them relative to each other.
   *
   * At most one handler, like `registerMethod`: a second call throws
   * instead of silently replacing the first.
   */
  registerDataHandler(handler: DataFrameHandler): void {
    if (this.dataHandler !== undefined) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
        'a data frame handler is already registered',
      );
    }
    this.dataHandler = handler;
  }

  /**
   * Registers a handler invoked once for every connection that closes,
   * *regardless of why*: a graceful `end()`, a `destroy()` after a malformed
   * frame or a bad/expired handshake, or the handshake timeout firing on a
   * connection that never sent one. Added for M1.7 — `docs/specs/
   * m1.7-attach-detach.md` section 3.7 needs *something* to tell
   * `service.ts` a client is gone so it can drop that client from every
   * session's attached list; this is that something.
   *
   * `clientId` is the same id `RequestContext.clientId` carries — assigned
   * when the socket connects, before the handshake completes (see
   * `RequestContext`'s own doc comment) — so it is handed to the handler
   * even for a connection that never got past `pending-handshake`. That
   * `clientId` will not be in any of `service.ts`'s attached lists (it
   * never got far enough to attach anything), and the handler is expected
   * to tolerate that silently, not treat it as an error.
   *
   * Called from `onSocketClose`, wrapped so a throwing handler can never
   * propagate: a connection closing is normal traffic on a long-running
   * daemon, not a path where one client's cleanup bug is allowed to bring
   * the rest of the server down.
   *
   * At most one handler, like `registerDataHandler`: a second call throws
   * instead of silently replacing the first.
   */
  onConnectionClose(handler: (clientId: string) => void): void {
    if (this.connectionCloseHandler !== undefined) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
        'a connection-close handler is already registered',
      );
    }
    this.connectionCloseHandler = handler;
  }

  /** Starts listening. Resolves once the server is actually accepting connections; rejects on a listen-time error (e.g. the address is already in use). Idempotent — a second call while already listening resolves immediately. */
  async listen(): Promise<void> {
    if (this.listening) {
      return;
    }
    await removeStaleSocketFile(this.address);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.address);
    });
    this.listening = true;
    // A server-level error after startup (e.g. EMFILE) would otherwise
    // become an unhandled 'error' event and crash the process; this server
    // has no logger yet to hand it to (that's later wiring), so swallowing
    // is safer than taking the whole daemon down over one OS-level hiccup.
    this.server.on('error', () => {});
  }

  /**
   * Stops accepting new connections, tears down every open one, and waits
   * for the underlying `net.Server` to fully close before resolving —
   * safe to call from a test's `afterEach` without leaking a handle into
   * the next test. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    for (const conn of this.connections.values()) {
      clearTimeout(conn.handshakeTimer);
      conn.framed.destroy();
    }
    this.connections.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    await removeStaleSocketFile(this.address);
  }

  /** Broadcasts a JSON control-plane event to every handshaked client. Connections still mid-handshake never see it. */
  broadcastEvent(event: string, payload: unknown): void {
    const buf = encodeWireControl({ kind: 'event', event, payload });
    for (const conn of this.connections.values()) {
      if (conn.state === 'ready') {
        conn.framed.send(buf);
      }
    }
  }

  /** Broadcasts a binary (type 1) PTY data frame to every handshaked client. `data` is copied verbatim onto the wire — no JSON, no base64. */
  broadcastData(sessionId: SessionId, data: Uint8Array): void {
    const buf = encodeWireData(sessionId, data);
    for (const conn of this.connections.values()) {
      if (conn.state === 'ready') {
        conn.framed.send(buf);
      }
    }
  }

  /**
   * Sends a binary (type 1) PTY data frame to one specific client — the
   * targeted counterpart to `broadcastData`, added for M1.7's
   * `session.attach`/`session.detach` (`docs/specs/m1.7-attach-detach.md`
   * section 3.5), which delivers a session's output only to clients
   * actually attached to it instead of every connected client.
   *
   * Silently does nothing if `clientId` names a connection that is no
   * longer open (never handshaked, or already closed) instead of throwing —
   * the caller may be racing a client that disconnected mid-attach, and
   * that is normal, expected traffic, not a programming error worth
   * tearing anything down over.
   */
  sendDataTo(clientId: string, sessionId: SessionId, data: Uint8Array): void {
    const conn = this.connections.get(clientId);
    if (conn === undefined || conn.state !== 'ready') {
      return;
    }
    conn.framed.send(encodeWireData(sessionId, data));
  }

  /**
   * Sends a JSON control-plane event to one specific client — the targeted
   * counterpart to `broadcastEvent`, for the same reason `sendDataTo`
   * exists (see its doc comment). Same silent-no-op contract for a
   * `clientId` that is no longer connected.
   */
  sendEventTo(clientId: string, event: string, payload: unknown): void {
    const conn = this.connections.get(clientId);
    if (conn === undefined || conn.state !== 'ready') {
      return;
    }
    conn.framed.send(encodeWireControl({ kind: 'event', event, payload }));
  }

  private handleConnection(socket: Socket): void {
    const id = `conn-${this.nextConnectionSeq}`;
    this.nextConnectionSeq += 1;

    const framed = new FramedSocket(socket, {
      onFrame: (frame) => {
        this.onFrame(id, frame);
      },
      onDecodeError: () => {
        this.onDecodeError(id);
      },
      onClose: () => {
        this.onSocketClose(id);
      },
    });

    const handshakeTimer = setTimeout(() => {
      this.onHandshakeTimeout(id);
    }, this.handshakeTimeoutMs);

    this.connections.set(id, {
      id,
      framed,
      state: 'pending-handshake',
      handshakeTimer,
    });
  }

  private onHandshakeTimeout(id: string): void {
    const conn = this.connections.get(id);
    if (conn === undefined || conn.state !== 'pending-handshake') {
      return;
    }
    // No handshake-ack here: the client never authenticated, so there is
    // nothing to correlate a rejection with beyond "the connection closed"
    // — which is exactly what destroy()/onSocketClose already communicate.
    conn.framed.destroy();
  }

  private onDecodeError(id: string): void {
    const conn = this.connections.get(id);
    if (conn === undefined) {
      return;
    }
    // Per protocol.ts's FrameDecoder contract, the decoder is unusable
    // after throwing — this connection can never be trusted again. Tearing
    // down only this one (never touching `this.server` or any other entry
    // in `this.connections`) is the whole point of per-connection
    // isolation.
    conn.framed.destroy();
  }

  private onSocketClose(id: string): void {
    const conn = this.connections.get(id);
    if (conn === undefined) {
      return;
    }
    clearTimeout(conn.handshakeTimer);
    this.connections.delete(id);
    if (this.connectionCloseHandler !== undefined) {
      try {
        this.connectionCloseHandler(id);
      } catch {
        // See onConnectionClose's doc comment: a connection closing is not
        // a path where a handler's own bug gets to propagate and take the
        // rest of the server down with it. No logger exists yet to hand
        // this to (same tradeoff `listen()`'s own swallowed server-level
        // 'error' listener above already makes) — silently isolating it is
        // safer than an unhandled exception here.
      }
    }
  }

  private onFrame(id: string, frame: Frame): void {
    const conn = this.connections.get(id);
    if (conn === undefined) {
      return;
    }

    if (conn.state === 'pending-handshake') {
      this.handlePreHandshakeFrame(conn, frame);
      return;
    }

    if (frame.type !== FRAME_TYPE.CONTROL) {
      // Binary data frames are the client->daemon half of PTY input
      // (protocol.ts's frame-format header comment: `type` 1 carries both
      // directions). Dispatched synchronously to whatever
      // `registerDataHandler` registered — see that method's doc comment
      // for why staying synchronous here, in this same per-frame loop, is
      // what keeps this connection's control and data frames applied in
      // the order they arrived. No handler registered (e.g. a daemon build
      // that never wired session input) silently drops it instead of
      // tearing the connection down: this transport stays session-agnostic
      // and doesn't get to decide that's a protocol violation.
      if (this.dataHandler !== undefined) {
        const context: RequestContext = {
          clientId: conn.id,
          ...(conn.clientName !== undefined ? { clientName: conn.clientName } : {}),
        };
        this.dataHandler(frame.sessionId, frame.data, context);
      }
      return;
    }

    const message = fromControlMessage(frame.message);
    if (message.kind === 'request') {
      // Fire-and-forget on purpose: concurrent, interleaved requests must
      // each be dispatched as soon as they arrive rather than queued behind
      // whichever request happened to arrive first, so a slow handler can
      // never block a fast one's response. `handleRequest` never lets a
      // handler's rejection escape (see its own try/catch) and always
      // finishes by writing a response frame or returning silently for a
      // connection that's gone — so there's nothing for `.catch()` to add
      // here; `void` documents that this is deliberate, not a missed await.
      void this.handleRequest(conn, message);
    }
    // 'response' / 'event' / 'handshake' / 'handshake-ack' from a client
    // aren't meaningful in this protocol's client->server direction post-
    // handshake; ignored for forward-compatibility rather than torn down.
  }

  private handlePreHandshakeFrame(conn: ConnectionRecord, frame: Frame): void {
    if (frame.type !== FRAME_TYPE.CONTROL) {
      this.rejectHandshake(
        conn,
        PROTOCOL_ERROR_CODE.UNAUTHORIZED,
        'expected a handshake as the first message, got a binary data frame',
      );
      return;
    }
    const message = fromControlMessage(frame.message);
    if (message.kind !== 'handshake') {
      this.rejectHandshake(
        conn,
        PROTOCOL_ERROR_CODE.UNAUTHORIZED,
        `expected a handshake as the first message, got "${message.kind}"`,
      );
      return;
    }
    this.completeHandshake(conn, message);
  }

  private completeHandshake(conn: ConnectionRecord, message: HandshakeMessage): void {
    if (message.protocolVersion !== this.protocolVersion) {
      this.rejectHandshake(
        conn,
        PROTOCOL_ERROR_CODE.VERSION_MISMATCH,
        `expected protocol version ${this.protocolVersion}, got ${message.protocolVersion}`,
      );
      return;
    }
    if (!tokensMatch(this.token, message.token)) {
      this.rejectHandshake(conn, PROTOCOL_ERROR_CODE.UNAUTHORIZED, 'invalid token');
      return;
    }

    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = undefined;
    conn.state = 'ready';
    if (message.clientName !== undefined) {
      conn.clientName = message.clientName;
    }

    const ack: HandshakeAckMessage = {
      kind: 'handshake-ack',
      ok: true,
      protocolVersion: this.protocolVersion,
    };
    conn.framed.send(encodeWireControl(ack));
  }

  private rejectHandshake(conn: ConnectionRecord, code: ProtocolErrorCode, message: string): void {
    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = undefined;
    const ack: HandshakeAckMessage = { kind: 'handshake-ack', ok: false, error: { code, message } };
    // send() then end() (not destroy()): FramedSocket's `end()` defers the
    // actual close until anything already queued — this ack — has reached
    // the socket, so a momentarily-backpressured rejection still arrives
    // whole instead of being truncated by an abrupt reset.
    conn.framed.send(encodeWireControl(ack));
    conn.framed.end();
  }

  private async handleRequest(conn: ConnectionRecord, message: WireRequest): Promise<void> {
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.sendResponse(conn, message, {
        ok: false,
        error: {
          code: PROTOCOL_ERROR_CODE.UNKNOWN_METHOD,
          message: `no handler registered for method "${message.method}"`,
        },
      });
      return;
    }

    const context: RequestContext = {
      clientId: conn.id,
      ...(conn.clientName !== undefined ? { clientName: conn.clientName } : {}),
    };

    try {
      const result = await handler(message.params, context);
      this.sendResponse(conn, message, { ok: true, result });
    } catch (err) {
      this.sendResponse(conn, message, { ok: false, error: toErrorPayload(err) });
    }
  }

  private sendResponse(
    conn: ConnectionRecord,
    message: WireRequest,
    outcome: { ok: true; result: unknown } | { ok: false; error: ProtocolErrorPayload },
  ): void {
    const response: WireResponse = outcome.ok
      ? {
          kind: 'response',
          id: message.id,
          method: message.method,
          ok: true,
          result: outcome.result,
        }
      : {
          kind: 'response',
          id: message.id,
          method: message.method,
          ok: false,
          error: outcome.error,
        };
    // Safe to call even if the connection closed while the handler was
    // pending: FramedSocket.send() is a documented no-op once its socket
    // has closed.
    conn.framed.send(encodeWireControl(response));
  }
}
