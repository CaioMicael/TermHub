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

import type {
  GraveyardListParams,
  GraveyardListResult,
  ProfilesListParams,
  ProfilesListResult,
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionId,
  SessionRestoreParams,
  SessionRestoreResult,
  SessionSummary,
} from '@termhub/shared';

import type { SplitDirection } from './tree.js';
import type { StoreState, Workspace } from './workspace.js';

/**
 * Fallback shell for `splitPaneWithNewSession` when the pane being split
 * has no `SessionSummary` in the store yet (the target session's metadata
 * hasn't arrived — an edge case, not the normal path). Every other caller of
 * `session.create` in this module now takes its shell/args explicitly (a
 * `ShellProfile` for a brand-new workspace via `tab-bar-actions.ts`'s
 * profile menu, or the split target's own `shell`/`args` for a split) —
 * M4.6's second half replaced the single hardcoded shell this constant used
 * to be for every session this module created. Same value
 * `packages/app/src/renderer/src/session-boot.ts`'s `DEFAULT_SHELL` falls
 * back to, for the same reason: something has to be spawnable even with no
 * better information at all.
 */
export const NEW_SESSION_SHELL = 'powershell.exe';

/**
 * Every RPC method this module (and, by extension, everything that shares
 * its `SessionActionsBridge` type — `Sidebar.tsx`'s graveyard section and
 * `ProfileMenu.tsx`'s profile fetch included) calls, keyed to its real
 * params/result shape (`@termhub/shared`'s `protocol.ts`). `session.close`/
 * `session.restore`/`graveyard.list` are M4.5's addition on top of M3's
 * `session.create` — see `buryClosedSession` below for why `session.close`
 * is called from here rather than from `pane-header-actions.ts`/
 * `tab-bar-actions.ts`. `profiles.list` is M4.6's second half: the `+`
 * button's profile menu (`ProfileMenu.tsx`/`profile-menu-actions.ts`) needs
 * it on the same bridge object `TabBar.tsx` already threads through as a
 * prop, rather than a second bridge type.
 */
export interface SessionActionsRequestParams {
  'session.create': SessionCreateParams;
  'session.close': SessionCloseParams;
  'session.restore': SessionRestoreParams;
  'graveyard.list': GraveyardListParams;
  'profiles.list': ProfilesListParams;
}
export interface SessionActionsRequestResult {
  'session.create': { session: SessionSummary };
  'session.close': SessionCloseResult;
  'session.restore': SessionRestoreResult;
  'graveyard.list': GraveyardListResult;
  'profiles.list': ProfilesListResult;
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
 * `workspaceId` to show it, in direction `dir`. The new session's shell and
 * args are the *target pane's own* — `targetSession.shell`/`targetSession.args`
 * (M4.6's second half: a split reopens the same shell profile the split
 * pane is running, `NEW_SESSION_SHELL` only if that target session's
 * metadata isn't in the store yet, an edge case that should never happen in
 * practice). This is why `SessionSummary` grew an `args` field
 * (`packages/shared/src/protocol.ts`) alongside the `shell` it already had:
 * without `args`, splitting a WSL pane would spawn `wsl.exe` with no
 * `-d <distro>` and land in the default distro, not the one actually open.
 * Its cwd is the *workspace's* `cwd` (M3.1's prompt, section 3.3 — not the
 * target pane's own cwd, which this store doesn't track per-session beyond
 * what `SessionSummary.cwd` already reports). Its `cols`/`rows` come from
 * `estimateSplitSize` against the target session's current `SessionSummary`,
 * or a plain 80x24 guess if that session's metadata isn't in the store yet.
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
  const shell = targetSession?.shell ?? NEW_SESSION_SHELL;
  const args = targetSession?.args;

  const { session } = await bridge.request('session.create', {
    shell,
    cwd: workspace.cwd,
    cols: sizeHint.cols,
    rows: sizeHint.rows,
    ...(args !== undefined ? { args } : {}),
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
 *
 * `params.shell`/`params.args` are M4.6's second half: the caller (
 * `tab-bar-actions.ts`'s `createWorkspaceTab`) supplies the `ShellProfile`
 * the user picked from the `+` button's menu — this function no longer
 * hardcodes `NEW_SESSION_SHELL` itself, unlike before this task.
 */
export async function createWorkspaceWithNewSession(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  params: {
    workspaceId: string;
    name: string;
    cwd: string;
    size: Size;
    shell: string;
    args?: string[];
  },
): Promise<SessionSummary> {
  const { session } = await bridge.request('session.create', {
    shell: params.shell,
    cwd: params.cwd,
    cols: params.size.cols,
    rows: params.size.rows,
    ...(params.args !== undefined ? { args: params.args } : {}),
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

/**
 * M4.5's "fechar enterra": tells the daemon to bury `sessionId` in its
 * graveyard (the default TTL — this never passes `ttlMs`, since the value
 * lives in the main process's `config.json` and plumbing it to the renderer
 * is out of this task's scope, per its own report). Fire-and-forget by
 * design (`no-floating-promises`-safe: the `.catch` below is what handles
 * it, not an ignored return value) — nothing here blocks the UI on the
 * daemon's reply, and `session.close` is idempotent (`protocol.ts`'s own
 * doc comment: "Repetir o close não muda o expiresAt"), so calling it twice
 * for the same session (e.g. this module's own caller retrying) is
 * harmless.
 *
 * **Not** called from `closePaneAction`/`handleCloseClick` above — armadilha
 * 5's own test (`session-actions.test.ts`) locks `closePaneAction` to
 * *never* touch the bridge, and `PaneHeader.tsx`'s close button
 * (`pane-header-actions.ts`'s one caller) is a forbidden file whose call
 * site passes no bridge at all. `Sidebar.tsx` is this function's real
 * caller instead: it diffs the store's own tree shape on every change
 * (`graveyard-model.ts`'s `sessionsJustUnplaced`) and calls this for every
 * session that diff finds, regardless of *which* close button removed its
 * pane — see this task's final report for the full reasoning.
 */
export function buryClosedSession(
  bridge: Pick<SessionActionsBridge, 'request'>,
  sessionId: SessionId,
  onError?: (err: unknown) => void,
): void {
  bridge.request('session.close', { sessionId }).catch((err: unknown) => {
    (
      onError ??
      ((error: unknown) => {
        console.error('buryClosedSession: falha ao enterrar sessão no daemon', sessionId, error);
      })
    )(err);
  });
}
