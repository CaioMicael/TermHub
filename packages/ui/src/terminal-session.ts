// Pure logic behind `Terminal.tsx`, deliberately free of any xterm/React/DOM
// dependency so it can be driven by Vitest (`environment: 'node'`, the
// repo's default — see vitest.config.ts) with plain fakes instead of a real
// browser. `Terminal.tsx` only wires this module to a real `@xterm/xterm`
// instance and React's mount/unmount cycle.
//
// ## The attach-order contract (docs/specs/m1.7-attach-detach.md section
// 3.4, `packages/daemon/src/transport-client.ts`'s `onData` doc comment)
//
// `session.attach`'s snapshot (and any live data that follows) travels as
// binary `session.data` frames that arrive *before* the RPC response —
// never inside it. `attachTerminalSession` below installs the bridge's
// `onData` listener before ever requesting `session.attach`, on purpose: a
// listener installed after `await`ing the request has already missed the
// snapshot, and the daemon never re-sends it.
//
// The M2.2 bridge (`packages/app/src/preload/bridge.ts`) fans out *every*
// session's data through one `onData` callback, so this module filters by
// `sessionId` itself — a chunk for another session must never reach this
// session's sink.
//
// ## Ownership: why session.attach/session.detach are reference-counted
//
// React.StrictMode mounts an effect, runs its cleanup, and mounts it again
// — all *synchronously*, in the same commit. `Terminal.tsx`'s effect
// attaches on mount and detaches on cleanup, so in dev this always plays
// out as: acquire (mount 1) -> release (cleanup 1) -> acquire (mount 2).
//
// The app's main process holds exactly ONE `TransportClient` (one daemon
// connection) shared by every `Terminal` — see `packages/app/src/main/
// daemon-relay.ts`. The daemon tracks attachment per *connection*
// (`clientId`, `packages/daemon/src/service.ts`'s `SessionRuntime.
// attached`), not per `Terminal` instance. `session.attach` is idempotent
// while already attached, and `session.detach` unconditionally removes the
// connection from the session's attached list (`docs/specs/
// m1.7-attach-detach.md` section 3.7) — it has no idea two `Terminal`s
// share the same wire connection and think they each own the attachment.
//
// A naive "attach on mount, detach on cleanup" therefore sends `session.
// attach -> session.attach -> session.detach` for the StrictMode sequence
// above — and the *last* message wins: the connection ends up detached,
// even though a live `Terminal` (mount 2) is still showing this session
// and still expects output. Keyboard input still works (`sendData` doesn't
// require being attached), which is what makes this bug easy to miss by
// eye: the terminal looks interactive, it just never redraws.
//
// The fix is reference counting per `(bridge, sessionId)`, module-level
// (`sessionOwnershipByBridge` below):
// - The first acquisition (0 -> 1) sends the real `session.attach`. Every
//   acquisition after that (refCount >= 1, or refCount 0 with a still-
//   pending deferred detach — see below) just increments and reuses the
//   in-flight-or-settled attach promise.
// - A release that brings the count to 0 does NOT send `session.detach`
//   immediately. It *schedules* one (`setTimeout(..., 0)`, i.e. next
//   macrotask) and cancels it if a new acquisition arrives first. This is
//   exactly what absorbs StrictMode's synchronous cleanup-then-remount:
//   the scheduled detach never fires, because the remount's acquisition
//   cancels it before the current synchronous stack of the browser's
//   event loop even yields. The daemon only ever sees one `session.
//   attach`, full stop.
//
// Why not "detach first, then let the daemon's own idempotent attach sort
// it out" (i.e. always sending attach+detach immediately and relying on
// M1.7's phase machine)? Section 3.3 of docs/specs/m1.7-attach-detach.md:
// if `session.detach` arrives while an in-flight `session.attach` is still
// `snapshotting`, that attach resolves into "there is no attachment left
// to resurrect" and sends nothing — so the *second* `session.attach`
// (mount 2's) would have to run its own, brand-new `serialize()` and get
// its own fresh snapshot. Mount 2's `onData` listener is already
// subscribed by then (same ordering contract as ever), so if mount 1's
// snapshot happened to land before that detach purged it, mount 2 could
// receive two overlapping snapshots — the exact "duplicated history on
// screen" race M1.7 exists to rule out. Deferring the detach instead of
// sending it avoids ever creating that window: from the daemon's point of
// view, across the whole StrictMode dance, there is only ever the one
// original attach.
//
// Known limitation, acceptable for this milestone: a *second* `Terminal`
// that acquires an already-attached session (refCount > 0, outside the
// StrictMode case) does not get a fresh snapshot — only whatever arrives
// live from that point on. Nothing in M2/M3 mounts two `Terminal`s for the
// same session today; M2.6/M3 own deciding whether/how that should work.

/** Every RPC method `terminal-session.ts` actually calls, keyed to its params shape. */
export interface TerminalBridgeRequestParams {
  'session.attach': { sessionId: number };
  'session.detach': { sessionId: number };
}

export type TerminalBridgeMethod = keyof TerminalBridgeRequestParams;

/**
 * The minimal slice of `window.termhub` (`PreloadBridge`, defined in
 * `@termhub/app`'s `packages/app/src/preload/bridge.ts`) that this module
 * needs — defined locally so `@termhub/ui` never imports from `@termhub/app`
 * (the dependency direction is the other way: `@termhub/app` depends on
 * `@termhub/ui`). `window.termhub` is structurally assignable to this
 * interface as-is: its `request` is generic over a *superset* of
 * `TerminalBridgeMethod`, and its `onData`/`sendData` signatures match
 * exactly, so no adapter is needed at the call site (see `Terminal.tsx`).
 */
export interface TerminalBridge {
  /** Resolves once the daemon (or the bridge itself) has handled the call. The result is never inspected by this module — only whether it succeeds. */
  request<M extends TerminalBridgeMethod>(
    method: M,
    params: TerminalBridgeRequestParams[M],
  ): Promise<unknown>;
  /** Fire-and-forget keyboard/paste input, already encoded to bytes — see `encodeTerminalTextInput`/`encodeTerminalBinaryInput`. */
  sendData(sessionId: number, data: Uint8Array): void;
  /** Fires for *every* attached session's output, not just this one — callers (this module) filter by `sessionId`. Returns an unsubscribe function. */
  onData(listener: (sessionId: number, data: Uint8Array) => void): () => void;
}

/** The minimal surface `attachTerminalSession` needs from a terminal to write PTY output into — real `Terminal.tsx` passes something backed by `@xterm/xterm`'s `write`; tests pass a plain recorder. */
export interface TerminalSink {
  write(data: Uint8Array): void;
}

export interface AttachedTerminalSession {
  /**
   * Resolves once *this acquirer's* underlying `session.attach` has
   * settled (it may be reused from an earlier acquirer — see this module's
   * header comment). Rejects if the attach failed. Never needs to be
   * awaited to use the sink: `onData` is already subscribed and writing to
   * it before this even has a chance to resolve (the whole point of the
   * ordering contract above) — this exists only for callers that want to
   * observe/report a failure (`Terminal.tsx` logs it via `.catch()`).
   */
  ready: Promise<void>;
  /**
   * Synchronous: unsubscribes this acquirer's data listener immediately —
   * no `write` on this acquirer's sink can happen once this returns — and
   * releases this acquirer's hold on the shared attachment. The real
   * `session.detach` is deferred, not sent from inside this call (see this
   * module's header comment on ownership); it may end up cancelled by a
   * later acquisition instead of ever being sent. Safe to call more than
   * once; only the first call does anything.
   */
  detach(): void;
}

interface SessionOwnershipRecord {
  refCount: number;
  /** The in-flight-or-settled `session.attach` for the current attachment, shared by every current holder. */
  attachPromise: Promise<void>;
  /** Set only while `refCount` is 0 and the real `session.detach` is scheduled but hasn't fired yet — cleared (and the timer cancelled) by the next acquisition. */
  detachTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Ownership records keyed by bridge instance, then by `sessionId`. A
 * `WeakMap` on the bridge — rather than one shared global map — means two
 * different `TerminalBridge` instances (as every test's own fake bridge
 * is) never share state, and a bridge that's garbage-collected takes its
 * records with it; there is exactly one real bridge (`window.termhub`) in
 * production, so this is purely about test isolation, not a production
 * concern.
 */
const sessionOwnershipByBridge = new WeakMap<TerminalBridge, Map<number, SessionOwnershipRecord>>();

function ownershipMapFor(bridge: TerminalBridge): Map<number, SessionOwnershipRecord> {
  let map = sessionOwnershipByBridge.get(bridge);
  if (map === undefined) {
    map = new Map();
    sessionOwnershipByBridge.set(bridge, map);
  }
  return map;
}

/**
 * Acquires a hold on `sessionId`'s attachment, sending the real `session.
 * attach` only if nothing else currently holds one (see this module's
 * header comment). Always increments the ref count synchronously, before
 * any `await` — so a `release` called before this resolves (StrictMode's
 * cleanup) is never racing this bookkeeping, only the network.
 */
function acquireSessionOwnership(bridge: TerminalBridge, sessionId: number): Promise<void> {
  const registry = ownershipMapFor(bridge);
  const existing = registry.get(sessionId);
  if (existing !== undefined) {
    if (existing.detachTimer !== undefined) {
      clearTimeout(existing.detachTimer);
      existing.detachTimer = undefined;
    }
    existing.refCount += 1;
    return existing.attachPromise;
  }

  const attachPromise = bridge.request('session.attach', { sessionId }).then(
    () => undefined,
    (err: unknown) => {
      // Attach failed: there is nothing worth holding onto — drop the
      // record, but only if it's still this attempt's (a release+reacquire
      // cycle could in principle have already replaced it with a fresh
      // one) — so the next acquirer gets a fresh attempt instead of
      // reusing a broken promise, without clobbering a newer attempt.
      const record = registry.get(sessionId);
      if (record !== undefined && record.attachPromise === attachPromise) {
        registry.delete(sessionId);
      }
      throw err;
    },
  );
  registry.set(sessionId, { refCount: 1, attachPromise, detachTimer: undefined });
  return attachPromise;
}

/**
 * Releases this caller's hold on `sessionId`'s attachment. If this was the
 * last hold, defers the real `session.detach` to the next macrotask
 * instead of sending it now — `acquireSessionOwnership` cancels that timer
 * if a new hold arrives first, which is what makes React.StrictMode's
 * synchronous cleanup-then-remount invisible to the daemon.
 */
function releaseSessionOwnership(bridge: TerminalBridge, sessionId: number): void {
  const registry = ownershipMapFor(bridge);
  const record = registry.get(sessionId);
  if (record === undefined) {
    return; // Never acquired (or already fully released) — nothing to do.
  }
  record.refCount -= 1;
  if (record.refCount > 0) {
    return;
  }
  record.detachTimer = setTimeout(() => {
    registry.delete(sessionId);
    bridge.request('session.detach', { sessionId }).catch((err: unknown) => {
      console.error('[terminal-session] deferred session.detach failed', sessionId, err);
    });
  }, 0);
}

/**
 * Attaches `sink` to `sessionId` on `bridge`: installs the filtered data
 * listener *before* acquiring the attachment (the ordering contract
 * above), then writes every chunk for this session to `sink`, in the order
 * it arrives, with no distinction between "snapshot" and "live" bytes — the
 * daemon's own `seq`-based filter (M1.7) already guarantees there is
 * nothing to lose or duplicate by the time bytes reach this listener, so
 * drawing that line again here would be redundant at best and wrong at
 * worst (docs/specs/m1.7-attach-detach.md section 2).
 *
 * Returns synchronously (not a `Promise`) on purpose: `Terminal.tsx`'s
 * cleanup must be able to call `.detach()` even if the underlying `session.
 * attach` hasn't settled yet — see `ready`'s doc comment and this module's
 * header comment on why that used to be exactly the bug.
 */
export function attachTerminalSession(
  bridge: TerminalBridge,
  sessionId: number,
  sink: TerminalSink,
): AttachedTerminalSession {
  let unsubscribed = false;
  const unsubscribe = bridge.onData((eventSessionId, data) => {
    if (eventSessionId !== sessionId) {
      return;
    }
    sink.write(data);
  });

  const ready = acquireSessionOwnership(bridge, sessionId);

  let detached = false;
  return {
    ready,
    detach(): void {
      if (detached) {
        return;
      }
      detached = true;
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
      releaseSessionOwnership(bridge, sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Keyboard input encoding (armadilha 3)
// ---------------------------------------------------------------------------

/**
 * Encodes xterm's `onData` string (regular keyboard/paste input) as UTF-8
 * bytes for `sendData`. Safe for any Unicode input, including accented
 * characters — `TextEncoder` is exactly what UTF-8-encodes a JS string.
 */
export function encodeTerminalTextInput(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

/**
 * Encodes xterm's `onBinary` string for `sendData`. Per xterm.js's own
 * `IEvent<string>` doc comment on `Terminal.onBinary`, this string is used
 * for binary reports (e.g. mouse tracking) where **each character's code
 * unit is one byte, 0-255** — not a Unicode string to UTF-8-encode.
 * Running it through `TextEncoder` would be wrong: any char above 0x7F
 * would come out as *two* UTF-8 bytes instead of the one raw byte the PTY
 * expects, corrupting every such report. This function takes each char
 * code as-is (masked to a byte, matching the 0-255 contract) instead.
 */
export function encodeTerminalBinaryInput(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i) & 0xff;
  }
  return bytes;
}
