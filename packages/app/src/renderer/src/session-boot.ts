import type {
  ProfilesListParams,
  ProfilesListResult,
  SessionCreateParams,
  SessionSummary,
  WorkspaceTemplate,
  WorkspacesFile,
} from '@termhub/shared';
import {
  applyRelaunchedSession,
  reconcileLayout,
  toPersistedLayout,
  treeFromSessions,
  type StoreState,
  type Workspace,
} from '@termhub/ui';

import { pickDefaultShellProfile } from './default-shell-profile.js';

// M3.1's single-workspace boot policy, now the *fallback* path M4.3's
// persisted-layout reconciliation falls back to (docs/milestones.md M4.3,
// this task's prompt section 2, rule 5: "sem arquivo, ou com zero
// workspaces: o boot é exatamente o de hoje"). Every non-`exited` session
// the daemon already knows about is reattached into one default workspace,
// laid out by `treeFromSessions` (`@termhub/ui`'s store, M3.1's prompt
// section 3.4: "Com 4 sessões, sai 2×2"); focus goes to the one with the
// highest `createdAt` — the session the user was most recently working in,
// same reasoning M2.6 already had for a single session. With no live
// session at all, one is created, as before.
//
// Exited sessions are left exactly where they are, untouched, for M4's
// graveyard to pick up later — this module only ever reads their `status`.
// Their metadata still ends up in the returned `sessions` array (so the
// store's `sessions` map has them, for whenever M4's cemetery UI wants to
// read it), but never in the workspace's tree.
//
// ## M4.3: reconciling the persisted layout first
//
// `bootWorkspaceOnce` now asks `bridge.loadLayout()` for the persisted
// `WorkspacesFile` (M4.1's `workspaces.json`, loaded in the main process at
// boot) and hands it, together with `session.list`'s live sessions, to
// `@termhub/ui`'s pure `reconcileLayout` (`packages/ui/src/
// layout-persistence.ts` — see its own doc comment for the reconciliation
// rules). Three outcomes:
//
// - `'fresh-boot'` (rule 5 above): falls through to the single-workspace
//   policy this file has always implemented, unchanged.
// - `'restored'` with no `needsFreshSessionInWorkspaceId`: the reconciled
//   workspaces/activeWorkspaceId are returned as is — no daemon call at
//   all beyond the `session.list` already made.
// - `'restored'` with `needsFreshSessionInWorkspaceId` set (rule 6: the
//   daemon restarted, so `liveSessions` was empty and every workspace's
//   tree collapsed to `root: null`): exactly **one** `session.create` is
//   made — the same call/params the fresh-boot path already uses — and its
//   result becomes that one workspace's sole pane, so the screen isn't
//   left empty.
//
// A `loadLayout()` rejection (e.g. the main process has no `LayoutAccess`
// configured at all) is treated the same as "no file" rather than failing
// the whole boot — losing the persisted layout must never be worse than
// the M2.6 gate this file also has to keep passing.
//
// ## Why this still has to be idempotent against React.StrictMode
//
// Same reasoning M2.6 already established (see the original version of this
// file's header comment, preserved in git history): React 18 StrictMode
// double-invokes effects in dev, so `resolveBootWorkspace` guards with a
// module-level singleton promise — the first call actually resolves
// sessions/creates one and builds the workspace; every call after that just
// awaits the same in-flight-or-settled promise. See `session-boot.test.ts`
// for the StrictMode-shaped test proving exactly one `session.create` (or
// zero, when a live session already exists) happens.
//
// ## M4.6 (second half): the fresh-session shell is no longer hardcoded
//
// Both places this module creates a fresh session (this file's
// `freshBootWorkspace` and the `needsFreshSessionInWorkspaceId` branch just
// below) now ask `resolveDefaultShellParams` for the machine's own default
// shell instead of always passing `DEFAULT_SHELL` ("powershell.exe"). That
// helper's own doc comment covers the fallback chain; the short version is:
// a `profiles.list` failure, or a profile list with nothing
// `pickDefaultShellProfile` (`./default-shell-profile.js`) recognizes as a
// default, still falls back to exactly today's `DEFAULT_SHELL`/no-args
// behavior — this task's own "armadilhas" section is explicit that the boot
// must never get worse than it already was.

/** Every RPC method this module's boot policy calls, keyed to its real wire params/result shape (`@termhub/shared`'s `protocol.ts`) — a minimal, locally-typed slice of `window.termhub`, mirroring the same "small interface, structurally compatible" approach `@termhub/ui`'s `TerminalBridge`/`SessionActionsBridge` use. */
export interface SessionBootRequestParams {
  'session.list': Record<string, never>;
  'session.create': SessionCreateParams;
  'profiles.list': ProfilesListParams;
}
export interface SessionBootRequestResult {
  'session.list': { sessions: SessionSummary[] };
  'session.create': { session: SessionSummary };
  'profiles.list': ProfilesListResult;
}
export type SessionBootMethod = keyof SessionBootRequestParams;

export interface SessionBootBridge {
  request<M extends SessionBootMethod>(
    method: M,
    params: SessionBootRequestParams[M],
  ): Promise<SessionBootRequestResult[M]>;
  /** M4.3: the persisted layout — see this file's header comment. Structurally satisfied by `window.termhub` (`preload/bridge.ts`'s `PreloadBridge.loadLayout`); a test fake can reject to exercise the "no layout available" fallback. */
  loadLayout(): Promise<WorkspacesFile>;
}

export interface SessionBootSize {
  cols: number;
  rows: number;
}

/**
 * The cwd this policy asks the daemon to spawn a fresh session into when
 * there is nothing better to seed it with (the fresh-session path below);
 * unchanged by this task.
 *
 * `DEFAULT_SHELL` is now only the *last-resort* fallback, not the shell a
 * fresh boot actually uses (M4.6's second half) — see
 * `resolveDefaultShellParams` below for the real policy: the machine's own
 * default `ShellProfile` (`default-shell-profile.ts`'s
 * `pickDefaultShellProfile`), read from `profiles.list`. This constant is
 * what boot falls back to when that RPC fails or returns nothing usable, so
 * the boot never gets *worse* than it was before this task (this task's
 * prompt, section 2 and its own "armadilhas" section).
 */
export const DEFAULT_SHELL = 'powershell.exe';
export const DEFAULT_CWD = 'C:\\';

/**
 * Resolves the `shell`/`args` a fresh boot session should launch with:
 * the machine's default `ShellProfile` (`pickDefaultShellProfile`) when
 * `profiles.list` succeeds and offers one, `DEFAULT_SHELL` with no `args`
 * otherwise — a rejected `profiles.list` call, an empty/all-exotic profile
 * list (`pickDefaultShellProfile` returning `undefined`), or any other
 * failure all collapse to that same fallback, so this never throws and
 * never blocks the boot on the daemon's shell-detection succeeding.
 *
 * Exported for `daemon-resync.ts` (M4.8): the fresh session a daemon-restart
 * resync creates (rule 6, section 3.4) goes through this exact same policy
 * instead of a shell hardcoded independently — see that module's own doc
 * comment.
 */
export async function resolveDefaultShellParams(
  bridge: SessionBootBridge,
): Promise<{ shell: string; args?: string[] }> {
  try {
    const { profiles } = await bridge.request('profiles.list', {});
    const profile = pickDefaultShellProfile(profiles);
    if (profile !== undefined) {
      return { shell: profile.shell, args: profile.args };
    }
  } catch (err) {
    console.warn('[TermHub] could not load shell profiles; falling back to the default shell', err);
  }
  return { shell: DEFAULT_SHELL };
}

/** The single workspace boot ever reconciles into today. M3.1's prompt only asks for *one* workspace holding every live session — a session picker across several *workspaces* would need per-session project/cwd grouping this module has no way to infer yet (that's product-level, not this task's). */
export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_WORKSPACE_NAME = 'default';

export interface BootResult {
  /** M4.3: possibly more than one when a persisted layout was reconciled — the fresh-boot fallback still returns exactly one, as before. */
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** Every session `session.list` returned (live and exited alike), plus one freshly created session per relaunch (M4.7) and/or rule 6 — not just the ones placed in some workspace's tree. The caller (`App.tsx`) is expected to `upsertSession`-equivalent (via `hydrate`) all of them into the store. */
  sessions: SessionSummary[];
  /** M4.7: the persisted `workspaces.json`'s own `templates`, verbatim — `[]` for the fresh-boot fallback (no file to read them from) or a `loadLayout()` rejection. The caller seeds its templates store with this once, at boot. */
  templates: WorkspaceTemplate[];
}

let bootPromise: Promise<BootResult> | null = null;

/** Test-only: clears the module-level singleton so each test starts from a clean slate. Not exported from `@termhub/app`'s public surface — this module has none; it's imported directly by `App.tsx` and by its own test. */
export function resetSessionBootForTests(): void {
  bootPromise = null;
}

/**
 * Resolves to the default workspace this window's UI should render on boot,
 * plus every session's metadata for the store's `sessions` map. Safe to call
 * more than once (including concurrently, before the first call has
 * resolved) — every call after the first returns the same promise instead of
 * repeating the `session.list`/`session.create` round trip.
 */
export function resolveBootWorkspace(
  bridge: SessionBootBridge,
  size: SessionBootSize,
): Promise<BootResult> {
  bootPromise ??= bootWorkspaceOnce(bridge, size);
  return bootPromise;
}

async function bootWorkspaceOnce(
  bridge: SessionBootBridge,
  size: SessionBootSize,
): Promise<BootResult> {
  const { sessions } = await bridge.request('session.list', {});
  const live = sessions.filter((session) => session.status !== 'exited');

  let layoutFile: WorkspacesFile | undefined;
  try {
    layoutFile = await bridge.loadLayout();
  } catch (err) {
    // M4.3's prompt: losing the persisted layout must never be worse than
    // the M2.6 gate this file also has to keep passing — fall through to
    // the fresh-boot policy below exactly as if there were no file at all.
    console.warn(
      '[TermHub] could not load the persisted layout; falling back to a fresh boot',
      err,
    );
    layoutFile = undefined;
  }

  const outcome = reconcileLayout(layoutFile, live);
  const templates = layoutFile?.templates ?? [];

  if (outcome.kind === 'fresh-boot') {
    return { ...(await freshBootWorkspace(bridge, size, sessions, live)), templates };
  }

  let workspaces = outcome.workspaces;
  let allSessions = sessions;

  // M4.7, rule 6.5: relaunch every dead leaf that carried a `launch` spec —
  // its own shell/cwd/args/command, never `resolveDefaultShellParams`'s
  // "machine's current default shell" (the whole point of a launch spec is
  // running the *same* thing again). Done before rule 6 below: reconcileLayout
  // itself already guarantees rule 6 never fires when this list isn't empty
  // (docs/milestones.md M4.7's own decision — "regra 6 só vale quando não
  // sobrou nada vivo nem nada pra relançar"), but this order also means a
  // workspace that had *both* a relaunchable leaf and other, unrelated dead
  // leaves ends up with the relaunched session in exactly the same tree
  // spot it always occupied — `applyRelaunchedSession`'s own contract.
  for (const pending of outcome.toRelaunch) {
    const params: SessionCreateParams = {
      shell: pending.launch.shell,
      cwd: pending.launch.cwd,
      cols: size.cols,
      rows: size.rows,
      ...(pending.launch.name !== undefined ? { name: pending.launch.name } : {}),
      ...(pending.launch.args !== undefined ? { args: pending.launch.args } : {}),
      ...(pending.launch.command !== undefined ? { command: pending.launch.command } : {}),
    };
    const { session } = await bridge.request('session.create', params);
    workspaces = applyRelaunchedSession(
      workspaces,
      pending.workspaceId,
      pending.sessionId,
      session,
    );
    allSessions = [...allSessions, session];
  }

  if (outcome.needsFreshSessionInWorkspaceId !== undefined) {
    // Rule 6: the daemon restarted (no live session survived anywhere) and
    // nothing was relaunchable either, so every workspace's tree collapsed
    // to `root: null` — create exactly one session, in the workspace that
    // was active, the same call the fresh-boot path below uses.
    const targetId = outcome.needsFreshSessionInWorkspaceId;
    const target = workspaces.find((workspace) => workspace.id === targetId);
    const defaults = await resolveDefaultShellParams(bridge);
    const params: SessionCreateParams = {
      shell: defaults.shell,
      cwd: target?.cwd ?? DEFAULT_CWD,
      cols: size.cols,
      rows: size.rows,
      ...(defaults.args !== undefined ? { args: defaults.args } : {}),
    };
    const { session } = await bridge.request('session.create', params);
    workspaces = workspaces.map((workspace) =>
      workspace.id === targetId
        ? {
            ...workspace,
            root: { kind: 'leaf', sessionId: session.id },
            focusedSessionId: session.id,
          }
        : workspace,
    );
    allSessions = [...allSessions, session];
  }

  return {
    workspaces,
    activeWorkspaceId: outcome.activeWorkspaceId,
    sessions: allSessions,
    templates,
  };
}

/** M3.1's original single-workspace boot policy (docs/specs/m2.6-boot-reattach.md section 3.4), used as `reconcileLayout`'s `'fresh-boot'` fallback (rule 5). `allSessions` is every session `session.list` returned (live and exited); `live` is the same list already filtered to non-`exited`, computed once by the caller. Returns everything but `templates` — this path never has a layout file to read them from, so its one caller (`bootWorkspaceOnce`) fills that field in itself. */
async function freshBootWorkspace(
  bridge: SessionBootBridge,
  size: SessionBootSize,
  allSessions: SessionSummary[],
  live: SessionSummary[],
): Promise<Omit<BootResult, 'templates'>> {
  if (live.length === 0) {
    const defaults = await resolveDefaultShellParams(bridge);
    const params: SessionCreateParams = {
      shell: defaults.shell,
      cwd: DEFAULT_CWD,
      cols: size.cols,
      rows: size.rows,
      ...(defaults.args !== undefined ? { args: defaults.args } : {}),
    };
    const { session } = await bridge.request('session.create', params);
    const workspace: Workspace = {
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
      cwd: DEFAULT_CWD,
      root: { kind: 'leaf', sessionId: session.id },
      focusedSessionId: session.id,
      maximizedSessionId: undefined,
    };
    return {
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      sessions: [...allSessions, session],
    };
  }

  // Sorted ascending by createdAt, so the last element is the newest — the
  // one that gets focus (docs/specs/m2.6-boot-reattach.md section 3.4's
  // rule, generalized from "the" session to "the newest of several").
  const sortedLive = live.slice().sort((a, b) => a.createdAt - b.createdAt);
  const ids = sortedLive.map((session) => session.id);
  const root = treeFromSessions(ids, DEFAULT_WORKSPACE_ID);
  const newest = sortedLive[sortedLive.length - 1] as SessionSummary;
  const workspace: Workspace = {
    id: DEFAULT_WORKSPACE_ID,
    name: DEFAULT_WORKSPACE_NAME,
    // The newest live session's own cwd — a better guess for "where a
    // session created from this workspace's `+`/split button should spawn"
    // than the fixed `DEFAULT_CWD`, since it's whatever directory the user
    // was actually working in last. Still just a guess: M4.6/M4.7's
    // per-workspace launch config is the real fix.
    cwd: newest.cwd,
    root,
    focusedSessionId: newest.id,
    maximizedSessionId: undefined,
  };
  return { workspaces: [workspace], activeWorkspaceId: workspace.id, sessions: allSessions };
}

// ---------------------------------------------------------------------------
// M4.3: saving the layout, gated to start only after boot's own hydrate
// ---------------------------------------------------------------------------

/** The bridge surface `startLayoutPersistence` needs — `window.termhub` structurally satisfies it. */
export interface LayoutPersistenceBridge {
  saveLayout(layout: unknown): void;
}

/** The store surface `startLayoutPersistence` needs — `useTermhubStore` (a Zustand `UseBoundStore`) structurally satisfies it; a test can pass a plain fake instead. */
export interface LayoutPersistenceStore {
  subscribe(listener: (state: StoreState, previousState: StoreState) => void): () => void;
}

/**
 * M4.7: the templates store's own read surface (`@termhub/ui`'s
 * `useTemplatesStore`) — narrowed to just `getState`, which is all
 * `startLayoutPersistence` needs to fold the current templates into a
 * layout-triggered save (see that function's own doc comment on why a
 * workspace/tab change must never wipe out the templates half of the same
 * file). Optional on every call site that predates M4.7 — omitting it
 * simply persists an empty `templates` list, `toPersistedLayout`'s own
 * default.
 */
export interface LayoutPersistenceTemplatesSource {
  getState(): { templates: WorkspaceTemplate[] };
}

/**
 * Starts saving the layout (`toPersistedLayout` -> `bridge.saveLayout`) on
 * every `workspaces`/`activeWorkspaceId` change **from this call onward** —
 * never retroactively, and never for whatever transition (if any) already
 * happened before it was called. `App.tsx` calls this exactly once, and
 * only after its own boot `hydrate()` has already run (`bootState` reaching
 * `'ready'`): calling it any earlier would let the very first store
 * mutation — boot's own `hydrate()`, which populates `workspaces` from
 * nothing — itself trigger a save, which is the premature-save risk this
 * task's prompt warns about by name ("um `subscribe` no topo do `App.tsx`
 * faz exatamente isso"). Returns the unsubscribe function.
 *
 * A `sessions`-only change never saves: Zustand's plain (non-selector)
 * `subscribe` fires on every `set()` regardless of which slice changed, so
 * this compares `workspaces`/`activeWorkspaceId` by reference against the
 * previous state itself, rather than depending on a subscription that only
 * fires for a chosen slice.
 *
 * `templatesSource` (M4.7), when given, folds its *current* templates into
 * every save this triggers — see `startTemplatesPersistence` below for the
 * other half (a templates-only change saving the *current* layout).
 */
export function startLayoutPersistence(
  store: LayoutPersistenceStore,
  bridge: LayoutPersistenceBridge,
  templatesSource?: LayoutPersistenceTemplatesSource,
): () => void {
  return store.subscribe((state, previousState) => {
    if (
      state.workspaces === previousState.workspaces &&
      state.activeWorkspaceId === previousState.activeWorkspaceId
    ) {
      return;
    }
    bridge.saveLayout(toPersistedLayout(state, templatesSource?.getState().templates ?? []));
  });
}

/**
 * M4.7: the templates store's subscribe surface — `useTemplatesStore`
 * (`@termhub/ui`'s Zustand store) structurally satisfies it.
 */
export interface TemplatesPersistenceStore extends LayoutPersistenceTemplatesSource {
  subscribe(
    listener: (
      state: { templates: WorkspaceTemplate[] },
      previousState: { templates: WorkspaceTemplate[] },
    ) => void,
  ): () => void;
}

/**
 * The other half of M4.7's persistence: saves the file again whenever the
 * templates store itself changes (a model saved, edited or deleted) —
 * `startLayoutPersistence` above only reacts to a *layout* change, so a
 * template-only edit would otherwise never reach disk at all. Composes the
 * *current* layout (`mainStore.getState()`) with the *new* templates, same
 * "never let one half of the file wipe out the other" reasoning. `App.tsx`
 * starts this alongside `startLayoutPersistence`, once boot is `'ready'`.
 */
export function startTemplatesPersistence(
  templatesStore: TemplatesPersistenceStore,
  mainStore: { getState(): StoreState },
  bridge: LayoutPersistenceBridge,
): () => void {
  return templatesStore.subscribe((state, previousState) => {
    if (state.templates === previousState.templates) {
      return;
    }
    bridge.saveLayout(toPersistedLayout(mainStore.getState(), state.templates));
  });
}
