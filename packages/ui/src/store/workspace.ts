// Pure reducers over the store's whole state (`StoreState`): workspaces (=
// tabs, docs/plan.md section 2 — there is no separate "tab" entity), the
// active one, focus/maximize, and the `sessions` metadata map the header/tab
// UI reads. Each function takes a `StoreState` and returns a `StoreState` —
// the previous reference when the call is a no-op/rejected, a new object
// otherwise — so callers (the Zustand store in `store.ts`, and tests) can
// cheaply tell rejection from success with `result === state`.
//
// Tree-shaped operations (`split`, `closePane`, `movePane`, `setRatio`)
// delegate to `tree.ts`'s pure functions for the actual tree surgery; this
// module's job on top of them is exactly the one `tree.ts` can't do itself
// (see its header comment): guarding a `sessionId` against appearing in more
// than one *workspace's* tree, and threading focus/maximize state.

import type { SessionId, SessionStatus, SessionSummary } from '@termhub/shared';

import {
  closePane as closePaneInTree,
  collectSessionIds,
  movePane as movePaneInTree,
  setRatio as setRatioInTree,
  splitPane as splitPaneInTree,
  type MoveEdge,
  type PaneNode,
  type SplitDirection,
} from './tree.js';

export interface Workspace {
  id: string;
  name: string;
  /** The directory new sessions created in this workspace (split, or the workspace's own initial session) are spawned in — `session-actions.ts`'s job to pass along to `session.create`. */
  cwd: string;
  /** `null` when every pane has been closed — the workspace/tab itself still exists (closing the tab is `closeWorkspace`, a separate action). */
  root: PaneNode | null;
  focusedSessionId: SessionId | undefined;
  /** Set while this workspace is showing exactly one pane "tela cheia" (docs/plan.md section 2, the prototype's `.pane.solo`) via `toggleMaximize`. Always one of the tree's current leaves, or `undefined`. */
  maximizedSessionId: SessionId | undefined;
}

export interface StoreState {
  /** Ordered — this order *is* the tab order (`reorderWorkspaces` mutates it directly). */
  workspaces: Workspace[];
  activeWorkspaceId: string | undefined;
  /** Session metadata as reported by the daemon (`session.list`/`session.create`/`session.attach` results, `upsertSession`'s job to keep current) — what the tab bar, sidebar and pane header render. Not every session here is necessarily in some workspace's tree (a session can exist in the daemon with no pane showing it, e.g. right after `closePaneAction` — see `session-actions.ts`). */
  sessions: Record<SessionId, SessionSummary>;
}

function findWorkspace(state: StoreState, workspaceId: string): Workspace | undefined {
  return state.workspaces.find((w) => w.id === workspaceId);
}

function replaceWorkspace(state: StoreState, workspaceId: string, next: Workspace): StoreState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? next : w)),
  };
}

/** Whether `sessionId` is currently a leaf in *any* workspace's tree — the cross-workspace half of armadilha 1 (`tree.ts`'s header comment covers the within-one-tree half). */
function isSessionPlaced(state: StoreState, sessionId: SessionId): boolean {
  return state.workspaces.some((w) => collectSessionIds(w.root).has(sessionId));
}

// ---------------------------------------------------------------------------
// Tree reducers
// ---------------------------------------------------------------------------

/**
 * Splits `targetSessionId`'s pane in workspace `workspaceId`, inserting a
 * new leaf for `newSessionId`. Rejects (returns `state` unchanged) when the
 * workspace doesn't exist, `targetSessionId` isn't a leaf in it,
 * `newSessionId` is already a leaf *anywhere* — this workspace or any other
 * (armadilha 1) — or the workspace has no tree yet (`root: null`; use
 * `addWorkspace`/direct assignment to seed the first pane instead). On
 * success, the new leaf becomes focused.
 */
export function splitInWorkspace(
  state: StoreState,
  workspaceId: string,
  targetSessionId: SessionId,
  newSessionId: SessionId,
  dir: SplitDirection,
  newNodeId: string,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  if (isSessionPlaced(state, newSessionId)) {
    return state;
  }
  const outcome = splitPaneInTree(workspace.root, targetSessionId, newSessionId, dir, newNodeId);
  if (!outcome.ok) {
    return state;
  }
  return replaceWorkspace(state, workspaceId, {
    ...workspace,
    root: outcome.root,
    focusedSessionId: newSessionId,
  });
}

/**
 * Removes `sessionId`'s pane from workspace `workspaceId`'s tree.
 * **Never sends anything to the daemon** — the session stays alive,
 * unattached, in `state.sessions` for M4.4/M4.5's graveyard to manage later
 * (M3.1's prompt, section 3.3 and armadilha 5; the daemon call, if any, is
 * `session-actions.ts`'s `closePaneAction`'s job, and it deliberately never
 * makes one). If the closed pane was focused, focus moves to the neighboring
 * leaf `tree.ts`'s `closePane` reports; if it was maximized, maximize is
 * cleared. Rejects (returns `state` unchanged) when the workspace or the
 * pane doesn't exist.
 */
export function closePaneInWorkspace(
  state: StoreState,
  workspaceId: string,
  sessionId: SessionId,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  const outcome = closePaneInTree(workspace.root, sessionId);
  if (!outcome.ok) {
    return state;
  }
  return replaceWorkspace(state, workspaceId, {
    ...workspace,
    root: outcome.root,
    focusedSessionId:
      workspace.focusedSessionId === sessionId ? outcome.nextFocus : workspace.focusedSessionId,
    maximizedSessionId:
      workspace.maximizedSessionId === sessionId ? undefined : workspace.maximizedSessionId,
  });
}

/**
 * Moves `sourceSessionId`'s pane to `edge` of `targetSessionId`'s pane,
 * both within workspace `workspaceId` — moving a pane to a *different*
 * workspace is explicitly out of scope (M3.1's prompt, section 3.1). Rejects
 * (returns `state` unchanged) when the workspace doesn't exist or
 * `tree.ts`'s `movePane` rejects (source/target missing, or
 * `source === target`).
 */
export function movePaneInWorkspace(
  state: StoreState,
  workspaceId: string,
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
  edge: MoveEdge,
  newNodeId: string,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  const outcome = movePaneInTree(workspace.root, sourceSessionId, targetSessionId, edge, newNodeId);
  if (!outcome.ok) {
    return state;
  }
  return replaceWorkspace(state, workspaceId, { ...workspace, root: outcome.root });
}

/** Sets a split node's `ratio` in workspace `workspaceId`'s tree (M3.2's divider drag). Rejects (returns `state` unchanged) when the workspace or the node doesn't exist. `ratio` survives split/close/move on other branches because it lives on the tree node itself, not in any component's local state (M3.1's prompt, armadilha 4). */
export function setRatioInWorkspace(
  state: StoreState,
  workspaceId: string,
  nodeId: string,
  ratio: number,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  const outcome = setRatioInTree(workspace.root, nodeId, ratio);
  if (!outcome.ok) {
    return state;
  }
  return replaceWorkspace(state, workspaceId, { ...workspace, root: outcome.root });
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * Focuses `sessionId`'s pane within workspace `workspaceId`, and makes that
 * workspace the active one — matching the prototype's `focusPane(wsId,
 * paneId)` (both the sidebar and clicking a pane call the same function,
 * switching tabs when needed). Rejects (returns `state` unchanged) when the
 * workspace doesn't exist or `sessionId` isn't one of its current leaves.
 */
export function focusPane(
  state: StoreState,
  workspaceId: string,
  sessionId: SessionId,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  if (!collectSessionIds(workspace.root).has(sessionId)) {
    return state;
  }
  const withFocus = replaceWorkspace(state, workspaceId, {
    ...workspace,
    focusedSessionId: sessionId,
  });
  return withFocus.activeWorkspaceId === workspaceId
    ? withFocus
    : { ...withFocus, activeWorkspaceId: workspaceId };
}

/** Toggles `sessionId`'s pane as workspace `workspaceId`'s solo/"tela cheia" pane (docs/plan.md section 2). Calling it again on the same session un-maximizes. Rejects (returns `state` unchanged) when the workspace doesn't exist or `sessionId` isn't one of its current leaves. */
export function toggleMaximize(
  state: StoreState,
  workspaceId: string,
  sessionId: SessionId,
): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  if (!collectSessionIds(workspace.root).has(sessionId)) {
    return state;
  }
  const maximizedSessionId = workspace.maximizedSessionId === sessionId ? undefined : sessionId;
  return replaceWorkspace(state, workspaceId, { ...workspace, maximizedSessionId });
}

// ---------------------------------------------------------------------------
// Workspace (tab) CRUD
// ---------------------------------------------------------------------------

/**
 * Appends `workspace` and, unless `opts.activate` is explicitly `false`,
 * makes it the active one. Rejects (returns `state` unchanged) when a
 * workspace with the same `id` already exists, or when any session already
 * placed in `workspace.root` is also placed in an existing workspace
 * (armadilha 1, at creation time — `session-boot.ts`'s multi-session boot
 * path is the main caller that could otherwise violate this).
 */
export function addWorkspace(
  state: StoreState,
  workspace: Workspace,
  opts: { activate?: boolean } = {},
): StoreState {
  if (findWorkspace(state, workspace.id) !== undefined) {
    return state;
  }
  for (const sessionId of collectSessionIds(workspace.root)) {
    if (isSessionPlaced(state, sessionId)) {
      return state;
    }
  }
  const workspaces = [...state.workspaces, workspace];
  const activeWorkspaceId = opts.activate === false ? state.activeWorkspaceId : workspace.id;
  return { ...state, workspaces, activeWorkspaceId };
}

/**
 * Removes workspace `workspaceId` entirely — its panes' sessions are left
 * exactly as `closePaneInWorkspace` would leave them (untouched in
 * `state.sessions`, no daemon call): removing a workspace never implies
 * closing/killing anything at the session level. If it was the active
 * workspace, the first remaining one (in tab order) becomes active, or
 * `undefined` if none remain. Rejects (returns `state` unchanged) when the
 * workspace doesn't exist.
 */
export function closeWorkspace(state: StoreState, workspaceId: string): StoreState {
  if (findWorkspace(state, workspaceId) === undefined) {
    return state;
  }
  const workspaces = state.workspaces.filter((w) => w.id !== workspaceId);
  const activeWorkspaceId =
    state.activeWorkspaceId === workspaceId ? workspaces[0]?.id : state.activeWorkspaceId;
  return { ...state, workspaces, activeWorkspaceId };
}

/** Switches the active workspace without touching focus inside it. Rejects (returns `state` unchanged) when the workspace doesn't exist, or is already active (a true no-op, kept referentially stable for cheap Zustand subscriptions). */
export function setActiveWorkspace(state: StoreState, workspaceId: string): StoreState {
  if (findWorkspace(state, workspaceId) === undefined) {
    return state;
  }
  if (state.activeWorkspaceId === workspaceId) {
    return state;
  }
  return { ...state, activeWorkspaceId: workspaceId };
}

/**
 * Reorders the tab strip to exactly `workspaceIds` (M3.6's tab drag). Rejects
 * (returns `state` unchanged) unless `workspaceIds` is a permutation of the
 * current workspace ids — same length, no duplicates, every id already
 * present. A partial or foreign list is refused outright rather than
 * partially applied.
 */
export function reorderWorkspaces(state: StoreState, workspaceIds: readonly string[]): StoreState {
  const currentIds = state.workspaces.map((w) => w.id);
  if (workspaceIds.length !== currentIds.length) {
    return state;
  }
  const currentSet = new Set(currentIds);
  const seen = new Set<string>();
  for (const id of workspaceIds) {
    if (!currentSet.has(id) || seen.has(id)) {
      return state;
    }
    seen.add(id);
  }
  const byId = new Map(state.workspaces.map((w) => [w.id, w] as const));
  const workspaces = workspaceIds.map((id) => byId.get(id) as Workspace);
  return { ...state, workspaces };
}

/** Renames workspace `workspaceId`. Rejects (returns `state` unchanged) when it doesn't exist. */
export function renameWorkspace(state: StoreState, workspaceId: string, name: string): StoreState {
  const workspace = findWorkspace(state, workspaceId);
  if (workspace === undefined) {
    return state;
  }
  return replaceWorkspace(state, workspaceId, { ...workspace, name });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Inserts or replaces `session`'s metadata, keyed by `session.id`. This is the only reducer that ever writes `state.sessions` — `session-actions.ts` calls it right after a `session.create`/`session.list` round trip settles. */
export function upsertSession(state: StoreState, session: SessionSummary): StoreState {
  return { ...state, sessions: { ...state.sessions, [session.id]: session } };
}

/** Drops `sessionId`'s metadata. Does **not** touch any workspace's tree — a caller closing a session for real (M4's graveyard reaping it past its TTL) is expected to have already removed its pane via `closePaneInWorkspace`, if it had one. Rejects (returns `state` unchanged) when the session isn't present. */
export function removeSession(state: StoreState, sessionId: SessionId): StoreState {
  if (!(sessionId in state.sessions)) {
    return state;
  }
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  return { ...state, sessions };
}

// ---------------------------------------------------------------------------
// Selector helpers used only by `selectors.ts` (kept here to share
// `findWorkspace`/`isSessionPlaced` without exporting them)
// ---------------------------------------------------------------------------

export function statusOf(state: StoreState, sessionId: SessionId): SessionStatus | undefined {
  return state.sessions[sessionId]?.status;
}

export { findWorkspace };
