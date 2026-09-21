import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type {
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionExitPayload,
  SessionId,
  SessionListParams,
  SessionListResult,
  SessionResizeParams,
  SessionResizeResult,
  SessionSummary,
} from '@termhub/shared';

import type { Registry, SessionLike } from './registry.js';
import type { TransportServer } from './transport.js';

// Wires the transport (transport.ts, M1.2) to the registry (registry.ts,
// M1.4): registers the `session.*` RPCs, forwards each session's PTY output
// as broadcast binary frames, and turns a session dying into a broadcast
// `session.exit` event. This is the only file that knows about both layers
// at once — the registry never imports transport.ts, and transport.ts never
// imports registry.ts.
//
// ## Broadcast, not targeted delivery
//
// `attachBroadcast` below sends every session's output/exit to *every*
// handshaked client, via `TransportServer.broadcastData`/`broadcastEvent` —
// there is no "only the clients attached to this session" filter yet.
// That's deliberate for this task (see this task's final report): restricting
// delivery to attached clients is M1.7 (`session.attach`/`session.detach`),
// which needs a targeted send keyed by `RequestContext.clientId` that
// `TransportServer` does not expose today.
//
// ## Keyboard input
//
// `writeSessionInput` (below) is the client->PTY half of M1.1's protocol
// change: input travels as a binary `type: FRAME_TYPE.DATA` frame instead of
// an RPC. `registerSessionService` wires it to `server.registerDataHandler`
// (transport-server.ts), which invokes it synchronously, in the same
// per-connection, strict-arrival-order dispatch a `session.resize` request
// on that connection goes through — that's what keeps a resize and the
// keystroke frame sent right after it applied in the order they arrived on
// the wire, not just in the order this module happens to call them.

/**
 * Registers `session.create` / `session.resize` / `session.close` /
 * `session.list` on `server`, delegating to `registry`, and wires every
 * session's output/exit to `server`'s broadcast. Call once per
 * `TransportServer` instance (mirrors `registerMethod`'s own "no duplicate
 * registration" contract).
 */
export function registerSessionService(server: TransportServer, registry: Registry): void {
  server.registerMethod<SessionCreateParams, SessionCreateResult>('session.create', (params) => {
    const summary = registry.create(params);
    const registered = registry.get(summary.id);
    // Always defined in practice — registry.create() just registered this
    // id and nothing else has had a chance to close it yet — but guarding
    // instead of asserting keeps this file from ever throwing into
    // TransportServer's handler dispatch over an invariant that belongs to
    // registry.ts, not here.
    if (registered !== undefined) {
      attachBroadcast(server, summary.id, registered.session);
    }
    return { session: summary };
  });

  server.registerMethod<SessionResizeParams, SessionResizeResult>('session.resize', (params) => {
    const registered = registry.get(params.sessionId);
    if (registered === undefined) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND,
        `no session with id ${params.sessionId}`,
      );
    }
    // Synchronous on purpose (no `await` anywhere in this handler): a
    // `MethodHandler` may return a plain value or a `Promise`, and
    // `TransportServer.handleRequest` invokes it synchronously before its
    // own first `await`. Staying synchronous here is what makes this
    // handler's effect land in the same tick it was dispatched, immediately
    // after any earlier frame on the same connection finished dispatching —
    // `registerDataHandler`'s handler (wired to `writeSessionInput` below)
    // makes the same promise for binary input frames, which together is
    // what keeps a resize and the keystrokes sent right after it applied in
    // the order they arrived on the wire.
    registered.session.resize(params.cols, params.rows);
    return {};
  });

  server.registerMethod<SessionCloseParams, SessionCloseResult>('session.close', (params) => {
    // registry.close() is already idempotent (see registry.ts) — closing an
    // unknown or already-closed id is a no-op, not an error, so this handler
    // doesn't need its own existence check.
    registry.close(params.sessionId);
    return {};
  });

  server.registerMethod<SessionListParams, SessionListResult>('session.list', () => ({
    sessions: listWithExit(registry),
  }));

  server.registerDataHandler((sessionId, data) => {
    writeSessionInput(registry, sessionId, data);
  });
}

/**
 * Writes `data` (the payload of a client-sent binary `type: FRAME_TYPE.DATA`
 * frame — see this module's header comment) into the target session's PTY.
 * Registered as `server`'s data-frame handler by `registerSessionService`,
 * and also exported so tests can call it directly. Silently drops the write
 * instead of throwing when `sessionId` names no live session: a data frame
 * carries no request id to fail, and a client racing a `session.close` with
 * its next keystroke is normal, expected traffic, not a protocol violation
 * worth tearing the connection down over.
 */
export function writeSessionInput(
  registry: Registry,
  sessionId: SessionId,
  data: Uint8Array,
): void {
  const registered = registry.get(sessionId);
  if (registered === undefined) {
    return;
  }
  // node-pty's `IPty#write` accepts either a `Buffer` or a `string`, but
  // `SessionLike#write` (session.ts) is typed `(data: string) => void` to
  // match `Session`'s own signature — decode here rather than widening that
  // interface for this one caller.
  registered.session.write(Buffer.from(data).toString('utf8'));
}

/** Subscribes a freshly-created session's output/exit to `server`'s broadcast. */
function attachBroadcast(
  server: TransportServer,
  sessionId: SessionId,
  session: SessionLike,
): void {
  session.onData((data) => {
    server.broadcastData(sessionId, Buffer.from(data, 'utf8'));
  });
  session.onExit((exit) => {
    const payload: SessionExitPayload = {
      sessionId,
      exitCode: exit.exitCode,
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
    };
    server.broadcastEvent('session.exit', payload);
  });
}

/**
 * `registry.list()`'s `SessionSummary`s never carry `exitCode`/`signal` —
 * `registry.ts` (out of bounds for this task) tracks that separately, on
 * `RegisteredSession.exit`, and only merges `status: 'exited'` into the
 * summary itself. This reconstructs the wire-facing shape `session.list`
 * promises (`SessionSummary.exitCode`/`signal`, added to protocol.ts by this
 * task) by pairing each summary back up with its registry record, entirely
 * through `Registry`'s existing public `list()`/`get()` — no change to
 * registry.ts needed.
 */
function listWithExit(registry: Registry): SessionSummary[] {
  return registry.list().map((summary) => {
    const exit = registry.get(summary.id)?.exit;
    if (exit === undefined) {
      return summary;
    }
    return {
      ...summary,
      exitCode: exit.exitCode,
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
    };
  });
}
