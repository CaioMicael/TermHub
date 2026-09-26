import type { SessionCreateParams, SessionSummary } from '@termhub/shared';
import { treeFromSessions, type Workspace } from '@termhub/ui';

// M3.1's definitive boot policy, superseding M2.6's single-session one
// (docs/specs/m2.6-boot-reattach.md section 3.4, which this module used to
// implement verbatim — see this task's final report for the diff). Every
// non-`exited` session the daemon already knows about is reattached into
// one default workspace, laid out by `treeFromSessions` (`@termhub/ui`'s
// store, M3.1's prompt section 3.4: "Com 4 sessões, sai 2×2"); focus goes to
// the one with the highest `createdAt` — the session the user was most
// recently working in, same reasoning M2.6 already had for a single
// session. With no live session at all, one is created, as before.
//
// Exited sessions are left exactly where they are, untouched, for M4's
// graveyard to pick up later — this module only ever reads their `status`.
// Their metadata still ends up in the returned `sessions` array (so the
// store's `sessions` map has them, for whenever M4's cemetery UI wants to
// read it), but never in the workspace's tree.
//
// **Known, documented gap** (M3.1's prompt, section 3.4: "Persistir o
// layout é da M4.3. Aqui o layout é reconstruído a cada boot"): there is no
// saved layout yet. Every boot re-derives a fresh `treeFromSessions` grid
// from whatever `session.list` returns, even if the user had arranged their
// panes differently before closing the window. M4.3 is what makes this
// stick.
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

/** Every RPC method this module's boot policy calls, keyed to its real wire params/result shape (`@termhub/shared`'s `protocol.ts`) — a minimal, locally-typed slice of `window.termhub`, mirroring the same "small interface, structurally compatible" approach `@termhub/ui`'s `TerminalBridge`/`SessionActionsBridge` use. */
export interface SessionBootRequestParams {
  'session.list': Record<string, never>;
  'session.create': SessionCreateParams;
}
export interface SessionBootRequestResult {
  'session.list': { sessions: SessionSummary[] };
  'session.create': { session: SessionSummary };
}
export type SessionBootMethod = keyof SessionBootRequestParams;

export interface SessionBootBridge {
  request<M extends SessionBootMethod>(
    method: M,
    params: SessionBootRequestParams[M],
  ): Promise<SessionBootRequestResult[M]>;
}

export interface SessionBootSize {
  cols: number;
  rows: number;
}

/**
 * The shell/cwd this policy asks the daemon to spawn when it has to create a
 * session, and the workspace's own `cwd` field when there is nothing better
 * to seed it with (the fresh-session path below). See the original M2.6
 * version of this file for the full "why hardcoded" rationale (renderer
 * sandboxing, no PATH/home access) — unchanged by this task, still M4.6's
 * (`profiles.ts`) to fix.
 */
export const DEFAULT_SHELL = 'powershell.exe';
export const DEFAULT_CWD = 'C:\\';

/** The single workspace boot ever reconciles into today. M3.1's prompt only asks for *one* workspace holding every live session — a session picker across several *workspaces* would need per-session project/cwd grouping this module has no way to infer yet (that's product-level, not this task's). */
export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_WORKSPACE_NAME = 'default';

export interface BootResult {
  workspace: Workspace;
  /** Every session `session.list` returned (live and exited alike) — not just the ones placed in `workspace.root`. The caller (`App.tsx`) is expected to `upsertSession` all of them into the store. */
  sessions: SessionSummary[];
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
  const live = sessions
    .filter((session) => session.status !== 'exited')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);

  if (live.length === 0) {
    const params: SessionCreateParams = {
      shell: DEFAULT_SHELL,
      cwd: DEFAULT_CWD,
      cols: size.cols,
      rows: size.rows,
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
    return { workspace, sessions: [...sessions, session] };
  }

  // `live` is sorted ascending by createdAt, so the last element is the
  // newest — the one that gets focus (docs/specs/m2.6-boot-reattach.md
  // section 3.4's rule, generalized from "the" session to "the newest of
  // several").
  const ids = live.map((session) => session.id);
  const root = treeFromSessions(ids, DEFAULT_WORKSPACE_ID);
  const newest = live[live.length - 1] as SessionSummary;
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
  return { workspace, sessions };
}
