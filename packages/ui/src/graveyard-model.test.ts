import { describe, expect, it } from 'vitest';
import type { GraveyardEntry, SessionSummary } from '@termhub/shared';

import {
  buildGraveyardRows,
  collectSessionLocations,
  formatAliveRemaining,
  formatClosedAgo,
  mostRecentlyClosedSessionId,
  resolveRestoreWorkspaceId,
  resolveSplitTarget,
  sessionsJustUnplaced,
  sortGraveyardEntries,
  type SessionOrigin,
} from './graveyard-model.js';
import { makeLeaf, splitPane, treeFromSessions } from './store/tree.js';
import type { StoreState, Workspace } from './store/workspace.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'claude',
    tag: 'main',
    cwd: 'C:\\projects\\termhub',
    shell: 'powershell.exe',
    createdAt: 0,
    cols: 80,
    rows: 24,
    status: 'idle',
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'termhub',
    cwd: 'C:\\projects\\termhub',
    root: makeLeaf(1),
    focusedSessionId: 1,
    maximizedSessionId: undefined,
    ...overrides,
  };
}

function state(overrides: Partial<StoreState> = {}): StoreState {
  return { workspaces: [workspace()], activeWorkspaceId: 'ws1', sessions: {}, ...overrides };
}

function entry(
  overrides: Partial<GraveyardEntry> & { session?: Partial<SessionSummary> } = {},
): GraveyardEntry {
  const { session: sessionOverrides, ...rest } = overrides;
  return {
    session: session(sessionOverrides),
    closedAt: 1_000_000,
    expiresAt: 1_000_000 + 600_000,
    ...rest,
  };
}

describe('sortGraveyardEntries', () => {
  it('sorts newest-closed-first, regardless of input order', () => {
    const oldest = entry({ session: session({ id: 1 }), closedAt: 100 });
    const newest = entry({ session: session({ id: 2 }), closedAt: 300 });
    const middle = entry({ session: session({ id: 3 }), closedAt: 200 });
    expect(sortGraveyardEntries([oldest, newest, middle]).map((e) => e.session.id)).toEqual([
      2, 3, 1,
    ]);
  });

  it('does not mutate its input', () => {
    const list = [
      entry({ session: session({ id: 1 }), closedAt: 1 }),
      entry({ session: session({ id: 2 }), closedAt: 2 }),
    ];
    const copy = [...list];
    sortGraveyardEntries(list);
    expect(list).toEqual(copy);
  });
});

describe('mostRecentlyClosedSessionId', () => {
  it('picks the most recent entry by closedAt — the exact target of Ctrl+Shift+T', () => {
    const entries = [
      entry({ session: session({ id: 1 }), closedAt: 500 }),
      entry({ session: session({ id: 2 }), closedAt: 1500 }),
      entry({ session: session({ id: 3 }), closedAt: 900 }),
    ];
    expect(mostRecentlyClosedSessionId(entries)).toBe(2);
  });

  it('is undefined when nothing is buried', () => {
    expect(mostRecentlyClosedSessionId([])).toBeUndefined();
  });

  // Mutation this test was verified to catch (M4.5's prompt, section 3):
  // swapping `b.closedAt - a.closedAt` for `a.closedAt - b.closedAt` in
  // `sortGraveyardEntries` turned this test red — it picked session 1
  // (closedAt 500, the *oldest*) instead of 2 (closedAt 1500, the newest).
  // See this task's final report for the captured output.
});

describe('formatAliveRemaining', () => {
  it('matches the prototype wording — "vivo N min"', () => {
    expect(formatAliveRemaining(1_000_000 + 8 * 60_000, 1_000_000)).toBe('vivo 8 min');
  });

  it('rounds up: 7 min 30 s left still reads as 8 min remaining', () => {
    expect(formatAliveRemaining(1_000_000 + 7 * 60_000 + 30_000, 1_000_000)).toBe('vivo 8 min');
  });

  it('floors at 1 min, never "vivo 0 min"', () => {
    expect(formatAliveRemaining(1_000_000 + 10_000, 1_000_000)).toBe('vivo 1 min');
    expect(formatAliveRemaining(1_000_000 - 5_000, 1_000_000)).toBe('vivo 1 min');
  });
});

describe('formatClosedAgo', () => {
  it('matches the prototype wording for minutes and hours', () => {
    expect(formatClosedAgo(1_000_000 - 2 * 60_000, 1_000_000)).toBe('há 2 min');
    expect(formatClosedAgo(1_000_000 - 14 * 60_000, 1_000_000)).toBe('há 14 min');
    expect(formatClosedAgo(1_000_000 - 65 * 60_000, 1_000_000)).toBe('há 1 h');
  });

  it('reads as "agora" for anything under a minute', () => {
    expect(formatClosedAgo(1_000_000, 1_000_000)).toBe('agora');
    expect(formatClosedAgo(1_000_000 - 30_000, 1_000_000)).toBe('agora');
  });
});

describe('collectSessionLocations', () => {
  it('maps every placed session id to its workspace id/name', () => {
    const two = workspace({
      id: 'ws2',
      name: 'api-gateway',
      root: treeFromSessions([10, 11], 'boot2'),
      focusedSessionId: 10,
    });
    const s = state({ workspaces: [workspace(), two] });
    const locations = collectSessionLocations(s);
    expect(locations.get(1)).toEqual({ workspaceId: 'ws1', workspaceName: 'termhub' });
    expect(locations.get(10)).toEqual({ workspaceId: 'ws2', workspaceName: 'api-gateway' });
    expect(locations.get(11)).toEqual({ workspaceId: 'ws2', workspaceName: 'api-gateway' });
  });

  it('reports nothing for a workspace with no panes (root: null)', () => {
    const s = state({ workspaces: [workspace({ root: null, focusedSessionId: undefined })] });
    expect(collectSessionLocations(s).size).toBe(0);
  });
});

describe('sessionsJustUnplaced', () => {
  it('reports a session present before and absent after, with its prior origin', () => {
    const prev = new Map<number, SessionOrigin>([
      [1, { workspaceId: 'ws1', workspaceName: 'termhub' }],
      [2, { workspaceId: 'ws1', workspaceName: 'termhub' }],
    ]);
    const next = new Map<number, SessionOrigin>([
      [2, { workspaceId: 'ws1', workspaceName: 'termhub' }],
    ]);
    expect(sessionsJustUnplaced(prev, next)).toEqual([
      { sessionId: 1, origin: { workspaceId: 'ws1', workspaceName: 'termhub' } },
    ]);
  });

  it('reports every session of a whole tab closing at once', () => {
    const prev = new Map<number, SessionOrigin>([
      [10, { workspaceId: 'ws2', workspaceName: 'api-gateway' }],
      [11, { workspaceId: 'ws2', workspaceName: 'api-gateway' }],
    ]);
    const next = new Map<number, SessionOrigin>();
    const result = sessionsJustUnplaced(prev, next)
      .map((r) => r.sessionId)
      .sort();
    expect(result).toEqual([10, 11]);
  });

  it('reports nothing when nothing left (a split, or a move within the same workspace)', () => {
    const prev = new Map<number, SessionOrigin>([
      [1, { workspaceId: 'ws1', workspaceName: 'termhub' }],
    ]);
    const next = new Map<number, SessionOrigin>([
      [1, { workspaceId: 'ws1', workspaceName: 'termhub' }],
      [2, { workspaceId: 'ws1', workspaceName: 'termhub' }],
    ]);
    expect(sessionsJustUnplaced(prev, next)).toEqual([]);
  });
});

describe('buildGraveyardRows', () => {
  it('marks an exited session as not alive and formats elapsed time, not remaining', () => {
    const e = entry({
      session: session({ id: 5, status: 'exited', exitCode: 0 }),
      closedAt: 1_000_000 - 3 * 60_000,
      expiresAt: 1_000_000 + 400_000,
    });
    const [row] = buildGraveyardRows([e], new Map(), 1_000_000);
    expect(row?.alive).toBe(false);
    expect(row?.timeText).toBe('há 3 min');
  });

  it('marks a still-running (or idle/awaiting) session as alive and shows the countdown', () => {
    const e = entry({
      session: session({ id: 6, status: 'idle' }),
      expiresAt: 1_000_000 + 5 * 60_000,
    });
    const [row] = buildGraveyardRows([e], new Map(), 1_000_000);
    expect(row?.alive).toBe(true);
    expect(row?.timeText).toBe('vivo 5 min');
  });

  it('carries the workspace label when the origin is known, omits it otherwise', () => {
    const e = entry({ session: session({ id: 7 }) });
    const origins = new Map<number, SessionOrigin>([
      [7, { workspaceId: 'ws1', workspaceName: 'termhub' }],
    ]);
    const [withOrigin] = buildGraveyardRows([e], origins, 1_000_000);
    expect(withOrigin?.workspaceLabel).toBe('termhub');
    const [withoutOrigin] = buildGraveyardRows([e], new Map(), 1_000_000);
    expect(withoutOrigin?.workspaceLabel).toBeUndefined();
  });
});

describe('resolveRestoreWorkspaceId', () => {
  it('goes back to the origin workspace when it still exists', () => {
    const s = state({
      workspaces: [workspace({ id: 'ws1' }), workspace({ id: 'ws2', name: 'other' })],
    });
    const origin: SessionOrigin = { workspaceId: 'ws2', workspaceName: 'other' };
    expect(resolveRestoreWorkspaceId(s, origin)).toBe('ws2');
  });

  it('falls back to the active workspace when the origin is unknown (armadilha: window reopened)', () => {
    const s = state({ activeWorkspaceId: 'ws1' });
    expect(resolveRestoreWorkspaceId(s, undefined)).toBe('ws1');
  });

  it('falls back to the active workspace when the origin workspace no longer exists', () => {
    const s = state({ activeWorkspaceId: 'ws1' });
    const origin: SessionOrigin = { workspaceId: 'gone', workspaceName: 'gone' };
    expect(resolveRestoreWorkspaceId(s, origin)).toBe('ws1');
  });

  it('falls back to the first workspace when somehow there is no active one', () => {
    const s = state({ activeWorkspaceId: undefined });
    expect(resolveRestoreWorkspaceId(s, undefined)).toBe('ws1');
  });

  it('is undefined when the store has no workspace at all', () => {
    const s = state({ workspaces: [], activeWorkspaceId: undefined });
    expect(resolveRestoreWorkspaceId(s, undefined)).toBeUndefined();
  });
});

describe('resolveSplitTarget', () => {
  it('splits into the focused pane when it is still a current leaf', () => {
    const root = treeFromSessions([1, 2, 3], 'b');
    expect(resolveSplitTarget(root, 2)).toBe(2);
  });

  it('falls back to the first leaf when the focused pane no longer exists', () => {
    const root = treeFromSessions([1, 2, 3], 'b');
    expect(resolveSplitTarget(root, 999)).toBe(1);
  });

  it('falls back to the first leaf when nothing is focused', () => {
    const root = treeFromSessions([5, 6], 'b');
    expect(resolveSplitTarget(root, undefined)).toBe(5);
  });

  it('reflects a real split tree the same way `splitPane` would build one', () => {
    const outcome = splitPane(makeLeaf(1), 1, 2, 'row', 'n1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(resolveSplitTarget(outcome.root, 1)).toBe(1);
    }
  });
});
