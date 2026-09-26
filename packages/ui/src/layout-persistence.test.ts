import { describe, expect, it } from 'vitest';
import type { SessionId, SessionSummary } from '@termhub/shared';

import { collectSessionIds, treeLeaves } from './store/tree.js';
import type { StoreState, Workspace } from './store/workspace.js';
import {
  reconcileLayout,
  toPersistedLayout,
  RECOVERED_WORKSPACE_ID,
} from './layout-persistence.js';

function session(overrides: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    name: 'powershell.exe',
    cwd: 'C:\\repo',
    shell: 'powershell.exe',
    createdAt: 1_000 + overrides.id,
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toPersistedLayout
// ---------------------------------------------------------------------------

describe('toPersistedLayout', () => {
  it("projects workspaces in tab order, with root/focus/active-tab and each leaf's sessionCreatedAt", () => {
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1, createdAt: 111 }),
      2: session({ id: 2, createdAt: 222 }),
    };
    const workspace: Workspace = {
      id: 'ws-a',
      name: 'alpha',
      cwd: 'C:\\a',
      root: {
        kind: 'split',
        id: 'n1',
        dir: 'row',
        ratio: 0.35,
        a: { kind: 'leaf', sessionId: 1 },
        b: { kind: 'leaf', sessionId: 2 },
      },
      focusedSessionId: 2,
      maximizedSessionId: 2, // must never be persisted
    };
    const state: StoreState = { workspaces: [workspace], activeWorkspaceId: 'ws-a', sessions };

    expect(toPersistedLayout(state)).toEqual({
      version: 1,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        {
          id: 'ws-a',
          name: 'alpha',
          cwd: 'C:\\a',
          focusedSessionId: 2,
          root: {
            kind: 'split',
            id: 'n1',
            dir: 'row',
            ratio: 0.35,
            a: { kind: 'leaf', sessionId: 1, sessionCreatedAt: 111 },
            b: { kind: 'leaf', sessionId: 2, sessionCreatedAt: 222 },
          },
        },
      ],
    });
  });

  it('omits activeWorkspaceId/focusedSessionId when undefined, and persists root: null as is', () => {
    const workspace: Workspace = {
      id: 'ws-empty',
      name: 'empty',
      cwd: 'C:\\',
      root: null,
      focusedSessionId: undefined,
      maximizedSessionId: undefined,
    };
    const state: StoreState = {
      workspaces: [workspace],
      activeWorkspaceId: undefined,
      sessions: {},
    };

    expect(toPersistedLayout(state)).toEqual({
      version: 1,
      workspaces: [{ id: 'ws-empty', name: 'empty', cwd: 'C:\\', root: null }],
    });
  });
});

// ---------------------------------------------------------------------------
// Round trip (the task's required proof 1)
// ---------------------------------------------------------------------------

describe('round trip: store -> toPersistedLayout -> reconcileLayout -> same workspaces/activeWorkspaceId', () => {
  it('survives 3 workspaces, nested splits with non-0.5 ratios, focus and the active tab', () => {
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1, createdAt: 1_000 }),
      2: session({ id: 2, createdAt: 2_000 }),
      3: session({ id: 3, createdAt: 3_000 }),
      4: session({ id: 4, createdAt: 4_000 }),
    };
    const originalWorkspaces: Workspace[] = [
      {
        id: 'ws-1',
        name: 'one',
        cwd: 'C:\\one',
        root: {
          kind: 'split',
          id: 'n1',
          dir: 'row',
          ratio: 0.27,
          a: { kind: 'leaf', sessionId: 1 },
          b: {
            kind: 'split',
            id: 'n2',
            dir: 'column',
            ratio: 0.73,
            a: { kind: 'leaf', sessionId: 2 },
            b: { kind: 'leaf', sessionId: 3 },
          },
        },
        focusedSessionId: 3,
        maximizedSessionId: undefined,
      },
      {
        id: 'ws-2',
        name: 'two',
        cwd: 'C:\\two',
        root: { kind: 'leaf', sessionId: 4 },
        focusedSessionId: 4,
        maximizedSessionId: 4,
      },
      {
        id: 'ws-3',
        name: 'three',
        cwd: 'C:\\three',
        root: null,
        focusedSessionId: undefined,
        maximizedSessionId: undefined,
      },
    ];
    const originalState: StoreState = {
      workspaces: originalWorkspaces,
      activeWorkspaceId: 'ws-2',
      sessions,
    };

    const file = toPersistedLayout(originalState);

    const liveSessions = Object.values(sessions);
    const outcome = reconcileLayout(file, liveSessions);

    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.needsFreshSessionInWorkspaceId).toBeUndefined();
    expect(outcome.activeWorkspaceId).toBe('ws-2');
    // maximizedSessionId is never restored (never persisted in the first place).
    expect(outcome.workspaces).toEqual(
      originalWorkspaces.map((w) => ({ ...w, maximizedSessionId: undefined })),
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileLayout — one rule per test (the task's required proof 2)
// ---------------------------------------------------------------------------

describe('reconcileLayout', () => {
  it('rule 5: no file at all -> fresh-boot', () => {
    expect(reconcileLayout(undefined, [])).toEqual({ kind: 'fresh-boot' });
  });

  it('rule 5: a file with zero workspaces -> fresh-boot, same as no file (M2.6 boot unmodified)', () => {
    expect(reconcileLayout({ version: 1, workspaces: [] }, [])).toEqual({ kind: 'fresh-boot' });
  });

  it("rule 1: a dead leaf collapses its parent, preserving the surviving sibling split's id and ratio", () => {
    const live = [session({ id: 2, createdAt: 200 })];
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: {
            kind: 'split' as const,
            id: 'outer',
            dir: 'row' as const,
            ratio: 0.4,
            a: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 }, // dead: no live session 1
            b: {
              kind: 'split' as const,
              id: 'inner',
              dir: 'column' as const,
              ratio: 0.65,
              a: { kind: 'leaf' as const, sessionId: 2, sessionCreatedAt: 200 },
              b: { kind: 'leaf' as const, sessionId: 3, sessionCreatedAt: 300 }, // dead: no live session 3
            },
          },
          focusedSessionId: 1,
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    const [workspace] = outcome.workspaces;
    expect(workspace?.root).toEqual({ kind: 'leaf', sessionId: 2 });
    // The neighboring "inner" split's own id/ratio never leaked into the
    // final result because *both* its former children died except one,
    // and outer's own dead child (1) collapsed straight onto whatever
    // "inner" collapsed down to (armadilha 2, M3.1 — via tree.ts's closePane).
    expect(workspace?.focusedSessionId).toBe(2); // rule 3: focus vanished, first surviving leaf takes over
  });

  it('rule 1: id collision — same sessionId, different createdAt does not match, and is treated as dead', () => {
    // A session "3" from *this* daemon lifetime, unrelated to the persisted one.
    const live = [session({ id: 3, createdAt: 999_999 })];
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 3, sessionCreatedAt: 300 },
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    // The persisted leaf didn't survive (createdAt mismatch) -> workspace collapses to null...
    expect(outcome.workspaces[0]?.root).toBeNull();
    // ...and the live session 3 is an orphan (rule 4), not silently reattached
    // to the stale leaf.
    const recovered = outcome.workspaces.find((w) => w.id === RECOVERED_WORKSPACE_ID);
    expect(recovered).toBeDefined();
    expect(collectSessionIds(recovered?.root ?? null)).toEqual(new Set([3]));
  });

  it('rule 2: a workspace whose whole tree dies stays in the list, with root: null, name and cwd intact', () => {
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'kept',
          cwd: 'C:\\kept',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 },
        },
      ],
    };

    const outcome = reconcileLayout(file, []); // no live sessions -> rule 6 also applies, checked separately below
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.workspaces).toEqual([
      {
        id: 'ws-a',
        name: 'kept',
        cwd: 'C:\\kept',
        root: null,
        focusedSessionId: undefined,
        maximizedSessionId: undefined,
      },
    ]);
  });

  it('rule 3: focusedSessionId and activeWorkspaceId that vanished fall back to the first surviving leaf / first workspace', () => {
    const live = [session({ id: 2, createdAt: 200 })];
    const file = {
      version: 1 as const,
      activeWorkspaceId: 'gone', // not a workspace in this file at all
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: {
            kind: 'split' as const,
            id: 'n1',
            dir: 'row' as const,
            ratio: 0.5,
            a: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 }, // dead
            b: { kind: 'leaf' as const, sessionId: 2, sessionCreatedAt: 200 },
          },
          focusedSessionId: 1, // dead leaf
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.activeWorkspaceId).toBe('ws-a');
    expect(outcome.workspaces[0]?.focusedSessionId).toBe(2);
  });

  it('rule 4: a live session placed in no workspace becomes an orphan in a "Recuperadas" workspace, created only when orphans exist', () => {
    const live = [
      session({ id: 1, createdAt: 100 }),
      session({ id: 42, createdAt: 4_200, cwd: 'C:\\orphan' }),
    ];
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 },
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.workspaces).toHaveLength(2);
    const recovered = outcome.workspaces[1];
    expect(recovered?.id).toBe(RECOVERED_WORKSPACE_ID);
    expect(recovered?.name).toBe('Recuperadas');
    expect(recovered?.cwd).toBe('C:\\orphan');
    expect(treeLeaves(recovered?.root ?? null).map((l) => l.sessionId)).toEqual([42]);
  });

  it('rule 4: no orphans at all -> no "Recuperadas" workspace is created', () => {
    const live = [session({ id: 1, createdAt: 100 })];
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 },
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.workspaces.map((w) => w.id)).toEqual(['ws-a']);
  });

  it('rule 6: the daemon restarted (no live session anywhere) -> workspaces are kept and the active one is flagged for a fresh session', () => {
    const file = {
      version: 1 as const,
      activeWorkspaceId: 'ws-b',
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 },
        },
        {
          id: 'ws-b',
          name: 'b',
          cwd: 'C:\\b',
          root: { kind: 'leaf' as const, sessionId: 2, sessionCreatedAt: 200 },
        },
      ],
    };

    const outcome = reconcileLayout(file, []);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.workspaces.map((w) => ({ id: w.id, root: w.root }))).toEqual([
      { id: 'ws-a', root: null },
      { id: 'ws-b', root: null },
    ]);
    expect(outcome.activeWorkspaceId).toBe('ws-b');
    expect(outcome.needsFreshSessionInWorkspaceId).toBe('ws-b');
  });

  it('rule 6 does not apply when at least one live session exists anywhere, even if unplaced (that is rule 4 instead)', () => {
    const live = [session({ id: 99, createdAt: 9_900 })];
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 },
        },
      ],
    };

    const outcome = reconcileLayout(file, live);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.needsFreshSessionInWorkspaceId).toBeUndefined();
  });
});
