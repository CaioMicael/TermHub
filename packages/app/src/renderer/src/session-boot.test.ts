import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ShellProfile,
  SessionSummary,
  WorkspaceTemplate,
  WorkspacesFile,
} from '@termhub/shared';
import { collectSessionIds, treeLeaves, type PaneNode, type StoreState } from '@termhub/ui';

import {
  DEFAULT_CWD,
  DEFAULT_SHELL,
  DEFAULT_WORKSPACE_ID,
  resetSessionBootForTests,
  resolveBootWorkspace,
  startLayoutPersistence,
  startTemplatesPersistence,
  type BootResult,
  type LayoutPersistenceStore,
  type SessionBootBridge,
  type SessionBootMethod,
  type SessionBootRequestParams,
  type SessionBootRequestResult,
  type TemplatesPersistenceStore,
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

  // -------------------------------------------------------------------------
  // M4.7: rule 6.5 — relaunching a dead leaf that carries a `launch` spec,
  // in the exact same tree spot, and never through `resolveDefaultShellParams`
  // (the whole point is running the *same* thing again, not the machine's
  // current default shell).
  // -------------------------------------------------------------------------

  it('relaunches a dead leaf with a launch spec, in the same split position, using its own shell/cwd/args/command — not the profile-based default', async () => {
    const relaunched = summary({ id: 42, shell: 'pwsh.exe', cwd: '/agents', command: 'claude' });
    const listCalls: number[] = [];
    const profilesListCalls: number[] = [];
    const createCalls: unknown[] = [];
    const persistedLayout: WorkspacesFile = {
      version: 1,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: '/agents',
          root: {
            kind: 'split',
            id: 'n1',
            dir: 'row',
            ratio: 0.37,
            a: {
              kind: 'leaf',
              sessionId: 1,
              sessionCreatedAt: 100,
              launch: {
                name: 'claude',
                cwd: '/agents',
                shell: 'pwsh.exe',
                args: ['-NoLogo'],
                command: 'claude',
              },
            },
            b: { kind: 'leaf', sessionId: 2, sessionCreatedAt: 200 }, // dead, no launch: dropped as before
          },
        },
      ],
    };
    function request<M extends SessionBootMethod>(
      method: M,
      params: SessionBootRequestParams[M],
    ): Promise<SessionBootRequestResult[M]> {
      if (method === 'session.list') {
        listCalls.push(1);
        const result: SessionBootRequestResult['session.list'] = { sessions: [] }; // nothing survived
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      if (method === 'profiles.list') {
        profilesListCalls.push(1);
        const result: SessionBootRequestResult['profiles.list'] = { profiles: [] };
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      createCalls.push(params);
      const result: SessionBootRequestResult['session.create'] = { session: relaunched };
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    const bridge: SessionBootBridge = {
      request,
      loadLayout: () => Promise.resolve(persistedLayout),
    };

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    // Exactly one session.create — the relaunch — and it never touched
    // profiles.list at all: the launch spec already says what to run.
    expect(createCalls).toEqual([
      {
        shell: 'pwsh.exe',
        cwd: '/agents',
        cols: 80,
        rows: 24,
        name: 'claude',
        args: ['-NoLogo'],
        command: 'claude',
      },
    ]);
    expect(profilesListCalls).toHaveLength(0);
    // Same split id/ratio, dead-without-launch sibling gone, relaunched
    // leaf in the exact same position with the NEW session's id.
    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 42 });
    expect(onlyWorkspace(result).focusedSessionId).toBe(42);
    expect(result.sessions.some((s) => s.id === 42)).toBe(true);
  });

  it('rule 6 (blank fresh session) never fires when something was relaunched instead — no second, extra session.create', async () => {
    const relaunched = summary({ id: 7 });
    const createCalls: unknown[] = [];
    const persistedLayout: WorkspacesFile = {
      version: 1,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: {
            kind: 'leaf',
            sessionId: 1,
            sessionCreatedAt: 100,
            launch: { cwd: 'C:\\a', shell: 'bash' },
          },
        },
      ],
    };
    function request<M extends SessionBootMethod>(
      method: M,
      params: SessionBootRequestParams[M],
    ): Promise<SessionBootRequestResult[M]> {
      if (method === 'session.list') {
        const result: SessionBootRequestResult['session.list'] = { sessions: [] };
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      if (method === 'profiles.list') {
        const result: SessionBootRequestResult['profiles.list'] = { profiles: [] };
        return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
      }
      createCalls.push(params);
      const result: SessionBootRequestResult['session.create'] = { session: relaunched };
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    const bridge: SessionBootBridge = {
      request,
      loadLayout: () => Promise.resolve(persistedLayout),
    };

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(createCalls).toHaveLength(1); // the relaunch only — not a second, rule-6 blank session
    expect(onlyWorkspace(result).root).toEqual({ kind: 'leaf', sessionId: 7 });
  });

  it("carries the persisted file's own templates through untouched, and [] when there is none (fresh-boot)", async () => {
    const templates = [{ id: 'tpl-1', name: '3 agentes', sessions: [] }];
    const created = summary({ id: 6 });
    const { bridge: freshBridge } = createFakeBridge([], created);
    const freshResult = await resolveBootWorkspace(freshBridge, { cols: 80, rows: 24 });
    expect(freshResult.templates).toEqual([]);

    resetSessionBootForTests();
    const persistedLayout: WorkspacesFile = {
      version: 1,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf', sessionId: 1, sessionCreatedAt: 100 },
        },
      ],
      templates,
    };
    const bridge: SessionBootBridge = {
      request: <M extends SessionBootMethod>(method: M): Promise<SessionBootRequestResult[M]> => {
        if (method === 'session.list') {
          const result: SessionBootRequestResult['session.list'] = { sessions: [created] };
          return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
      loadLayout: () => Promise.resolve(persistedLayout),
    };
    // The one persisted leaf (id 1) never matches the live session (id 6,
    // different id/createdAt) — it's dead, no launch, so it's dropped; the
    // live session (6) lands as an orphan. Irrelevant to this test, which
    // only cares that `templates` rode along regardless.
    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    expect(result.templates).toEqual(templates);
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
  /** Not part of `LayoutPersistenceStore` itself (that interface only needs `subscribe`) — added so this same fake also satisfies `startTemplatesPersistence`'s `mainStore: {getState(): StoreState}` parameter in the M4.7 "both halves of the file" tests below. */
  getState(): StoreState;
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
    getState() {
      return state;
    },
  };
}

/** Same shape `makeFakeStore` gives the layout store, for `useTemplatesStore` (`TemplatesPersistenceStore`'s own `subscribe`/`getState`). */
interface FakeTemplatesStore extends TemplatesPersistenceStore {
  setState(next: { templates: WorkspaceTemplate[] }): void;
}

function makeFakeTemplatesStore(initial: WorkspaceTemplate[]): FakeTemplatesStore {
  let state = { templates: initial };
  const listeners = new Set<
    (
      state: { templates: WorkspaceTemplate[] },
      previousState: { templates: WorkspaceTemplate[] },
    ) => void
  >();
  return {
    getState() {
      return state;
    },
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

// ---------------------------------------------------------------------------
// M4.7: layout and templates share one `workspaces.json` — a save triggered
// by either half must never drop the other. Coordinator's own bug report:
// "se a gravação do layout sair sem os modelos, qualquer mudança de painel
// regrava o arquivo sem eles, e os modelos do usuário somem."
// ---------------------------------------------------------------------------

function template(overrides: Partial<WorkspaceTemplate> & { id: string }): WorkspaceTemplate {
  return { name: 'x', sessions: [], ...overrides };
}

describe('startLayoutPersistence + startTemplatesPersistence (M4.7): neither save drops the other half of the file', () => {
  it('a layout-only change saves a file that still contains the current templates', () => {
    const layoutStore = makeFakeStore(hydratedState());
    const templatesStore = makeFakeTemplatesStore([template({ id: 'tpl-1', name: '3 agentes' })]);
    const saved: WorkspacesFile[] = [];
    const unsubscribe = startLayoutPersistence(
      layoutStore,
      { saveLayout: (layout) => saved.push(layout as WorkspacesFile) },
      templatesStore,
    );

    // A real layout change (a different `workspaces` array reference, as
    // every `store/workspace.ts` reducer produces) — no template touched.
    const changed: StoreState = { ...hydratedState(), activeWorkspaceId: 'ws-a' };
    layoutStore.setState({ ...changed, workspaces: [...changed.workspaces] });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.templates).toEqual([template({ id: 'tpl-1', name: '3 agentes' })]);
    // The layout itself is still there too — this save is additive, not a
    // templates-only file.
    expect(saved[0]?.workspaces).toHaveLength(1);
    unsubscribe();
  });

  it('a templates-only change saves a file with the current layout and the new templates', () => {
    const layoutStore = makeFakeStore(hydratedState());
    const templatesStore = makeFakeTemplatesStore([]);
    const saved: WorkspacesFile[] = [];
    const unsubscribe = startTemplatesPersistence(templatesStore, layoutStore, {
      saveLayout: (layout) => saved.push(layout as WorkspacesFile),
    });

    templatesStore.setState({ templates: [template({ id: 'tpl-1', name: '3 agentes' })] });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.templates).toEqual([template({ id: 'tpl-1', name: '3 agentes' })]);
    // The layout came along too, from `layoutStore`'s own current state —
    // not just the templates half of the file.
    expect(saved[0]?.workspaces).toHaveLength(1);
    expect(saved[0]?.activeWorkspaceId).toBe('ws-a');
    unsubscribe();
  });

  it("neither save fires before boot: starting both only after hydrate/setTemplates already ran (App.tsx's own policy, gated on bootState.phase === 'ready') saves nothing for that past transition, and exactly one save each for a later, real change", () => {
    const layoutStore = makeFakeStore(emptyState);
    const templatesStore = makeFakeTemplatesStore([]);

    // Boot's own hydrate + templates seed, same as `App.tsx`'s boot effect —
    // with nobody subscribed yet.
    layoutStore.setState(hydratedState());
    templatesStore.setState({ templates: [template({ id: 'tpl-1', name: 'seeded' })] });

    const layoutSaved: unknown[] = [];
    const templatesSaved: unknown[] = [];
    const unsubLayout = startLayoutPersistence(
      layoutStore,
      { saveLayout: (layout) => layoutSaved.push(layout) },
      templatesStore,
    );
    const unsubTemplates = startTemplatesPersistence(templatesStore, layoutStore, {
      saveLayout: (layout) => templatesSaved.push(layout),
    });

    // Neither boot transition (already past) triggers a save — same policy
    // `startLayoutPersistence`'s own "subscribing only after hydrate" test
    // already proves for the layout half alone; this is the same guarantee
    // holding for both functions once wired together, exactly as `App.tsx`
    // wires them (both effects gated on `bootState.phase === 'ready'`).
    expect(layoutSaved).toHaveLength(0);
    expect(templatesSaved).toHaveLength(0);

    // A real, later layout change — exactly one layout-triggered save.
    const changed: StoreState = { ...hydratedState(), activeWorkspaceId: 'ws-a' };
    layoutStore.setState({ ...changed, workspaces: [...changed.workspaces] });
    expect(layoutSaved).toHaveLength(1);
    expect(templatesSaved).toHaveLength(0); // the templates-only watcher didn't fire for a layout change

    // A real, later templates change — exactly one templates-triggered save.
    templatesStore.setState({ templates: [template({ id: 'tpl-2', name: 'new' })] });
    expect(templatesSaved).toHaveLength(1);
    expect(layoutSaved).toHaveLength(1); // unchanged — the layout watcher didn't fire for a templates change

    unsubLayout();
    unsubTemplates();
  });
});
