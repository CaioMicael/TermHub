// Pure derivation behind `Sidebar.tsx`'s tree view (M4.2's prompt, section
// 2): which workspace groups to show, in what order, which rows they hold,
// which row is the active one, the session count and the "waiting" marker
// (◆) each group shows. Kept in its own `.ts` file so this is testable with
// Vitest in a plain `node` environment, no DOM, no React — the same
// reasoning `pane-header-status.ts`/`tab-bar-actions.ts` already give for
// splitting pure logic out of a component.

import type { SessionId, SessionSummary } from '@termhub/shared';

import { selectWorkspaceLeaves } from './store/selectors.js';
import type { StoreState } from './store/workspace.js';

/**
 * One session row inside a workspace group. `session` is `undefined` when
 * the leaf's `sessionId` isn't (yet) in `state.sessions` — the same gap
 * `PaneHeader.tsx`'s own doc comment describes between `store.split` placing
 * a leaf and `upsertSession` recording its metadata. `Sidebar.tsx` renders
 * that case the same neutral way `PaneHeader` does (no crash on
 * `session.name`/`session.status`) rather than this module inventing a
 * placeholder name/status of its own.
 */
export interface SidebarRow {
  workspaceId: string;
  sessionId: SessionId;
  session: SessionSummary | undefined;
  /**
   * Whether this is the row for the *focused* pane of the *active*
   * workspace — matches the prototype's single `focusPane(wsId, paneId)`
   * driving both `.row.active` and the active tab in one call
   * (`termhub-prototipo.html`'s `renderTree`: `p.id === focusedPane && ws.id
   * === activeWs`).
   */
  active: boolean;
}

/** One workspace's group in the sidebar's tree view. */
export interface SidebarGroup {
  workspaceId: string;
  name: string;
  cwd: string;
  sessionCount: number;
  /**
   * Prototype's `waiting ? '◆' : ''` (yellow diamond) on the group head —
   * true iff some row in this group has a *known* `session.status ===
   * 'awaiting-input'`. A row whose session isn't in `state.sessions` yet
   * never counts here — the same "excluded from the vote" posture
   * `selectors.ts`'s `selectAggregatedWorkspaceStatus` documents for the tab
   * bar's own aggregated dot.
   */
  waiting: boolean;
  rows: SidebarRow[];
}

/**
 * Builds one `SidebarGroup` per workspace, **in tab order** —
 * `state.workspaces`'s own order already *is* tab order (`workspace.ts`'s
 * own doc comment on `StoreState.workspaces`), so this function does no
 * sorting of its own. A workspace with `root: null` (every pane closed, or
 * none ever placed) still gets a group, with `rows: []` and
 * `sessionCount: 0` — the prototype's sidebar never hides a workspace, it
 * just shows a group with nothing under it (`selectWorkspaceLeaves` already
 * returns `[]` for that case).
 */
export function buildSidebarGroups(state: StoreState): SidebarGroup[] {
  return state.workspaces.map((workspace) => {
    const sessionIds = selectWorkspaceLeaves(state, workspace.id);
    const rows: SidebarRow[] = sessionIds.map((sessionId) => ({
      workspaceId: workspace.id,
      sessionId,
      session: state.sessions[sessionId],
      active: workspace.id === state.activeWorkspaceId && sessionId === workspace.focusedSessionId,
    }));
    const waiting = rows.some((row) => row.session?.status === 'awaiting-input');
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      cwd: workspace.cwd,
      sessionCount: rows.length,
      waiting,
      rows,
    };
  });
}

/**
 * Total session count across *every* workspace's tree — the activity bar's
 * "Terminais" badge (M4.2's prompt, section 2: "o número de sessões nas
 * árvores de todos os workspaces"). Sums each workspace's own
 * `selectWorkspaceLeaves` length rather than `Object.keys(state.sessions).
 * length`: a session with no pane anywhere (e.g. right after
 * `closePaneAction` — `session-actions.ts`'s own doc comment) still lives in
 * `state.sessions` but must not inflate this count, and the tree invariant
 * (`workspace.ts`'s `isSessionPlaced` guard) means no session is ever
 * counted twice across workspaces.
 */
export function totalPlacedSessionCount(state: StoreState): number {
  return state.workspaces.reduce(
    (total, workspace) => total + selectWorkspaceLeaves(state, workspace.id).length,
    0,
  );
}

/**
 * The pane a bare "dividir"/"novo terminal" action (no specific row clicked)
 * splits: the *active* workspace's own focused pane. `undefined` when there
 * is no active workspace, the active workspace id doesn't resolve (defensive
 * — shouldn't happen, `state.activeWorkspaceId` is always kept in sync by
 * `workspace.ts`'s reducers), or its `focusedSessionId` is unset (a
 * workspace with `root: null`, or one whose sole leaf was never focused).
 *
 * Used by `Sidebar.tsx`'s title-bar "Novo terminal"/"Dividir painel" buttons
 * (M4.2's prompt, section 2 — both funnel through the same
 * `splitPaneWithNewSession` call, there being no other session-creation flow
 * inside a workspace yet; see this task's final report for that decision).
 */
export function activeFocusedTarget(
  state: StoreState,
): { workspaceId: string; sessionId: SessionId } | undefined {
  const workspaceId = state.activeWorkspaceId;
  if (workspaceId === undefined) {
    return undefined;
  }
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (workspace === undefined || workspace.focusedSessionId === undefined) {
    return undefined;
  }
  return { workspaceId, sessionId: workspace.focusedSessionId };
}
