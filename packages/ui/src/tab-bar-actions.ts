// Pure/testable logic behind `TabBar.tsx`'s two non-trivial behaviors
// (M3.3's prompt, section 4.A): which tab's `x` is allowed to close, and
// what the `+` button hands off to `session-actions.ts`'s
// `createWorkspaceWithNewSession`. Kept out of the component itself so
// these can be unit-tested in a plain `node` environment, no DOM, no React
// — the same reasoning `session-actions.ts`'s own header comment gives for
// living outside `store.ts`.

import type { SessionSummary } from '@termhub/shared';

import {
  createWorkspaceWithNewSession,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
  type Size,
} from './store/session-actions.js';
import type { Workspace } from './store/workspace.js';

/**
 * The last remaining workspace can never be closed (M3.3's prompt, section
 * 2: "o último workspace restante não pode ser fechado") — there is always
 * at least one tab, so there is always somewhere for the grid area to
 * render. This is enforced here, in the UI layer, not in
 * `store/workspace.ts`'s `closeWorkspace` reducer itself: that reducer
 * happily empties `workspaces` to `[]` if asked to (see its doc comment —
 * it only guards against closing an *unknown* workspace), because nothing
 * about the tree/workspace bookkeeping *requires* at least one tab to
 * exist. "Always one tab" is a tab-bar policy, not a store invariant, so it
 * belongs on this side of the boundary — `store/workspace.ts` is out of
 * this task's file scope regardless (see the task prompt's fronteiras).
 */
export function canCloseWorkspace(workspaceCount: number): boolean {
  return workspaceCount > 1;
}

/**
 * The minimal slice of `TermhubStore` the tab bar's `x` needs: just
 * `closeWorkspace`. Deliberately not `SessionActionsStoreApi` (which also
 * exposes `upsertSession`/`split`/`addWorkspace`/`closePane`) — narrowing
 * the type here is what makes armadilha 1 (M3.3's prompt: "fechar aba não
 * fecha sessão") checkable by inspection: this function has no way to call
 * anything session-related, closer than an `eslint-disable` or a comment
 * promising not to.
 */
export interface CloseWorkspaceStoreApi {
  closeWorkspace: (workspaceId: string) => void;
}

/**
 * Closes `workspaceId`'s tab — **never** the sessions inside it. Calls only
 * `store.closeWorkspace`, exactly once, and only when `canCloseWorkspace`
 * allows it (this call's own `workspaceCount` — the tab count *before* this
 * close, i.e. `workspaces.length` at click time). No `bridge` parameter
 * exists on this function at all, by design: there is nothing here that
 * could reach the daemon even by mistake (mirrors `session-actions.ts`'s
 * `closePaneAction`, one level up — workspace instead of pane).
 */
export function closeWorkspaceTab(
  store: CloseWorkspaceStoreApi,
  workspaceId: string,
  workspaceCount: number,
): void {
  if (!canCloseWorkspace(workspaceCount)) {
    return;
  }
  store.closeWorkspace(workspaceId);
}

/** Fallback shell/cwd/size for a workspace born from the tab bar's `+` with no better guess available — mirrors `packages/app/src/renderer/src/session-boot.ts`'s `DEFAULT_CWD` and its own fresh-session size guess. Duplicated rather than imported for the same reason `session-actions.ts`'s `NEW_SESSION_SHELL` already duplicates `DEFAULT_SHELL`: `@termhub/ui` must not depend on `@termhub/app` (session-actions.ts's header comment). Real shell/cwd detection is M4.6/M4.7's job. */
export const NEW_WORKSPACE_CWD_FALLBACK = 'C:\\';
export const NEW_WORKSPACE_SIZE: Size = { cols: 80, rows: 24 };
export const NEW_WORKSPACE_NAME_BASE = 'Novo workspace';

/**
 * Picks a workspace id that doesn't collide with any id already in
 * `existingIds` — `createWorkspaceWithNewSession`'s `addWorkspace` call
 * silently no-ops on a colliding id (`workspace.ts`'s `addWorkspace` doc
 * comment), which would make the tab bar's `+` button do nothing with no
 * error. `ws-` prefix keeps generated ids visibly distinct from
 * `session-boot.ts`'s `'default'` and from any workspace id a future
 * persisted-layout load (M4.3) might reuse.
 */
export function generateWorkspaceId(existingIds: readonly string[]): string {
  const existing = new Set(existingIds);
  let n = existing.size + 1;
  let candidate = `ws-${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `ws-${n}`;
  }
  return candidate;
}

/**
 * Picks a display name that doesn't collide with any name already in
 * `existingNames` — `"Novo workspace"`, then `"Novo workspace 2"`,
 * `"Novo workspace 3"`, ... Collisions aren't rejected anywhere in the
 * store (two workspaces can legally share a `name`), so this is purely
 * cosmetic: it keeps repeated clicks on `+` from producing a tab bar full
 * of indistinguishable "Novo workspace" tabs.
 */
export function nextWorkspaceName(existingNames: readonly string[]): string {
  const existing = new Set(existingNames);
  if (!existing.has(NEW_WORKSPACE_NAME_BASE)) {
    return NEW_WORKSPACE_NAME_BASE;
  }
  let n = 2;
  let candidate = `${NEW_WORKSPACE_NAME_BASE} ${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${NEW_WORKSPACE_NAME_BASE} ${n}`;
  }
  return candidate;
}

/**
 * What the tab bar's `+` button triggers (M3.3's prompt, section 2): builds
 * a fresh, non-colliding `workspaceId`/`name`, picks a `cwd` (the currently
 * active workspace's own `cwd`, when there is one — a new tab next to an
 * existing project most often belongs in the same place; falls back to
 * `NEW_WORKSPACE_CWD_FALLBACK` otherwise) and a fixed size guess
 * (`NEW_WORKSPACE_SIZE` — corrected for real once the pane mounts and
 * `fit()` runs, same posture as `session-actions.ts`'s `estimateSplitSize`
 * doc comment), then delegates to `createWorkspaceWithNewSession` for the
 * actual `session.create` round trip plus the `upsertSession`/`addWorkspace`
 * store writes.
 *
 * `session-actions.ts`'s `createWorkspaceWithNewSession` does **not**
 * decide the name/cwd/size itself — it takes them as params. This
 * function is the piece of policy that this task's own prompt assumed
 * lived inside that action (see this task's final report for the
 * discrepancy) but actually has to live on the caller's side.
 */
export async function createWorkspaceTab(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  activeWorkspace: Pick<Workspace, 'cwd'> | undefined,
): Promise<SessionSummary> {
  const state = store.getState();
  const workspaceId = generateWorkspaceId(state.workspaces.map((w) => w.id));
  const name = nextWorkspaceName(state.workspaces.map((w) => w.name));
  const cwd = activeWorkspace?.cwd ?? NEW_WORKSPACE_CWD_FALLBACK;
  return createWorkspaceWithNewSession(store, bridge, {
    workspaceId,
    name,
    cwd,
    size: NEW_WORKSPACE_SIZE,
  });
}
