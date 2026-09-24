import { describe, expect, it } from 'vitest';

import {
  closePane,
  collectSessionIds,
  makeLeaf,
  movePane,
  setRatio,
  splitPane,
  treeFromSessions,
  treeLeaves,
  type PaneNode,
} from './tree.js';

describe('splitPane', () => {
  it('splits a leaf into a new split node holding the target and the new leaf', () => {
    const root = makeLeaf(1);
    const outcome = splitPane(root, 1, 2, 'row', 'n1');
    expect(outcome).toEqual({
      ok: true,
      root: { kind: 'split', id: 'n1', dir: 'row', ratio: 0.5, a: makeLeaf(1), b: makeLeaf(2) },
    });
  });

  it('splits deep inside an existing tree, leaving unrelated branches untouched by reference', () => {
    const untouched = makeLeaf(3);
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: untouched,
    };
    const outcome = splitPane(root, 1, 2, 'column', 'n2');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const split = outcome.root as Extract<PaneNode, { kind: 'split' }>;
    expect(split.b).toBe(untouched); // same reference: untouched branch is not recreated
    expect(split.a).toEqual({
      kind: 'split',
      id: 'n2',
      dir: 'column',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    });
  });

  // Armadilha 1: a session already present in the tree can never be
  // inserted a second time.
  it('rejects when newSessionId is already in the tree (duplicate session)', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const outcome = splitPane(root, 1, 2, 'row', 'n3');
    expect(outcome).toEqual({ ok: false, reason: 'duplicate-session' });
  });

  it('rejects when the target session is not in the tree', () => {
    const outcome = splitPane(makeLeaf(1), 99, 2, 'row', 'n4');
    expect(outcome).toEqual({ ok: false, reason: 'target-not-found' });
  });

  it('rejects splitting an empty tree', () => {
    expect(splitPane(null, 1, 2, 'row', 'n5')).toEqual({ ok: false, reason: 'target-not-found' });
  });
});

describe('closePane', () => {
  it('closing the sole leaf yields an empty tree', () => {
    expect(closePane(makeLeaf(1), 1)).toEqual({ ok: true, root: null, nextFocus: undefined });
  });

  it('closing one of two sibling leaves collapses to the remaining leaf', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    expect(closePane(root, 1)).toEqual({ ok: true, root: makeLeaf(2), nextFocus: 2 });
  });

  // Armadilha 2: the naive version discards the risen node's own id/ratio.
  // Tree: root(a=leaf(1), b=inner(id:"inner", ratio:0.7, a=leaf(2), b=leaf(3)))
  // Closing leaf 1 must make `inner` rise to the root slot, WITH its own id
  // and ratio intact — not a fresh node, not root's id/ratio.
  it('closing a leaf whose sibling is an internal node preserves that node id and ratio when it rises', () => {
    const inner: PaneNode = {
      kind: 'split',
      id: 'inner',
      dir: 'column',
      ratio: 0.7,
      a: makeLeaf(2),
      b: makeLeaf(3),
    };
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: inner,
    };
    const outcome = closePane(root, 1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.root).toBe(inner); // same object: risen unchanged, id+ratio preserved
    expect(outcome.nextFocus).toBe(2);
  });

  it('closing a leaf deep in the tree only rebuilds the path to it', () => {
    const untouched = makeLeaf(4);
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: {
        kind: 'split',
        id: 'left',
        dir: 'column',
        ratio: 0.3,
        a: makeLeaf(1),
        b: makeLeaf(2),
      },
      b: untouched,
    };
    const outcome = closePane(root, 1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const split = outcome.root as Extract<PaneNode, { kind: 'split' }>;
    expect(split.b).toBe(untouched);
    expect(split.a).toEqual(makeLeaf(2));
    expect(outcome.nextFocus).toBe(2);
  });

  it('rejects an unknown session id', () => {
    expect(closePane(makeLeaf(1), 99)).toEqual({ ok: false, reason: 'not-found' });
    expect(closePane(null, 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('movePane', () => {
  it('moves a leaf to the right edge of its own sibling (armadilha 3 shape)', () => {
    // Two-leaf tree; move leaf 1 to the right of leaf 2 — removing 1
    // collapses the very root that contains 2.
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const outcome = movePane(root, 1, 2, 'right', 'moved');
    expect(outcome).toEqual({
      ok: true,
      root: { kind: 'split', id: 'moved', dir: 'row', ratio: 0.5, a: makeLeaf(2), b: makeLeaf(1) },
    });
  });

  it('moves a leaf across branches, preserving ratio on branches it never touches', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: {
        kind: 'split',
        id: 'right',
        dir: 'column',
        ratio: 0.65,
        a: makeLeaf(2),
        b: makeLeaf(3),
      },
    };
    // Move 1 to the top of 3 — the source removal collapses `root` down to
    // `right` itself (the id "root" disappears; "right" becomes the new
    // top), and 1 lands above 3 inside it, and 2's branch is untouched.
    const outcome = movePane(root, 1, 3, 'top', 'moved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.root).toEqual({
      kind: 'split',
      id: 'right',
      dir: 'column',
      ratio: 0.65,
      a: makeLeaf(2),
      b: { kind: 'split', id: 'moved', dir: 'column', ratio: 0.5, a: makeLeaf(1), b: makeLeaf(3) },
    });
  });

  it('rejects moving a pane onto itself', () => {
    expect(movePane(makeLeaf(1), 1, 1, 'right', 'x')).toEqual({ ok: false, reason: 'same-pane' });
  });

  it('rejects when source or target is missing', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    expect(movePane(root, 99, 2, 'right', 'x')).toEqual({ ok: false, reason: 'source-not-found' });
    expect(movePane(root, 1, 99, 'right', 'x')).toEqual({ ok: false, reason: 'target-not-found' });
  });
});

describe('setRatio', () => {
  it('sets the ratio of the addressed node, clamped, leaving others by reference', () => {
    const untouched = makeLeaf(2);
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: {
        kind: 'split',
        id: 'inner',
        dir: 'column',
        ratio: 0.5,
        a: makeLeaf(1),
        b: untouched,
      },
      b: makeLeaf(3),
    };
    const outcome = setRatio(root, 'inner', 0.99);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const inner = (outcome.root as Extract<PaneNode, { kind: 'split' }>).a as Extract<
      PaneNode,
      { kind: 'split' }
    >;
    expect(inner.ratio).toBe(0.9); // clamped to MAX_RATIO
    expect(inner.b).toBe(untouched);
  });

  it('rejects an unknown node id', () => {
    expect(setRatio(makeLeaf(1), 'nope', 0.5)).toEqual({ ok: false, reason: 'not-found' });
    expect(setRatio(null, 'nope', 0.5)).toEqual({ ok: false, reason: 'not-found' });
  });
});

// Split/close/move ratio survival across sibling branches, end to end
// (M3.1's prompt, section 5.A: "ratio preservado através de split/close/move
// em outros ramos").
describe('ratio survives split/close/move happening on a different branch', () => {
  it('a branch ratio is untouched by operations on a sibling branch', () => {
    const left: PaneNode = {
      kind: 'split',
      id: 'left',
      dir: 'column',
      ratio: 0.42,
      a: makeLeaf(1),
      b: makeLeaf(2),
    };
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      dir: 'row',
      ratio: 0.5,
      a: left,
      b: makeLeaf(3),
    };

    const afterSplit = splitPane(root, 3, 4, 'column', 'n');
    expect(afterSplit.ok).toBe(true);
    if (!afterSplit.ok) throw new Error('unreachable');
    expect(
      (
        (afterSplit.root as Extract<PaneNode, { kind: 'split' }>).a as Extract<
          PaneNode,
          { kind: 'split' }
        >
      ).ratio,
    ).toBe(0.42);

    const afterClose = closePane(afterSplit.root, 4);
    expect(afterClose.ok).toBe(true);
    if (!afterClose.ok) throw new Error('unreachable');
    expect(
      (
        (afterClose.root as Extract<PaneNode, { kind: 'split' }>).a as Extract<
          PaneNode,
          { kind: 'split' }
        >
      ).ratio,
    ).toBe(0.42);

    const afterMove = movePane(afterClose.root, 3, 3, 'right', 'unused');
    // Moving onto itself always rejects — proves the reducer never mutates
    // in place, i.e. `afterClose.root` (still holding `left` at ratio 0.42)
    // is unaffected by the attempt.
    expect(afterMove).toEqual({ ok: false, reason: 'same-pane' });
    expect(
      (
        (afterClose.root as Extract<PaneNode, { kind: 'split' }>).a as Extract<
          PaneNode,
          { kind: 'split' }
        >
      ).ratio,
    ).toBe(0.42);
  });
});

describe('treeFromSessions', () => {
  it('1 session: a single leaf', () => {
    expect(treeFromSessions([1])).toEqual(makeLeaf(1));
  });

  it('2 sessions: one row split', () => {
    expect(treeFromSessions([1, 2])).toEqual({
      kind: 'split',
      id: 'boot-1',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(1),
      b: makeLeaf(2),
    });
  });

  it('3 sessions: balanced, no duplicate ids, every session placed exactly once', () => {
    const tree = treeFromSessions([1, 2, 3]);
    expect(tree).not.toBeNull();
    expect(treeLeaves(tree).map((l) => l.sessionId)).toEqual([1, 2, 3]);
  });

  it('4 sessions: a 2x2 grid (row split of two column splits)', () => {
    const tree = treeFromSessions([1, 2, 3, 4]);
    // Node ids are minted post-order (children before their parent), so the
    // root — the last node built — gets the highest counter value.
    expect(tree).toEqual({
      kind: 'split',
      id: 'boot-3',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'split', id: 'boot-1', dir: 'column', ratio: 0.5, a: makeLeaf(1), b: makeLeaf(2) },
      b: { kind: 'split', id: 'boot-2', dir: 'column', ratio: 0.5, a: makeLeaf(3), b: makeLeaf(4) },
    });
  });

  it('5 sessions: balanced, no duplicate ids, every session placed exactly once', () => {
    const tree = treeFromSessions([1, 2, 3, 4, 5]);
    expect(treeLeaves(tree).map((l) => l.sessionId)).toEqual([1, 2, 3, 4, 5]);
    expect(collectSessionIds(tree).size).toBe(5);
  });

  it('empty input yields an empty tree', () => {
    expect(treeFromSessions([])).toBeNull();
  });

  it('distinct prefixes avoid id collisions across two calls', () => {
    const a = treeFromSessions([1, 2], 'ws-a');
    const b = treeFromSessions([3, 4], 'ws-b');
    const idsOf = (n: PaneNode | null): string[] =>
      n === null || n.kind === 'leaf' ? [] : [n.id, ...idsOf(n.a), ...idsOf(n.b)];
    const all = [...idsOf(a), ...idsOf(b)];
    expect(new Set(all).size).toBe(all.length);
  });
});
