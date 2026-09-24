import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import { makeLeaf, type PaneNode } from './tree.js';
import {
  addWorkspace,
  closePaneInWorkspace,
  closeWorkspace,
  focusPane,
  movePaneInWorkspace,
  removeSession,
  renameWorkspace,
  reorderWorkspaces,
  setActiveWorkspace,
  setRatioInWorkspace,
  splitInWorkspace,
  toggleMaximize,
  upsertSession,
  type StoreState,
  type Workspace,
} from './workspace.js';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'ws1',
    cwd: 'C:\\',
    root: makeLeaf(1),
    focusedSessionId: 1,
    maximizedSessionId: undefined,
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'powershell.exe',
    cwd: 'C:\\',
    shell: 'powershell.exe',
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    status: 'idle',
    ...overrides,
  };
}

function state(overrides: Partial<StoreState> = {}): StoreState {
  return { workspaces: [workspace()], activeWorkspaceId: 'ws1', sessions: {}, ...overrides };
}

describe('splitInWorkspace', () => {
  it('splits the target pane and focuses the new leaf', () => {
    const s = state();
    const next = splitInWorkspace(s, 'ws1', 1, 2, 'row', 'n1');
    expect(next.workspaces[0]?.root).toEqual({
      kind: 'split',
      id: 'n1',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    });
    expect(next.workspaces[0]?.focusedSessionId).toBe(2);
  });

  it('rejects a session already placed in a DIFFERENT workspace (cross-workspace armadilha 1)', () => {
    const other = workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 });
    const s = state({ workspaces: [workspace(), other] });
    const next = splitInWorkspace(s, 'ws1', 1, 2, 'row', 'n1');
    expect(next).toBe(s); // unchanged reference: rejected
  });

  it('rejects an unknown workspace', () => {
    const s = state();
    expect(splitInWorkspace(s, 'nope', 1, 2, 'row', 'n1')).toBe(s);
  });
});

describe('closePaneInWorkspace', () => {
  it('closes the pane, moves focus to the neighboring leaf, clears maximize if it was maximized', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'r',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const s = state({
      workspaces: [workspace({ root, focusedSessionId: 1, maximizedSessionId: 1 })],
    });
    const next = closePaneInWorkspace(s, 'ws1', 1);
    const ws = next.workspaces[0];
    expect(ws?.root).toEqual(makeLeaf(2));
    expect(ws?.focusedSessionId).toBe(2);
    expect(ws?.maximizedSessionId).toBeUndefined();
  });

  it('leaves focus alone when the closed pane was not focused', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'r',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const s = state({ workspaces: [workspace({ root, focusedSessionId: 2 })] });
    const next = closePaneInWorkspace(s, 'ws1', 1);
    expect(next.workspaces[0]?.focusedSessionId).toBe(2);
  });

  // Armadilha 5: closing a pane must never imply a daemon call — this
  // reducer only ever touches the tree, and `state.sessions` is untouched.
  it('never removes the session from state.sessions', () => {
    const s = state({ sessions: { 1: session({ id: 1 }) } });
    const next = closePaneInWorkspace(s, 'ws1', 1);
    expect(next.sessions).toEqual(s.sessions);
  });

  it('rejects an unknown workspace or pane', () => {
    const s = state();
    expect(closePaneInWorkspace(s, 'nope', 1)).toBe(s);
    expect(closePaneInWorkspace(s, 'ws1', 99)).toBe(s);
  });
});

describe('movePaneInWorkspace', () => {
  it('moves a pane within the workspace', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'r',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const s = state({ workspaces: [workspace({ root })] });
    const next = movePaneInWorkspace(s, 'ws1', 1, 2, 'right', 'moved');
    expect(next.workspaces[0]?.root).toEqual({
      kind: 'split',
      id: 'moved',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(2),
      b: makeLeaf(1),
    });
  });

  it('rejects an unknown workspace', () => {
    const s = state();
    expect(movePaneInWorkspace(s, 'nope', 1, 2, 'right', 'x')).toBe(s);
  });
});

describe('setRatioInWorkspace', () => {
  it('sets the ratio, surviving a later switch of active workspace', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'r',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const s = state({
      workspaces: [
        workspace({ root }),
        workspace({ id: 'ws2', root: makeLeaf(9), focusedSessionId: 9 }),
      ],
    });
    const afterRatio = setRatioInWorkspace(s, 'ws1', 'r', 0.8);
    const afterSwitch = setActiveWorkspace(afterRatio, 'ws2');
    const backAgain = setActiveWorkspace(afterSwitch, 'ws1');
    expect((backAgain.workspaces[0]?.root as Extract<PaneNode, { kind: 'split' }>).ratio).toBe(0.8);
  });
});

describe('focusPane', () => {
  it('focuses the pane and switches the active workspace', () => {
    const s = state({
      workspaces: [workspace(), workspace({ id: 'ws2', root: makeLeaf(9), focusedSessionId: 9 })],
      activeWorkspaceId: 'ws1',
    });
    const next = focusPane(s, 'ws2', 9);
    expect(next.activeWorkspaceId).toBe('ws2');
    expect(next.workspaces.find((w) => w.id === 'ws2')?.focusedSessionId).toBe(9);
  });

  it('rejects a session not in that workspace', () => {
    const s = state();
    expect(focusPane(s, 'ws1', 999)).toBe(s);
  });
});

describe('toggleMaximize', () => {
  it('toggles on then off', () => {
    const s = state();
    const on = toggleMaximize(s, 'ws1', 1);
    expect(on.workspaces[0]?.maximizedSessionId).toBe(1);
    const off = toggleMaximize(on, 'ws1', 1);
    expect(off.workspaces[0]?.maximizedSessionId).toBeUndefined();
  });
});

describe('workspace CRUD', () => {
  it('addWorkspace appends and activates by default', () => {
    const s = state();
    const next = addWorkspace(s, workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 }));
    expect(next.workspaces.map((w) => w.id)).toEqual(['ws1', 'ws2']);
    expect(next.activeWorkspaceId).toBe('ws2');
  });

  it('addWorkspace with activate:false keeps the current active workspace', () => {
    const s = state();
    const next = addWorkspace(s, workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 }), {
      activate: false,
    });
    expect(next.activeWorkspaceId).toBe('ws1');
  });

  it('addWorkspace rejects a duplicate id', () => {
    const s = state();
    expect(addWorkspace(s, workspace())).toBe(s);
  });

  it('addWorkspace rejects a session already placed elsewhere', () => {
    const s = state(); // ws1 already holds session 1
    const next = addWorkspace(s, workspace({ id: 'ws2', root: makeLeaf(1), focusedSessionId: 1 }));
    expect(next).toBe(s);
  });

  it('closeWorkspace removes it and reassigns active to the first remaining', () => {
    const s = state({
      workspaces: [workspace(), workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 })],
      activeWorkspaceId: 'ws1',
    });
    const next = closeWorkspace(s, 'ws1');
    expect(next.workspaces.map((w) => w.id)).toEqual(['ws2']);
    expect(next.activeWorkspaceId).toBe('ws2');
  });

  it('closeWorkspace clears activeWorkspaceId when it was the last one', () => {
    const s = state();
    const next = closeWorkspace(s, 'ws1');
    expect(next.activeWorkspaceId).toBeUndefined();
    expect(next.workspaces).toHaveLength(0);
  });

  it('reorderWorkspaces reorders and rejects a non-permutation', () => {
    const s = state({
      workspaces: [workspace(), workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 })],
    });
    const reordered = reorderWorkspaces(s, ['ws2', 'ws1']);
    expect(reordered.workspaces.map((w) => w.id)).toEqual(['ws2', 'ws1']);
    expect(reorderWorkspaces(s, ['ws1'])).toBe(s);
    expect(reorderWorkspaces(s, ['ws1', 'ws1'])).toBe(s);
    expect(reorderWorkspaces(s, ['ws1', 'unknown'])).toBe(s);
  });

  it('renameWorkspace renames', () => {
    const s = state();
    const next = renameWorkspace(s, 'ws1', 'novo nome');
    expect(next.workspaces[0]?.name).toBe('novo nome');
  });
});

describe('sessions', () => {
  it('upsertSession inserts then replaces', () => {
    const s = state();
    const inserted = upsertSession(s, session({ id: 5 }));
    expect(inserted.sessions[5]?.id).toBe(5);
    const replaced = upsertSession(inserted, session({ id: 5, status: 'running' }));
    expect(replaced.sessions[5]?.status).toBe('running');
  });

  it('removeSession drops metadata but is a no-op reference for an unknown id', () => {
    const s = state({ sessions: { 5: session({ id: 5 }) } });
    const next = removeSession(s, 5);
    expect(next.sessions[5]).toBeUndefined();
    expect(removeSession(next, 5)).toBe(next);
  });
});
