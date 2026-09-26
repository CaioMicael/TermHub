// Read-only selectors over `StoreState`, for components (M3.2/M3.3/M3.4) and
// tests. Pure functions, no Zustand dependency — a component calls these
// through `useTermhubStore(state => selectX(state, ...))` for the
// subscription semantics; a test just calls them directly against a plain
// `StoreState`.

import type { SessionId, SessionStatus } from '@termhub/shared';

import { treeLeaves } from './tree.js';
import { findWorkspace, statusOf, type StoreState } from './workspace.js';

/** Every session id currently in `workspaceId`'s tree, in left-to-right (`a` before `b`) order. Empty array for an unknown workspace or one with `root: null`. */
export function selectWorkspaceLeaves(state: StoreState, workspaceId: string): SessionId[] {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return [];
  }
  return treeLeaves(workspace.root).map((leaf) => leaf.sessionId);
}

/** Number of panes currently in `workspaceId` — what the tab bar's counter badge (docs/plan.md's prototype, `.tab .tcount`) reads. */
export function selectSessionCount(state: StoreState, workspaceId: string): number {
  return selectWorkspaceLeaves(state, workspaceId).length;
}

/**
 * The aggregated status a workspace's tab/sidebar-group dot shows, per
 * docs/milestones.md M5.4: `'awaiting-input'` beats `'running'` beats
 * `'idle'`, and an all-`'exited'` workspace is reported as `'exited'` rather
 * than falling into `'idle'` — "exited à parte" (M3.1's prompt, section
 * 3.1). `'empty'` is this selector's own addition for a workspace with no
 * panes at all (`root: null`), which M5.4's four statuses don't cover; a
 * consumer that only expects `SessionStatus` should treat it the same as
 * `'idle'`.
 *
 * A pane whose session id isn't (yet) in `state.sessions` — e.g. the
 * instant between `splitInWorkspace` inserting the leaf and
 * `session-actions.ts`'s `upsertSession` call landing — is simply excluded
 * from the vote rather than crashing or defaulting to a specific status;
 * with every pane like that, `'idle'` is returned (there is no "unknown"
 * bucket at the workspace-status level today).
 */
export function selectAggregatedWorkspaceStatus(
  state: StoreState,
  workspaceId: string,
): SessionStatus | 'empty' {
  const sessionIds = selectWorkspaceLeaves(state, workspaceId);
  if (sessionIds.length === 0) {
    return 'empty';
  }
  const statuses = sessionIds
    .map((id) => statusOf(state, id))
    .filter((status): status is SessionStatus => status !== undefined);

  const PRIORITY: readonly SessionStatus[] = ['awaiting-input', 'running', 'idle'];
  for (const candidate of PRIORITY) {
    if (statuses.includes(candidate)) {
      return candidate;
    }
  }
  if (statuses.length > 0 && statuses.every((status) => status === 'exited')) {
    return 'exited';
  }
  return 'idle';
}
