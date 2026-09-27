// M4.3: pure projection/reconciliation between the store's live state
// (`store/workspace.ts`'s `StoreState`) and the persisted `WorkspacesFile`
// (`@termhub/shared`'s `config-schema.ts`, M4.1). No DOM, no bridge, no
// Zustand — both directions are plain functions over plain data, so
// `layout-persistence.test.ts` drives them directly, and the round trip
// (store -> file -> store) is a single, deterministic assertion.
//
// `packages/app/src/renderer/src/session-boot.ts` (and, for a live daemon
// resync, `daemon-resync.ts`) is the only caller: it loads the file
// (`window.termhub.loadLayout()`), reconciles it against `session.list`'s
// live sessions, and — only when `reconcileLayout` reports
// `needsFreshSessionInWorkspaceId` (rule 6 below) or a non-empty
// `toRelaunch` (M4.7, rule 6.5 below) — calls `session.create` itself,
// since this module never touches the daemon or any bridge.

import type { LaunchSpec, SessionId, SessionSummary } from '@termhub/shared';
import type {
  PersistedPaneNode,
  PersistedWorkspace,
  WorkspaceTemplate,
  WorkspacesFile,
} from '@termhub/shared';

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
 *
 * `templates` (M4.7) rides along in the same file — `WorkspacesView.tsx`'s
 * own templates store is what actually owns them; this function only
 * embeds whatever it's handed, verbatim, so a caller saving the layout can
 * compose one `bridge.saveLayout` call that never wipes out the other half
 * of the file. Omitted entirely when empty, matching `activeWorkspaceId`'s
 * own "don't persist a value with nothing behind it" posture just above.
 */
export function toPersistedLayout(
  state: StoreState,
  templates: readonly WorkspaceTemplate[] = [],
): WorkspacesFile {
  const workspaces: PersistedWorkspace[] = state.workspaces.map((workspace) =>
    toPersistedWorkspace(workspace, state.sessions),
  );
  return {
    version: 1,
    ...(state.activeWorkspaceId !== undefined
      ? { activeWorkspaceId: state.activeWorkspaceId }
      : {}),
    workspaces,
    ...(templates.length > 0 ? { templates: [...templates] } : {}),
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
    const session = sessions[node.sessionId];
    return {
      kind: 'leaf',
      sessionId: node.sessionId,
      sessionCreatedAt: session?.createdAt ?? 0,
      // M4.7: "relançar sessão morta com o mesmo comando" needs to know
      // what that command *was* — filled in here, from the session's own
      // metadata, whenever it's known. Omitted (not `launch: undefined`,
      // `exactOptionalPropertyTypes` per typescript-rules.md) when the
      // session's metadata isn't in the store at all — the same safe
      // fallback `sessionCreatedAt`'s own `?? 0` already gives: a leaf with
      // no launch spec is simply not a relaunch candidate on the next
      // reconciliation, same as before this task.
      ...(session !== undefined ? { launch: launchSpecOf(session) } : {}),
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

/** A leaf's `launch` spec, built from its live `SessionSummary` — the shell/cwd/args/command that would spawn an equivalent session again. */
function launchSpecOf(session: SessionSummary): LaunchSpec {
  return {
    name: session.name,
    cwd: session.cwd,
    shell: session.shell,
    ...(session.args !== undefined ? { args: session.args } : {}),
    ...(session.command !== undefined ? { command: session.command } : {}),
  };
}

// ---------------------------------------------------------------------------
// reconcileLayout — file + session.list -> initial store state
// ---------------------------------------------------------------------------

/**
 * M4.7: one dead leaf `reconcileLayout` found a `launch` spec for, reported
 * so the caller (`session-boot.ts`/`daemon-resync.ts`) can create a
 * replacement session and swap it into the tree at the very same spot —
 * see `applyRelaunchedSession` below, the other half of this contract.
 */
export interface PendingRelaunch {
  /** Which returned workspace (in `ReconcileRestored.workspaces`) this leaf lives in. */
  workspaceId: string;
  /**
   * The placeholder id still sitting in that workspace's tree — the dead
   * session's own former id, deliberately **not** removed from the tree
   * (unlike a dead leaf with no `launch`, which `closePane` already
   * collapsed away) so its exact position — same split node `id`s/`ratio`s
   * above it, same side of the tree — survives until the caller has an id
   * to actually replace it with.
   */
  sessionId: SessionId;
  launch: LaunchSpec;
}

export interface ReconcileRestored {
  kind: 'restored';
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * Set only under rule 6: `liveSessions` was empty (the daemon restarted)
   * **and** nothing was left to relaunch either (`toRelaunch` below is
   * empty) — every workspace's tree collapsed to `root: null` and there is
   * no better information to seed a pane with. The caller must create
   * exactly **one** new session in this workspace (the same `session.create`
   * the M2.6 boot uses) before hydrating the store, or every pane would
   * start empty.
   */
  needsFreshSessionInWorkspaceId?: string;
  /**
   * M4.7: every dead leaf that carried a `launch` spec, across every
   * workspace — still sitting in `workspaces` above under its old,
   * placeholder id (see `PendingRelaunch.sessionId`'s own doc comment). The
   * caller creates one new session per entry, with `launch`'s own
   * shell/cwd/args/command (never re-resolving "the machine's current
   * default shell" — the whole point is running the *same* thing again),
   * then calls `applyRelaunchedSession` to swap it in. Always present, even
   * when empty, so a caller never has to guard against `undefined` — this
   * function is pure and never calls anything itself (`session-boot.ts`'s
   * own header comment).
   */
  toRelaunch: PendingRelaunch[];
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
 *    with its `name`/`cwd` intact. Relaunching a session into it (when one
 *    of its dead leaves has a `launch` spec) is rule 6.5's job, below.
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
 * 6. See `ReconcileRestored.needsFreshSessionInWorkspaceId`'s doc comment —
 *    only when `liveSessions` is empty **and** `toRelaunch` (rule 6.5) is
 *    also empty. With any live session present, an unplaced one is rule 4's
 *    orphan case instead.
 * 6.5 (M4.7). A dead leaf (rule 1's match failed) that carries a `launch`
 *     spec is **not** removed via `closePane` like an ordinary dead leaf —
 *     it stays exactly where it is, still bearing its old, now-dead
 *     `sessionId`, and is reported in `ReconcileRestored.toRelaunch`
 *     instead (see that field's own doc comment for what the caller does
 *     with it). A dead leaf with *no* `launch` is removed exactly as rule 1
 *     always did — this only changes the leaves that have somewhere to be
 *     relaunched to.
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
  const toRelaunch: PendingRelaunch[] = [];

  const workspaces: Workspace[] = file.workspaces.map((persisted) =>
    reconcileWorkspace(persisted, liveCreatedAtById, placed, toRelaunch),
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

  if (liveSessions.length === 0 && toRelaunch.length === 0) {
    return {
      kind: 'restored',
      workspaces,
      activeWorkspaceId,
      needsFreshSessionInWorkspaceId: activeWorkspaceId,
      toRelaunch,
    };
  }

  return { kind: 'restored', workspaces, activeWorkspaceId, toRelaunch };
}

function reconcileWorkspace(
  persisted: PersistedWorkspace,
  liveCreatedAtById: ReadonlyMap<SessionId, number>,
  placed: Set<SessionId>,
  toRelaunch: PendingRelaunch[],
): Workspace {
  let root = toLiveNode(persisted.root);
  for (const dead of deadLeaves(persisted.root, liveCreatedAtById)) {
    if (dead.launch !== undefined) {
      // Rule 6.5: left in place, on purpose — see `PendingRelaunch`'s own
      // doc comment for why this leaf is never handed to `closePane`.
      toRelaunch.push({
        workspaceId: persisted.id,
        sessionId: dead.sessionId,
        launch: dead.launch,
      });
      continue;
    }
    if (root === null) {
      break;
    }
    const outcome = closePane(root, dead.sessionId);
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

/** Strips `sessionCreatedAt`/`launch` (the persisted-only fields) to get a plain `PaneNode` `tree.ts` can operate on. Liveness itself is decided by `deadLeaves`, not here — this is pure reshaping. */
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

/** One dead leaf, as `deadLeaves` reports it — the leaf's own former id, plus its `launch` spec when it has one (rule 6.5). */
interface DeadLeaf {
  sessionId: SessionId;
  launch?: LaunchSpec;
}

/** Every leaf in `node` whose live session is missing, or whose `createdAt` doesn't match (rule 1's id+createdAt requirement — a same-id session from a different daemon lifetime is not a match). */
function deadLeaves(
  node: PersistedPaneNode | null,
  liveCreatedAtById: ReadonlyMap<SessionId, number>,
): DeadLeaf[] {
  const dead: DeadLeaf[] = [];
  function recur(current: PersistedPaneNode | null): void {
    if (current === null) {
      return;
    }
    if (current.kind === 'leaf') {
      const createdAt = liveCreatedAtById.get(current.sessionId);
      if (createdAt === undefined || createdAt !== current.sessionCreatedAt) {
        dead.push({
          sessionId: current.sessionId,
          ...(current.launch !== undefined ? { launch: current.launch } : {}),
        });
      }
      return;
    }
    recur(current.a);
    recur(current.b);
  }
  recur(node);
  return dead;
}

// ---------------------------------------------------------------------------
// applyRelaunchedSession — the other half of rule 6.5's contract
// ---------------------------------------------------------------------------

/**
 * Swaps a `PendingRelaunch` entry's placeholder leaf (its dead session's own
 * former id, still sitting in the tree — see that field's own doc comment)
 * for the brand-new session the caller just created with that same
 * `launch` spec. Same workspace, same split node ids/ratios, same side of
 * the tree — relaunching a pane must never move it (this task's own
 * "armadilhas" section). Also moves `focusedSessionId` along, when it
 * pointed at the placeholder.
 *
 * Pure and a no-op (returns `workspaces` itself, same reference) if
 * `workspaceId` doesn't name a workspace in `workspaces`, or that
 * workspace's tree has no leaf with `oldSessionId` — defensive; every real
 * caller only ever passes back exactly what `reconcileLayout` itself
 * reported in `toRelaunch`, straight from `ReconcileRestored.workspaces`.
 */
export function applyRelaunchedSession(
  workspaces: Workspace[],
  workspaceId: string,
  oldSessionId: SessionId,
  newSession: SessionSummary,
): Workspace[] {
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (workspace === undefined || workspace.root === null) {
    return workspaces;
  }
  const nextRoot = replaceLeafSessionId(workspace.root, oldSessionId, newSession.id);
  if (nextRoot === workspace.root) {
    return workspaces;
  }
  return workspaces.map((w) =>
    w.id === workspaceId
      ? {
          ...w,
          root: nextRoot,
          focusedSessionId:
            w.focusedSessionId === oldSessionId ? newSession.id : w.focusedSessionId,
        }
      : w,
  );
}

function replaceLeafSessionId(node: PaneNode, oldId: SessionId, newId: SessionId): PaneNode {
  if (node.kind === 'leaf') {
    return node.sessionId === oldId ? { kind: 'leaf', sessionId: newId } : node;
  }
  const a = replaceLeafSessionId(node.a, oldId, newId);
  const b = replaceLeafSessionId(node.b, oldId, newId);
  if (a === node.a && b === node.b) {
    return node;
  }
  return { ...node, a, b };
}
