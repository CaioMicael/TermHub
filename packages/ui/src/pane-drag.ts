// Pure/testable logic behind M3.6's pane drag-and-drop, kept out of
// `SplitTree.tsx`/`PaneHeader.tsx` for the same reason `pane-header-actions.ts`
// and `split-layout.ts` already give: no DOM, no React, driven by Vitest in a
// plain `node` environment.
//
// The React wiring (`SplitTree.tsx`'s drop-zone overlay, `PaneHeader.tsx`'s
// `draggable` header) only ever calls the four functions below — `edgeForPoint`
// (armadilha 2's "which border is the pointer over"), `isPaneDragDisabled`
// (the solo/maximized case, section 2's last bullet), `computePaneDrop` (the
// "does this drop actually move anything" decision, section 2's other
// bullets) and the `encode`/`decodePaneDragPayload` pair (armadilha 5: a
// custom MIME type so dragging text or a file in from outside the app is
// never mistaken for a pane).

import { createContext } from 'react';
import type { SessionId } from '@termhub/shared';

import type { MoveEdge } from './store/tree.js';

/** Custom `dataTransfer` MIME type for a pane drag — never a bare `text/plain`, so a file or text dragged in from outside the app (or a tab drag, see `tab-drag.ts`'s own distinct MIME) is never misread as a pane move (armadilha 5). */
export const PANE_DRAG_MIME = 'application/x-termhub-pane';

export interface DragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DragPoint {
  x: number;
  y: number;
}

/**
 * How close to the rect's center a point can be before it counts as "no
 * border" (section 2: "soltar ... fora de uma borda: nada muda") — a point
 * whose nearest-edge distance (normalized to that dimension) exceeds this
 * fraction lands in the dead zone in the middle and returns `null`. `0.3` is
 * this task's own judgment call (the prompt names the diagonal-quadrant
 * *shape* — "como no VS Code" — but not an exact dead-zone size); see this
 * task's final report.
 */
export const EDGE_DEAD_ZONE_FRACTION = 0.3;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Which of `rect`'s four edges `point` is closest to, or `null` when `point`
 * is closer to the center than to any edge (the dead zone above). The
 * boundary between two adjacent edges (e.g. top vs. left) is exactly the
 * rect's diagonal — the normalized distance to "top" is `ny` and to "left"
 * is `nx`, so `ny === nx` is the tie line — which is the "quadrantes em
 * diagonal como no VS Code" shape the prompt asks for. Ties (including every
 * corner, where two distances are equal) resolve to a fixed priority,
 * `top > bottom > left > right`, so the result is always deterministic.
 */
export function edgeForPoint(rect: DragRect, point: DragPoint): MoveEdge | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const nx = clamp01((point.x - rect.left) / rect.width);
  const ny = clamp01((point.y - rect.top) / rect.height);
  const candidates: Array<{ edge: MoveEdge; distance: number }> = [
    { edge: 'top', distance: ny },
    { edge: 'bottom', distance: 1 - ny },
    { edge: 'left', distance: nx },
    { edge: 'right', distance: 1 - nx },
  ];
  let best = candidates[0] as { edge: MoveEdge; distance: number };
  for (const candidate of candidates) {
    if (candidate.distance < best.distance) {
      best = candidate;
    }
  }
  if (best.distance > EDGE_DEAD_ZONE_FRACTION) {
    return null;
  }
  return best.edge;
}

/**
 * Pane dragging has no valid target when the workspace shows only one pane —
 * solo (a single-leaf tree) or a maximized pane (`SplitTree.tsx` renders only
 * that one leaf either way) — section 2's last bullet. Both `solo` and
 * `maximized` are already props `PaneHeader`/`SplitTree`'s leaf view receive;
 * this is the whole decision, factored out so it's unit-testable without a
 * DOM.
 */
export function isPaneDragDisabled(params: { solo: boolean; maximized: boolean }): boolean {
  return params.solo || params.maximized;
}

export interface PaneDropResult {
  sourceSessionId: SessionId;
  targetSessionId: SessionId;
  edge: MoveEdge;
}

/**
 * Decides what a completed drop means, covering every "nothing changes" case
 * from section 2: no session was actually being dragged (`sourceSessionId`
 * is `null` — e.g. the payload's MIME type didn't match, see
 * `decodePaneDragPayload`), the drop landed back on the pane being dragged
 * (`sourceSessionId === targetSessionId`), or the pointer wasn't over a
 * border (`edge` is `null`, from `edgeForPoint` above, or `dropOccurred` is
 * `false` — dropped outside the grid entirely, so no target pane's overlay
 * ever ran `edgeForPoint` at all).
 */
export function computePaneDrop(params: {
  sourceSessionId: SessionId | null;
  targetSessionId: SessionId;
  edge: MoveEdge | null;
}): PaneDropResult | null {
  const { sourceSessionId, targetSessionId, edge } = params;
  if (sourceSessionId === null || edge === null) {
    return null;
  }
  if (sourceSessionId === targetSessionId) {
    return null;
  }
  return { sourceSessionId, targetSessionId, edge };
}

export function encodePaneDragPayload(sessionId: SessionId): string {
  return JSON.stringify({ sessionId });
}

/**
 * The other half of armadilha 5: reads a `dataTransfer`-shaped object back
 * into a `SessionId`, but only if `PANE_DRAG_MIME` is among its `types` —
 * plain text or a file dragged in from outside the app never has that type,
 * so this returns `null` for them instead of guessing at `getData('text/plain')`.
 * Typed as the minimal structural slice of the DOM's `DataTransfer` this
 * needs (`types`/`getData`), the same "small interface, not the real
 * browser type" pattern `pane-header-actions.ts`'s `PaneHeaderClickEvent`
 * already uses — trivially fakeable in a `node`-environment test.
 */
export function decodePaneDragPayload(dataTransfer: {
  types: readonly string[];
  getData: (type: string) => string;
}): SessionId | null {
  if (!dataTransfer.types.includes(PANE_DRAG_MIME)) {
    return null;
  }
  const raw = dataTransfer.getData(PANE_DRAG_MIME);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('sessionId' in parsed)) {
      return null;
    }
    return typeof parsed.sessionId === 'number' ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// React wiring shared between `SplitTree.tsx` (the `Provider`, and the
// drop-zone overlay that calls `setDropTarget`/`drop`) and `PaneHeader.tsx`
// (`beginDrag`/`endDrag` from the header's own `onDragStart`/`onDragEnd`).
// Defined here, not inline in either component, so both can `useContext` the
// same instance without one importing the other.
// ---------------------------------------------------------------------------

export interface PaneDropTarget {
  sessionId: SessionId;
  edge: MoveEdge;
}

export interface PaneDragState {
  draggingSessionId: SessionId | null;
  dropTarget: PaneDropTarget | null;
}

export interface PaneDragApi {
  state: PaneDragState;
  beginDrag: (sessionId: SessionId) => void;
  endDrag: () => void;
  setDropTarget: (target: PaneDropTarget | null) => void;
  /** Runs `computePaneDrop` against the session currently being dragged and, on a real move, calls the store's `movePane` — see `SplitTree.tsx`'s `PaneDragProvider` for the implementation. Always clears the drag state, whether or not the drop actually moved anything. */
  drop: (targetSessionId: SessionId, edge: MoveEdge | null) => void;
}

/** `null` outside a `SplitTree` (`PaneHeader.tsx` degrades to non-draggable in that case — see its own `useContext` call). */
export const PaneDragContext = createContext<PaneDragApi | null>(null);
