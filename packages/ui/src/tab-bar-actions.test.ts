import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import {
  canCloseWorkspace,
  closeWorkspaceTab,
  createWorkspaceTab,
  generateWorkspaceId,
  nextWorkspaceName,
  NEW_WORKSPACE_CWD_FALLBACK,
  NEW_WORKSPACE_SIZE,
  type CloseWorkspaceStoreApi,
} from './tab-bar-actions.js';
import { makeLeaf } from './store/tree.js';
import {
  NEW_SESSION_SHELL,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
} from './store/session-actions.js';
import type { StoreState, Workspace } from './store/workspace.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 9,
    name: 'powershell.exe',
    cwd: 'C:\\projects\\termhub',
    shell: 'powershell.exe',
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'ws1',
    cwd: 'C:\\projects\\termhub',
    root: makeLeaf(1),
    focusedSessionId: 1,
    maximizedSessionId: undefined,
    ...overrides,
  };
}

describe('canCloseWorkspace', () => {
  it('forbids closing the last remaining workspace', () => {
    expect(canCloseWorkspace(1)).toBe(false);
  });
  it('allows closing when more than one workspace exists', () => {
    expect(canCloseWorkspace(2)).toBe(true);
    expect(canCloseWorkspace(3)).toBe(true);
  });
  it('forbids for a nonsensical zero count too', () => {
    expect(canCloseWorkspace(0)).toBe(false);
  });
});

describe('closeWorkspaceTab', () => {
  it('calls store.closeWorkspace exactly once when more than one tab remains', () => {
    const calls: string[] = [];
    const store: CloseWorkspaceStoreApi = { closeWorkspace: (id) => calls.push(id) };
    closeWorkspaceTab(store, 'ws1', 2);
    expect(calls).toEqual(['ws1']);
  });

  it('is a no-op for the last remaining workspace — armadilha "último workspace não fecha"', () => {
    const calls: string[] = [];
    const store: CloseWorkspaceStoreApi = { closeWorkspace: (id) => calls.push(id) };
    closeWorkspaceTab(store, 'ws1', 1);
    expect(calls).toEqual([]);
  });

  // This test was verified to actually catch a regression (M3.3's prompt,
  // section 4.A: "mostre um teste falhando"): temporarily removing the
  // `canCloseWorkspace` guard in `closeWorkspaceTab` (tab-bar-actions.ts)
  // turned this test red with `AssertionError: expected [ 'ws1' ] to
  // deeply equal []` — see this task's final report for the full output.
  // The guard was restored immediately after capturing it.
});

describe('generateWorkspaceId', () => {
  it('produces an id absent from the existing list', () => {
    const id = generateWorkspaceId(['default']);
    expect(id).not.toBe('default');
    expect(id.startsWith('ws-')).toBe(true);
  });

  it('never collides even when the natural next candidate is already taken', () => {
    const id = generateWorkspaceId(['default', 'ws-1', 'ws-2']);
    expect(['default', 'ws-1', 'ws-2']).not.toContain(id);
  });
});

describe('nextWorkspaceName', () => {
  it('returns the base name when unused', () => {
    expect(nextWorkspaceName(['default', 'landing-page'])).toBe('Novo workspace');
  });

  it('numbers subsequent collisions', () => {
    expect(nextWorkspaceName(['Novo workspace'])).toBe('Novo workspace 2');
    expect(nextWorkspaceName(['Novo workspace', 'Novo workspace 2'])).toBe('Novo workspace 3');
  });
});

describe('createWorkspaceTab', () => {
  function createFakeStore(initial: StoreState): SessionActionsStoreApi & {
    calls: { upsertSession: SessionSummary[]; addWorkspace: unknown[][] };
  } {
    let state = initial;
    const calls = { upsertSession: [] as SessionSummary[], addWorkspace: [] as unknown[][] };
    return {
      calls,
      getState: () => state,
      upsertSession: (s) => {
        calls.upsertSession.push(s);
        state = { ...state, sessions: { ...state.sessions, [s.id]: s } };
      },
      split: () => {
        throw new Error('createWorkspaceTab must never call split');
      },
      addWorkspace: (ws, opts) => {
        calls.addWorkspace.push([ws, opts]);
        state = { ...state, workspaces: [...state.workspaces, ws] };
      },
      closePane: () => {
        throw new Error('createWorkspaceTab must never call closePane');
      },
    };
  }

  it('creates a session in the active workspace cwd and adds a non-colliding new workspace', async () => {
    const active = workspace({ id: 'default', name: 'default', cwd: 'C:\\dev\\termhub' });
    const store = createFakeStore({
      workspaces: [active],
      activeWorkspaceId: 'default',
      sessions: {},
    });
    const created = session({ id: 42 });
    const request = vi.fn().mockResolvedValue({ session: created });
    const bridge: SessionActionsBridge = { request };

    const result = await createWorkspaceTab(store, bridge, active);

    expect(result).toEqual(created);
    expect(request).toHaveBeenCalledWith('session.create', {
      shell: NEW_SESSION_SHELL,
      cwd: 'C:\\dev\\termhub',
      cols: NEW_WORKSPACE_SIZE.cols,
      rows: NEW_WORKSPACE_SIZE.rows,
    });
    expect(store.calls.upsertSession).toEqual([created]);
    const [ws] = store.calls.addWorkspace[0] as [Workspace, unknown];
    expect(ws.id).not.toBe('default');
    expect(ws.cwd).toBe('C:\\dev\\termhub');
    expect(ws.root).toEqual({ kind: 'leaf', sessionId: 42 });
  });

  it('falls back to the fixed cwd guess when there is no active workspace', async () => {
    const store = createFakeStore({ workspaces: [], activeWorkspaceId: undefined, sessions: {} });
    const created = session({ id: 5 });
    const request = vi.fn().mockResolvedValue({ session: created });

    await createWorkspaceTab(store, { request }, undefined);

    expect(request).toHaveBeenCalledWith('session.create', {
      shell: NEW_SESSION_SHELL,
      cwd: NEW_WORKSPACE_CWD_FALLBACK,
      cols: NEW_WORKSPACE_SIZE.cols,
      rows: NEW_WORKSPACE_SIZE.rows,
    });
  });
});
