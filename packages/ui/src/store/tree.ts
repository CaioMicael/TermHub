// Pure binary tree of panes for one workspace (docs/plan.md section 2:
// "aba = workspace", each workspace owns exactly one tree). Every function
// here is a pure function over immutable data — no React, no Zustand, no
// daemon/bridge access — so `tree.test.ts` drives it directly with plain
// values.
//
// ## Why sessionId uniqueness is enforced by the *caller* (`workspace.ts`),
// not here
//
// M3.1's prompt, armadilha 1 (and docs/specs/m2.6-boot-reattach.md section
// 6): a `sessionId` must never appear twice in a tree — a second `Terminal`
// attaching to the same session never gets a snapshot written to it (only
// the first attacher's `write` sink receives one; see
// `terminal-session.ts`'s header comment on reference-counted ownership).
// The guard against a *duplicate within one workspace*'s tree lives in
// `splitPane`/`movePane` below (`collectSessionIds` is checked before
// mutating). The guard against a duplicate *across different workspaces*
// needs the full store state (every workspace's tree), which this module
// deliberately doesn't have access to — that check lives one layer up, in
// `workspace.ts`'s `splitInWorkspace`/`addWorkspace`.

/** One direction a split node divides its two children along. `SplitTree.tsx` (M3.2) maps this to a CSS flex-direction; this module never renders anything, so the exact visual meaning is that component's business. */
export type SplitDirection = 'row' | 'column';

/** Which edge of an existing pane a moved pane lands against — `movePane`'s `edge` parameter. */
export type MoveEdge = 'top' | 'right' | 'bottom' | 'left';

/**
 * Bounds `ratio` is clamped into. Keeps either side of a split from ever
 * reaching 0px (M3.1's prompt, section 3.1: "ratio fica preso num intervalo
 * que não deixa painel com 0px") — the exact pixel floor depends on
 * `SplitTree.tsx`'s own minimum pane size (M3.2), so this is a generous,
 * package-wide floor rather than a pixel-accurate one.
 */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
export const DEFAULT_RATIO = 0.5;

export interface PaneLeaf {
  readonly kind: 'leaf';
  readonly sessionId: number;
}

/** An internal split node. `id` is stable across reducers — `setRatio` addresses a node by it, and `closePane` preserves it (along with `ratio`) when a node rises to replace its removed sibling's parent (M3.1's prompt, armadilha 2). */
export interface PaneSplitNode {
  readonly kind: 'split';
  readonly id: string;
  readonly dir: SplitDirection;
  /** Share of space given to `a` along `dir`, in `[MIN_RATIO, MAX_RATIO]`. `b` gets the rest. */
  readonly ratio: number;
  readonly a: PaneNode;
  readonly b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplitNode;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_RATIO;
  }
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function makeLeaf(sessionId: number): PaneLeaf {
  return { kind: 'leaf', sessionId };
}

/** Every `sessionId` present anywhere in `node`'s tree. `node === null` (an empty workspace) yields an empty set. */
export function collectSessionIds(
  node: PaneNode | null,
  out: Set<number> = new Set(),
): Set<number> {
  if (node === null) {
    return out;
  }
  if (node.kind === 'leaf') {
    out.add(node.sessionId);
    return out;
  }
  collectSessionIds(node.a, out);
  collectSessionIds(node.b, out);
  return out;
}

/** Every leaf in `node`'s tree, in left-to-right (`a` before `b`) traversal order. Used by selectors (`selectWorkspaceLeaves`) and by `closePane`'s "focus a neighboring leaf" rule. */
export function treeLeaves(node: PaneNode | null): PaneLeaf[] {
  if (node === null) {
    return [];
  }
  if (node.kind === 'leaf') {
    return [node];
  }
  return [...treeLeaves(node.a), ...treeLeaves(node.b)];
}

function firstLeafOf(node: PaneNode): PaneLeaf {
  return node.kind === 'leaf' ? node : firstLeafOf(node.a);
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

export type SplitOutcome =
  { ok: true; root: PaneNode } | { ok: false; reason: 'target-not-found' | 'duplicate-session' };

/**
 * Replaces the leaf holding `targetSessionId` with a new split node whose
 * two children are that same leaf and a fresh leaf for `newSessionId`.
 * `newNodeId` is caller-supplied (the store's job to mint one, e.g. via
 * `crypto.randomUUID()`) so this function stays pure and deterministic —
 * see this file's header comment.
 *
 * Rejects (returns the tree unchanged is NOT what happens — no `root` is
 * returned at all, `ok: false`) when:
 * - `root` is `null` (nothing to split — an empty workspace has no target
 *   leaf; seed it with `makeLeaf`/`treeFromSessions` instead);
 * - `targetSessionId` isn't in the tree;
 * - `newSessionId` is already in the tree — armadilha 1: this function only
 *   guards duplicates *within `root`*; guarding across workspaces is
 *   `workspace.ts`'s `splitInWorkspace` job (see this file's header
 *   comment).
 *
 * `newLeafSide` controls which child slot (`a` or `b`) the *new* leaf takes;
 * the existing target leaf takes the other slot. `movePane` below reuses
 * this to control which side of the target the moved pane lands on.
 */
export function splitPane(
  root: PaneNode | null,
  targetSessionId: number,
  newSessionId: number,
  dir: SplitDirection,
  newNodeId: string,
  newLeafSide: 'a' | 'b' = 'b',
): SplitOutcome {
  if (root === null) {
    return { ok: false, reason: 'target-not-found' };
  }
  const existing = collectSessionIds(root);
  if (existing.has(newSessionId)) {
    return { ok: false, reason: 'duplicate-session' };
  }
  if (!existing.has(targetSessionId)) {
    return { ok: false, reason: 'target-not-found' };
  }

  function recur(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      if (node.sessionId !== targetSessionId) {
        return node;
      }
      const newLeaf = makeLeaf(newSessionId);
      const split: PaneSplitNode = {
        kind: 'split',
        id: newNodeId,
        dir,
        ratio: DEFAULT_RATIO,
        a: newLeafSide === 'a' ? newLeaf : node,
        b: newLeafSide === 'a' ? node : newLeaf,
      };
      return split;
    }
    const a = recur(node.a);
    const b = recur(node.b);
    if (a === node.a && b === node.b) {
      return node;
    }
    return { ...node, a, b };
  }

  return { ok: true, root: recur(root) };
}

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

export type CloseOutcome =
  | { ok: true; root: PaneNode | null; nextFocus: number | undefined }
  | { ok: false; reason: 'not-found' };

/**
 * Removes the leaf holding `sessionId`. If its parent's *other* child is an
 * internal split node, that whole node rises to take the removed leaf's
 * grandparent slot **with its own `id` and `ratio` preserved** (M3.1's
 * prompt, armadilha 2 — the naive version that discards the risen node's own
 * id/ratio is exactly the bug this is written to avoid; see `tree.test.ts`
 * for the case that catches it).
 *
 * Closing the last leaf yields `root: null` — the workspace itself is
 * untouched by this function (closing the workspace/tab is a different
 * action, `closeWorkspace` in `workspace.ts`).
 *
 * `nextFocus` is the closed leaf's former sibling subtree's first leaf (in
 * `treeLeaves` order) — "a neighboring leaf" per M3.1's prompt, section 3.1
 * — or `undefined` when the closed leaf was the whole tree.
 */
export function closePane(root: PaneNode | null, sessionId: number): CloseOutcome {
  if (root === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (root.kind === 'leaf') {
    if (root.sessionId !== sessionId) {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, root: null, nextFocus: undefined };
  }
  if (!collectSessionIds(root).has(sessionId)) {
    return { ok: false, reason: 'not-found' };
  }

  interface RecurResult {
    node: PaneNode;
    /**
     * Set (to a real session id) only at the exact point the target leaf
     * was removed — the sibling that rose there is the "neighboring leaf"
     * candidate, and it must not be overwritten by an unrelated ancestor
     * further up. Always present (never omitted) — `exactOptionalPropertyTypes`
     * (typescript-rules.md) rejects an optional property explicitly set to
     * `undefined`, so this is `number | undefined`, not `focus?: number`.
     */
    focus: number | undefined;
  }

  function recur(node: PaneSplitNode): RecurResult {
    if (node.a.kind === 'leaf' && node.a.sessionId === sessionId) {
      return { node: node.b, focus: firstLeafOf(node.b).sessionId };
    }
    if (node.b.kind === 'leaf' && node.b.sessionId === sessionId) {
      return { node: node.a, focus: firstLeafOf(node.a).sessionId };
    }
    if (node.a.kind === 'split') {
      const left = recur(node.a);
      if (left.node !== node.a) {
        return { node: { ...node, a: left.node }, focus: left.focus };
      }
    }
    if (node.b.kind === 'split') {
      const right = recur(node.b);
      if (right.node !== node.b) {
        return { node: { ...node, b: right.node }, focus: right.focus };
      }
    }
    // Neither child's subtree contains `sessionId` — this node is
    // unaffected. Returning the original `node` (same reference) is what
    // lets the caller detect "not found in this branch" via `!==` above,
    // without a separate boolean out-parameter.
    return { node, focus: undefined };
  }

  const result = recur(root);
  return { ok: true, root: result.node, nextFocus: result.focus };
}

// ---------------------------------------------------------------------------
// movePane
// ---------------------------------------------------------------------------

export type MoveOutcome =
  | { ok: true; root: PaneNode }
  | { ok: false; reason: 'source-not-found' | 'target-not-found' | 'same-pane' };

/**
 * Moves the leaf holding `sourceSessionId` to sit against `edge` of the leaf
 * holding `targetSessionId`, both addressed **by `sessionId`, not by tree
 * path** (M3.1's prompt, armadilha 3): removing the source can collapse the
 * very node that contains the target, so re-locating the target by identity
 * *after* the removal — rather than trusting a path computed before it — is
 * what keeps this correct. Implemented as `closePane` (remove the source)
 * followed by `splitPane` (re-insert it next to the, possibly relocated,
 * target) — both already re-verify their own preconditions against the tree
 * they're actually given.
 *
 * `top`/`left` insert the moved pane as the target's new `a` sibling (visibly
 * before it); `bottom`/`right` insert it as `b` (visibly after). `top`/
 * `bottom` split `column`; `left`/`right` split `row`.
 */
export function movePane(
  root: PaneNode | null,
  sourceSessionId: number,
  targetSessionId: number,
  edge: MoveEdge,
  newNodeId: string,
): MoveOutcome {
  if (sourceSessionId === targetSessionId) {
    return { ok: false, reason: 'same-pane' };
  }
  if (root === null) {
    return { ok: false, reason: 'source-not-found' };
  }
  const ids = collectSessionIds(root);
  if (!ids.has(sourceSessionId)) {
    return { ok: false, reason: 'source-not-found' };
  }
  if (!ids.has(targetSessionId)) {
    return { ok: false, reason: 'target-not-found' };
  }

  const removed = closePane(root, sourceSessionId);
  if (!removed.ok) {
    // Unreachable: existence was just confirmed above.
    return { ok: false, reason: 'source-not-found' };
  }
  // removed.root cannot be null here: the target (a different, still-present
  // session) guarantees at least one leaf remains.
  const dir: SplitDirection = edge === 'top' || edge === 'bottom' ? 'column' : 'row';
  const newLeafSide: 'a' | 'b' = edge === 'top' || edge === 'left' ? 'a' : 'b';
  const inserted = splitPane(
    removed.root,
    targetSessionId,
    sourceSessionId,
    dir,
    newNodeId,
    newLeafSide,
  );
  if (!inserted.ok) {
    // Unreachable given the checks above (target still present post-removal,
    // source no longer in the tree so it can't collide as a duplicate).
    return { ok: false, reason: 'target-not-found' };
  }
  return { ok: true, root: inserted.root };
}

// ---------------------------------------------------------------------------
// setRatio
// ---------------------------------------------------------------------------

export type SetRatioOutcome = { ok: true; root: PaneNode } | { ok: false; reason: 'not-found' };

/** Sets the `ratio` of the split node with id `nodeId`, clamped via `clampRatio`. Every other node in the tree keeps its own identity (`===`) when unaffected, so this is cheap to no-op-detect upstream. */
export function setRatio(root: PaneNode | null, nodeId: string, ratio: number): SetRatioOutcome {
  if (root === null) {
    return { ok: false, reason: 'not-found' };
  }
  const clamped = clampRatio(ratio);

  function exists(node: PaneNode): boolean {
    if (node.kind === 'leaf') {
      return false;
    }
    if (node.id === nodeId) {
      return true;
    }
    return exists(node.a) || exists(node.b);
  }
  if (!exists(root)) {
    return { ok: false, reason: 'not-found' };
  }

  function recur(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      return node;
    }
    if (node.id === nodeId) {
      return node.ratio === clamped ? node : { ...node, ratio: clamped };
    }
    const a = recur(node.a);
    const b = recur(node.b);
    if (a === node.a && b === node.b) {
      return node;
    }
    return { ...node, a, b };
  }

  return { ok: true, root: recur(root) };
}

// ---------------------------------------------------------------------------
// treeFromSessions — boot layout (M3.1 section 3.4/session-boot.ts)
// ---------------------------------------------------------------------------

/**
 * Builds a balanced binary tree from `sessionIds`, in the order given
 * (caller sorts — `session-boot.ts` sorts by `createdAt`). Splits the list
 * in half at each level, alternating `row`/`column` direction starting with
 * `row`, so 4 sessions come out as a 2×2 grid (M3.1's prompt, section 3.4)
 * and other counts (1, 2, 3, 5, …) come out as a reasonable, deterministic
 * layout rather than one long chain of splits.
 *
 * Pure and deterministic: node ids are minted from a counter local to this
 * call (`${nodeIdPrefix}-${n}`), not from `crypto.randomUUID()` or
 * `Date.now()` — same `sessionIds` (and `nodeIdPrefix`) in, same tree out,
 * every time. Two calls in the same boot must pass different prefixes to
 * avoid colliding split-node ids across workspaces.
 *
 * Empty input yields `null` (an empty workspace) — this can't happen from
 * `session-boot.ts`'s own boot policy (it always creates a session when none
 * is reusable), but the empty case is handled here rather than assumed away
 * by a caller.
 */
export function treeFromSessions(
  sessionIds: readonly number[],
  nodeIdPrefix = 'boot',
): PaneNode | null {
  let counter = 0;
  function nextId(): string {
    counter += 1;
    return `${nodeIdPrefix}-${counter}`;
  }

  function build(ids: readonly number[], dir: SplitDirection): PaneNode | null {
    if (ids.length === 0) {
      return null;
    }
    if (ids.length === 1) {
      return makeLeaf(ids[0] as number);
    }
    const mid = Math.ceil(ids.length / 2);
    const nextDir: SplitDirection = dir === 'row' ? 'column' : 'row';
    // `build` never returns null for a non-empty slice, so these are safe.
    const a = build(ids.slice(0, mid), nextDir) as PaneNode;
    const b = build(ids.slice(mid), nextDir) as PaneNode;
    return { kind: 'split', id: nextId(), dir, ratio: DEFAULT_RATIO, a, b };
  }

  return build(sessionIds, 'row');
}
