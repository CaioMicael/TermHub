// Pure decision logic behind "which terminals get a WebGL context right now"
// (docs/specs/m3.5-terminal-lifecycle.md section 4.4), free of any DOM/xterm
// dependency so it's driven by Vitest with plain arrays — same split as
// `terminal-session.ts`/`terminal-resize.ts`/`terminal-webgl.ts`.
//
// `terminal-registry.ts` is the only caller: it already knows, from the
// store alone (no DOM observation — section 4.4's own requirement), which
// hosts are currently *visible* (the active workspace's tree, or just the
// maximized pane) and *open* (already past `term.open()` — an unopened host
// can't host a WebGL context at all, `terminal-webgl.ts`'s own requirement).
// It passes this module only that already-filtered list, in leaf order, plus
// the focused session and the context budget — this module never needs to
// know about workspaces, trees or "open" at all.

import type { SessionId } from '@termhub/shared';

export interface SelectWebglSessionsParams {
  /**
   * Every open, visible host's session id, in leaf order (left-to-right —
   * `treeLeaves`' own order, `store/tree.ts`). The caller has already
   * excluded anything not open and not visible; this module doesn't
   * re-derive either notion.
   */
  visibleOpenSessionIds: readonly SessionId[];
  /** The active workspace's focused pane, if any — wins the tie-break below even when it isn't first in `visibleOpenSessionIds`. */
  focusedSessionId: SessionId | undefined;
  /** The Chromium WebGL-context budget (`~16` real-world, section 3 — the registry's own default is 8, deliberately half that ceiling). */
  maxContexts: number;
}

/**
 * Picks, deterministically, which of `visibleOpenSessionIds` should have a
 * live WebGL context: the focused pane first (if it's in the list at all),
 * then the rest in leaf order, truncated at `maxContexts`. Same input, same
 * output, every time — no hidden state, no randomness, no `Date.now()`.
 */
export function selectWebglSessions(params: SelectWebglSessionsParams): Set<SessionId> {
  const budget = Math.max(0, Math.floor(params.maxContexts));
  const ordered = orderByFocusFirst(params.visibleOpenSessionIds, params.focusedSessionId);
  return new Set(ordered.slice(0, budget));
}

function orderByFocusFirst(
  ids: readonly SessionId[],
  focusedSessionId: SessionId | undefined,
): SessionId[] {
  if (focusedSessionId === undefined || !ids.includes(focusedSessionId)) {
    return [...ids];
  }
  return [focusedSessionId, ...ids.filter((id) => id !== focusedSessionId)];
}
