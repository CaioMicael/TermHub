// Pure/testable logic behind M3.6's tab reordering, mirroring `pane-drag.ts`'s
// reasoning: no DOM, no React, driven by Vitest in a plain `node`
// environment. `TabBar.tsx` only ever calls `tabInsertionIndex` (which slot
// the dragged tab would land in) and `reorderWorkspaceIds` (turning that
// index into the exact array `store.reorderWorkspaces` takes).

/** Custom `dataTransfer` MIME type for a tab drag — distinct from `pane-drag.ts`'s `PANE_DRAG_MIME` so a tab drag is never misread as a pane move or vice versa, and neither is confused with text/a file dragged in from outside the app (armadilha 5, shared with pane dragging). */
export const TAB_DRAG_MIME = 'application/x-termhub-tab';

export function encodeTabDragPayload(workspaceId: string): string {
  return JSON.stringify({ workspaceId });
}

/** Same reasoning as `pane-drag.ts`'s `decodePaneDragPayload`: `null` unless `TAB_DRAG_MIME` is present, so foreign drags never reorder tabs. */
export function decodeTabDragPayload(dataTransfer: {
  types: readonly string[];
  getData: (type: string) => string;
}): string | null {
  if (!dataTransfer.types.includes(TAB_DRAG_MIME)) {
    return null;
  }
  const raw = dataTransfer.getData(TAB_DRAG_MIME);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('workspaceId' in parsed)) {
      return null;
    }
    return typeof parsed.workspaceId === 'string' ? parsed.workspaceId : null;
  } catch {
    return null;
  }
}

export interface TabRect {
  id: string;
  /** Left edge, in whatever coordinate space the caller measured all rects in (`TabBar.tsx` uses `getBoundingClientRect().left` for every tab in the same strip, so only relative positions matter). */
  left: number;
  width: number;
}

/**
 * Where the dragged tab (`draggingId`) would land among `tabs` if dropped at
 * `pointerX`, as an index into `tabs` **with `draggingId` removed** — i.e.
 * directly usable as `reorderWorkspaceIds`'s `insertionIndex` below. `tabs`
 * is expected in on-screen left-to-right order, `draggingId` included (it's
 * filtered out here so the caller doesn't have to).
 *
 * Compares `pointerX` against each remaining tab's midpoint, left to right —
 * the first tab whose midpoint `pointerX` hasn't reached yet is where the
 * drop indicator goes (0 if pointer sits left of the very first tab, `tabs.
 * length - 1` — i.e. after every remaining tab — if it's right of the last
 * one).
 */
export function tabInsertionIndex(
  tabs: readonly TabRect[],
  draggingId: string,
  pointerX: number,
): number {
  const others = tabs.filter((tab) => tab.id !== draggingId);
  for (let i = 0; i < others.length; i += 1) {
    const tab = others[i] as TabRect;
    const midpoint = tab.left + tab.width / 2;
    if (pointerX < midpoint) {
      return i;
    }
  }
  return others.length;
}

/**
 * Builds the full reordered id list `store.reorderWorkspaces` expects (a
 * permutation of every current id — `workspace.ts`'s own doc comment):
 * removes `draggingId` from `ids`, then re-inserts it at `insertionIndex`
 * (clamped into range, so a stale/out-of-bounds index from a race between
 * `dragover` and `drop` never throws or silently drops an id).
 */
export function reorderWorkspaceIds(
  ids: readonly string[],
  draggingId: string,
  insertionIndex: number,
): string[] {
  const without = ids.filter((id) => id !== draggingId);
  const clamped = Math.min(Math.max(insertionIndex, 0), without.length);
  const result = [...without];
  result.splice(clamped, 0, draggingId);
  return result;
}
