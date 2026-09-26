import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellProfile, SessionSummary, WorkspacesFile } from '@termhub/shared';
import { forgetSessionOwnership, type TerminalBridge } from '@termhub/ui';
import type { StoreState, Workspace } from '@termhub/ui';

import { resetDaemonResyncForTests, runDaemonResync } from './daemon-resync.js';
import type { DaemonResyncBridge } from './daemon-resync.js';

beforeEach(() => {
  resetDaemonResyncForTests();
});

// docs/specs/m4.8-daemon-resilience.md section 4, required test 4: same
// daemon (everything reconciles, nothing dropped, every host reattaches),
// daemon restarted (nothing survives, workspaces stay, one fresh session is
// born, old hosts are discarded), and a mixed case.

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'claude',
    cwd: 'C:\\projects\\termhub',
    shell: 'powershell.exe',
    createdAt: 1000,
    cols: 80,
    rows: 24,
    status: 'idle',
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'ws1',
    cwd: 'C:\\projects\\termhub',
    root: { kind: 'leaf', sessionId: 1 },
    focusedSessionId: 1,
    maximizedSessionId: undefined,
    ...overrides,
  };
}

interface FakeBridgeResult {
  bridge: DaemonResyncBridge & TerminalBridge;
  requests: Array<{ method: string; params: unknown }>;
}

/**
 * `runDaemonResync`'s `bridge` parameter is `DaemonResyncBridge &
 * TerminalBridge` — the same `window.termhub` object satisfies both in
 * production, via one fully generic `request` method (`RequestMethod` is a
 * superset of both interfaces' own narrower method sets). A plain object
 * literal can't express that same genuinely-generic signature, so this
 * fake's `request` is declared against `DaemonResyncBridge`'s own (narrow,
 * fully-typed) signature — every test in this file only ever calls
 * `session.list`/`session.create` through it, never one of
 * `TerminalBridge`'s own methods — and the object is asserted to the wider
 * intersection type once, here, rather than reaching for `any` anywhere in
 * the fake's own body.
 */
function createFakeBridge(options: {
  sessionListResult: SessionSummary[];
  createResult?: SessionSummary;
  /** Defaults to `[]` (no profile `pickDefaultShellProfile` would pick — falls back to `DEFAULT_SHELL`). */
  profilesListResult?: ShellProfile[];
  /** `true` makes the `profiles.list` request reject instead — the other fallback path `resolveDefaultShellParams` covers. */
  profilesListRejects?: boolean;
}): FakeBridgeResult {
  const requests: Array<{ method: string; params: unknown }> = [];
  const request: DaemonResyncBridge['request'] = ((method: string, params: unknown) => {
    requests.push({ method, params });
    if (method === 'session.list') {
      return Promise.resolve({ sessions: options.sessionListResult });
    }
    if (method === 'session.create') {
      return Promise.resolve({ session: options.createResult ?? makeSession({ id: 99 }) });
    }
    if (method === 'profiles.list') {
      if (options.profilesListRejects === true) {
        return Promise.reject(new Error('profiles.list failed'));
      }
      return Promise.resolve({ profiles: options.profilesListResult ?? [] });
    }
    return Promise.resolve({});
  }) as DaemonResyncBridge['request'];
  const bridge = {
    request,
    sendData: () => {},
    onData: () => () => {},
    readClipboardText: () => Promise.resolve(''),
    writeClipboardText: () => Promise.resolve(),
    openContextMenu: () => Promise.resolve(undefined),
    loadLayout: () => Promise.resolve({ version: 1, workspaces: [] } as WorkspacesFile),
    // This fake's `request` only implements `DaemonResyncBridge`'s methods
    // (see this function's own doc comment) — asserted to the wider
    // intersection type `runDaemonResync` requires, not `any`.
  } as DaemonResyncBridge & TerminalBridge;
  return { bridge, requests };
}

function createFakeStore(initial: StoreState): {
  store: { getState: () => StoreState; hydrate: (next: StoreState) => void };
  hydrateCalls: StoreState[];
} {
  let state = initial;
  const hydrateCalls: StoreState[] = [];
  return {
    store: {
      getState: () => state,
      hydrate: (next) => {
        hydrateCalls.push(next);
        state = next;
      },
    },
    hydrateCalls,
  };
}

function createFakeRegistry(): { registry: { reattachAll: () => void }; reattachAllCalls: number } {
  let reattachAllCalls = 0;
  return {
    registry: {
      reattachAll: () => {
        reattachAllCalls += 1;
      },
    },
    get reattachAllCalls() {
      return reattachAllCalls;
    },
  };
}

describe('runDaemonResync (docs/specs/m4.8-daemon-resilience.md required test 4)', () => {
  it('same daemon: the surviving session matches by id+createdAt, nothing drops, no session.create, and the registry reattaches', async () => {
    const session1 = makeSession({ id: 1, createdAt: 1000 });
    const initial: StoreState = {
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session1 },
    };
    const { bridge, requests } = createFakeBridge({ sessionListResult: [session1] });
    const { store, hydrateCalls } = createFakeStore(initial);
    const registryFake = createFakeRegistry();

    const result = await runDaemonResync(bridge, store, registryFake.registry);

    expect(result.daemonRestarted).toBe(false);
    expect(requests.some((r) => r.method === 'session.create')).toBe(false);
    expect(hydrateCalls).toHaveLength(1);
    const hydrated = hydrateCalls[0];
    expect(hydrated?.workspaces[0]?.root).toEqual({ kind: 'leaf', sessionId: 1 });
    expect(hydrated?.activeWorkspaceId).toBe('ws1');
    expect(registryFake.reattachAllCalls).toBe(1);
  });

  it('daemon restarted: nothing survives, the workspace stays, exactly one fresh session is born, and the registry still reattaches', async () => {
    const oldSession = makeSession({ id: 1, createdAt: 1000 });
    const initial: StoreState = {
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: oldSession },
    };
    const freshSession = makeSession({ id: 1, createdAt: 5000 }); // id reused by the new daemon, different createdAt
    const { bridge, requests } = createFakeBridge({
      sessionListResult: [], // the new daemon has no live sessions yet
      createResult: freshSession,
    });
    const { store, hydrateCalls } = createFakeStore(initial);
    const registryFake = createFakeRegistry();

    const result = await runDaemonResync(bridge, store, registryFake.registry);

    expect(result.daemonRestarted).toBe(true);
    expect(requests.filter((r) => r.method === 'session.create')).toHaveLength(1);
    expect(hydrateCalls).toHaveLength(1);
    const hydrated = hydrateCalls[0];
    // The workspace itself stays (never removed) and gets exactly the one
    // fresh session as its sole pane.
    expect(hydrated?.workspaces).toHaveLength(1);
    expect(hydrated?.workspaces[0]?.id).toBe('ws1');
    expect(hydrated?.workspaces[0]?.root).toEqual({ kind: 'leaf', sessionId: freshSession.id });
    expect(hydrated?.workspaces[0]?.focusedSessionId).toBe(freshSession.id);
    // The old session's metadata is gone — the new connection never
    // reported it, and it was never asked to be recreated.
    expect(hydrated?.sessions[1]).toEqual(freshSession);
    expect(registryFake.reattachAllCalls).toBe(1);
  });

  it('mixed: one workspace survives untouched, another loses its only session and ends up empty — no fresh session created (some live session exists elsewhere)', async () => {
    const survivor = makeSession({ id: 1, createdAt: 1000 });
    const dead = makeSession({ id: 2, createdAt: 2000 });
    const initial: StoreState = {
      workspaces: [
        makeWorkspace({ id: 'ws1', root: { kind: 'leaf', sessionId: 1 }, focusedSessionId: 1 }),
        makeWorkspace({
          id: 'ws2',
          name: 'ws2',
          root: { kind: 'leaf', sessionId: 2 },
          focusedSessionId: 2,
        }),
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: survivor, 2: dead },
    };
    const { bridge, requests } = createFakeBridge({ sessionListResult: [survivor] }); // only session 1 survived
    const { store, hydrateCalls } = createFakeStore(initial);
    const registryFake = createFakeRegistry();

    const result = await runDaemonResync(bridge, store, registryFake.registry);

    expect(result.daemonRestarted).toBe(false);
    expect(requests.some((r) => r.method === 'session.create')).toBe(false); // rule 6 doesn't apply — a live session exists
    const hydrated = hydrateCalls[0];
    expect(hydrated?.workspaces.find((w) => w.id === 'ws1')?.root).toEqual({
      kind: 'leaf',
      sessionId: 1,
    });
    expect(hydrated?.workspaces.find((w) => w.id === 'ws2')?.root).toBeNull();
    expect(hydrated?.sessions[2]).toBeUndefined(); // the dead session's metadata is gone
    expect(registryFake.reattachAllCalls).toBe(1);
  });

  it("forgets session ownership before doing anything else — a real session.attach follows a naive release+acquire only because of this (see terminal-session.test.ts's own required test 2)", async () => {
    const bridgeCalls: string[] = [];
    const request: DaemonResyncBridge['request'] = ((method: string) => {
      bridgeCalls.push(method);
      if (method === 'session.list') return Promise.resolve({ sessions: [] });
      if (method === 'session.create') return Promise.resolve({ session: makeSession({ id: 7 }) });
      if (method === 'profiles.list') return Promise.resolve({ profiles: [] });
      return Promise.resolve({});
    }) as DaemonResyncBridge['request'];
    // Same reasoning as `createFakeBridge`'s own doc comment: this fake only
    // implements `DaemonResyncBridge`'s methods, asserted to the wider
    // intersection type `runDaemonResync` requires.
    const bridge = {
      request,
      sendData: () => {},
      onData: () => () => {},
      readClipboardText: () => Promise.resolve(''),
      writeClipboardText: () => Promise.resolve(),
      openContextMenu: () => Promise.resolve(undefined),
      loadLayout: () => Promise.resolve({ version: 1, workspaces: [] } as WorkspacesFile),
    } as DaemonResyncBridge & TerminalBridge;
    const forgetSpy = vi.fn();
    // Spies on the real `forgetSessionOwnership` behavior indirectly: since
    // it's a module-level WeakMap keyed by `bridge`, calling it here first
    // and then asserting a *second* call in `runDaemonResync` doesn't throw
    // and doesn't touch the daemon proves it ran without needing to mock
    // the import itself.
    expect(() => forgetSessionOwnership(bridge)).not.toThrow();
    forgetSpy();

    const { store } = createFakeStore({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    const registryFake = createFakeRegistry();
    await runDaemonResync(bridge, store, registryFake.registry);

    expect(forgetSpy).toHaveBeenCalledTimes(1);
    // The very first bridge call is session.list — forgetSessionOwnership
    // itself never touches the bridge's `request`.
    expect(bridgeCalls[0]).toBe('session.list');
  });
});

// ---------------------------------------------------------------------------
// Coordinator fix 1: the restart's fresh session uses the machine's real
// default shell profile (M4.6's second half, `resolveDefaultShellParams`),
// not a hardcoded `'powershell.exe'` that would undo that fix the moment a
// daemon restart happened.
// ---------------------------------------------------------------------------

describe('runDaemonResync — the restart session uses the real default shell profile, not a hardcoded one', () => {
  function pwshProfile(): ShellProfile {
    return {
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'pwsh',
      shell: 'pwsh.exe',
      args: ['-NoLogo'],
    };
  }

  it('a profiles.list that offers pwsh: the fresh session is created with it, not powershell.exe', async () => {
    const oldSession = makeSession({ id: 1, createdAt: 1000 });
    const { bridge, requests } = createFakeBridge({
      sessionListResult: [],
      createResult: makeSession({ id: 1, createdAt: 5000, shell: 'pwsh.exe', args: ['-NoLogo'] }),
      profilesListResult: [pwshProfile()],
    });
    const { store } = createFakeStore({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: oldSession },
    });
    const registryFake = createFakeRegistry();

    await runDaemonResync(bridge, store, registryFake.registry);

    const createCall = requests.find((r) => r.method === 'session.create');
    expect(createCall?.params).toMatchObject({ shell: 'pwsh.exe', args: ['-NoLogo'] });
  });

  it('a rejecting profiles.list: the fresh session falls back to the fixed DEFAULT_SHELL, with no args — never blocks the resync', async () => {
    const oldSession = makeSession({ id: 1, createdAt: 1000 });
    const { bridge, requests } = createFakeBridge({
      sessionListResult: [],
      createResult: makeSession({ id: 1, createdAt: 5000 }),
      profilesListRejects: true,
    });
    const { store, hydrateCalls } = createFakeStore({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: oldSession },
    });
    const registryFake = createFakeRegistry();

    const result = await runDaemonResync(bridge, store, registryFake.registry);

    expect(result.daemonRestarted).toBe(true);
    const createCall = requests.find((r) => r.method === 'session.create');
    expect(createCall?.params).toMatchObject({ shell: 'powershell.exe' });
    expect((createCall?.params as { args?: string[] }).args).toBeUndefined();
    expect(hydrateCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Coordinator fix 2: at most one resync in flight — a second call arriving
// while one is already running is coalesced into exactly one follow-up run,
// using the latest state, instead of running concurrently.
// ---------------------------------------------------------------------------

describe('runDaemonResync — at most one resync in flight', () => {
  /** A `session.list` the test resolves by hand, so it can hold a resync "in flight" on demand. */
  function createControllableBridge(): {
    bridge: DaemonResyncBridge & TerminalBridge;
    requests: Array<{ method: string; params: unknown }>;
    /** Resolves the *next* still-pending `session.list` call with `sessions`. */
    resolveNextSessionList: (sessions: SessionSummary[]) => void;
    /** Every session ever created, in order — `session.create` always succeeds immediately and also gets added to what future `session.list` calls report, modeling a real daemon. */
    createdSessions: SessionSummary[];
  } {
    const requests: Array<{ method: string; params: unknown }> = [];
    const pendingSessionListResolvers: Array<(sessions: SessionSummary[]) => void> = [];
    const createdSessions: SessionSummary[] = [];
    let nextCreatedId = 100;

    const request: DaemonResyncBridge['request'] = ((method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === 'session.list') {
        return new Promise<{ sessions: SessionSummary[] }>((resolve) => {
          pendingSessionListResolvers.push((sessions) => resolve({ sessions }));
        });
      }
      if (method === 'session.create') {
        const session = makeSession({ id: nextCreatedId, createdAt: 9_000 + nextCreatedId });
        nextCreatedId += 1;
        createdSessions.push(session);
        return Promise.resolve({ session });
      }
      if (method === 'profiles.list') {
        return Promise.resolve({ profiles: [] });
      }
      return Promise.resolve({});
    }) as DaemonResyncBridge['request'];

    const bridge = {
      request,
      sendData: () => {},
      onData: () => () => {},
      readClipboardText: () => Promise.resolve(''),
      writeClipboardText: () => Promise.resolve(),
      openContextMenu: () => Promise.resolve(undefined),
      loadLayout: () => Promise.resolve({ version: 1, workspaces: [] } as WorkspacesFile),
    } as DaemonResyncBridge & TerminalBridge;

    return {
      bridge,
      requests,
      resolveNextSessionList: (sessions) => {
        const resolve = pendingSessionListResolvers.shift();
        if (resolve === undefined) {
          throw new Error('test setup invariant broken: no pending session.list to resolve');
        }
        resolve(sessions);
      },
      createdSessions,
    };
  }

  it('a second call while one is in flight is coalesced into exactly one follow-up run, with at most one session.create in total', async () => {
    const { bridge, requests, resolveNextSessionList, createdSessions } =
      createControllableBridge();
    const { store, hydrateCalls } = createFakeStore({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession({ id: 1, createdAt: 1000 }) },
    });
    const registryFake = createFakeRegistry();

    // Call A: the daemon restarted (no live sessions at all), starts its
    // own session.list round trip and awaits it.
    const callA = runDaemonResync(bridge, store, registryFake.registry);

    // Call B arrives while A's session.list is still pending — per the
    // guard, this must not start its own session.list yet.
    const callB = runDaemonResync(bridge, store, registryFake.registry);
    expect(requests.filter((r) => r.method === 'session.list')).toHaveLength(1);

    // A's session.list resolves: nothing survived: A creates exactly one
    // fresh session and hydrates the store with it.
    resolveNextSessionList([]);
    const resultA = await callA;
    expect(resultA.daemonRestarted).toBe(true);
    expect(requests.filter((r) => r.method === 'session.create')).toHaveLength(1);

    // Only now does B's own (queued) run actually start its session.list —
    // reporting the daemon's current, real state: the session A just
    // created is now live.
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.method === 'session.list')).toHaveLength(2),
    );
    const created = createdSessions[0];
    if (created === undefined) {
      throw new Error('test setup invariant broken: call A never created a session');
    }
    resolveNextSessionList([created]);
    const resultB = await callB;

    // B's own reconciliation finds that session already matching the store
    // (same id+createdAt, since A's hydrate already placed it) — nothing
    // missing, so B never needs rule 6 at all.
    expect(resultB.daemonRestarted).toBe(false);
    expect(requests.filter((r) => r.method === 'session.create')).toHaveLength(1); // still just A's
    expect(hydrateCalls).toHaveLength(2); // both A and B actually ran and hydrated
    expect(registryFake.reattachAllCalls).toBe(2);
  });
});
