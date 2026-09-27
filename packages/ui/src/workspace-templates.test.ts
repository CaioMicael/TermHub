import { describe, expect, it } from 'vitest';
import type { SessionId, SessionSummary } from '@termhub/shared';

import { collectSessionIds, treeLeaves, type PaneNode } from './store/tree.js';
import {
  buildAutoGridTree,
  nextTemplateId,
  nextTemplateName,
  templateFromWorkspace,
} from './workspace-templates.js';

function session(overrides: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    name: 'agent',
    cwd: 'C:\\repo',
    shell: 'pwsh.exe',
    createdAt: 1_000,
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAutoGridTree — the task's required proof 3
// ---------------------------------------------------------------------------

describe('buildAutoGridTree', () => {
  it('1 session: alone, no split at all', () => {
    expect(buildAutoGridTree([1])).toEqual({ kind: 'leaf', sessionId: 1 });
  });

  it('2 sessions: side by side (a row split)', () => {
    const root = buildAutoGridTree([1, 2]);
    expect(root).toEqual({
      kind: 'split',
      id: 'grid-1',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 1 },
      b: { kind: 'leaf', sessionId: 2 },
    });
  });

  it('3 sessions: one alone on the left, two stacked on the right', () => {
    const root = buildAutoGridTree([1, 2, 3]);
    expect(root).toEqual({
      kind: 'split',
      id: 'grid-1',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 1 },
      b: {
        kind: 'split',
        id: 'grid-2',
        dir: 'column',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 2 },
        b: { kind: 'leaf', sessionId: 3 },
      },
    });
  });

  it('4 sessions: a 2x2 grid', () => {
    const root = buildAutoGridTree([1, 2, 3, 4]);
    expect(root).toEqual({
      kind: 'split',
      id: 'grid-3',
      dir: 'column',
      ratio: 0.5,
      a: {
        kind: 'split',
        id: 'grid-1',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 1 },
        b: { kind: 'leaf', sessionId: 2 },
      },
      b: {
        kind: 'split',
        id: 'grid-2',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 3 },
        b: { kind: 'leaf', sessionId: 4 },
      },
    });
  });

  it('6 sessions: balanced rows — 3 rows of 2, stacked evenly', () => {
    const root = buildAutoGridTree([1, 2, 3, 4, 5, 6]);
    // rows = ceil(sqrt(6)) = 3, perRow = ceil(6/3) = 2 -> [1,2] [3,4] [5,6].
    expect(root).toEqual({
      kind: 'split',
      id: 'grid-4',
      dir: 'column',
      ratio: 0.5,
      a: {
        kind: 'split',
        id: 'grid-5',
        dir: 'column',
        ratio: 0.5,
        a: {
          kind: 'split',
          id: 'grid-1',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: 1 },
          b: { kind: 'leaf', sessionId: 2 },
        },
        b: {
          kind: 'split',
          id: 'grid-2',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: 3 },
          b: { kind: 'leaf', sessionId: 4 },
        },
      },
      b: {
        kind: 'split',
        id: 'grid-3',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 5 },
        b: { kind: 'leaf', sessionId: 6 },
      },
    });

    // Structural invariants that hold regardless of the exact nesting above
    // (belt and suspenders against a mutation that keeps the leaf set right
    // but reshuffles internal node ids): every session placed exactly once,
    // in the same left-to-right order given, and every split is either
    // 'row' (2 leaves side by side) or part of the 'column' stacking.
    expect(collectSessionIds(root)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(treeLeaves(root).map((l) => l.sessionId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('every leaf appears exactly once, in the given order, for 1 through 8 sessions', () => {
    for (let n = 1; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const root = buildAutoGridTree(ids);
      expect(treeLeaves(root).map((l) => l.sessionId)).toEqual(ids);
    }
  });

  it('empty input yields null', () => {
    expect(buildAutoGridTree([])).toBeNull();
  });

  it('two calls with different prefixes never collide on split node ids', () => {
    const a = buildAutoGridTree([1, 2, 3], 'ws-a');
    const b = buildAutoGridTree([4, 5, 6], 'ws-b');
    const idsOf = (node: PaneNode | null, into: string[] = []): string[] => {
      if (node === null) return into;
      if (node.kind === 'split') {
        into.push(node.id);
        idsOf(node.a, into);
        idsOf(node.b, into);
      }
      return into;
    };
    const allIds = [...idsOf(a), ...idsOf(b)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

// ---------------------------------------------------------------------------
// templateFromWorkspace — the task's required proof 3 ("modelo a partir de
// um workspace")
// ---------------------------------------------------------------------------

describe('templateFromWorkspace', () => {
  it('builds one template session per leaf, in tree order, with name/cwd/shell/args/command from its own SessionSummary', () => {
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1, name: 'claude', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' }),
      2: session({ id: 2, name: 'pwsh', shell: 'pwsh.exe', args: ['-NoLogo'] }),
    };
    const workspace = {
      root: {
        kind: 'split' as const,
        id: 'n1',
        dir: 'row' as const,
        ratio: 0.5,
        a: { kind: 'leaf' as const, sessionId: 1 },
        b: { kind: 'leaf' as const, sessionId: 2 },
      },
    };

    const template = templateFromWorkspace(workspace, sessions, 'tpl-1', '3 agentes');

    expect(template).toEqual({
      id: 'tpl-1',
      name: '3 agentes',
      sessions: [
        { name: 'claude', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' },
        { name: 'pwsh', cwd: 'C:\\repo', shell: 'pwsh.exe', args: ['-NoLogo'] },
      ],
    });
  });

  it('skips a leaf whose session metadata is unknown, instead of guessing at it', () => {
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1 }),
    };
    const workspace = {
      root: {
        kind: 'split' as const,
        id: 'n1',
        dir: 'row' as const,
        ratio: 0.5,
        a: { kind: 'leaf' as const, sessionId: 1 },
        b: { kind: 'leaf' as const, sessionId: 999 }, // unknown
      },
    };

    const template = templateFromWorkspace(workspace, sessions, 'tpl-1', 'x');

    expect(template.sessions).toHaveLength(1);
    expect(template.sessions[0]?.name).toBe('agent');
  });

  it('an empty workspace (root: null) yields a template with zero sessions', () => {
    const template = templateFromWorkspace({ root: null }, {}, 'tpl-1', 'x');
    expect(template.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nextTemplateId / nextTemplateName
// ---------------------------------------------------------------------------

describe('nextTemplateId', () => {
  it('picks tpl-1 when nothing exists yet, and skips past collisions', () => {
    expect(nextTemplateId([])).toBe('tpl-1');
    expect(nextTemplateId(['tpl-1'])).not.toBe('tpl-1');
    expect(nextTemplateId(['tpl-1', 'tpl-2'])).not.toMatch(/^(tpl-1|tpl-2)$/);
  });
});

describe('nextTemplateName', () => {
  it('returns the base name when it does not collide, else appends a counter', () => {
    expect(nextTemplateName('3 agentes', [])).toBe('3 agentes');
    expect(nextTemplateName('3 agentes', ['3 agentes'])).toBe('3 agentes 2');
    expect(nextTemplateName('3 agentes', ['3 agentes', '3 agentes 2'])).toBe('3 agentes 3');
  });
});
