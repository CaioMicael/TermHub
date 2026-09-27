import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import type { EventPayloadByName, JsonEventName, SessionId, SessionSummary } from '@termhub/shared';

import {
  startSessionStatusSync,
  type StatusSyncBridge,
  type StatusSyncStore,
} from './session-status-sync.js';
import { applySessionStatus, type StoreState } from './store/workspace.js';
import { makeLeaf } from './store/tree.js';

// M5.3, spec section 4's UI test suite: a real Zustand store (so `reconcile`
// really goes through `store.subscribe`/`getState`, not a hand-rolled fake of
// either) plus a fake bridge whose `emitEvent`/`emitConnection` helpers are
// this test file's only way to drive `startSessionStatusSync` — no real IPC,
// no `@termhub/app` import (this package never imports it either).

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'powershell.exe',
    cwd: 'C:\\',
    shell: 'powershell.exe',
    createdAt: 0,
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

interface TestStore extends StoreState {
  applySessionStatus: (
    sessionId: SessionId,
    status: SessionSummary['status'],
    since: number,
    exitCode?: number,
  ) => void;
  /** Test-only stand-in for the real store's `hydrate` action — this file has no need for the real store's dozen other actions. */
  hydrate: (next: StoreState) => void;
}

/** A real Zustand store — `startSessionStatusSync`'s `reconcile()` really goes through `store.subscribe`/`getState`, not a hand-rolled fake of either — narrowed down to `StatusSyncStore`'s shape plus a `hydrate` escape hatch these tests use directly (never through a cast). */
function createTestStore(
  initial: Partial<StoreState> = {},
): StatusSyncStore & { hydrate: (next: StoreState) => void } {
  const store = create<TestStore>((set) => ({
    workspaces: [],
    activeWorkspaceId: undefined,
    sessions: {},
    ...initial,
    applySessionStatus: (sessionId, status, since, exitCode) => {
      set((state) => applySessionStatus(state, sessionId, status, since, exitCode));
    },
    hydrate: (next) => {
      set(() => next);
    },
  }));
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(() => listener()),
    hydrate: (next) => {
      store.getState().hydrate(next);
    },
  };
}

function createFakeBridge(): {
  bridge: StatusSyncBridge;
  emitEvent: <E extends JsonEventName>(event: E, payload: EventPayloadByName[E]) => void;
  emitConnection: (epoch: number | undefined) => void;
} {
  const eventListeners = new Set<
    (event: JsonEventName, payload: EventPayloadByName[JsonEventName]) => void
  >();
  const connectionListeners = new Set<(state: { epoch?: number }) => void>();

  const bridge: StatusSyncBridge = {
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onConnectionStateChange: (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };

  return {
    bridge,
    emitEvent: (event, payload) => {
      for (const listener of eventListeners) {
        listener(event, payload);
      }
    },
    emitConnection: (epoch) => {
      for (const listener of connectionListeners) {
        listener(epoch === undefined ? {} : { epoch });
      }
    },
  };
}

/** A workspace whose tree already places `sessionId` as its sole leaf — `hydrate`'s own shape in the real app, minimal here. */
function workspaceWith(sessionId: SessionId): StoreState['workspaces'][number] {
  return {
    id: 'ws1',
    name: 'ws1',
    cwd: 'C:\\',
    root: makeLeaf(sessionId),
    focusedSessionId: sessionId,
    maximizedSessionId: undefined,
  };
}

describe('startSessionStatusSync', () => {
  it('test 1: an event for a session not yet in the store is not lost — a later, older hydrate does not erase it', () => {
    const store = createTestStore();
    const { bridge, emitEvent } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    // The store is empty: this must not create a phantom session (test 3
    // covers that more directly) — it only has to be remembered.
    emitEvent('session.status', { sessionId: 1, status: 'awaiting-input', since: 200 });
    expect(store.getState().sessions[1]).toBeUndefined();

    // hydrate() lands afterward with a summary read *before* the event
    // happened (statusSince: 100 < the event's 200) — the naive "apply only
    // if present" bug would leave this at 'running' forever.
    store.hydrate({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ status: 'running', statusSince: 100 }) },
    });

    expect(store.getState().sessions[1]?.status).toBe('awaiting-input');
    expect(store.getState().sessions[1]?.statusSince).toBe(200);
    stop();
  });

  it('test 2: a newer summary from hydrate beats an older event', () => {
    const store = createTestStore();
    const { bridge, emitEvent } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    emitEvent('session.status', { sessionId: 1, status: 'awaiting-input', since: 100 });
    store.hydrate({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ status: 'idle', statusSince: 200 }) },
    });

    expect(store.getState().sessions[1]?.status).toBe('idle');
    expect(store.getState().sessions[1]?.statusSince).toBe(200);
    stop();
  });

  it('test 3: an event for an id that never enters the store never creates a phantom session', () => {
    const store = createTestStore();
    const { bridge, emitEvent } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    emitEvent('session.status', { sessionId: 999, status: 'running', since: 1 });
    store.hydrate({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session() },
    });

    expect(store.getState().sessions[999]).toBeUndefined();
    expect(Object.keys(store.getState().sessions)).toEqual(['1']);
    stop();
  });

  it('test 4: session.exit sets exited + exitCode, and a later session.status for the same id changes nothing', () => {
    const store = createTestStore({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ status: 'running', statusSince: 50 }) },
    });
    const { bridge, emitEvent } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    emitEvent('session.exit', { sessionId: 1, exitCode: 3 });
    expect(store.getState().sessions[1]?.status).toBe('exited');
    expect(store.getState().sessions[1]?.exitCode).toBe(3);
    const statusSinceAfterExit = store.getState().sessions[1]?.statusSince;

    emitEvent('session.status', {
      sessionId: 1,
      status: 'running',
      since: (statusSinceAfterExit ?? 0) + 1_000_000,
    });
    expect(store.getState().sessions[1]?.status).toBe('exited');
    expect(store.getState().sessions[1]?.exitCode).toBe(3);
    stop();
  });

  it('test 5: applying one event triggers only a small, finite number of store notifications, never a loop', () => {
    const store = createTestStore({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ status: 'running', statusSince: 0 }) },
    });
    const { bridge, emitEvent } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    let notifications = 0;
    const unsubscribeSpy = store.subscribe(() => {
      notifications += 1;
    });

    emitEvent('session.status', { sessionId: 1, status: 'idle', since: 500 });

    expect(store.getState().sessions[1]?.status).toBe('idle');
    expect(notifications).toBeLessThanOrEqual(2);
    unsubscribeSpy();
    stop();
  });

  it('test 6: a connection-epoch change clears remembered events — a stale one from the old generation is not applied', () => {
    const store = createTestStore();
    const { bridge, emitEvent, emitConnection } = createFakeBridge();
    const stop = startSessionStatusSync(bridge, store);

    emitConnection(1);
    // Session 1, generation 1: remembered, but never applied (no session 1
    // in the store yet during generation 1).
    emitEvent('session.status', { sessionId: 1, status: 'awaiting-input', since: 999 });

    emitConnection(2);
    // Generation 2's session 1 is a completely different session (the
    // daemon renumbers ids from 1 on every start) — hydrate gives it a
    // *smaller* statusSince than the old event's, which would otherwise
    // "win" under a naive "newest since wins" rule that didn't also clear on
    // epoch change.
    store.hydrate({
      workspaces: [workspaceWith(1)],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ status: 'running', statusSince: 10 }) },
    });

    expect(store.getState().sessions[1]?.status).toBe('running');
    expect(store.getState().sessions[1]?.statusSince).toBe(10);
    stop();
  });
});
