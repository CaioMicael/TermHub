// Pure logic behind `Sidebar.tsx`'s "Fechados recentemente" section (M4.5's
// prompt) — free of React/DOM/Zustand, so it's testable with Vitest in the
// repo's plain `node` environment. Four concerns live here:
//
// 1. Detecting *which* sessions just left every workspace's tree (a pane
//    close, or a whole tab closing) — `sessionsJustUnplaced`, a diff over
//    two `collectSessionLocations` snapshots. This mirrors
//    `terminal-registry.ts`'s own `computePlacedSessionIds` diff (that
//    module's header comment) for a different purpose: that registry diffs
//    to decide host birth/death; this diffs to decide when to bury a
//    session in the daemon's graveyard (`session.close`) — `Sidebar.tsx` is
//    the only caller, since `terminal-registry.ts` itself is out of this
//    task's file scope (M4.5's prompt, fronteiras).
//
//    This is also why `session-actions.ts`'s `closePaneAction` — the
//    function every close button (`PaneHeader.tsx`'s header button,
//    `Sidebar.tsx`'s own row button) already calls — is untouched by this
//    task: `session-actions.test.ts`'s existing "armadilha 5" test locks it
//    to *never* touch the bridge, and `PaneHeader.tsx` is a forbidden file
//    whose one close-button call site (`handleCloseClick(event,
//    sessionActionsStore, workspaceId, sessionId)`) passes no bridge at
//    all — there is no way to thread a `session.close` call through that
//    frozen call site. Diffing the store's own tree shape, instead, is
//    call-site-agnostic: it doesn't matter whether a pane left the tree via
//    the pane header, the sidebar's row button, or `tab-bar-actions.ts`'s
//    `closeWorkspaceTab` removing a whole tab — every path already goes
//    through `store.closePane`/`store.closeWorkspace`, and both leave a
//    footprint this diff notices on the very next store change.
//
// 2. Remembering which workspace a buried session was closed from — the
//    daemon has no notion of workspaces (M4.4's own commit message) — via
//    `collectSessionLocations`, and resolving where a restored session goes
//    back to (`resolveRestoreWorkspaceId`) when that workspace may no
//    longer exist.
//
// 3. Turning `GraveyardEntry[]` (`@termhub/shared`'s wire shape) into
//    what the row needs to render: sort order, the alive/exited split, and
//    the countdown/elapsed text (`termhub-prototipo.html`'s own
//    `c.alive ? 'vivo ' + c.ttl : c.when` — `buildGraveyardRows`).
//
// 4. Picking the entry `Ctrl+Shift+T` restores — `mostRecentlyClosedSessionId`.

import type { GraveyardEntry, SessionId } from '@termhub/shared';

import { collectSessionIds, treeLeaves, type PaneNode } from './store/tree.js';
import type { StoreState } from './store/workspace.js';

/**
 * Where a session was living the instant before it got buried. The daemon
 * never sees this — it's `Sidebar.tsx`'s own in-memory bookkeeping
 * (`collectSessionLocations` + `sessionsJustUnplaced`), never persisted,
 * never sent over the wire.
 */
export interface SessionOrigin {
  workspaceId: string;
  workspaceName: string;
}

/** Every currently-placed session id, mapped to the workspace it's placed in — one snapshot of "who lives where" right now. `Sidebar.tsx` keeps the *previous* call's result around (in a `useRef`) and diffs it against a fresh one on every store change via `sessionsJustUnplaced`. */
export function collectSessionLocations(state: StoreState): Map<SessionId, SessionOrigin> {
  const locations = new Map<SessionId, SessionOrigin>();
  for (const workspace of state.workspaces) {
    for (const sessionId of collectSessionIds(workspace.root)) {
      locations.set(sessionId, { workspaceId: workspace.id, workspaceName: workspace.name });
    }
  }
  return locations;
}

/** One session that was placed in `prevLocations` and is no longer placed anywhere in `nextLocations` — paired with the origin `prevLocations` recorded for it, since `nextLocations` may have no trace of it at all (a whole tab closing). */
export interface JustUnplacedSession {
  sessionId: SessionId;
  origin: SessionOrigin;
}

/**
 * The diff `Sidebar.tsx`'s store subscription runs on every change: every
 * session present in `prevLocations` but absent from `nextLocations`. Order
 * follows `prevLocations`'s own iteration order (insertion order of a
 * `Map`), which is deterministic given a deterministic caller.
 *
 * A session moved *within* the same tree (`movePaneInWorkspace`) or from
 * one workspace to another never shows up here: this project's `movePane`
 * is same-workspace-only (`tree.ts`'s own doc comment), and every
 * placement change is a single synchronous reducer call — there is no
 * intermediate tick where a session is transiently absent from every tree
 * while actually staying "placed" in spirit. The only two reducers that
 * ever *remove* a leaf from every tree it was the sole occupant of are
 * `closePaneInWorkspace` and `closeWorkspace` (`workspace.ts`) — both are
 * exactly "the user closed something".
 */
export function sessionsJustUnplaced(
  prevLocations: ReadonlyMap<SessionId, SessionOrigin>,
  nextLocations: ReadonlyMap<SessionId, SessionOrigin>,
): JustUnplacedSession[] {
  const result: JustUnplacedSession[] = [];
  for (const [sessionId, origin] of prevLocations) {
    if (!nextLocations.has(sessionId)) {
      result.push({ sessionId, origin });
    }
  }
  return result;
}

/** `GraveyardEntry[]`, newest-closed-first — `termhub-prototipo.html`'s own `closed.unshift(...)` ordering (the fake mock always prepends), reproduced here as an explicit sort since a real `graveyard.list` response carries no ordering guarantee of its own. */
export function sortGraveyardEntries(entries: readonly GraveyardEntry[]): GraveyardEntry[] {
  return [...entries].sort((a, b) => b.closedAt - a.closedAt);
}

/** The entry `Ctrl+Shift+T` restores — the most recently closed one (`sortGraveyardEntries`'s own ordering), or `undefined` when nothing is buried. */
export function mostRecentlyClosedSessionId(
  entries: readonly GraveyardEntry[],
): SessionId | undefined {
  return sortGraveyardEntries(entries)[0]?.session.id;
}

/**
 * Minutes remaining until `expiresAt`, as `termhub-prototipo.html`'s own
 * `'vivo ' + c.ttl` reads (e.g. `"vivo 8 min"`). Rounded *up* and floored at
 * 1 — "vivo 1 min" for anything under a minute left, never "vivo 0 min" for
 * a session `graveyard.list` still bothered to report as alive.
 */
export function formatAliveRemaining(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  return `vivo ${minutes} min`;
}

/**
 * How long ago `closedAt` was, as `termhub-prototipo.html`'s own `c.when`
 * reads (`"há 2 min"`, `"há 14 min"`, `"há 1 h"`). Floored, so "há 2 min"
 * means at least two full minutes have actually passed; under a minute
 * reads as `"agora"` (the prototype's own value for a session the instant
 * it's closed, `when:'agora'`).
 */
export function formatClosedAgo(closedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - closedAt) / 60_000);
  if (minutes < 1) {
    return 'agora';
  }
  if (minutes < 60) {
    return `há ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return `há ${hours} h`;
}

/** One row `Sidebar.tsx`'s graveyard section renders — everything `buildGraveyardRows` derives from a `GraveyardEntry` plus this renderer's own `SessionOrigin` bookkeeping. */
export interface GraveyardRow {
  sessionId: SessionId;
  name: string;
  tag: string | undefined;
  /** The workspace this session was closed from, when known — `undefined` when the origin was never recorded (M4.5's prompt: "se não souber ... mostre só a tag" — `Sidebar.tsx`'s job to omit the "· <workspace>" segment in that case, not this function's). */
  workspaceLabel: string | undefined;
  /** `entry.session.status !== 'exited'` — the PTY is still alive in the daemon's graveyard, vs. the process having already exited while buried. */
  alive: boolean;
  timeText: string;
  closedAt: number;
  expiresAt: number;
}

/** Builds every row the graveyard section shows, newest-first (`sortGraveyardEntries`). `origins` is `Sidebar.tsx`'s own `SessionOrigin` bookkeeping (`collectSessionLocations`'s accumulated history), keyed by the *buried* session's id — not to be confused with `collectSessionLocations`'s own per-call return value, which only ever covers *currently placed* sessions. */
export function buildGraveyardRows(
  entries: readonly GraveyardEntry[],
  origins: ReadonlyMap<SessionId, SessionOrigin>,
  now: number,
): GraveyardRow[] {
  return sortGraveyardEntries(entries).map((entry) => {
    const alive = entry.session.status !== 'exited';
    return {
      sessionId: entry.session.id,
      name: entry.session.name,
      tag: entry.session.tag,
      workspaceLabel: origins.get(entry.session.id)?.workspaceName,
      alive,
      timeText: alive
        ? formatAliveRemaining(entry.expiresAt, now)
        : formatClosedAgo(entry.closedAt, now),
      closedAt: entry.closedAt,
      expiresAt: entry.expiresAt,
    };
  });
}

/**
 * Which workspace a restored session goes back to (M4.5's prompt): the
 * workspace it was closed from, if `origin` names one and it still exists;
 * the active workspace otherwise (`origin` unknown — "a janela foi
 * reaberta" — or its workspace was itself closed in the meantime). Falls
 * back to the first workspace in tab order if there is somehow no active
 * one (defensive — `tab-bar-actions.ts`'s "always ≥1 tab" policy means this
 * shouldn't happen in practice); `undefined` only when the store has zero
 * workspaces at all, which `Sidebar.tsx` treats as "nowhere to restore to".
 */
export function resolveRestoreWorkspaceId(
  state: StoreState,
  origin: SessionOrigin | undefined,
): string | undefined {
  if (origin !== undefined && state.workspaces.some((w) => w.id === origin.workspaceId)) {
    return origin.workspaceId;
  }
  return state.activeWorkspaceId ?? state.workspaces[0]?.id;
}

/**
 * Which pane a restored session splits into, when the target workspace
 * already has a tree: the workspace's own focused pane, if it's still one
 * of its current leaves, else the tree's first leaf in `treeLeaves` order.
 * `undefined` only for an empty tree — `workspace.ts`'s `placeSessionInWorkspace`
 * (this function's one caller) branches on `root: null` before ever calling
 * this, so that case is unreachable from there in practice.
 */
export function resolveSplitTarget(
  root: PaneNode | null,
  focusedSessionId: SessionId | undefined,
): SessionId | undefined {
  const leaves = treeLeaves(root);
  if (
    focusedSessionId !== undefined &&
    leaves.some((leaf) => leaf.sessionId === focusedSessionId)
  ) {
    return focusedSessionId;
  }
  return leaves[0]?.sessionId;
}
