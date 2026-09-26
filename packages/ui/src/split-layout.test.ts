import { describe, expect, it } from 'vitest';

import {
  buildPaneLayout,
  collectLayoutLeafKeys,
  paneLeafKey,
  ratioToSizes,
  sizesToRatio,
  splitChildPanelIds,
  splitGroupKey,
  type PaneLayout,
} from './split-layout.js';
import { closePane, movePane, type PaneNode } from './store/tree.js';

// A balanced 2x2 tree, same shape `treeFromSessions([1, 2, 3, 4])` produces:
// a row split of two column splits.
function grid2x2(): PaneNode {
  return {
    kind: 'split',
    id: 'root',
    dir: 'row',
    ratio: 0.5,
    a: {
      kind: 'split',
      id: 'left',
      dir: 'column',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 1 },
      b: { kind: 'leaf', sessionId: 2 },
    },
    b: {
      kind: 'split',
      id: 'right',
      dir: 'column',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 3 },
      b: { kind: 'leaf', sessionId: 4 },
    },
  };
}

describe('ratioToSizes / sizesToRatio', () => {
  it('splits 100 between the two panels proportionally to ratio', () => {
    expect(ratioToSizes(0.5)).toEqual([50, 50]);
    expect(ratioToSizes(0.25)).toEqual([25, 75]);
  });

  it('always sums to exactly 100, regardless of floating point ratio', () => {
    const [a, b] = ratioToSizes(0.333);
    expect(a + b).toBe(100);
  });

  it('is the exact inverse of sizesToRatio for round values', () => {
    for (const ratio of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const [a, b] = ratioToSizes(ratio);
      expect(sizesToRatio(a, b)).toBeCloseTo(ratio, 10);
    }
  });

  it('falls back to 0.5 when both sizes are non-positive (e.g. transient 0/0)', () => {
    expect(sizesToRatio(0, 0)).toBe(0.5);
    expect(sizesToRatio(Number.NaN, 10)).toBe(0.5);
  });
});

describe('buildPaneLayout', () => {
  it('returns null for an empty workspace', () => {
    expect(buildPaneLayout(null)).toBeNull();
  });

  it('keys a single leaf by its sessionId', () => {
    const layout = buildPaneLayout({ kind: 'leaf', sessionId: 7 });
    expect(layout).toEqual({ kind: 'leaf', key: paneLeafKey(7), sessionId: 7 });
  });

  it('builds a split node with stable keys, panel ids and sizes derived from ratio', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'n1',
      dir: 'row',
      ratio: 0.25,
      a: { kind: 'leaf', sessionId: 1 },
      b: { kind: 'leaf', sessionId: 2 },
    };
    const layout = buildPaneLayout(root) as Extract<PaneLayout, { kind: 'split' }>;
    expect(layout.kind).toBe('split');
    expect(layout.key).toBe(splitGroupKey('n1'));
    expect(layout.nodeId).toBe('n1');
    expect(layout.dir).toBe('row');
    expect(layout.sizes).toEqual([25, 75]);
    expect(layout.panelIds).toEqual(splitChildPanelIds('n1'));
    expect(layout.a).toEqual({ kind: 'leaf', key: paneLeafKey(1), sessionId: 1 });
    expect(layout.b).toEqual({ kind: 'leaf', key: paneLeafKey(2), sessionId: 2 });
  });

  it('produces every leaf key, in left-to-right order, for a 2x2 grid', () => {
    const layout = buildPaneLayout(grid2x2());
    expect(collectLayoutLeafKeys(layout)).toEqual([
      paneLeafKey(1),
      paneLeafKey(2),
      paneLeafKey(3),
      paneLeafKey(4),
    ]);
  });
});

// Armadilha 2 (this task's prompt): a leaf's key must be derived from its
// sessionId, never from its position in the tree/leaf list. These tests
// build a layout before and after a tree edit on an *unrelated* branch and
// assert the untouched leaves keep the exact same key — a positional-index
// implementation would still pass the "same set of keys" check but would
// assign a *different* leaf to a given index after the edit, which is
// exactly the silent-remount bug this guards against. See this task's final
// report for the run where `paneLeafKey` was swapped for an index-based
// stand-in and this suite caught it.
describe('leaf key stability across tree edits (armadilha 2)', () => {
  it('keeps every untouched leaf key the same after closePane on another branch', () => {
    const root = grid2x2();
    const before = buildPaneLayout(root);
    const beforeKeys = collectLayoutLeafKeys(before);

    const outcome = closePane(root, 4); // closes the last leaf, in the "right" branch
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const after = buildPaneLayout(outcome.root);
    const afterKeys = collectLayoutLeafKeys(after);

    // Leaves 1 and 2 (the untouched "left" branch) keep the exact same key.
    expect(afterKeys).toContain(paneLeafKey(1));
    expect(afterKeys).toContain(paneLeafKey(2));
    expect(beforeKeys.filter((k) => k === paneLeafKey(1) || k === paneLeafKey(2))).toEqual(
      afterKeys.filter((k) => k === paneLeafKey(1) || k === paneLeafKey(2)),
    );
    // Leaf 3 rose to replace the "right" split node entirely — it's still
    // keyed by its own sessionId, unaffected by its new depth in the tree.
    expect(afterKeys).toContain(paneLeafKey(3));
    expect(afterKeys).not.toContain(paneLeafKey(4));
  });

  it('keeps the risen split node keyed by its own id (not a fresh one) after closePane', () => {
    // A deeper tree so closing a leaf collapses an internal split node up
    // one level, per tree.ts's closePane doc comment.
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 1 },
      b: {
        kind: 'split',
        id: 'inner',
        dir: 'column',
        ratio: 0.7,
        a: { kind: 'leaf', sessionId: 2 },
        b: { kind: 'leaf', sessionId: 3 },
      },
    };
    const outcome = closePane(root, 1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const layout = buildPaneLayout(outcome.root) as Extract<PaneLayout, { kind: 'split' }>;
    // "inner" rose to become the new root, keeping its own id/key/ratio.
    expect(layout.key).toBe(splitGroupKey('inner'));
    expect(layout.sizes).toEqual([70, 30]);
  });

  it('keeps a moved leaf keyed by its own sessionId after movePane, even under a fresh split node', () => {
    const root = grid2x2();
    const outcome = movePane(root, 1, 3, 'right', 'moved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const afterKeys = collectLayoutLeafKeys(buildPaneLayout(outcome.root));
    expect(afterKeys).toEqual(
      expect.arrayContaining([paneLeafKey(1), paneLeafKey(2), paneLeafKey(3), paneLeafKey(4)]),
    );
  });
});
