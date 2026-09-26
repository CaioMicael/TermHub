import { beforeEach, describe, expect, it } from 'vitest';
import type { ShellProfile, SessionSummary, WorkspacesFile } from '@termhub/shared';
import { collectSessionIds, treeLeaves, type PaneNode, type StoreState } from '@termhub/ui';

import {
  DEFAULT_CWD,
  DEFAULT_SHELL,
  DEFAULT_WORKSPACE_ID,
  resetSessionBootForTests,
  resolveBootWorkspace,
  startLayoutPersistence,
  type BootResult,
  type LayoutPersistenceStore,
  type SessionBootBridge,
  type SessionBootMethod,
  type SessionBootRequestParams,
  type SessionBootRequestResult,
} from './session-boot.js';

/** Every test in this file is about the `'fresh-boot'` fallback (M3.1's original policy) — a fake bridge whose `loadLayout()` always resolves to the "no persisted layout at all" default is what makes `reconcileLayout` take that path. M4.3's own reconciliation rules are `layout-persistence.test.ts`'s job (pure, no bridge at all), and `bridge-gateway.test.ts`/`App.tsx`'s own doc comment cover the wiring around a *present* layout. */
function noPersistedLayout(): WorkspacesFile {
  return { version: 1, workspaces: [] };
}

/** Every test in this file resolves to exactly one workspace (the fresh-boot fallback's own policy) — this just spares each assertion an inline `noUncheckedIndexedAccess` check. */
function onlyWorkspace(result: BootResult): BootResult['workspaces'][number] {
  const [workspace] = result.workspaces;
  if (workspace === undefined) {
    throw new Error('fixture: expected exactly one workspace');
  }
  return workspace;
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'powershell.exe',
    cwd: DEFAULT_CWD,
    shell: DEFAULT_SHELL,
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

/**
 * `profiles.list`'s fake response for `createFakeBridge` — defaults to an
 * empty profile list, which makes `pickDefaultShellProfile` return
 * `undefined` and every test below fall back to exactly `DEFAULT_SHELL`
 * with no `args`, i.e. today's pre-M4.6 behavior. Tests that care about the
 * profile-driven path override this; tests that don't (every test that
 * predates this task) get the old behavior unchanged, with no edits to
 * their own assertions needed.
 */
function createFakeBridge(
  initialSessions: SessionSummary[],
  createdSession: SessionSummary,
  options: { profiles?: ShellProfile[]; profilesError?: Error } = {},
): {
  bridge: SessionBootBridge;
  listCalls: number[];
  createCalls: unknown[];
  profilesListCalls: number[];
} {
  const listCalls: number[] = [];
  const createCalls: unknown[] = [];
  const profilesListCalls: number[] = [];

  function request<M extends SessionBootMethod>(
    method: M,
    params: SessionBootRequestParams[M],
  ): Promise<SessionBootRequestResult[M]> {
    if (method === 'session.list') {
      listCalls.push(1);
      const result: SessionBootRequestResult['session.list'] = { sessions: initialSessions };
      // as: this function's return type depends on `M`, which isn't known
      // inside the branch — see `session-boot.ts`'s own doc comment on the
      // identical pattern in `packages/app/src/preload/bridge.ts`.
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    if (method === 'profiles.list') {
      profilesListCalls.push(1);
      if (options.profilesError !== undefined) {
        // No `as` needed here (unlike the branches below): `Promise.reject`
        // returns `Promise<never>`, already assignable to any
        // `Promise<SessionBootRequestResult[M]>`.
        return Promise.reject(options.profilesError);
      }
      const result: SessionBootRequestResult['profiles.list'] = {
        profiles: options.profiles ?? [],
      };
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    createCalls.push(params);
    const result: SessionBootRequestResult['session.create'] = { session: createdSession };
    return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
  }

  return {
    bridge: { request, loadLayout: () => Promise.resolve(noPersistedLayout()) },
    listCalls,
    createCalls,
    profilesListCalls,
  };
}

describe('resolveBootWorkspace', () => {
  beforeEach(() => {
    resetSessionBootForTests();
  });

  it('with no live session: creates one and returns a single-leaf workspace focused on it', async () => {
    const created = summary({ id: 6, status: 'running' });
    const { bridge, createCalls } = createFakeBridge([], created);

    const result = await resolveBootWorkspace(bridge, { cols: 120, rows: 40 });

    expect(onlyWorkspace(result).id).toBe(DEFAULT_WORKSPACE_ID);
    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 6 });
    expect(onlyWorkspace(result).focusedSessionId).toBe(6);
    expect(result.sessions).toEqual([created]);
    expect(createCalls).toEqual([{ shell: DEFAULT_SHELL, cwd: DEFAULT_CWD, cols: 120, rows: 40 }]);
  });

  it('with exited sessions only: still creates a fresh one, ignoring the exited ones for the tree', async () => {
    const exited = summary({ id: 5, status: 'exited', exitCode: 0, createdAt: 9_999 });
    const created = summary({ id: 6, status: 'running' });
    const { bridge, createCalls } = createFakeBridge([exited], created);

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 6 });
    expect(createCalls).toHaveLength(1);
    // The exited session's metadata is still handed back for the store.
    expect(result.sessions).toEqual([exited, created]);
  });

  it('with N live sessions: builds treeFromSessions over all of them, no session.create', async () => {
    const s1 = summary({ id: 1, createdAt: 1_000 });
    const s2 = summary({ id: 2, createdAt: 2_000 });
    const s3 = summary({ id: 3, createdAt: 3_000 });
    const s4 = summary({ id: 4, createdAt: 4_000 });
    const { bridge, createCalls } = createFakeBridge([s1, s2, s3, s4], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(createCalls).toHaveLength(0);
    expect(collectSessionIds(onlyWorkspace(result).root).size).toBe(4);
    expect(
      treeLeaves(onlyWorkspace(result).root)
        .map((l) => l.sessionId)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
    // 2x2: root is a split of two column splits, per treeFromSessions.
    const root = onlyWorkspace(result).root as Extract<PaneNode, { kind: 'split' }>;
    expect(root.a.kind).toBe('split');
    expect(root.b.kind).toBe('split');
  });

  it('focuses the live session with the highest createdAt, regardless of session.list order', async () => {
    const older = summary({ id: 5, createdAt: 1_000 });
    const newest = summary({ id: 7, createdAt: 3_000 });
    const middle = summary({ id: 6, createdAt: 2_000 });
    const { bridge } = createFakeBridge([older, newest, middle], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(onlyWorkspace(result).focusedSessionId).toBe(7);
  });

  it('ignores exited sessions even when their createdAt is the highest, both for the tree and for focus', async () => {
    const live = summary({ id: 5, status: 'idle', createdAt: 1_000 });
    const exitedButNewer = summary({ id: 6, status: 'exited', exitCode: 0, createdAt: 5_000 });
    const { bridge, createCalls } = createFakeBridge([live, exitedButNewer], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 5 });
    expect(onlyWorkspace(result).focusedSessionId).toBe(5);
    expect(createCalls).toHaveLength(0);
  });

  it('StrictMode-shaped double call: two synchronous calls before the first settles result in exactly one session.create', async () => {
    const { bridge, createCalls, listCalls } = createFakeBridge([], summary());

    const first = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const second = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(createCalls).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
  });

  it('StrictMode-shaped double call with already-live sessions: no session.create at all', async () => {
    const alive = summary({ id: 9, status: 'awaiting-input' });
    const { bridge, createCalls } = createFakeBridge([alive], summary({ id: 99 }));

    const first = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const second = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    await Promise.all([first, second]);

    expect(createCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // M4.6 (second half): the fresh-session shell comes from `profiles.list` +
  // `pickDefaultShellProfile`, not a hardcoded `DEFAULT_SHELL` — with a
  // fallback to that same old value whenever profile detection can't help.
  // ---------------------------------------------------------------------

  it('launches the fresh boot session with the machine default shell profile, args included', async () => {
    const pwsh: ShellProfile = {
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'pwsh',
      shell: 'pwsh.exe',
      args: [],
    };
    const created = summary({ id: 6, shell: 'pwsh.exe' });
    const { bridge, createCalls, profilesListCalls } = createFakeBridge([], created, {
      profiles: [pwsh],
    });

    await resolveBootWorkspace(bridge, { cols: 120, rows: 40 });

    expect(profilesListCalls).toHaveLength(1);
    expect(createCalls).toEqual([
      { shell: 'pwsh.exe', args: [], cwd: DEFAULT_CWD, cols: 120, rows: 40 },
    ]);
  });

  it('picks the WSL default over powershell when no pwsh/powershell/cmd is present — armadilha check: falls through to DEFAULT_SHELL correctly instead', async () => {
    // A machine that only detected a WSL distro and Git Bash (no pwsh/
    // powershell/cmd at all — an unlikely but possible broken install)
    // has no Windows default per `pickDefaultShellProfile`, so this must
    // still fall back to `DEFAULT_SHELL`, not silently default into WSL.
    const wsl: ShellProfile = {
      id: 'wsl:Ubuntu',
      name: 'Ubuntu (WSL)',
      kind: 'wsl',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
    };
    const created = summary({ id: 6 });
    const { bridge, createCalls } = createFakeBridge([], created, { profiles: [wsl] });

    await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(createCalls).toEqual([{ shell: DEFAULT_SHELL, cwd: DEFAULT_CWD, cols: 80, rows: 24 }]);
  });

  it('falls back to DEFAULT_SHELL when profiles.list rejects — the boot must never be worse than before this task', async () => {
    const created = summary({ id: 6 });
    const { bridge, createCalls } = createFakeBridge([], created, {
      profilesError: new Error('daemon unreachable'),
    });

    await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(createCalls).toEqual([{ shell: DEFAULT_SHELL, cwd: DEFAULT_CWD, cols: 80, rows: 24 }]);
  });

  it('applies the same default-shell resolution to the rule-6 (daemon restarted, persisted layout present) fresh session', async () => {
    const pwsh: ShellProfile = {
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'pwsh',
      shell: 'pwsh.exe',
      args: [],
    };
    const created = summary({ id: 6, shell: 'pwsh.exe', cwd: 'C:\\dev\\restored' });
    const listCalls: number[] = [];
    const createCalls: unknown[] = [];
    const profilesListCalls: number[] = [];
    // A persisted layout with one workspace and no surviving leaf (the
    // persisted session id has no match in `session.list`'s — empty —
    // result) is exactly rule 6's trigger condition
    // (`@termhub/ui`'s `layout-persistence.ts`: `liveSessions.length === 0`
    // with at least one persisted workspace) — `needsFreshSessionInWorkspaceId`
    // is what makes `bootWorkspaceOnce` take this second `session.create`
    // call site, not `freshBootWorkspace`'s.
    const persistedLayout: WorkspacesFile = {
      version: 1,
      workspaces: [
        {
          id: 'ws-restored',
          name: 'restored',
          cwd: 'C:\\dev\\restored',
          root: { kind: 'leaf', sessionId: 42, sessionCreatedAt: 1_000 },
        },
      ],
      activeWorkspaceId: 'ws-restored',
    };
    function request<M extends SessionBootMethod>(
      method: M,
      params: SessionBootRequestParams[M],
    ): Promise<SessionBootRequestResult[M]> {
      if (method === 'session.list') {
        listCalls.push(1);
        const result: SessionBootRequestResult['session.list'] = { sessions: [] };
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      if (method === 'profiles.list') {
        profilesListCalls.push(1);
        const result: SessionBootRequestResult['profiles.list'] = { profiles: [pwsh] };
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      createCalls.push(params);
      const result: SessionBootRequestResult['session.create'] = { session: created };
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    const bridge: SessionBootBridge = {
      request,
      loadLayout: () => Promise.resolve(persistedLayout),
    };

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(profilesListCalls).toHaveLength(1);
    expect(createCalls).toEqual([
      { shell: 'pwsh.exe', args: [], cwd: 'C:\\dev\\restored', cols: 80, rows: 24 },
    ]);
    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 6 });
  });
});

// ---------------------------------------------------------------------------
// M4.3, this task's required proof 3: saving the layout must never start
// before boot's own `hydrate()` — a plain fake store (no Zustand, no React)
// stands in for `useTermhubStore` so this is exercised without any of
// App.tsx's rendering.
// ---------------------------------------------------------------------------

interface FakeLayoutStore extends LayoutPersistenceStore {
  setState(next: StoreState): void;
}

function makeFakeStore(initial: StoreState): FakeLayoutStore {
  let state = initial;
  const listeners = new Set<(state: StoreState, previousState: StoreState) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState(next) {
      const previous = state;
      state = next;
      for (const listener of listeners) {
        listener(state, previous);
      }
    },
  };
}

const emptyState: StoreState = { workspaces: [], activeWorkspaceId: undefined, sessions: {} };

function hydratedState(): StoreState {
  return {
    workspaces: [
      {
        id: 'ws-a',
        name: 'a',
        cwd: 'C:\\a',
        root: { kind: 'leaf', sessionId: 1 },
        focusedSessionId: 1,
        maximizedSessionId: undefined,
      },
    ],
    activeWorkspaceId: 'ws-a',
    sessions: { 1: summary({ id: 1 }) },
  };
}

describe('startLayoutPersistence', () => {
  it('the bug this task avoids: subscribing before hydrate saves on the hydrate transition itself', () => {
    const store = makeFakeStore(emptyState);
    const saved: unknown[] = [];
    const unsubscribe = startLayoutPersistence(store, {
      saveLayout: (layout) => saved.push(layout),
    });

    expect(saved).toHaveLength(0); // nothing saved just from subscribing

    // This is boot's own `hydrate()` — the very first real mutation.
    store.setState(hydratedState());

    // A subscription registered before hydrate observes hydrate's own
    // transition and saves it — exactly the premature-save risk this
    // task's prompt names ("um subscribe no topo do App.tsx faz
    // exatamente isso"). This is why `App.tsx` never calls
    // `startLayoutPersistence` this early.
    expect(saved).toHaveLength(1);
    unsubscribe();
  });

  it('subscribing only after hydrate: no save from the hydrate transition, and exactly one save for a later change', () => {
    const store = makeFakeStore(emptyState);
    // Boot's hydrate happens first, with nobody subscribed yet.
    store.setState(hydratedState());

    const saved: unknown[] = [];
    const unsubscribe = startLayoutPersistence(store, {
      saveLayout: (layout) => saved.push(layout),
    });
    expect(saved).toHaveLength(0); // hydrate already happened before subscribing

    const changed: StoreState = { ...hydratedState(), activeWorkspaceId: 'ws-a' };
    // A real change: a *different* workspaces array reference (as every
    // reducer in store/workspace.ts produces on a real mutation).
    store.setState({ ...changed, workspaces: [...changed.workspaces] });
    expect(saved).toHaveLength(1);
    unsubscribe();
  });

  it('a sessions-only change never saves', () => {
    const initial = hydratedState();
    const store = makeFakeStore(initial);
    const saved: unknown[] = [];
    const unsubscribe = startLayoutPersistence(store, {
      saveLayout: (layout) => saved.push(layout),
    });

    // Same `workspaces` array reference and same `activeWorkspaceId` as
    // `initial` — only `sessions` differs, as a real `upsertSession` call
    // (`store/workspace.ts`) produces.
    store.setState({ ...initial, sessions: { ...initial.sessions, 2: summary({ id: 2 }) } });

    expect(saved).toHaveLength(0);
    unsubscribe();
  });

  it('unsubscribing stops further saves', () => {
    const store = makeFakeStore(hydratedState());
    const saved: unknown[] = [];
    const unsubscribe = startLayoutPersistence(store, {
      saveLayout: (layout) => saved.push(layout),
    });
    unsubscribe();

    store.setState({ ...hydratedState(), activeWorkspaceId: undefined });
    expect(saved).toHaveLength(0);
  });
});
