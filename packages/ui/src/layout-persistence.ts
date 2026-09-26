// M4.3: pure projection/reconciliation between the store's live state
// (`store/workspace.ts`'s `StoreState`) and the persisted `WorkspacesFile`
// (`@termhub/shared`'s `config-schema.ts`, M4.1). No DOM, no bridge, no
// Zustand — both directions are plain functions over plain data, so
// `layout-persistence.test.ts` drives them directly, and the round trip
// (store -> file -> store) is a single, deterministic assertion.
//
// `packages/app/src/renderer/src/session-boot.ts` is the only caller: it
// loads the file (`window.termhub.loadLayout()`), reconciles it against
// `session.list`'s live sessions, and — only when `reconcileLayout` reports
// `needsFreshSessionInWorkspaceId` (rule 6 below) — calls `session.create`
// itself, since this module never touches the daemon or any bridge.

import type { SessionId, SessionSummary } from '@termhub/shared';
import type { PersistedPaneNode, PersistedWorkspace, WorkspacesFile } from '@termhub/shared';

import {
  closePane,
  collectSessionIds,
  treeFromSessions,
  treeLeaves,
  type PaneNode,
} from './store/tree.js';
import type { StoreState, Workspace } from './store/workspace.js';

/**
 * The workspace new orphaned live sessions land in — rule 4: "sessão viva
 * que não está em nenhuma folha ... vai para um workspace 'Recuperadas',
 * criado só quando há órfãs." A fixed id/name, not a generated one, so this
 * module stays deterministic without a `crypto.randomUUID()` dependency —
 * same reasoning `session-boot.ts`'s `DEFAULT_WORKSPACE_ID` already uses.
 * Collides only if a real persisted workspace happens to use this exact id,
 * which nothing in this codebase does today.
 */
export const RECOVERED_WORKSPACE_ID = 'recovered';
export const RECOVERED_WORKSPACE_NAME = 'Recuperadas';
/** Used only when every orphan is missing its own `cwd` somehow — defensive, not expected to trigger in practice since `SessionSummary.cwd` is required. */
export const RECOVERED_WORKSPACE_CWD_FALLBACK = 'C:\\';

// ---------------------------------------------------------------------------
// toPersistedLayout — store -> file
// ---------------------------------------------------------------------------

/**
 * Projects the store's current state into the `WorkspacesFile` shape M4.1's
 * `StateFile<WorkspacesFile>` persists. Workspaces are emitted in their
 * current tab order (`state.workspaces` order *is* tab order —
 * `store/workspace.ts`'s own doc comment). `maximizedSessionId` is
 * deliberately **not** persisted (the prompt's decision, section 2): it is
 * transient "tela cheia" UI state, not part of the saved layout.
 *
 * A leaf's `sessionCreatedAt` comes from `state.sessions[sessionId]
 * .createdAt` — always present in practice, since a session only ever
 * becomes a leaf via a `session.create`/`session.attach` round trip that
 * also calls `upsertSession` first (M3.1's own invariant). Falls back to `0`
 * rather than throwing if it is ever missing, so a caller with a
 * momentarily-inconsistent store never crashes on save; a leaf persisted
 * this way simply never matches a live session on the next boot (its
 * `sessionCreatedAt` can't collide with a real epoch-millisecond timestamp),
 * which is the safe failure mode — it will be treated as dead, not as a
 * false match.
 */
export function toPersistedLayout(state: StoreState): WorkspacesFile {
  const workspaces: PersistedWorkspace[] = state.workspaces.map((workspace) =>
    toPersistedWorkspace(workspace, state.sessions),
  );
  return {
    version: 1,
    ...(state.activeWorkspaceId !== undefined
      ? { activeWorkspaceId: state.activeWorkspaceId }
      : {}),
    workspaces,
  };
}

function toPersistedWorkspace(
  workspace: Workspace,
  sessions: Record<SessionId, SessionSummary>,
): PersistedWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    cwd: workspace.cwd,
    root: workspace.root === null ? null : toPersistedNode(workspace.root, sessions),
    ...(workspace.focusedSessionId !== undefined
      ? { focusedSessionId: workspace.focusedSessionId }
      : {}),
  };
}

function toPersistedNode(
  node: PaneNode,
  sessions: Record<SessionId, SessionSummary>,
): PersistedPaneNode {
  if (node.kind === 'leaf') {
    return {
      kind: 'leaf',
      sessionId: node.sessionId,
      sessionCreatedAt: sessions[node.sessionId]?.createdAt ?? 0,
    };
  }
  return {
    kind: 'split',
    id: node.id,
    dir: node.dir,
    ratio: node.ratio,
    a: toPersistedNode(node.a, sessions),
    b: toPersistedNode(node.b, sessions),
  };
}

// ---------------------------------------------------------------------------
// reconcileLayout — file + session.list -> initial store state
// ---------------------------------------------------------------------------

export interface ReconcileRestored {
  kind: 'restored';
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * Set only under rule 6: `liveSessions` was empty (the daemon restarted),
   * so every workspace's tree collapsed to `root: null` — nothing survived
   * to reconcile against. The caller must create exactly **one** new
   * session in this workspace (the same `session.create` the M2.6 boot
   * uses) before hydrating the store, or every pane would start empty.
   */
  needsFreshSessionInWorkspaceId?: string;
}

/**
 * `reconcileLayout`'s result. `'fresh-boot'` (rule 5) means: no file, or a
 * file with zero workspaces — the caller falls back to exactly today's
 * (M2.6) boot policy, unmodified. This module has no opinion on what that
 * policy does; it only reports that there is nothing of its own to restore.
 */
export type ReconcileOutcome = { kind: 'fresh-boot' } | ReconcileRestored;

/**
 * Reconciles a persisted `WorkspacesFile` against the daemon's current
 * `session.list` result (`liveSessions`) into the store's initial state.
 * Pure: no daemon/bridge access anywhere in this function — see this file's
 * header comment for who calls `session.create` when rule 6 applies.
 *
 * Rules (docs/milestones.md M4.3 / this task's prompt, section 2):
 *
 * 1. A persisted leaf survives only when a live session matches it by
 *    **both** `sessionId` and `sessionCreatedAt` (a same-id, different-
 *    `createdAt` session is a different, unrelated one after a daemon
 *    restart — never a match). A leaf that doesn't survive is removed via
 *    `tree.ts`'s own `closePane`, which is what collapses its parent
 *    correctly (surviving sibling keeps its own `id`/`ratio` — M3.1's
 *    armadilha 2), reused here rather than reimplemented.
 * 2. A workspace whose tree collapses entirely (`root: null`) still exists,
 *    with its `name`/`cwd` intact. Relaunching a session into it is M4.7's
 *    job, not this one's.
 * 3. `focusedSessionId` that no longer names a surviving leaf becomes the
 *    first surviving leaf (`treeLeaves` order), or `undefined` if none
 *    survived. `activeWorkspaceId` that is missing, or that named a
 *    workspace that (per rule 2) still always exists but — defensively —
 *    is checked anyway, becomes the first workspace in file order.
 * 4. A live session that ends up placed in no workspace at all (an
 *    "orphan" — e.g. a pane closed before the graveyard UI existed) is
 *    collected into one `RECOVERED_WORKSPACE_ID` workspace, created only
 *    when at least one orphan exists.
 * 5. See `ReconcileOutcome`'s doc comment.
 * 6. See `ReconcileRestored.needsFreshSessionInWorkspaceId`'s doc comment.
 *    This can only apply when `liveSessions` is empty — with any live
 *    session present, an unplaced one is rule 4's orphan case instead.
 */
export function reconcileLayout(
  file: WorkspacesFile | undefined,
  liveSessions: readonly SessionSummary[],
): ReconcileOutcome {
  if (file === undefined || file.workspaces.length === 0) {
    return { kind: 'fresh-boot' };
  }

  const liveCreatedAtById = new Map<SessionId, number>(
    liveSessions.map((session) => [session.id, session.createdAt]),
  );
  const placed = new Set<SessionId>();

  const workspaces: Workspace[] = file.workspaces.map((persisted) =>
    reconcileWorkspace(persisted, liveCreatedAtById, placed),
  );

  const orphans = liveSessions.filter((session) => !placed.has(session.id));
  if (orphans.length > 0) {
    workspaces.push(buildRecoveredWorkspace(orphans));
  }

  const firstWorkspace = workspaces[0];
  if (firstWorkspace === undefined) {
    // Unreachable: `file.workspaces.length === 0` was already handled above,
    // and `workspaces` starts as a 1:1 map over `file.workspaces` before any
    // orphan workspace is appended, so it always has at least one entry
    // here.
    throw new Error('layout-persistence: invariant violated — no workspaces after reconciliation');
  }
  const activeWorkspaceId =
    file.activeWorkspaceId !== undefined &&
    workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : firstWorkspace.id;

  if (liveSessions.length === 0) {
    return {
      kind: 'restored',
      workspaces,
      activeWorkspaceId,
      needsFreshSessionInWorkspaceId: activeWorkspaceId,
    };
  }

  return { kind: 'restored', workspaces, activeWorkspaceId };
}

function reconcileWorkspace(
  persisted: PersistedWorkspace,
  liveCreatedAtById: ReadonlyMap<SessionId, number>,
  placed: Set<SessionId>,
): Workspace {
  let root = toLiveNode(persisted.root);
  for (const deadId of deadLeafIds(persisted.root, liveCreatedAtById)) {
    if (root === null) {
      break;
    }
    const outcome = closePane(root, deadId);
    if (outcome.ok) {
      root = outcome.root;
    }
  }

  for (const sessionId of collectSessionIds(root)) {
    placed.add(sessionId);
  }

  const leaves = treeLeaves(root);
  const focusedSessionId = leaves.some((leaf) => leaf.sessionId === persisted.focusedSessionId)
    ? persisted.focusedSessionId
    : leaves[0]?.sessionId;

  return {
    id: persisted.id,
    name: persisted.name,
    cwd: persisted.cwd,
    root,
    focusedSessionId,
    maximizedSessionId: undefined,
  };
}

function buildRecoveredWorkspace(orphans: readonly SessionSummary[]): Workspace {
  const ids = orphans.map((session) => session.id);
  return {
    id: RECOVERED_WORKSPACE_ID,
    name: RECOVERED_WORKSPACE_NAME,
    cwd: orphans[0]?.cwd ?? RECOVERED_WORKSPACE_CWD_FALLBACK,
    root: treeFromSessions(ids, RECOVERED_WORKSPACE_ID),
    focusedSessionId: ids[0],
    maximizedSessionId: undefined,
  };
}

/** Strips `sessionCreatedAt` (the persisted-only field) to get a plain `PaneNode` `tree.ts` can operate on. Liveness itself is decided by `deadLeafIds`, not here — this is pure reshaping. */
function toLiveNode(node: PersistedPaneNode): PaneNode;
function toLiveNode(node: PersistedPaneNode | null): PaneNode | null;
function toLiveNode(node: PersistedPaneNode | null): PaneNode | null {
  if (node === null) {
    return null;
  }
  if (node.kind === 'leaf') {
    return { kind: 'leaf', sessionId: node.sessionId };
  }
  return {
    kind: 'split',
    id: node.id,
    dir: node.dir,
    ratio: node.ratio,
    a: toLiveNode(node.a),
    b: toLiveNode(node.b),
  };
}

/** Every leaf `sessionId` in `node` whose live session is missing, or whose `createdAt` doesn't match (rule 1's id+createdAt requirement — a same-id session from a different daemon lifetime is not a match). */
function deadLeafIds(
  node: PersistedPaneNode | null,
  liveCreatedAtById: ReadonlyMap<SessionId, number>,
): SessionId[] {
  const ids: SessionId[] = [];
  function recur(current: PersistedPaneNode | null): void {
    if (current === null) {
      return;
    }
    if (current.kind === 'leaf') {
      const createdAt = liveCreatedAtById.get(current.sessionId);
      if (createdAt === undefined || createdAt !== current.sessionCreatedAt) {
        ids.push(current.sessionId);
      }
      return;
    }
    recur(current.a);
    recur(current.b);
  }
  recur(node);
  return ids;
}
