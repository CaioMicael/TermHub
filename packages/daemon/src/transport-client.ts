import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { FRAME_TYPE, PROTOCOL_VERSION, ProtocolError } from '@termhub/shared';
import type { Frame, HandshakeAckMessage, HandshakeMessage, SessionId } from '@termhub/shared';

import { FramedSocket } from './transport-socket.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  encodeWireControl,
  encodeWireData,
  fromControlMessage,
} from './transport-wire.js';
import type { WireEvent, WireResponse } from './transport-wire.js';

// The client half of the transport (transport-server.ts is the other),
// reusable by the daemon's own integration tests today and by M2.1's
// `daemon-client.ts` later: connect, handshake, `request(method, params)`
// correlated by id, and subscriptions for broadcast events/data.

/** Returned by `onEvent`/`onData`/`onClose` to unsubscribe — same shape as `Session`'s `Disposable` (session.ts), defined locally so this module stays decoupled from session.ts (M1.2 doesn't know sessions exist). */
export interface Disposable {
  dispose(): void;
}

export interface TransportClientOptions {
  /** Address to connect to — a `TransportServer`'s `pipeAddress`, or a value from `resolvePipeAddress()` matching one. */
  address: string;
  /** Must match the server's configured token or the handshake is rejected. */
  token: string;
  /** Protocol version to declare in the handshake. Defaults to `PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Free-form identifier sent as the handshake's `clientName` (e.g. `"termhub-app"`, `"termhub-cli"`). */
  clientName?: string;
  /** Milliseconds to wait for the socket to connect and the handshake to be acknowledged before `connect()` rejects. Defaults to 5000. */
  handshakeTimeoutMs?: number;
}

type ClientState = 'idle' | 'connecting' | 'ready' | 'closed';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface ConnectDeferred {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class TransportClient {
  private readonly options: TransportClientOptions;
  private state: ClientState = 'idle';
  private framed: FramedSocket | undefined;
  private lastSocketError: Error | undefined;
  private connectDeferred: ConnectDeferred | undefined;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private nextRequestSeq = 1;
  private readonly eventListeners = new Set<(msg: WireEvent) => void>();
  private readonly dataListeners = new Set<(sessionId: SessionId, data: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();
  private resolveClosed: (() => void) | undefined;
  private readonly closedPromise: Promise<void>;

  constructor(options: TransportClientOptions) {
    this.options = options;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** Whether the handshake has completed and `request()` can be called. */
  get isReady(): boolean {
    return this.state === 'ready';
  }

  /**
   * Opens the connection and performs the handshake. Resolves once the
   * server acknowledges it successfully; rejects with a `ProtocolError`
   * (wrong token: `UNAUTHORIZED`; incompatible version: `VERSION_MISMATCH`)
   * if the server rejects it, or a plain `Error` if the socket never
   * connects, closes before acknowledging, or the ack doesn't arrive
   * within `handshakeTimeoutMs`.
   */
  connect(): Promise<void> {
    if (this.state !== 'idle') {
      return Promise.reject(
        new Error(`connect() called in state "${this.state}", expected "idle"`),
      );
    }
    this.state = 'connecting';

    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const socket: Socket = connect(this.options.address);
    // Attached directly on the raw socket (in addition to FramedSocket's
    // own swallowing listener below) purely to capture a meaningful reason
    // — e.g. ENOENT when no daemon is listening at all — for whichever
    // promise (`connect()`'s or an in-flight `request()`'s) ends up
    // rejecting once `'close'` fires.
    socket.on('error', (err: Error) => {
      this.lastSocketError = err;
    });

    const framed = new FramedSocket(socket, {
      onFrame: (frame) => {
        this.onFrame(frame);
      },
      onDecodeError: (err) => {
        this.onDecodeError(err);
      },
      onClose: () => {
        this.onSocketClose();
      },
    });
    this.framed = framed;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectDeferred = undefined;
        framed.destroy();
        reject(new Error(`daemon did not acknowledge the handshake within ${timeoutMs}ms`));
      }, timeoutMs);

      this.connectDeferred = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      socket.once('connect', () => {
        const handshake: HandshakeMessage = {
          kind: 'handshake',
          protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
          token: this.options.token,
          ...(this.options.clientName !== undefined ? { clientName: this.options.clientName } : {}),
        };
        framed.send(encodeWireControl(handshake));
      });
    });
  }

  /**
   * Sends a request and resolves with its result once the matching
   * response arrives, however many other requests are in flight at the
   * same time and regardless of the order their handlers resolve on the
   * server — correlation is entirely by the id this method generates, not
   * by arrival order. Rejects with a `ProtocolError` built from the
   * server's error payload on a failure response.
   */
  request<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
    if (this.state !== 'ready' || this.framed === undefined) {
      return Promise.reject(
        new Error(
          `request() called in state "${this.state}", expected "ready" (call connect() first)`,
        ),
      );
    }
    const framed = this.framed;
    const id = `req-${this.nextRequestSeq}`;
    this.nextRequestSeq += 1;

    return new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        // The pending map is keyed generically because one client
        // multiplexes concurrent requests of different `TResult` types at
        // once; `resolve` closes over *this* call's own `TResult`, so the
        // cast just restates what the caller already told us via
        // `request<TResult>(...)` — the wire carries no schema to check it
        // against (same trust boundary as `TransportServer.registerMethod`).
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject,
      });
      framed.send(encodeWireControl({ kind: 'request', id, method, params }));
    });
  }

  /**
   * Sends a binary (`type` 1) PTY data frame to the daemon — the
   * client->daemon half of PTY input (see protocol.ts's frame-format header
   * comment: `type` 1 now carries both directions). Unlike `request()`
   * there is no response to correlate this with, so this returns as soon as
   * the frame is handed to the socket (or queued under backpressure — see
   * transport-socket.ts's `send()`), not once the daemon has processed it.
   * Throws synchronously if called before `connect()` resolves.
   */
  sendData(sessionId: SessionId, data: Uint8Array): void {
    if (this.state !== 'ready' || this.framed === undefined) {
      throw new Error(
        `sendData() called in state "${this.state}", expected "ready" (call connect() first)`,
      );
    }
    this.framed.send(encodeWireData(sessionId, data));
  }

  /** Subscribes to broadcast JSON events (`TransportServer.broadcastEvent`). */
  onEvent(listener: (msg: WireEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  /**
   * Subscribes to binary PTY data frames — both `TransportServer.
   * broadcastData` and (M1.7) `TransportServer.sendDataTo`'s targeted
   * sends, which is what a `session.attach` snapshot travels as.
   *
   * ## Contract for `session.attach` (docs/specs/m1.7-attach-detach.md section 3.4)
   *
   * Call this — install the data handler — **before** calling
   * `request('session.attach', ...)`, not after. `session.attach`'s result
   * carries no snapshot field; the snapshot (and any output that arrived
   * while it was being produced) is written to this connection as one or
   * more binary data frames *before* the RPC response frame, on the same
   * ordered stream `FramedSocket` already guarantees delivery order for —
   * no separate synchronization is needed, but only if a listener is
   * already registered to receive them. A handler installed *after*
   * `await`ing `session.attach()` has already missed those frames; they are
   * not re-sent.
   */
  onData(listener: (sessionId: SessionId, data: Uint8Array) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  /** Subscribes to the connection closing, for any reason. */
  onClose(listener: () => void): Disposable {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  /** Closes the connection gracefully and waits for it to actually finish closing. Safe to call more than once, or before `connect()`. */
  async close(): Promise<void> {
    if (this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    if (this.state === 'closed') {
      return;
    }
    this.framed?.end();
    await this.closedPromise;
  }

  private onFrame(frame: Frame): void {
    if (frame.type === FRAME_TYPE.DATA) {
      for (const listener of this.dataListeners) {
        listener(frame.sessionId, frame.data);
      }
      return;
    }

    const message = fromControlMessage(frame.message);
    switch (message.kind) {
      case 'handshake-ack':
        this.onHandshakeAck(message);
        return;
      case 'response':
        this.onResponse(message);
        return;
      case 'event':
        for (const listener of this.eventListeners) {
          listener(message);
        }
        return;
      default:
        // 'request' / 'handshake' are never sent server->client in this
        // protocol; ignored for forward-compatibility.
        return;
    }
  }

  private onHandshakeAck(message: HandshakeAckMessage): void {
    const deferred = this.connectDeferred;
    if (deferred === undefined) {
      return; // Stray/duplicate ack — nothing waiting on it.
    }
    this.connectDeferred = undefined;
    if (message.ok) {
      this.state = 'ready';
      deferred.resolve();
    } else {
      this.state = 'closed';
      deferred.reject(
        new ProtocolError(message.error.code, message.error.message, message.error.details),
      );
    }
  }

  private onResponse(message: WireResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (pending === undefined) {
      return; // No in-flight request for this id (already settled, or a stray message) — ignore.
    }
    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new ProtocolError(message.error.code, message.error.message, message.error.details),
      );
    }
  }

  private onDecodeError(err: ProtocolError): void {
    // Same contract as the server side: the decoder is unusable after
    // throwing, so the connection has to go. `onSocketClose` (fired by
    // `destroy()`) does the actual rejection/cleanup, using this as the
    // reason so callers see *why* instead of a bare "connection closed".
    this.lastSocketError = err;
    this.framed?.destroy();
  }

  private onSocketClose(): void {
    this.state = 'closed';

    const reason = () =>
      this.lastSocketError ?? new Error('the connection to the daemon closed unexpectedly');

    const deferred = this.connectDeferred;
    if (deferred !== undefined) {
      this.connectDeferred = undefined;
      deferred.reject(reason());
    }

    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason());
    }
    this.pendingRequests.clear();

    for (const listener of this.closeListeners) {
      listener();
    }

    this.resolveClosed?.();
  }
}
