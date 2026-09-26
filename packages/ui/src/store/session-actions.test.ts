import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import { makeLeaf } from './tree.js';
import {
  closePaneAction,
  createWorkspaceWithNewSession,
  estimateSplitSize,
  splitPaneWithNewSession,
  NEW_SESSION_SHELL,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
} from './session-actions.js';
import type { StoreState, Workspace } from './workspace.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 2,
    name: 'powershell.exe',
    cwd: 'C:\\projects\\termhub',
    shell: 'powershell.exe',
    createdAt: Date.now(),
    cols: 40,
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

/** A fake `SessionActionsStoreApi` that records every call instead of actually mutating a Zustand store — enough to assert what each action calls, in what order, and never calls (armadilha 5). */
function createFakeStore(initial: StoreState): SessionActionsStoreApi & {
  calls: {
    upsertSession: SessionSummary[];
    split: unknown[][];
    addWorkspace: unknown[][];
    closePane: unknown[][];
  };
} {
  let state = initial;
  const calls = {
    upsertSession: [] as SessionSummary[],
    split: [] as unknown[][],
    addWorkspace: [] as unknown[][],
    closePane: [] as unknown[][],
  };
  return {
    calls,
    getState: () => state,
    upsertSession: (s) => {
      calls.upsertSession.push(s);
      state = { ...state, sessions: { ...state.sessions, [s.id]: s } };
    },
    split: (workspaceId, target, next, dir, nodeId) => {
      calls.split.push([workspaceId, target, next, dir, nodeId]);
    },
    addWorkspace: (ws, opts) => {
      calls.addWorkspace.push([ws, opts]);
      state = { ...state, workspaces: [...state.workspaces, ws] };
    },
    closePane: (workspaceId, sessionId) => {
      calls.closePane.push([workspaceId, sessionId]);
    },
  };
}

describe('estimateSplitSize', () => {
  it('halves cols for a row split, keeps rows', () => {
    expect(estimateSplitSize({ cols: 80, rows: 24 }, 'row')).toEqual({ cols: 40, rows: 24 });
  });
  it('halves rows for a column split, keeps cols', () => {
    expect(estimateSplitSize({ cols: 80, rows: 24 }, 'column')).toEqual({ cols: 80, rows: 12 });
  });
  it('floors at 1 for a tiny existing size', () => {
    expect(estimateSplitSize({ cols: 1, rows: 1 }, 'row')).toEqual({ cols: 1, rows: 1 });
  });
});

describe('splitPaneWithNewSession', () => {
  it('creates a session sized from the target pane, then upserts and splits in that order', async () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ id: 1, cols: 80, rows: 30 }) },
    });
    const created = session({ id: 2 });
    const request = vi.fn().mockResolvedValue({ session: created });
    const bridge: SessionActionsBridge = { request };

    const result = await splitPaneWithNewSession(store, bridge, {
      workspaceId: 'ws1',
      targetSessionId: 1,
      dir: 'row',
      newNodeId: 'n1',
    });

    expect(result).toEqual(created);
    expect(request).toHaveBeenCalledWith('session.create', {
      shell: NEW_SESSION_SHELL,
      cwd: 'C:\\projects\\termhub',
      cols: 40,
      rows: 30,
    });
    expect(store.calls.upsertSession).toEqual([created]);
    expect(store.calls.split).toEqual([['ws1', 1, 2, 'row', 'n1']]);
    // upsert before split, so the new leaf's metadata already exists once it's in the tree.
    expect(store.calls.upsertSession.length).toBe(1);
  });

  it('falls back to an 80x24 size hint when the target session metadata is not in the store yet', async () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    const created = session({ id: 2 });
    const request = vi.fn().mockResolvedValue({ session: created });

    await splitPaneWithNewSession(
      store,
      { request },
      {
        workspaceId: 'ws1',
        targetSessionId: 1,
        dir: 'column',
        newNodeId: 'n1',
      },
    );

    expect(request).toHaveBeenCalledWith('session.create', {
      shell: NEW_SESSION_SHELL,
      cwd: 'C:\\projects\\termhub',
      cols: 80,
      rows: 12,
    });
  });

  it('throws for an unknown workspace, without calling the bridge', async () => {
    const store = createFakeStore({ workspaces: [], activeWorkspaceId: undefined, sessions: {} });
    const request = vi.fn();
    await expect(
      splitPaneWithNewSession(
        store,
        { request },
        {
          workspaceId: 'nope',
          targetSessionId: 1,
          dir: 'row',
          newNodeId: 'n1',
        },
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceWithNewSession', () => {
  it('creates a session and a single-pane workspace around it', async () => {
    const store = createFakeStore({ workspaces: [], activeWorkspaceId: undefined, sessions: {} });
    const created = session({ id: 7 });
    const request = vi.fn().mockResolvedValue({ session: created });

    await createWorkspaceWithNewSession(
      store,
      { request },
      {
        workspaceId: 'ws-new',
        name: 'novo',
        cwd: 'C:\\dev\\x',
        size: { cols: 100, rows: 30 },
      },
    );

    expect(request).toHaveBeenCalledWith('session.create', {
      shell: NEW_SESSION_SHELL,
      cwd: 'C:\\dev\\x',
      cols: 100,
      rows: 30,
    });
    expect(store.calls.upsertSession).toEqual([created]);
    const [ws] = store.calls.addWorkspace[0] as [Workspace, unknown];
    expect(ws).toEqual({
      id: 'ws-new',
      name: 'novo',
      cwd: 'C:\\dev\\x',
      root: { kind: 'leaf', sessionId: 7 },
      focusedSessionId: 7,
      maximizedSessionId: undefined,
    });
  });
});

describe('closePaneAction', () => {
  it('only calls store.closePane — never touches the bridge/daemon (armadilha 5)', () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    closePaneAction(store, 'ws1', 1);
    expect(store.calls.closePane).toEqual([['ws1', 1]]);
  });
});
