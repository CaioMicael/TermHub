// Async actions that combine a daemon RPC with a store mutation — the layer
// M3.3 (tab bar's `+`) and M3.4 (pane header's "dividir") call into (M3.1's
// prompt, section 3.3). Kept separate from `store.ts` because these are not
// pure: they await a real round trip to the daemon before touching the
// store, and they own a policy decision (default shell/cwd, size estimate)
// that has nothing to do with tree/workspace bookkeeping.
//
// `SessionActionsBridge` below is a minimal, locally-typed slice of
// `window.termhub` — the same "small structural interface" approach
// `terminal-session.ts`'s `TerminalBridge` and `packages/app/src/renderer/
// src/session-boot.ts`'s `SessionBootBridge` already use, so `@termhub/ui`
// never has to import anything from `@termhub/app`.

import type { SessionCreateParams, SessionId, SessionSummary } from '@termhub/shared';

import type { SplitDirection } from './tree.js';
import type { StoreState, Workspace } from './workspace.js';

/**
 * The shell every session this module creates is spawned with. Mirrors
 * `packages/app/src/renderer/src/session-boot.ts`'s `DEFAULT_SHELL` — same
 * value, same reasoning (M3.1's prompt, section 3.3: "a sessão nova nasce com
 * shell ... iguais aos do session-boot.ts atual (powershell.exe fixo)").
 * Duplicated rather than imported because `@termhub/ui` must not depend on
 * `@termhub/app` (the dependency direction is the other way). Real shell
 * detection is M4.6's `profiles.ts` — same deferred gap `session-boot.ts`
 * already documents, not reinvented here.
 */
export const NEW_SESSION_SHELL = 'powershell.exe';

/** Every RPC method this module calls, keyed to its real params/result shape (`@termhub/shared`'s `protocol.ts`). */
export interface SessionActionsRequestParams {
  'session.create': SessionCreateParams;
}
export interface SessionActionsRequestResult {
  'session.create': { session: SessionSummary };
}
export type SessionActionsMethod = keyof SessionActionsRequestParams;

export interface SessionActionsBridge {
  request<M extends SessionActionsMethod>(
    method: M,
    params: SessionActionsRequestParams[M],
  ): Promise<SessionActionsRequestResult[M]>;
}

/**
 * The minimal slice of `TermhubStore` (`store.ts`) these actions need:
 * enough to read current state and apply the two mutations that follow a
 * successful `session.create`. `useTermhubStore` (the real Zustand hook) is
 * structurally assignable to this — it has `getState()` plus every action
 * method below — so no adapter is needed at the call site.
 */
export interface SessionActionsStoreApi {
  getState(): StoreState;
  upsertSession(session: SessionSummary): void;
  split(
    workspaceId: string,
    targetSessionId: SessionId,
    newSessionId: SessionId,
    dir: SplitDirection,
    newNodeId: string,
  ): void;
  addWorkspace(workspace: Workspace, opts?: { activate?: boolean }): void;
  closePane(workspaceId: string, sessionId: SessionId): void;
}

export interface Size {
  cols: number;
  rows: number;
}

/**
 * Estimates the size a new pane is born with when splitting an existing one:
 * the split pane's own current size, halved along the split's axis (M3.1's
 * prompt, section 3.3) — `row` (side-by-side panes) halves `cols`; `column`
 * (stacked panes) halves `rows`. This is only ever a first guess: M2.5's
 * `ResizeObserver` → `fit()` → `session.resize` flow corrects it for real
 * once the pane actually mounts and measures its pixel box, the same way it
 * already corrects a freshly-created solo session's guess today. Floored at
 * 1 so a very narrow/short existing pane never asks the daemon to create a
 * session with 0 cols/rows.
 */
export function estimateSplitSize(existing: Size, dir: SplitDirection): Size {
  if (dir === 'row') {
    return { cols: Math.max(1, Math.floor(existing.cols / 2)), rows: existing.rows };
  }
  return { cols: existing.cols, rows: Math.max(1, Math.floor(existing.rows / 2)) };
}

/**
 * Creates a new session and splits `targetSessionId`'s pane in
 * `workspaceId` to show it, in direction `dir`. The new session's shell is
 * `NEW_SESSION_SHELL`; its cwd is the *workspace's* `cwd` (M3.1's prompt,
 * section 3.3 — not the target pane's own cwd, which this store doesn't
 * track per-session beyond what `SessionSummary.cwd` already reports, and
 * which M4.6 may revisit). Its `cols`/`rows` come from `estimateSplitSize`
 * against the target session's current `SessionSummary`, or a plain 80x24
 * guess if that session's metadata isn't in the store yet.
 *
 * On the daemon accepting the session, this: (1) `upsertSession`s the new
 * session's metadata, then (2) `split`s the tree — in that order, so by the
 * time the new leaf exists in the tree, `selectAggregatedWorkspaceStatus`
 * and friends can already resolve its status. If `split` itself rejects
 * (e.g. `targetSessionId` no longer exists in the tree — closed by the time
 * this resolves), the session is left alive in the daemon and in
 * `state.sessions`, unattached to any pane; nothing here retries or cleans
 * it up (same "closing never kills a session" posture as `closePaneAction`
 * below — a session with no pane is exactly what M4's cemetery is for,
 * eventually).
 *
 * Throws if `workspaceId` doesn't name a workspace in the current store
 * state — there is no `cwd` to spawn into otherwise. Propagates a rejected
 * `session.create` unchanged.
 */
export async function splitPaneWithNewSession(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  params: {
    workspaceId: string;
    targetSessionId: SessionId;
    dir: SplitDirection;
    newNodeId: string;
  },
): Promise<SessionSummary> {
  const state = store.getState();
  const workspace = state.workspaces.find((w) => w.id === params.workspaceId);
  if (workspace === undefined) {
    throw new Error(`splitPaneWithNewSession: unknown workspace "${params.workspaceId}"`);
  }
  const targetSession = state.sessions[params.targetSessionId];
  const sizeHint = estimateSplitSize(
    targetSession !== undefined
      ? { cols: targetSession.cols, rows: targetSession.rows }
      : { cols: 80, rows: 24 },
    params.dir,
  );

  const { session } = await bridge.request('session.create', {
    shell: NEW_SESSION_SHELL,
    cwd: workspace.cwd,
    cols: sizeHint.cols,
    rows: sizeHint.rows,
  });

  store.upsertSession(session);
  store.split(params.workspaceId, params.targetSessionId, session.id, params.dir, params.newNodeId);
  return session;
}

/**
 * Creates a new session and a brand-new workspace whose sole pane shows it
 * (M3.1's prompt, section 3.3 — the tab bar's `+`, M3.3's job to call this).
 * `params.workspaceId` must not already name an existing workspace (checked
 * by the underlying `addWorkspace` reducer — a collision leaves the session
 * created in the daemon but not placed in any workspace, same "no retry, no
 * cleanup" posture as `splitPaneWithNewSession`).
 */
export async function createWorkspaceWithNewSession(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  params: { workspaceId: string; name: string; cwd: string; size: Size },
): Promise<SessionSummary> {
  const { session } = await bridge.request('session.create', {
    shell: NEW_SESSION_SHELL,
    cwd: params.cwd,
    cols: params.size.cols,
    rows: params.size.rows,
  });

  store.upsertSession(session);
  store.addWorkspace({
    id: params.workspaceId,
    name: params.name,
    cwd: params.cwd,
    root: { kind: 'leaf', sessionId: session.id },
    focusedSessionId: session.id,
    maximizedSessionId: undefined,
  });
  return session;
}

/**
 * Closes `sessionId`'s pane in `workspaceId` — armadilha 5 (M3.1's prompt):
 * this function calls **only** `store.closePane`, never `session.close` on
 * the daemon. The session keeps running, unattached, exactly as
 * `closePaneInWorkspace`'s own doc comment describes; M4.4/M4.5's graveyard
 * is what eventually decides its fate. Synchronous despite living in this
 * "async actions" module — kept here, not in `store.ts`, so every pane-close
 * entry point (M3.3's tab close button, M3.4's pane header close button)
 * reads this module's doc comment instead of re-deriving the "don't call
 * session.close" rule from scratch at each call site.
 */
export function closePaneAction(
  store: Pick<SessionActionsStoreApi, 'closePane'>,
  workspaceId: string,
  sessionId: SessionId,
): void {
  store.closePane(workspaceId, sessionId);
}
