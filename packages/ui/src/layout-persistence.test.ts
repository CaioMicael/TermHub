import { describe, expect, it } from 'vitest';
import type { SessionId, SessionSummary } from '@termhub/shared';

import { collectSessionIds, treeLeaves } from './store/tree.js';
import type { StoreState, Workspace } from './store/workspace.js';
import {
  applyRelaunchedSession,
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
            // M4.7: every leaf whose session metadata is known also gets a
            // `launch` spec, built from that same metadata.
            a: {
              kind: 'leaf',
              sessionId: 1,
              sessionCreatedAt: 111,
              launch: { name: 'powershell.exe', cwd: 'C:\\repo', shell: 'powershell.exe' },
            },
            b: {
              kind: 'leaf',
              sessionId: 2,
              sessionCreatedAt: 222,
              launch: { name: 'powershell.exe', cwd: 'C:\\repo', shell: 'powershell.exe' },
            },
          },
        },
      ],
    });
  });

  it("(M4.7) a leaf's launch spec carries args/command when the session has them, and templates ride along in the same file, omitted when empty", () => {
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1, shell: 'pwsh.exe', args: ['-NoLogo'], command: 'claude' }),
    };
    const workspace: Workspace = {
      id: 'ws-a',
      name: 'alpha',
      cwd: 'C:\\a',
      root: { kind: 'leaf', sessionId: 1 },
      focusedSessionId: 1,
      maximizedSessionId: undefined,
    };
    const state: StoreState = { workspaces: [workspace], activeWorkspaceId: 'ws-a', sessions };

    const withoutTemplates = toPersistedLayout(state);
    expect(withoutTemplates.templates).toBeUndefined();
    expect(withoutTemplates.workspaces[0]?.root).toEqual({
      kind: 'leaf',
      sessionId: 1,
      sessionCreatedAt: sessions[1]?.createdAt,
      // `cwd`/`name` come from the *session's own* metadata, not the
      // workspace's `cwd` — a session can be spawned into a different
      // directory than the workspace it currently sits in.
      launch: {
        name: 'powershell.exe',
        cwd: 'C:\\repo',
        shell: 'pwsh.exe',
        args: ['-NoLogo'],
        command: 'claude',
      },
    });

    const template = { id: 'tpl-1', name: '3 agentes', sessions: [] };
    expect(toPersistedLayout(state, [template]).templates).toEqual([template]);
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

// ---------------------------------------------------------------------------
// M4.7: rule 6.5 — a dead leaf with a `launch` spec is relaunched in place,
// not dropped — and `applyRelaunchedSession`, the other half of the
// contract `session-boot.ts`/`daemon-resync.ts` use to swap the new session
// into the exact same spot.
// ---------------------------------------------------------------------------

describe('reconcileLayout — rule 6.5 (M4.7): relaunchable dead leaves', () => {
  const launchOf = (name: string): { name: string; cwd: string; shell: string } => ({
    name,
    cwd: 'C:\\agents',
    shell: 'pwsh.exe',
  });

  it('a dead leaf with launch stays in the tree (same split id/ratio) and is reported in toRelaunch, instead of being removed', () => {
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
            a: {
              kind: 'leaf' as const,
              sessionId: 1,
              sessionCreatedAt: 100,
              launch: launchOf('agent-1'),
            },
            b: { kind: 'leaf' as const, sessionId: 2, sessionCreatedAt: 200 }, // dead, no launch
          },
          focusedSessionId: 1,
        },
      ],
    };

    const outcome = reconcileLayout(file, []); // nothing survived
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    // The relaunchable leaf rose to take the whole tree (armadilha 2, same
    // as an ordinary dead sibling) but is still THERE, under its old id —
    // not collapsed away like the launch-less one was.
    expect(outcome.workspaces[0]?.root).toEqual({ kind: 'leaf', sessionId: 1 });
    expect(outcome.toRelaunch).toEqual([
      { workspaceId: 'ws-a', sessionId: 1, launch: launchOf('agent-1') },
    ]);
    // Rule 6 does NOT fire — there is something to relaunch.
    expect(outcome.needsFreshSessionInWorkspaceId).toBeUndefined();
  });

  it('two relaunchable leaves under the same split both survive and are both reported, preserving the split node id/ratio', () => {
    const file = {
      version: 1 as const,
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: {
            kind: 'split' as const,
            id: 'n1',
            dir: 'column' as const,
            ratio: 0.62,
            a: {
              kind: 'leaf' as const,
              sessionId: 1,
              sessionCreatedAt: 100,
              launch: launchOf('agent-1'),
            },
            b: {
              kind: 'leaf' as const,
              sessionId: 2,
              sessionCreatedAt: 200,
              launch: launchOf('agent-2'),
            },
          },
        },
      ],
    };

    const outcome = reconcileLayout(file, []);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    // Untouched: neither leaf was ever handed to closePane, so the split
    // node's own id/ratio survive verbatim (just stripped of the
    // persisted-only sessionCreatedAt/launch fields, same as any live node).
    expect(outcome.workspaces[0]?.root).toEqual({
      kind: 'split',
      id: 'n1',
      dir: 'column',
      ratio: 0.62,
      a: { kind: 'leaf', sessionId: 1 },
      b: { kind: 'leaf', sessionId: 2 },
    });
    expect(outcome.toRelaunch).toEqual([
      { workspaceId: 'ws-a', sessionId: 1, launch: launchOf('agent-1') },
      { workspaceId: 'ws-a', sessionId: 2, launch: launchOf('agent-2') },
    ]);
  });

  it('rule 6 does not fire when nothing survived but something is relaunchable, across two workspaces', () => {
    const file = {
      version: 1 as const,
      activeWorkspaceId: 'ws-b',
      workspaces: [
        {
          id: 'ws-a',
          name: 'a',
          cwd: 'C:\\a',
          root: { kind: 'leaf' as const, sessionId: 1, sessionCreatedAt: 100 }, // no launch: dropped
        },
        {
          id: 'ws-b',
          name: 'b',
          cwd: 'C:\\b',
          root: {
            kind: 'leaf' as const,
            sessionId: 2,
            sessionCreatedAt: 200,
            launch: launchOf('agent'),
          },
        },
      ],
    };

    const outcome = reconcileLayout(file, []);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.workspaces.map((w) => ({ id: w.id, root: w.root }))).toEqual([
      { id: 'ws-a', root: null }, // launch-less dead leaf: gone, as rule 1 always did
      { id: 'ws-b', root: { kind: 'leaf', sessionId: 2 } }, // relaunchable: kept in place
    ]);
    expect(outcome.needsFreshSessionInWorkspaceId).toBeUndefined();
    expect(outcome.toRelaunch).toEqual([
      { workspaceId: 'ws-b', sessionId: 2, launch: launchOf('agent') },
    ]);
  });

  it('rule 6 still fires when nothing survived and nothing is relaunchable either (no launch anywhere)', () => {
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

    const outcome = reconcileLayout(file, []);
    if (outcome.kind !== 'restored') {
      throw new Error('expected restored');
    }
    expect(outcome.toRelaunch).toEqual([]);
    expect(outcome.needsFreshSessionInWorkspaceId).toBe('ws-a');
  });
});

describe('applyRelaunchedSession (M4.7)', () => {
  function relaunchedSession(
    overrides: Partial<SessionSummary> & { id: SessionId },
  ): SessionSummary {
    return session(overrides);
  }

  it('swaps the placeholder leaf for the new session, in the exact same spot, and moves focus along', () => {
    const workspaces: Workspace[] = [
      {
        id: 'ws-a',
        name: 'a',
        cwd: 'C:\\a',
        root: {
          kind: 'split',
          id: 'n1',
          dir: 'row',
          ratio: 0.42,
          a: { kind: 'leaf', sessionId: 1 }, // the dead placeholder
          b: { kind: 'leaf', sessionId: 99 },
        },
        focusedSessionId: 1,
        maximizedSessionId: undefined,
      },
    ];
    const newSession = relaunchedSession({ id: 500, createdAt: 5_000 });

    const next = applyRelaunchedSession(workspaces, 'ws-a', 1, newSession);

    expect(next[0]?.root).toEqual({
      kind: 'split',
      id: 'n1', // same split node id
      dir: 'row',
      ratio: 0.42, // same ratio
      a: { kind: 'leaf', sessionId: 500 }, // swapped
      b: { kind: 'leaf', sessionId: 99 }, // untouched
    });
    expect(next[0]?.focusedSessionId).toBe(500); // focus followed the swap
  });

  it('leaves focusedSessionId alone when it pointed somewhere else', () => {
    const workspaces: Workspace[] = [
      {
        id: 'ws-a',
        name: 'a',
        cwd: 'C:\\a',
        root: {
          kind: 'split',
          id: 'n1',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: 1 },
          b: { kind: 'leaf', sessionId: 99 },
        },
        focusedSessionId: 99,
        maximizedSessionId: undefined,
      },
    ];

    const next = applyRelaunchedSession(workspaces, 'ws-a', 1, relaunchedSession({ id: 500 }));

    expect(next[0]?.focusedSessionId).toBe(99);
  });

  it('is a no-op (same array reference) for an unknown workspace id or a leaf that is not there', () => {
    const workspaces: Workspace[] = [
      {
        id: 'ws-a',
        name: 'a',
        cwd: 'C:\\a',
        root: { kind: 'leaf', sessionId: 1 },
        focusedSessionId: 1,
        maximizedSessionId: undefined,
      },
    ];

    expect(applyRelaunchedSession(workspaces, 'nope', 1, relaunchedSession({ id: 500 }))).toBe(
      workspaces,
    );
    expect(applyRelaunchedSession(workspaces, 'ws-a', 999, relaunchedSession({ id: 500 }))).toBe(
      workspaces,
    );
  });
});
