import type { SessionAttachResult, SessionId } from '@termhub/shared';

import type { TransportClient } from '@termhub/daemon/src/transport-client.js';

// docs/specs/m2.6-boot-reattach.md section 3.2: the main process's own book
// of `session.attach`/`session.detach` calls to the daemon, one instance per
// *connection* to the daemon (not per window/renderer instance — see
// `main/index.ts`, which constructs exactly one and shares it across every
// `BridgeGateway`). This is now the **only** place that ever calls
// `session.attach`/`session.detach` on the daemon: `BridgeGateway`
// intercepts those two methods coming from the renderer and routes them
// here instead of forwarding them raw through `DaemonRelay` (that
// interception is `bridge-gateway.ts`'s job, not this file's — this module
// deliberately does not import `electron` or know anything about IPC,
// windows, or `webContents`, so it stays unit-testable with a plain fake
// `{ request }` object and no Electron process at all).
//
// ## Why the old owner (terminal-session.ts's ref count) isn't enough
//
// `packages/ui/src/terminal-session.ts` (M2.3) already reference-counts
// `session.attach`/`session.detach` *within one renderer instance* — it is
// what collapses React.StrictMode's mount/cleanup/remount into a single
// daemon-visible attach. That layer still exists, unchanged, on top of this
// one: it decides *whether* a given renderer instance's `window.termhub.
// request('session.attach', ...)` call happens at all. This book decides
// something the renderer has no way to know: whether *the single shared
// daemon connection* still needs to stay attached, now that a whole
// *renderer instance* (a window reload, not just one `Terminal` unmounting)
// can come and go independently of any other instance holding the same
// session (docs/specs/m2.6-boot-reattach.md section 2.2/2.3 — the reload
// case the M2.3 ref count was never designed for, since in M2.2/M2.3 there
// was only ever one renderer instance for the app's whole lifetime).
//
// ## The state machine (section 3.2)
//
// Four phases per session: `detached` (nobody holds it, no daemon op
// pending), `attaching`/`detaching` (the daemon request is in flight),
// `attached` (holders exist and the daemon confirmed it). Rule 1 — at most
// one daemon `attach`/`detach` in flight per session at a time, the next
// operation chaining behind the previous one's response — is what makes the
// *response of a `detach`* a safe boundary (section 3.2's closing
// paragraph): by the time this book ever sends a fresh `attach` for a
// session, any chunk still in flight from a *previous* attachment has
// already arrived at (and been dropped by) `bridge-gateway.ts`'s routing
// gate, because the daemon only answers `session.detach` *after* it has
// synchronously removed the client from that session's attached list
// (`packages/daemon/src/service.ts`'s `detachClient`), and the transport is
// FIFO.
//
// Rule 1 is enforced here by making every state transition happen
// *synchronously*, before this module's own first `await`: `acquire`'s
// initial `while (record.inFlight !== undefined) { await ...; }` loop can
// only ever see `inFlight` change between iterations if some *other*
// synchronous stretch of code set it — and the only code that does that is
// `sendAttach`/`sendDetach` below, both of which set `phase`/`inFlight`
// before their own first `await`-equivalent (a `.then()` registration, not
// an `await`). Two `acquire`/`release` calls issued back to back (no
// `await` between them, e.g. from the same synchronous handler) therefore
// never race each other: the first one's synchronous prefix fully commits
// its decision — including setting `inFlight` if it started an operation —
// before the second one's body ever starts running.

/** One `webContents`/preload load — the M2.6 renderer instance id from `packages/app/src/preload/bridge.ts`'s `hello` handshake (section 3.3). Opaque here; this module never generates or inspects one, only uses it as a `Set`/`Map` key. */
export type RendererKey = string;

type AttachmentPhase = 'detached' | 'attaching' | 'attached' | 'detaching';

interface SessionAttachmentRecord {
  phase: AttachmentPhase;
  /** Renderer instances currently holding this session. Emptied by `release`/`releaseAll` before a `detach` is ever considered. */
  holders: Set<RendererKey>;
  /** The one daemon `session.attach`/`session.detach` currently in flight for this session, if any — section 4's `inFlight`. Never rejects: both `sendAttach`/`sendDetach` swallow the underlying request's rejection into this field so a waiter here only ever learns "the previous op finished", never "it failed" (that failure is reported to whoever actually issued it). */
  inFlight: Promise<void> | undefined;
  /** The most recent successful `session.attach` result, cached so a holder joining an already-`attached` session (section 3.2 rule 2's "não recebe snapshot") still gets a `SessionAttachResult` to resolve with. */
  lastResult: SessionAttachResult | undefined;
}

/** The subset of `TransportClient` (`packages/daemon/src/transport-client.ts`) this book actually needs — narrower than depending on the concrete class, exactly like `packages/daemon/src/service.ts`'s own `AttachTransport` does, so tests can pass a lightweight fake instead of a real socket. */
export type AttachmentTransportClient = Pick<TransportClient, 'request'>;

export class SessionAttachments {
  private readonly client: AttachmentTransportClient;
  private readonly records = new Map<SessionId, SessionAttachmentRecord>();

  constructor(client: AttachmentTransportClient) {
    this.client = client;
  }

  /**
   * Adds `holder` to `sessionId`'s holders and returns the `session.attach`
   * result it should observe: a fresh one (and a fresh daemon snapshot) if
   * this is the first holder on a `detached` session, the *next* fresh one
   * if a `detach` is currently in flight (section 3.2 rule 2's "espera a
   * resposta do detach e então manda um attach novo"), or the cached result
   * of whatever attach is already in flight/settled if another holder
   * already has this session `attaching`/`attached` (rule 2's "só se soma
   * ... não recebe snapshot" — out of scope to fix, per section 6).
   *
   * Rejects with whatever `session.attach` itself rejected with
   * (`ProtocolError`, e.g. `session_not_found`) — and, per section 4, does
   * **not** register `holder` in that case.
   */
  async acquire(holder: RendererKey, sessionId: SessionId): Promise<SessionAttachResult> {
    const record = this.recordFor(sessionId);

    // Rule 1: wait out whatever daemon op is already in flight for this
    // session before deciding what to do. A rejection there belongs to
    // whichever call started it (sendAttach/sendDetach already reported it
    // to that call's own caller) — this call only cares that the field it
    // is waiting on is now clear.
    while (record.inFlight !== undefined) {
      await record.inFlight;
    }

    if (record.phase === 'attached') {
      // Someone else is already attached (out of scope to give this holder
      // its own fresh snapshot — section 6) — join without sending anything.
      record.holders.add(holder);
      if (record.lastResult === undefined) {
        // Unreachable in practice: `sendAttach` always sets `lastResult`
        // before flipping `phase` to `'attached'` (same synchronous-ish
        // step, see its own comment) — guarded instead of asserted so a
        // future refactor that breaks that invariant fails loudly here
        // instead of handing the caller `undefined` silently.
        throw new Error(
          `session-attachments: invariant violated — session ${String(sessionId)} is 'attached' with no cached result`,
        );
      }
      return record.lastResult;
    }

    // `record.phase` is `'detached'` here: either nobody has ever attached
    // this session through this book, or the wait above just watched a
    // `detach` finish. Either way this holder is the one that (re-)opens
    // the attachment, with a fresh `session.attach` and a fresh snapshot —
    // rule 2's "manda session.attach e passa a attaching" / "manda um
    // attach novo, que traz snapshot novo".
    record.holders.add(holder);
    return this.sendAttach(record, sessionId);
  }

  /**
   * Removes `holder`'s hold on `sessionId`. If it was the last one, starts
   * (or schedules, per rule 1) the real `session.detach`. Synchronous,
   * idempotent, never throws (section 4) — a `session.detach` failure at
   * the daemon is logged, not surfaced, since nothing here is positioned to
   * retry or report it meaningfully.
   */
  release(holder: RendererKey, sessionId: SessionId): void {
    const record = this.records.get(sessionId);
    if (record === undefined || !record.holders.delete(holder)) {
      return; // Never held (or already released) this session — idempotent no-op.
    }
    if (record.holders.size > 0) {
      return; // Other holders remain — the attachment stays open for them.
    }
    this.scheduleDetach(record, sessionId);
  }

  /** `release`, for every session `holder` currently holds — section 3.3's `closed`/`destroyed`/`render-process-gone`/new-`hello` cleanup. Synchronous, idempotent, never throws. */
  releaseAll(holder: RendererKey): void {
    for (const [sessionId, record] of this.records) {
      if (record.holders.delete(holder) && record.holders.size === 0) {
        this.scheduleDetach(record, sessionId);
      }
    }
  }

  /**
   * Routing rule 4 (docs/specs/m2.6-boot-reattach.md section 3.2): may
   * `holder` receive a data chunk for `sessionId` right now? Only if it is
   * a current holder *and* the session is `attaching` or `attached` — never
   * `detaching`/`detached`, which is what closes defect 2.3 (bytes already
   * on the wire when a `detach` was requested still arrive, tagged
   * `detaching`, and this returns `false` for them). Synchronous, no side
   * effect — `bridge-gateway.ts` calls this for every chunk.
   */
  accepts(holder: RendererKey, sessionId: SessionId): boolean {
    const record = this.records.get(sessionId);
    if (record === undefined || !record.holders.has(holder)) {
      return false;
    }
    return record.phase === 'attaching' || record.phase === 'attached';
  }

  /**
   * Every session `holder` currently holds — not part of section 4's
   * required signature, added for `bridge-gateway.ts`'s own benefit: right
   * before `releaseAll(holder)` actually releases anything, the caller
   * needs to know *which* sessions are about to stop being accepted for
   * this holder, so it can discard `DaemonRelay`'s coalescer for exactly
   * those (`DaemonRelay.discardPending`'s own doc comment explains why
   * that step can't be skipped). Synchronous, no side effect, safe to call
   * with an unknown holder (returns `[]`).
   */
  holderSessions(holder: RendererKey): SessionId[] {
    const sessionIds: SessionId[] = [];
    for (const [sessionId, record] of this.records) {
      if (record.holders.has(holder)) {
        sessionIds.push(sessionId);
      }
    }
    return sessionIds;
  }

  private recordFor(sessionId: SessionId): SessionAttachmentRecord {
    let record = this.records.get(sessionId);
    if (record === undefined) {
      record = {
        phase: 'detached',
        holders: new Set(),
        inFlight: undefined,
        lastResult: undefined,
      };
      this.records.set(sessionId, record);
    }
    return record;
  }

  /**
   * Sends the real `session.attach`, synchronously committing `phase:
   * 'attaching'` and `record.inFlight` before returning — see this file's
   * header comment on why that synchronicity is what rule 1 depends on. Not
   * declared `async`: every state mutation below happens in plain,
   * synchronous `.then()` callbacks chained off the request's own promise,
   * so there is no hidden `await` point between entry and `record.inFlight`
   * being set.
   */
  private sendAttach(
    record: SessionAttachmentRecord,
    sessionId: SessionId,
  ): Promise<SessionAttachResult> {
    record.phase = 'attaching';
    // `TransportClient.request()` (packages/daemon/src/transport-client.ts)
    // never throws synchronously — every failure, including a rejected
    // handshake state, comes back as a rejected `Promise` — but this call
    // is wrapped anyway: a synchronous throw here, unguarded, would skip
    // the `.then(...)` below entirely and leave `phase` wedged at
    // `'attaching'` forever, with no chance for the error-handling branch
    // to reset it.
    let requestPromise: Promise<SessionAttachResult>;
    try {
      requestPromise = this.client.request<SessionAttachResult>('session.attach', { sessionId });
    } catch (err) {
      requestPromise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const settled = requestPromise.then(
      (result) => {
        record.phase = 'attached';
        record.lastResult = result;
        return result;
      },
      (err: unknown) => {
        // The daemon rejected the attach (e.g. session_not_found) — there
        // is nothing to hold onto. Back to 'detached' so a future acquire
        // starts fresh instead of being wedged 'attaching' forever; the
        // holders this call itself added get removed by its caller
        // (acquire's own doc comment: "não fica registrado").
        record.phase = 'detached';
        record.lastResult = undefined;
        record.holders.clear();
        throw err;
      },
    );
    // `inFlight` is derived from (chained behind) `settled`, not built from
    // the raw request promise directly — so by the time `inFlight` itself
    // resolves, the `phase`/`lastResult` mutation above has already run
    // (promise callbacks chained off the same promise fire in the order
    // they were attached; chaining `inFlight` off `settled` instead of off
    // the raw request guarantees `settled`'s own callback runs first).
    const inFlight = settled.then(
      () => undefined,
      () => undefined,
    );
    record.inFlight = inFlight;
    void inFlight.finally(() => {
      if (record.inFlight === inFlight) {
        record.inFlight = undefined;
      }
    });
    return settled;
  }

  /**
   * Rule 1 applied to the detach side: if nothing is in flight, sends
   * `session.detach` right away (the common case — a holder released a
   * session nobody else wants, and nothing else is talking to the daemon
   * about it). If an `attach` is still in flight (this was the only holder,
   * and it released before its own `session.attach` even settled), waits
   * for that to finish and only then detaches — and only if the session is
   * still unheld at that point, since a new `acquire` may have arrived (and
   * itself already resolved into a fresh attach) while this was waiting.
   */
  private scheduleDetach(record: SessionAttachmentRecord, sessionId: SessionId): void {
    if (record.inFlight === undefined) {
      if (record.phase === 'attached') {
        this.sendDetach(record, sessionId);
      }
      // phase 'detached' already (e.g. this release raced a failed attach
      // that already reset it) — nothing to send.
      return;
    }
    const waitThenReconsider = record.inFlight.then(() => {
      if (record.holders.size === 0 && record.phase === 'attached') {
        this.sendDetach(record, sessionId);
      }
    });
    void waitThenReconsider.catch((err: unknown) => {
      // `record.inFlight` never itself rejects (see its own doc comment) —
      // this only guards against a bug in the `.then` callback above, so a
      // thrown error here does not vanish as a silent unhandled rejection.
      console.error('[session-attachments] error while waiting to detach', sessionId, err);
    });
  }

  /** Sends the real `session.detach`, synchronously committing `phase: 'detaching'` and `record.inFlight` before returning — same synchronicity contract as `sendAttach`. */
  private sendDetach(record: SessionAttachmentRecord, sessionId: SessionId): void {
    record.phase = 'detaching';
    let requestPromise: Promise<unknown>;
    try {
      requestPromise = this.client.request('session.detach', { sessionId });
    } catch (err) {
      requestPromise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const settled = requestPromise.then(
      () => {
        record.phase = 'detached';
        record.lastResult = undefined;
      },
      (err: unknown) => {
        // Section 4: "erro do detach no daemon é logado, não propagado: não
        // há quem trate." Treated as detached anyway — nothing is holding
        // this session, and staying 'detaching' forever would wedge every
        // future acquire behind a promise nobody observes failing.
        console.error('[session-attachments] session.detach failed', sessionId, err);
        record.phase = 'detached';
        record.lastResult = undefined;
      },
    );
    record.inFlight = settled;
    void settled.finally(() => {
      if (record.inFlight === settled) {
        record.inFlight = undefined;
      }
    });
  }
}
