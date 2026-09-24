// Pure render-planning logic for `SplitTree.tsx` (M3.2), kept separate from
// any React/`react-resizable-panels` import so it can be unit-tested without
// a DOM (this repo has no jsdom — see this task's prompt, section 4.A).
//
// Two independent concerns live here:
//
// 1. `buildPaneLayout` walks a `PaneNode` tree (`store/tree.ts`) into a
//    `PaneLayout` description that names every leaf and split with a
//    **stable, `sessionId`/`nodeId`-derived key** — never a positional
//    index. `SplitTree.tsx` uses these keys as React `key`/Panel `id`
//    props. A key derived from array position instead of identity is
//    exactly the bug armadilha 2 (this task's prompt) warns about: it would
//    make React treat "the leaf now at index 0" as the same component
//    across a `close`/`move` that actually replaced *what* sits at index 0,
//    silently remounting a `Terminal` that should have survived. The tests
//    below assert key stability across such reorderings.
//
// 2. `ratioToSizes`/`sizesToRatio` convert between the store's `ratio`
//    (`[MIN_RATIO, MAX_RATIO]`, share of `a`) and `react-resizable-panels`'
//    `Layout` (a map of panel id to percentage size, 0..100, summing to
//    100 for two panels). `SplitTree.tsx` calls `ratioToSizes` to derive
//    each split's initial `defaultSize`s, and `sizesToRatio` on the
//    library's `onLayoutChanged` callback (fired once per completed drag,
//    not per pointer-move — see `SplitTree.tsx`'s header comment) to
//    compute the value passed to the store's `setRatio`.

import type { PaneNode, SplitDirection } from './store/tree.js';

/** A leaf's Panel `id` / React `key`, derived only from its `sessionId` — stable regardless of where the leaf sits in the tree. */
export function paneLeafKey(sessionId: number): string {
  return `pane-${sessionId}`;
}

/** A split node's Group `id` / React `key`, derived only from the tree node's own stable `id` (`store/tree.ts`'s `PaneSplitNode.id`, preserved by `closePane` when a subtree rises — `tree.ts`'s header comment). */
export function splitGroupKey(nodeId: string): string {
  return `split-${nodeId}`;
}

/** The two child Panel ids within split node `nodeId` — always `${nodeId}-a`/`${nodeId}-b`, so they're stable across re-renders and unique within their parent Group without needing React's `useId`. */
export function splitChildPanelIds(nodeId: string): readonly [string, string] {
  return [`${nodeId}-a`, `${nodeId}-b`];
}

export interface PaneLayoutLeaf {
  readonly kind: 'leaf';
  readonly key: string;
  readonly sessionId: number;
}

export interface PaneLayoutSplit {
  readonly kind: 'split';
  readonly key: string;
  readonly nodeId: string;
  readonly dir: SplitDirection;
  /** `[aSize, bSize]`, percentages (0..100) summing to 100, derived from the tree node's `ratio` via `ratioToSizes`. */
  readonly sizes: readonly [number, number];
  /** `[aPanelId, bPanelId]` — see `splitChildPanelIds`. */
  readonly panelIds: readonly [string, string];
  readonly a: PaneLayout;
  readonly b: PaneLayout;
}

export type PaneLayout = PaneLayoutLeaf | PaneLayoutSplit;

/** Converts a store `ratio` (share of `a`, in `[0, 1]`) into a two-panel percentage layout summing to exactly 100 — `b`'s size is `100 - a`'s, not independently rounded, so the pair always sums to 100 regardless of floating-point drift in `ratio`. */
export function ratioToSizes(ratio: number): readonly [number, number] {
  const aSize = ratio * 100;
  return [aSize, 100 - aSize];
}

/**
 * The inverse of `ratioToSizes`: given the two panel sizes `react-resizable-panels`
 * reports for a split (in either order — `aSize` is whichever one corresponds
 * to the tree node's `a` child), returns the `ratio` to pass to `setRatio`.
 * Falls back to `0.5` if `aSize + bSize` isn't a usable positive number (e.g.
 * both panels momentarily collapsed to 0), matching `store/tree.ts`'s
 * `clampRatio`'s own non-finite fallback.
 */
export function sizesToRatio(aSize: number, bSize: number): number {
  const total = aSize + bSize;
  if (!Number.isFinite(total) || total <= 0) {
    return 0.5;
  }
  return aSize / total;
}

/** Walks `root` into a `PaneLayout` tree carrying stable keys/ids and precomputed panel sizes. `null` (an empty workspace) yields `null`. */
export function buildPaneLayout(root: PaneNode | null): PaneLayout | null {
  if (root === null) {
    return null;
  }
  return buildNode(root);
}

function buildNode(node: PaneNode): PaneLayout {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', key: paneLeafKey(node.sessionId), sessionId: node.sessionId };
  }
  const [aSize, bSize] = ratioToSizes(node.ratio);
  return {
    kind: 'split',
    key: splitGroupKey(node.id),
    nodeId: node.id,
    dir: node.dir,
    sizes: [aSize, bSize],
    panelIds: splitChildPanelIds(node.id),
    a: buildNode(node.a),
    b: buildNode(node.b),
  };
}

/** Every leaf's key, in left-to-right (`a` before `b`) order — the same traversal order as `store/tree.ts`'s `treeLeaves`. Used by tests to assert key stability across tree edits, and available to `SplitTree.tsx` if it ever needs a flat leaf list. */
export function collectLayoutLeafKeys(layout: PaneLayout | null): string[] {
  if (layout === null) {
    return [];
  }
  if (layout.kind === 'leaf') {
    return [layout.key];
  }
  return [...collectLayoutLeafKeys(layout.a), ...collectLayoutLeafKeys(layout.b)];
}
