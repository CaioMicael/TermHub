import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import {
  activeFocusedTarget,
  buildSidebarGroups,
  totalPlacedSessionCount,
} from './sidebar-model.js';
import { makeLeaf, treeFromSessions } from './store/tree.js';
import type { StoreState, Workspace } from './store/workspace.js';

function session(id: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: `agent-${id}`,
    cwd: 'C:\\projects\\termhub',
    shell: 'powershell.exe',
    createdAt: 0,
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

describe('buildSidebarGroups', () => {
  it('returns one group per workspace, in tab order (not alphabetical, not insertion-by-id)', () => {
    const state: StoreState = {
      workspaces: [
        workspace({ id: 'c', name: 'c-project', root: makeLeaf(3), focusedSessionId: 3 }),
        workspace({ id: 'a', name: 'a-project', root: makeLeaf(1), focusedSessionId: 1 }),
        workspace({ id: 'b', name: 'b-project', root: makeLeaf(2), focusedSessionId: 2 }),
      ],
      activeWorkspaceId: 'a',
      sessions: { 1: session(1), 2: session(2), 3: session(3) },
    };
    const groups = buildSidebarGroups(state);
    expect(groups.map((g) => g.workspaceId)).toEqual(['c', 'a', 'b']);
  });

  it('marks active exactly the row for the focused pane of the active workspace', () => {
    const state: StoreState = {
      workspaces: [
        workspace({
          id: 'ws1',
          root: treeFromSessions([1, 2]),
          focusedSessionId: 2,
        }),
        workspace({ id: 'ws2', root: makeLeaf(3), focusedSessionId: 3 }),
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session(1), 2: session(2), 3: session(3) },
    };
    const groups = buildSidebarGroups(state);
    const activeRows = groups.flatMap((g) => g.rows.filter((r) => r.active));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]).toMatchObject({ workspaceId: 'ws1', sessionId: 2 });

    // The other workspace's focused session is not active, because that
    // workspace itself isn't the active one — this is the mutation that
    // must turn this test red: dropping the `workspace.id ===
    // state.activeWorkspaceId` half of the condition in sidebar-model.ts's
    // `buildSidebarGroups` would mark ws2's row 3 active too.
    const ws2Row = groups.find((g) => g.workspaceId === 'ws2')?.rows[0];
    expect(ws2Row?.active).toBe(false);
  });

  it('reports the session count as the number of rows (leaves currently in the tree)', () => {
    const state: StoreState = {
      workspaces: [workspace({ id: 'ws1', root: treeFromSessions([1, 2, 3, 4]) })],
      activeWorkspaceId: 'ws1',
      sessions: {
        1: session(1),
        2: session(2),
        3: session(3),
        4: session(4),
      },
    };
    const [group] = buildSidebarGroups(state);
    expect(group?.sessionCount).toBe(4);
    expect(group?.rows).toHaveLength(4);
  });

  it('sums sessionCount across every workspace for totalPlacedSessionCount, ignoring unplaced sessions', () => {
    const state: StoreState = {
      workspaces: [
        workspace({ id: 'ws1', root: treeFromSessions([1, 2]) }),
        workspace({ id: 'ws2', root: makeLeaf(3) }),
      ],
      activeWorkspaceId: 'ws1',
      // Session 99 exists in the daemon/store but has no pane anywhere
      // (e.g. just closed via closePaneAction) — must not inflate the count.
      sessions: { 1: session(1), 2: session(2), 3: session(3), 99: session(99) },
    };
    expect(totalPlacedSessionCount(state)).toBe(3);
  });

  it('sets waiting only when some row has a known awaiting-input session', () => {
    const running: StoreState = {
      workspaces: [workspace({ id: 'ws1', root: treeFromSessions([1, 2]) })],
      activeWorkspaceId: 'ws1',
      sessions: { 1: session(1, { status: 'running' }), 2: session(2, { status: 'idle' }) },
    };
    expect(buildSidebarGroups(running)[0]?.waiting).toBe(false);

    const waiting: StoreState = {
      workspaces: [workspace({ id: 'ws1', root: treeFromSessions([1, 2]) })],
      activeWorkspaceId: 'ws1',
      sessions: {
        1: session(1, { status: 'running' }),
        2: session(2, { status: 'awaiting-input' }),
      },
    };
    expect(buildSidebarGroups(waiting)[0]?.waiting).toBe(true);

    // A different workspace's awaiting-input session must not light up this
    // one's marker — the mutation that must turn this red is voting across
    // *all* sessions instead of only this group's own rows.
    const otherWorkspaceWaiting: StoreState = {
      workspaces: [
        workspace({ id: 'ws1', root: makeLeaf(1) }),
        workspace({ id: 'ws2', root: makeLeaf(2) }),
      ],
      activeWorkspaceId: 'ws1',
      sessions: {
        1: session(1, { status: 'running' }),
        2: session(2, { status: 'awaiting-input' }),
      },
    };
    const [ws1Group] = buildSidebarGroups(otherWorkspaceWaiting);
    expect(ws1Group?.waiting).toBe(false);
  });

  it('gives an empty group (no rows, count 0) for a workspace with root: null', () => {
    const state: StoreState = {
      workspaces: [workspace({ id: 'empty-ws', root: null, focusedSessionId: undefined })],
      activeWorkspaceId: 'empty-ws',
      sessions: {},
    };
    const [group] = buildSidebarGroups(state);
    expect(group?.rows).toEqual([]);
    expect(group?.sessionCount).toBe(0);
    expect(group?.waiting).toBe(false);
  });

  it('renders a row with session: undefined for a leaf whose session metadata has not arrived yet, without crashing and without counting it as waiting', () => {
    const state: StoreState = {
      workspaces: [workspace({ id: 'ws1', root: treeFromSessions([1, 2]), focusedSessionId: 1 })],
      activeWorkspaceId: 'ws1',
      // Session 2 is placed in the tree but its metadata hasn't landed in
      // `state.sessions` yet (the gap `session-actions.ts`'s
      // `splitPaneWithNewSession` doc comment describes as effectively zero
      // but not assumed to always be).
      sessions: { 1: session(1) },
    };
    const [group] = buildSidebarGroups(state);
    expect(group?.sessionCount).toBe(2);
    const missingRow = group?.rows.find((r) => r.sessionId === 2);
    expect(missingRow?.session).toBeUndefined();
    expect(group?.waiting).toBe(false);
  });
});

describe('activeFocusedTarget', () => {
  it('returns the active workspace id and its focused session', () => {
    const state: StoreState = {
      workspaces: [
        workspace({ id: 'ws1', root: makeLeaf(1), focusedSessionId: 1 }),
        workspace({ id: 'ws2', root: makeLeaf(2), focusedSessionId: 2 }),
      ],
      activeWorkspaceId: 'ws2',
      sessions: { 1: session(1), 2: session(2) },
    };
    expect(activeFocusedTarget(state)).toEqual({ workspaceId: 'ws2', sessionId: 2 });
  });

  it('is undefined when there is no active workspace', () => {
    const state: StoreState = {
      workspaces: [workspace({ id: 'ws1' })],
      activeWorkspaceId: undefined,
      sessions: {},
    };
    expect(activeFocusedTarget(state)).toBeUndefined();
  });

  it('is undefined when the active workspace has no focused pane (root: null)', () => {
    const state: StoreState = {
      workspaces: [workspace({ id: 'ws1', root: null, focusedSessionId: undefined })],
      activeWorkspaceId: 'ws1',
      sessions: {},
    };
    expect(activeFocusedTarget(state)).toBeUndefined();
  });
});
