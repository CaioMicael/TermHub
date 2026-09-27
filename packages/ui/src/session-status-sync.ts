// M5.3: mirrors the daemon's `session.status`/`session.exit` events into the
// store's `sessions` map — the renderer-side half of
// `docs/specs/m5.3-status-propagation.md`. Nothing here reads `window.
// termhub` directly (armadilha in `docs/handoff.md`): `startSessionStatusSync`
// takes the bridge and the store as parameters, the same pattern
// `terminal-session.ts`'s `TerminalBridge` already established, so
// `@termhub/app`'s `App.tsx` is the only place the real `window.termhub`
// gets plugged in.
//
// ## Why a `latest` map lives outside the store (spec section 2.1)
//
// Boot (`session-boot.ts`) and the M4.8 resync (`daemon-resync.ts`) both do
// `session.list` and, a while later, `hydrate(...)` with whatever that list
// returned — and a `session.status` event can arrive in between, since the
// main process holds one daemon connection already attached to every
// session, independent of whether this renderer has finished booting yet.
// Two "obvious" fixes are both wrong:
//
// - Applying an event only if the session is already in the store drops it
//   silently before boot, and the later `hydrate` then overwrites it with
//   whatever `session.list` read *before* the event happened — the status
//   badge is wrong until the next real transition, which can be hours away.
// - Applying an event by creating the session in the store conjures a
//   phantom session id the window never asked for.
//
// The fix: every status carries the epoch ms it started at, the newest one
// wins regardless of source (event or `SessionSummary.statusSince`), and
// this module keeps its own record of "the latest status this module has
// heard about" independent of the store, replaying it into the store every
// time the store changes (`reconcile`, via `store.subscribe`) — which is
// exactly what makes a `hydrate` that lands after an event self-correct
// without anything else needing to remember to re-check.
//
// ## Why data before status (session.status) still isn't a race here
//
// The daemon already guarantees a status event for a chunk is sent only
// after that chunk's own data (`service.ts`'s `wireSessionDelivery`,
// docs/specs/m5.3-status-propagation.md section 2.2) — this module has
// nothing to add on top of that ordering; it just mirrors whatever event
// arrives, whenever it arrives.

import type {
  EventPayloadByName,
  JsonEventName,
  SessionExitPayload,
  SessionId,
  SessionStatus,
  SessionStatusPayload,
  SessionSummary,
} from '@termhub/shared';

/**
 * Structural subset of the preload bridge (`PreloadBridge`,
 * `packages/app/src/preload/bridge.ts`) this module needs — the same pattern
 * `terminal-session.ts`'s `TerminalBridge` uses, so `@termhub/ui` never
 * depends on `@termhub/app` (the dependency direction is the other way).
 * `window.termhub` is structurally assignable to this as-is: no adapter is
 * needed at the call site (see `App.tsx`).
 */
export interface StatusSyncBridge {
  /** Subscribes to `session.exit`/`session.status`. Returns an unsubscribe function. */
  onEvent(
    listener: (event: JsonEventName, payload: EventPayloadByName[JsonEventName]) => void,
  ): () => void;
  /**
   * Subscribes to connection-state changes. Only `epoch` is read here — the
   * daemon renumerates session ids from 1 on every start of its own
   * (`docs/handoff.md`'s "armadilhas"), so a status this module cached for
   * the *previous* connection's session `1` must never be replayed onto
   * whatever session `1` means on a new one.
   */
  onConnectionStateChange(listener: (state: { epoch?: number }) => void): () => void;
}

/** Structural subset of `useTermhubStore` this module needs — a plain `{getState, subscribe}` pair, not the Zustand hook itself (`App.tsx` passes `useTermhubStore` directly; it satisfies this shape as-is). */
export interface StatusSyncStore {
  getState(): {
    sessions: Record<SessionId, SessionSummary>;
    applySessionStatus: (
      sessionId: SessionId,
      status: SessionStatus,
      since: number,
      exitCode?: number,
    ) => void;
  };
  subscribe(listener: () => void): () => void;
}

interface LatestStatus {
  status: SessionStatus;
  since: number;
  exitCode?: number;
}

/**
 * Starts mirroring daemon status events into `store`. Returns a stop
 * function that unsubscribes from `bridge` and `store` — call it on
 * unmount, same lifecycle as any other bridge subscription in this codebase.
 */
export function startSessionStatusSync(
  bridge: StatusSyncBridge,
  store: StatusSyncStore,
): () => void {
  const latest = new Map<SessionId, LatestStatus>();
  let lastEpoch: number | undefined;

  // Spec section 3.4 item 4: replays `latest` into the store, for every
  // session `latest` knows about that the store *currently* has — a session
  // absent from the store is left alone (no phantom creation), still
  // sitting in `latest` for whenever it does show up (a later `hydrate`, or
  // `placeSessionInWorkspace`/`upsertSession`, all of which fire the same
  // `store.subscribe` listener below since they all end in a `set`).
  function reconcile(): void {
    const state = store.getState();
    for (const [sessionId, entry] of latest) {
      const summary = state.sessions[sessionId];
      if (summary === undefined) {
        continue;
      }
      const summarySince = summary.statusSince ?? -Infinity;
      // "Newest wins" (spec section 2.1) plus its one exception (item 3 of
      // section 3.4): an `exited` event beats a summary that hasn't heard
      // about the death yet, even if that summary's own `statusSince`
      // happens to read later — death is terminal, and a summary reporting
      // anything else while `latest` already knows the session exited is,
      // by construction, stale.
      const isNewer = entry.since > summarySince;
      const exitBeatsNonExit = entry.status === 'exited' && summary.status !== 'exited';
      if (isNewer || exitBeatsNonExit) {
        state.applySessionStatus(sessionId, entry.status, entry.since, entry.exitCode);
      }
    }
  }

  function recordStatus(sessionId: SessionId, status: SessionStatus, since: number): void {
    const existing = latest.get(sessionId);
    if (existing !== undefined && existing.since > since) {
      // A strictly older event arriving after a newer one (out-of-order
      // delivery is not a case the transport actually produces, but this
      // keeps `latest` itself monotonic regardless) — never regresses what
      // this module has already recorded.
      return;
    }
    latest.set(sessionId, { status, since });
  }

  const unsubscribeEvent = bridge.onEvent((event, payload) => {
    // `EventPayloadByName[JsonEventName]` is a plain union — TypeScript
    // doesn't correlate it with the sibling `event` parameter the way a
    // single discriminated value would, so narrowing needs an explicit cast
    // here, same boundary `protocol.ts`'s own `isControlMessage` documents
    // for the analogous JSON.parse case.
    if (event === 'session.status') {
      const status = payload as SessionStatusPayload;
      recordStatus(status.sessionId, status.status, status.since);
      reconcile();
      return;
    }
    if (event === 'session.exit') {
      const exit = payload as SessionExitPayload;
      // Spec section 3.4 item 3: exit always wins over whatever `latest`
      // already had for this session, regardless of `since` ordering — death
      // is terminal information a stale/racing `session.status` can never
      // override once observed.
      latest.set(exit.sessionId, { status: 'exited', since: Date.now(), exitCode: exit.exitCode });
      reconcile();
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    reconcile();
  });

  const unsubscribeConnection = bridge.onConnectionStateChange((state) => {
    if (state.epoch !== undefined && state.epoch !== lastEpoch) {
      lastEpoch = state.epoch;
      // Spec section 3.4 item 6: a status this module cached against the
      // previous connection's session ids means nothing once the daemon
      // renumbers from 1 again — clearing it here is what keeps an old
      // session `1`'s event from ever being replayed onto the new one.
      latest.clear();
    }
  });

  return () => {
    unsubscribeEvent();
    unsubscribeStore();
    unsubscribeConnection();
  };
}
