import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type {
  SessionAttachParams,
  SessionAttachResult,
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionDetachParams,
  SessionDetachResult,
  SessionExitPayload,
  SessionId,
  SessionListParams,
  SessionListResult,
  SessionResizeParams,
  SessionResizeResult,
  SessionSummary,
} from '@termhub/shared';

import { TerminalBuffer } from './buffer.js';
import type { Registry, SessionLike } from './registry.js';
import type { Disposable } from './session.js';
import type { TransportServer } from './transport.js';

// Wires the transport (transport.ts, M1.2) to the registry (registry.ts,
// M1.4): registers the `session.*` RPCs, feeds each session's PTY output
// into a per-session `TerminalBuffer` (buffer.ts, M1.6), and delivers that
// output/exit live — but only to the clients actually `session.attach`ed to
// that session, not to every connected client. This is the only file that
// knows about the transport, the registry, and the buffer all at once.
//
// ## `session.attach` / `session.detach` (M1.7)
//
// The full design — why the naive "subscribe then serialize" and
// "serialize then subscribe" orderings both duplicate or drop bytes, and why
// the fix needs `TerminalBuffer`'s sequence number rather than reasoning
// about promise/microtask order — is `docs/specs/m1.7-attach-detach.md`.
// This module implements it exactly:
//
// - `SessionRuntime` (buffer + per-client `AttachState`) is created
//   alongside a session in `session.create` and lives until `session.close`.
// - `wireSessionDelivery` is what actually feeds the buffer and fans output
//   out: for every chunk, it writes the buffer *first* (so the chunk has a
//   well-defined `seq` before anything downstream sees it), then delivers
//   to each attached client — straight to the wire if `live`, queued (with
//   that `seq`) if still `snapshotting`.
// - `attachClient` is section 3.3's five steps, and `chunkSeq <= seq`
//   (discard — already in the snapshot) vs `chunkSeq > seq` (send) is the
//   filter section 3.3 calls "the heart of the spec": it is what stays
//   correct even in the window where a chunk both lands in
//   `buffer.serialize()`'s snapshot *and* in a snapshotting client's
//   `pending` queue, not the order `attach`'s steps happen to run in.
// - `detachClient` / `detachClientEverywhere` remove a client from a
//   session's (or every session's) attached list. `session.detach` calls
//   the former; `registerSessionService` wires the latter to `server.
//   onConnectionClose` (transport-server.ts), so a connection dropping for
//   *any* reason — graceful close, a crash, a malformed frame tearing the
//   socket down — prunes that client from every session's attached list,
//   not just the one it last talked about. Without this, a client that
//   disconnects without calling `session.detach` stays in `attached`
//   forever: harmless per-chunk (`sendDataTo`/`sendEventTo` already no-op
//   for a gone `clientId`), but a real, slow memory leak on a long-running
//   daemon — `docs/specs/m1.7-attach-detach.md` section 3.7's own words.
//
// `SessionRuntime`, `AttachTransport`, `wireSessionDelivery`, `attachClient`,
// and `detachClient`/`detachClientEverywhere` are exported specifically so
// service.test.ts can drive them directly — as plain function calls, not
// through a real socket — which is what makes it possible to control
// *exactly* when a `FakeSession` emits a chunk relative to an in-flight
// `buffer.serialize()` (attach's own first `await`). Going through the real
// wire for that would mean racing real socket I/O to land a write inside a
// specific await window, which is exactly the "hope the timing works out"
// approach `docs/specs/m1.7-attach-detach.md` section 2 rules out.
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
 * Per-client attachment state for one session, as `docs/specs/
 * m1.7-attach-detach.md` section 4 specifies it verbatim: `snapshotting`
 * carries the queue of chunks that arrived (each tagged with the buffer
 * `seq` it got) while this client's snapshot was being produced but hadn't
 * been sent yet; `live` carries nothing because chunks go straight to the
 * wire once a client reaches it.
 */
export type AttachState =
  { phase: 'snapshotting'; pending: Array<{ seq: number; data: Uint8Array }> } | { phase: 'live' };

/**
 * Everything M1.7 tracks for one session beyond what the registry already
 * does: the `TerminalBuffer` mirroring its output, and which clients are
 * attached to it (and in what state). One of these is created alongside a
 * session in `session.create` and lives until `session.close`.
 *
 * `attached` is a plain, externally-mutable map (not hidden behind methods)
 * on purpose: service.test.ts constructs a `SessionRuntime` directly (with a
 * real `TerminalBuffer`, no transport, no registry) to drive `attachClient`
 * with full control over timing, and — for the one test that has to *force*
 * a chunk into both a snapshot and a pending queue rather than wait for it
 * to happen "naturally" (docs/specs/m1.7-attach-detach.md's required test
 * 3) — to seed `pending` with an adversarial entry directly.
 */
export interface SessionRuntime {
  readonly buffer: TerminalBuffer;
  readonly attached: Map<string, AttachState>;
}

/**
 * The subset of `TransportServer` (transport-server.ts) that delivering to
 * attached clients actually needs: targeted send, nothing else. Narrower
 * than depending on the concrete class so service.test.ts can pass a
 * lightweight fake — recording what was "sent" to which client — instead of
 * standing up a real named-pipe server for tests that are about the attach
 * state machine, not the transport.
 */
export interface AttachTransport {
  sendDataTo(clientId: string, sessionId: SessionId, data: Uint8Array): void;
  sendEventTo(clientId: string, event: string, payload: unknown): void;
}

/**
 * Read-only introspection into `registerSessionService`'s otherwise-private
 * per-session bookkeeping. Exists for tests: `attachedCount` is how
 * service.test.ts verifies M1.7's disconnect cleanup (`docs/specs/
 * m1.7-attach-detach.md` section 3.7) through the *real* wire — a client
 * connects, attaches, and has its raw connection dropped without ever
 * calling `session.detach` — without reaching into this module's private
 * closure state to do it.
 */
export interface SessionService {
  /**
   * How many clients are currently attached to `sessionId` (in either
   * `AttachState` phase). `0` for an unknown `sessionId`, same as "no
   * clients" — there is no separate "session doesn't exist" signal here,
   * callers that care use `session.list`/`session.attach` for that.
   */
  attachedCount(sessionId: SessionId): number;
}

/**
 * Registers `session.create` / `session.resize` / `session.close` /
 * `session.list` / `session.attach` / `session.detach` on `server`,
 * delegating to `registry`, and wires every session's output/exit through
 * its `SessionRuntime` to whichever clients are attached to it. Call once
 * per `TransportServer` instance (mirrors `registerMethod`'s own "no
 * duplicate registration" contract).
 */
export function registerSessionService(
  server: TransportServer,
  registry: Registry,
): SessionService {
  // One entry per live-or-not-yet-closed session, created in session.create
  // and removed in session.close — this module's own bookkeeping alongside
  // (never inside) the registry, exactly like buffer.ts's own module doc
  // comment says M1.7 would need to add.
  const runtimes = new Map<SessionId, { runtime: SessionRuntime; delivery: Disposable }>();

  server.registerMethod<SessionCreateParams, SessionCreateResult>('session.create', (params) => {
    const summary = registry.create(params);
    const registered = registry.get(summary.id);
    // Always defined in practice — registry.create() just registered this
    // id and nothing else has had a chance to close it yet — but guarding
    // instead of asserting keeps this file from ever throwing into
    // TransportServer's handler dispatch over an invariant that belongs to
    // registry.ts, not here.
    if (registered !== undefined) {
      const runtime: SessionRuntime = {
        buffer: new TerminalBuffer({ cols: params.cols, rows: params.rows }),
        attached: new Map(),
      };
      const delivery = wireSessionDelivery(server, summary.id, registered.session, runtime);
      runtimes.set(summary.id, { runtime, delivery });
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
    // The buffer's geometry has to track the real terminal's, or a client
    // attaching later gets a snapshot sized for the *old* dimensions
    // (docs/specs/m1.7-attach-detach.md section 3.2).
    runtimes.get(params.sessionId)?.runtime.buffer.resize(params.cols, params.rows);
    return {};
  });

  server.registerMethod<SessionCloseParams, SessionCloseResult>('session.close', (params) => {
    // registry.close() is already idempotent (see registry.ts) — closing an
    // unknown or already-closed id is a no-op, not an error, so this handler
    // doesn't need its own existence check.
    registry.close(params.sessionId);
    const entry = runtimes.get(params.sessionId);
    if (entry !== undefined) {
      // Unsubscribe before disposing the buffer: without this, a PTY event
      // that fires after close() (a real process's exit can arrive well
      // after `kill()` returns — registry.ts's own doc comment on `close()`
      // notes `kill()` doesn't wait for it) would otherwise call
      // `buffer.write()` on an already-disposed `TerminalBuffer`.
      entry.delivery.dispose();
      entry.runtime.buffer.dispose();
      runtimes.delete(params.sessionId);
    }
    return {};
  });

  server.registerMethod<SessionListParams, SessionListResult>('session.list', () => ({
    sessions: listWithExit(registry),
  }));

  server.registerMethod<SessionAttachParams, SessionAttachResult>(
    'session.attach',
    async (params, context) => {
      const registered = registry.get(params.sessionId);
      if (registered === undefined) {
        throw new ProtocolError(
          PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND,
          `no session with id ${params.sessionId}`,
        );
      }
      const entry = runtimes.get(params.sessionId);
      if (entry === undefined) {
        // Every session registered in the registry got a SessionRuntime in
        // session.create's handler above — this would only trip if that
        // invariant were ever broken, not a case a client request can
        // trigger on its own.
        throw new ProtocolError(
          PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
          `session ${params.sessionId} has a registry entry but no runtime`,
        );
      }
      await attachClient(server, params.sessionId, entry.runtime, context.clientId);
      // Re-fetch rather than reusing `registered.summary`: the session may
      // have exited while the snapshot was being produced, and the reply
      // should reflect that instead of a stale "running" captured before
      // the `await`.
      const latest = registry.get(params.sessionId);
      return { session: latest?.summary ?? registered.summary };
    },
  );

  server.registerMethod<SessionDetachParams, SessionDetachResult>(
    'session.detach',
    (params, context) => {
      const entry = runtimes.get(params.sessionId);
      if (entry !== undefined) {
        detachClient(entry.runtime, context.clientId);
      }
      // Unknown sessionId, or a client that was never attached to this one:
      // idempotent no-op either way (docs/specs/m1.7-attach-detach.md
      // section 3.7), not an error — same philosophy as registry.close().
      return {};
    },
  );

  server.registerDataHandler((sessionId, data) => {
    writeSessionInput(registry, sessionId, data);
  });

  // The M1.7 section 3.7 wiring `detachClientEverywhere`'s own doc comment
  // used to say couldn't be completed within this task's original file
  // boundary: a connection dropping for any reason — clean close, crash,
  // malformed frame, even one that never finished its handshake — prunes
  // `clientId` from every session's attached list, not just whichever one
  // it last attached to. `server.onConnectionClose` already isolates a
  // throwing handler (see its own doc comment in transport-server.ts), so
  // this doesn't need its own try/catch on top.
  server.onConnectionClose((clientId) => {
    detachClientEverywhere(
      Array.from(runtimes.values(), (entry) => entry.runtime),
      clientId,
    );
  });

  return {
    attachedCount: (sessionId) => runtimes.get(sessionId)?.runtime.attached.size ?? 0,
  };
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

/**
 * Feeds `session`'s output into `runtime.buffer` and fans it out to
 * `runtime.attached`'s clients through `transport` — the mechanism behind
 * `docs/specs/m1.7-attach-detach.md` section 3.2's "one `TerminalBuffer` per
 * session, alimentado no `onData`", and section 3.6's "entrega passa a ser
 * só para anexados".
 *
 * The buffer is written *before* any delivery decision is made, for every
 * chunk, unconditionally — a session with zero attached clients still keeps
 * its buffer current (section 3.6's "sessão sem nenhum cliente anexado
 * continua rodando e continua alimentando o buffer"), and writing first is
 * what gives each chunk a well-defined `seq` (via `buffer.sequence`, read
 * synchronously right after `buffer.write()`, with no `await` between them)
 * before it's decided whether to send it live or queue it.
 *
 * Returns a `Disposable` that unsubscribes both listeners — callers must
 * dispose it before disposing `runtime.buffer` (see `session.close`'s
 * handler above for why).
 */
export function wireSessionDelivery(
  transport: AttachTransport,
  sessionId: SessionId,
  session: SessionLike,
  runtime: SessionRuntime,
): Disposable {
  const dataSub = session.onData((data) => {
    runtime.buffer.write(data);
    const seq = runtime.buffer.sequence;
    const bytes = Buffer.from(data, 'utf8');
    for (const [clientId, state] of runtime.attached) {
      if (state.phase === 'live') {
        transport.sendDataTo(clientId, sessionId, bytes);
      } else {
        state.pending.push({ seq, data: bytes });
      }
    }
  });

  const exitSub = session.onExit((exit) => {
    const payload: SessionExitPayload = {
      sessionId,
      exitCode: exit.exitCode,
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
    };
    for (const clientId of runtime.attached.keys()) {
      transport.sendEventTo(clientId, 'session.exit', payload);
    }
  });

  return {
    dispose: () => {
      dataSub.dispose();
      exitSub.dispose();
    },
  };
}

/**
 * Implements `docs/specs/m1.7-attach-detach.md` section 3.3's five steps for
 * one client attaching to one session, exactly in the order the spec
 * mandates:
 *
 * 1. Synchronously (no `await` before this line) register `clientId` as
 *    `snapshotting` with an empty `pending` queue. From this point,
 *    `wireSessionDelivery`'s `onData` handler queues chunks for this client
 *    instead of sending them.
 * 2. `await runtime.buffer.serialize()`.
 * 3. Send the snapshot to this client.
 * 4. Drain `pending`: **discard** entries with `chunkSeq <= seq` (already
 *    reflected in the snapshot) and send the rest, in order. This is the
 *    filter the spec calls the heart of the whole design — not the order
 *    steps 1-2 happen to run in — because it stays correct even in the
 *    window where a chunk lands in *both* the snapshot `buffer.serialize()`
 *    produces and this client's `pending` queue (docs/specs/
 *    m1.7-attach-detach.md section 2's "armadilha mais fina").
 * 5. Flip the client to `live`.
 *
 * A client already attached (`snapshotting` or `live`) is a no-op that
 * doesn't re-send anything — section 4's "anexar duas vezes ... não
 * reenviar snapshot".
 *
 * If `clientId` is removed from `runtime.attached` while step 2 is in
 * flight (an explicit `session.detach`, or a dropped connection — see
 * `detachClient`), this resolves without sending the snapshot or flipping
 * anything to `live`: there is no attachment left to resurrect.
 */
export async function attachClient(
  transport: AttachTransport,
  sessionId: SessionId,
  runtime: SessionRuntime,
  clientId: string,
): Promise<void> {
  if (runtime.attached.has(clientId)) {
    return;
  }
  // Keep a reference to the exact state object *this* call registers.
  // docs/specs/m2.6-boot-reattach.md section 3.1's fix (below) hinges on
  // comparing against this same reference after the `await`, not on
  // re-reading whatever happens to be in `runtime.attached` for `clientId`
  // at that point.
  const state: AttachState = { phase: 'snapshotting', pending: [] };
  runtime.attached.set(clientId, state);

  // Do not put an `await` between the line above and the one below. As
  // written, both run in the same synchronous tick — nothing else
  // (including `wireSessionDelivery`'s onData handler for a chunk arriving
  // in between) can run between "register as snapshotting" and "capture
  // seq", because JS never preempts running synchronous code. That's what
  // guarantees every chunk this client's `pending` ever receives has
  // `chunkSeq > seq`, making the `chunk.seq > seq` filter below a provable
  // no-op in this specific implementation, not just a safety net.
  //
  // Insert *any* `await` here — even one that looks unrelated, e.g. an
  // extra permission check or a log flush — and that guarantee breaks: a
  // chunk could then be written to `runtime.buffer` (and so be reflected in
  // the `vt` this same call eventually returns) *after* this client already
  // registered as snapshotting, landing in `pending` with `chunkSeq <=
  // seq`. At that point the filter below stops being redundant and starts
  // being the only thing standing between this method and sending that
  // chunk twice (docs/specs/m1.7-attach-detach.md section 2's "armadilha
  // mais fina" — service.test.ts's required test 3 constructs this exact
  // collision by hand, since it can't otherwise occur with the code as it
  // stands here).
  const { vt, seq } = await runtime.buffer.serialize();

  // docs/specs/m2.6-boot-reattach.md section 3.1 ("attach -> detach ->
  // attach perde output"): re-reading `runtime.attached.get(clientId)` and
  // checking only its *phase* is wrong when a `detach` *and a brand new
  // attach* both land while this `serialize()` was in flight — the re-read
  // then finds the *second* attach's state object, which is also
  // `snapshotting`, and this (the first, stale) call would complete it with
  // its own, older snapshot and drain the second call's `pending` queue,
  // silently dropping every chunk between the two `seq`s (M2.6 required
  // test 1, above the M1.7 tests, constructs this exact race and was seen
  // failing against that phase-only check).
  //
  // Comparing by *identity* against `state` (captured above, before the
  // `await`) instead of by phase is what tells the two calls apart: a
  // detach-then-reattach always installs a *new* object for `clientId`, so
  // `runtime.attached.get(clientId) !== state` is true precisely when this
  // call has been superseded — by a detach with no reattach yet (removed
  // from the map), or by a detach followed by a newer attach (a different
  // object present) — and in both cases this call has nothing left to
  // complete.
  if (runtime.attached.get(clientId) !== state) {
    return; // detached, and possibly re-attached by a newer call, while serializing
  }

  transport.sendDataTo(clientId, sessionId, Buffer.from(vt, 'utf8'));

  for (const chunk of state.pending) {
    if (chunk.seq > seq) {
      transport.sendDataTo(clientId, sessionId, chunk.data);
    }
    // chunk.seq <= seq: already reflected in `vt` above — sending it again
    // would duplicate it. This is the filter docs/specs/
    // m1.7-attach-detach.md section 3.3 step 4 and section 5's required
    // test 3 are about.
  }
  runtime.attached.set(clientId, { phase: 'live' });
}

/**
 * Removes `clientId` from one session's attached list. A no-op (not an
 * error) if it wasn't attached, or was already removed — `Map.delete` is
 * already idempotent — which is what makes `session.detach` idempotent per
 * `docs/specs/m1.7-attach-detach.md` section 3.7.
 */
export function detachClient(runtime: SessionRuntime, clientId: string): void {
  runtime.attached.delete(clientId);
}

/**
 * Removes `clientId` from *every* session's attached list — what
 * `docs/specs/m1.7-attach-detach.md` section 3.7 asks for when a connection
 * drops without an explicit `session.detach`: "o cliente sai das listas de
 * anexados de todas as sessões". `registerSessionService` wires this to
 * `server.onConnectionClose` (transport-server.ts), so it runs for every
 * dropped connection in production, not just when called directly.
 *
 * Exported and unit-testable on its own too (service.test.ts calls it
 * directly against a set of `SessionRuntime`s, as well as proving the real
 * `onConnectionClose` wiring end to end through an actual dropped socket).
 */
export function detachClientEverywhere(runtimes: Iterable<SessionRuntime>, clientId: string): void {
  for (const runtime of runtimes) {
    runtime.attached.delete(clientId);
  }
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
