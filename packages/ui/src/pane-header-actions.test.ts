import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import {
  handleCloseClick,
  handleMaximizeClick,
  handleSplitClick,
  splitPaneFromHeader,
  type PaneHeaderClickEvent,
} from './pane-header-actions.js';
import { makeLeaf } from './store/tree.js';
import type { SessionActionsBridge, SessionActionsStoreApi } from './store/session-actions.js';
import type { StoreState, Workspace } from './store/workspace.js';

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

/** Same shape `session-actions.test.ts` already uses for a fake store that records every call. */
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

function fakeEvent(): PaneHeaderClickEvent & { stopped: boolean } {
  const e = { stopped: false, stopPropagation: () => {} };
  e.stopPropagation = () => {
    e.stopped = true;
  };
  return e;
}

// Armadilha 1: every handler must stop the click from bubbling to the
// pane's own onClick (which would call `onFocusPane`) before doing
// anything else.
describe('stopPropagation (armadilha 1)', () => {
  it('handleMaximizeClick stops propagation', () => {
    const event = fakeEvent();
    handleMaximizeClick(event, { toggleMaximize: () => {} }, 'ws1', 1);
    expect(event.stopped).toBe(true);
  });

  it('handleCloseClick stops propagation', () => {
    const event = fakeEvent();
    handleCloseClick(event, { closePane: () => {} }, 'ws1', 1);
    expect(event.stopped).toBe(true);
  });

  it('handleSplitClick stops propagation', () => {
    const event = fakeEvent();
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    const bridge: SessionActionsBridge = {
      request: vi.fn().mockResolvedValue({ session: session() }),
    };
    handleSplitClick(event, store, bridge, 'ws1', 1, { newNodeId: () => 'n1' });
    expect(event.stopped).toBe(true);
  });
});

describe('handleMaximizeClick', () => {
  it("calls store.toggleMaximize with the pane's own workspaceId/sessionId, nothing else", () => {
    const calls: Array<[string, number]> = [];
    handleMaximizeClick(fakeEvent(), { toggleMaximize: (w, s) => calls.push([w, s]) }, 'ws1', 7);
    expect(calls).toEqual([['ws1', 7]]);
  });
});

// Armadilha 2: fechar nunca fecha a sessão — só store.closePane, nunca a bridge.
describe('handleCloseClick', () => {
  it('calls only store.closePane, never touches a bridge (armadilha 2)', () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    // No bridge is even reachable from `handleCloseClick`'s signature — this
    // asserts the one call it *can* make lands correctly.
    handleCloseClick(fakeEvent(), store, 'ws1', 3);
    expect(store.calls.closePane).toEqual([['ws1', 3]]);
  });

  it('closes the pane belonging to the panel that was clicked, not another one', () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: {},
    });
    handleCloseClick(fakeEvent(), store, 'ws1', 1);
    handleCloseClick(fakeEvent(), store, 'ws1', 2);
    expect(store.calls.closePane).toEqual([
      ['ws1', 1],
      ['ws1', 2],
    ]);
  });
});

describe('splitPaneFromHeader', () => {
  it('creates a session and splits the target pane, row direction, using the given newNodeId', async () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ id: 1, cols: 80, rows: 30 }) },
    });
    const created = session({ id: 2 });
    const request = vi.fn().mockResolvedValue({ session: created });
    const bridge: SessionActionsBridge = { request };

    await splitPaneFromHeader(
      store,
      bridge,
      { workspaceId: 'ws1', targetSessionId: 1, dir: 'row' },
      { newNodeId: () => 'n1' },
    );

    expect(store.calls.upsertSession).toEqual([created]);
    expect(store.calls.split).toEqual([['ws1', 1, 2, 'row', 'n1']]);
  });

  // Armadilha 3: falha na criação não pode criar folha nem deixar a
  // promise rejeitar solta.
  it('does not create a leaf and does not reject when session.create fails', async () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ id: 1 }) },
    });
    const bridge: SessionActionsBridge = {
      request: vi.fn().mockRejectedValue(new Error('daemon down')),
    };
    const onError = vi.fn();

    await expect(
      splitPaneFromHeader(
        store,
        bridge,
        { workspaceId: 'ws1', targetSessionId: 1, dir: 'row' },
        { newNodeId: () => 'n1', onError },
      ),
    ).resolves.toBeUndefined();

    expect(store.calls.split).toEqual([]);
    expect(store.calls.upsertSession).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('handleSplitClick', () => {
  it('always splits in the "row" direction (side-by-side, matching the prototype icon)', () => {
    const store = createFakeStore({
      workspaces: [workspace()],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session({ id: 1 }) },
    });
    const created = session({ id: 5 });
    const bridge: SessionActionsBridge = {
      request: vi.fn().mockResolvedValue({ session: created }),
    };

    handleSplitClick(fakeEvent(), store, bridge, 'ws1', 1, { newNodeId: () => 'n1' });

    // handleSplitClick fires the async work without awaiting it (it's a
    // synchronous event handler) — give the microtask queue a turn.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.calls.split).toEqual([['ws1', 1, 5, 'row', 'n1']]);
        resolve();
      }, 0);
    });
  });
});
