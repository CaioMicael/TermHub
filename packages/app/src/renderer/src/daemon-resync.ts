import type {
  ProfilesListParams,
  ProfilesListResult,
  SessionCreateParams,
  SessionId,
  SessionSummary,
  WorkspacesFile,
} from '@termhub/shared';
import {
  forgetSessionOwnership,
  reconcileLayout,
  toPersistedLayout,
  type TerminalBridge,
  type TerminalRegistry,
  type Workspace,
} from '@termhub/ui';
import type { StoreState } from '@termhub/ui';

import { DEFAULT_CWD, resolveDefaultShellParams } from './session-boot.js';

// docs/specs/m4.8-daemon-resilience.md section 3.4: what runs when the
// daemon-supervisor's connection state comes back `'connected'` with a
// generation (epoch) different from the last one the renderer saw after
// boot. Kept out of `session-boot.ts` on purpose — a different agent is
// mid-task on that file for M4.6's second half, so this is a new module,
// called from `App.tsx`.
//
// The four steps, exactly as the spec orders them:
//
// 1. **Forget ownership** (`forgetSessionOwnership`, `@termhub/ui`'s
//    `terminal-session.ts`) — before anything else, and without sending
//    anything to the daemon. Section 2.3's own trap: skipping this would
//    make every host's later reattach silently reuse the *old* connection's
//    ref count and never send a real `session.attach` on the new one.
// 2. `session.list` on the new connection.
// 3. Reconcile: the store's own *current* state stands in for the
//    "persisted file" `layout-persistence.ts`'s `reconcileLayout` normally
//    reads from disk (`toPersistedLayout(store.getState())` — "o que já
//    estava na tela é o arquivo desta reconciliação"). The result is applied
//    via `hydrate`, exactly like `session-boot.ts`'s own cold-boot path:
//    dead leaves drop out of their tree, a workspace with nothing left gets
//    exactly one fresh session (rule 6), and orphaned live sessions land in
//    the "Recuperadas" workspace (rule 4) — none of that logic is
//    reimplemented here, only invoked.
// 4. **Reattach every host that's still in the registry**
//    (`registry.reattachAll()`) — each host resets its own xterm and gets a
//    brand-new attach, so a surviving session's terminal shows the daemon's
//    current snapshot with nothing duplicated, and a session that didn't
//    survive already had its host disposed by the registry's own store
//    subscription (M3.5) the instant `hydrate` ran, in step 3.
//
// Never runs in place of boot, and never before it (section 3.5): `App.tsx`
// only calls this once `bootState.phase === 'ready'`, keyed on the
// connection epoch changing.

/**
 * The RPC surface this module needs from `window.termhub` — narrowly typed
 * the same way `session-boot.ts`'s own `SessionBootBridge` is, so
 * `window.termhub` (whose real `request` is generic over every
 * `RequestMethod`) satisfies it structurally with no adapter.
 * `runDaemonResync`'s `bridge` parameter is this **and** `TerminalBridge`
 * (an intersection) — `forgetSessionOwnership` needs the exact same object
 * every `TerminalHost` was constructed with (its own doc comment), which is
 * the same `window.termhub` reference either way.
 *
 * `'profiles.list'` and `loadLayout` are here (unused directly by this
 * module's own logic) only so this interface stays structurally identical
 * to `SessionBootBridge` — `resolveDefaultShellParams` (imported from
 * `session-boot.ts`, this coordinator-requested fix) takes a
 * `SessionBootBridge`, and passing this module's own `bridge` straight
 * through to it needs the type-checker to see that they match; a real
 * `window.termhub` already implements both in production either way.
 */
export interface DaemonResyncRequestParams {
  'session.list': Record<string, never>;
  'session.create': SessionCreateParams;
  'profiles.list': ProfilesListParams;
}
export interface DaemonResyncRequestResult {
  'session.list': { sessions: SessionSummary[] };
  'session.create': { session: SessionSummary };
  'profiles.list': ProfilesListResult;
}
export type DaemonResyncMethod = keyof DaemonResyncRequestParams;

export interface DaemonResyncBridge {
  request<M extends DaemonResyncMethod>(
    method: M,
    params: DaemonResyncRequestParams[M],
  ): Promise<DaemonResyncRequestResult[M]>;
  /** See this interface's own doc comment — needed only so `bridge` structurally satisfies `SessionBootBridge` when handed to `resolveDefaultShellParams`. */
  loadLayout(): Promise<WorkspacesFile>;
}

/** The store surface this module needs — `useTermhubStore` (a Zustand `UseBoundStore`) structurally satisfies it; a test passes a plain fake instead. */
export interface DaemonResyncStore {
  getState(): StoreState;
  hydrate(next: StoreState): void;
}

/**
 * The size this resync asks the daemon to spawn the one workspace rule 6
 * may need a fresh session in, when nothing better can be guessed
 * (`guessSize` below). `session-boot.ts` owns the real default shell/cwd
 * policy now (`resolveDefaultShellParams`/`DEFAULT_CWD`, imported and
 * reused directly below — the M4.6 second half that used to make this a
 * forbidden file has since landed and merged) — this module invents
 * nothing of its own for either.
 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** A reasonable cols/rows guess for the one fresh session rule 6 may need — the target workspace's own most-recently-known session's geometry, if any is still remembered in `sessions` (stale, pre-resync entries are fine: only the size matters), else a plain default. The resize flow (M2.5) corrects this immediately after `ready` regardless. */
function guessSize(sessions: Readonly<Record<SessionId, SessionSummary>>): {
  cols: number;
  rows: number;
} {
  for (const session of Object.values(sessions)) {
    return { cols: session.cols, rows: session.rows };
  }
  return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
}

function indexById(sessions: readonly SessionSummary[]): Record<SessionId, SessionSummary> {
  const byId: Record<SessionId, SessionSummary> = {};
  for (const session of sessions) {
    byId[session.id] = session;
  }
  return byId;
}

export interface DaemonResyncResult {
  /**
   * Section 3.4's last paragraph: `true` when the daemon that came back was
   * a different lifetime — no session survived the reconciliation anywhere,
   * so rule 6 created exactly one fresh one. `App.tsx` shows "Daemon
   * reiniciado — as sessões anteriores foram encerradas" for a few seconds
   * when this is `true`, and just clears the banner otherwise.
   */
  daemonRestarted: boolean;
}

/**
 * Runs the whole resync (section 3.4's four steps), once, unconditionally —
 * `runDaemonResync` below is the version `App.tsx` actually calls, which
 * adds the at-most-one-in-flight guard. Kept separate so each concern (the
 * four steps themselves vs. not overlapping two runs of them) is testable on
 * its own.
 */
async function runDaemonResyncOnce(
  bridge: DaemonResyncBridge & TerminalBridge,
  store: DaemonResyncStore,
  registry: Pick<TerminalRegistry, 'reattachAll'>,
): Promise<DaemonResyncResult> {
  // Step 1 — section 2.3: before any daemon round trip, and sends nothing
  // itself.
  forgetSessionOwnership(bridge);

  // Step 2.
  const { sessions: liveSessions } = await bridge.request('session.list', {});

  // Step 3: the store's own current state stands in for the persisted
  // file — see this file's header comment.
  const currentState = store.getState();
  const asFile = toPersistedLayout(currentState);
  const outcome = reconcileLayout(asFile, liveSessions);

  if (outcome.kind === 'fresh-boot') {
    // Only reachable if the store had zero workspaces to begin with
    // (`toPersistedLayout` never emits an empty `workspaces` array
    // otherwise) — nothing of this app's own layout to reconcile. Still
    // reattach whatever the registry already holds (there should be
    // nothing, but this keeps the four steps uniform regardless of branch).
    registry.reattachAll();
    return { daemonRestarted: false };
  }

  let workspaces = outcome.workspaces;
  let sessions = indexById(liveSessions);
  const daemonRestarted = outcome.needsFreshSessionInWorkspaceId !== undefined;

  if (outcome.needsFreshSessionInWorkspaceId !== undefined) {
    // Rule 6: the daemon restarted with nothing surviving anywhere — create
    // exactly one session, in the workspace that was active, the same
    // shell-resolution policy `session-boot.ts`'s own fresh-boot path uses
    // (coordinator fix: this used to hardcode `'powershell.exe'`, undoing
    // M4.6's own "no shell fixo" fix the moment a daemon restart happened).
    const targetId = outcome.needsFreshSessionInWorkspaceId;
    const target = workspaces.find((workspace) => workspace.id === targetId);
    const { cols, rows } = guessSize(currentState.sessions);
    const defaults = await resolveDefaultShellParams(bridge);
    const params: SessionCreateParams = {
      shell: defaults.shell,
      cwd: target?.cwd ?? DEFAULT_CWD,
      cols,
      rows,
      ...(defaults.args !== undefined ? { args: defaults.args } : {}),
    };
    const { session } = await bridge.request('session.create', params);
    workspaces = workspaces.map((workspace) =>
      workspace.id === targetId
        ? {
            ...workspace,
            root: { kind: 'leaf' as const, sessionId: session.id },
            focusedSessionId: session.id,
          }
        : workspace,
    );
    sessions = { ...sessions, [session.id]: session };
  }

  store.hydrate({ workspaces, activeWorkspaceId: outcome.activeWorkspaceId, sessions });

  // Step 4.
  registry.reattachAll();

  return { daemonRestarted };
}

interface QueuedResync {
  bridge: DaemonResyncBridge & TerminalBridge;
  store: DaemonResyncStore;
  registry: Pick<TerminalRegistry, 'reattachAll'>;
  /** Every caller coalesced into this one queued follow-up run — all of them settle with its single result (coordinator fix 2). */
  resolvers: Array<(result: DaemonResyncResult) => void>;
  rejecters: Array<(err: unknown) => void>;
}

/**
 * Coordinator fix 2 (after the first version of this task shipped): at most
 * one resync in flight at a time. `App.tsx`'s own effect has no reentrancy
 * guard of its own — two connection drops close together (epoch N, then
 * epoch N+1, the second arriving *while* N's resync is still awaiting the
 * daemon) would otherwise run `runDaemonResyncOnce` twice concurrently, both
 * reading the store's *pre-resync* state and, if the daemon restarted, each
 * independently deciding "nothing survived" and each calling
 * `session.create` — two brand-new sessions instead of one.
 *
 * `inFlight`/`queued` are module-level, not per-caller: this function itself
 * *is* the lock. A call while nothing is running starts immediately and
 * becomes `inFlight`. A call while something is already running never starts
 * its own daemon round trip — it just replaces whatever was `queued` (so
 * only the *last* such call's `bridge`/`store`/`registry` are ever actually
 * used — "a geração mais recente") and returns a `Promise` that resolves
 * once that one follow-up run (started right after the in-flight one
 * settles) finishes. Any calls coalesced into that same queued slot before
 * it fires all resolve/reject together, from that single follow-up run.
 */
let inFlight: Promise<DaemonResyncResult> | undefined;
let queued: QueuedResync | undefined;

function startQueuedRunIfAny(): void {
  const next = queued;
  if (next === undefined) {
    return;
  }
  queued = undefined;
  runDaemonResync(next.bridge, next.store, next.registry).then(
    (result) => {
      for (const resolve of next.resolvers) {
        resolve(result);
      }
    },
    (err: unknown) => {
      for (const reject of next.rejecters) {
        reject(err);
      }
    },
  );
}

/**
 * The version of the resync `App.tsx` actually calls — `runDaemonResyncOnce`
 * plus the at-most-one-in-flight guard above. See that guard's own doc
 * comment for the defect this closes.
 */
export function runDaemonResync(
  bridge: DaemonResyncBridge & TerminalBridge,
  store: DaemonResyncStore,
  registry: Pick<TerminalRegistry, 'reattachAll'>,
): Promise<DaemonResyncResult> {
  if (inFlight === undefined) {
    const started = runDaemonResyncOnce(bridge, store, registry);
    inFlight = started;
    started
      .finally(() => {
        if (inFlight === started) {
          inFlight = undefined;
        }
        startQueuedRunIfAny();
      })
      .catch(() => {
        // Swallowed here on purpose: `started` itself (returned below,
        // untouched) already carries its own rejection to whoever actually
        // awaits *that* — this separate chain exists only for the
        // `.finally` bookkeeping above, and must never produce an
        // unhandled-rejection warning of its own.
      });
    return started;
  }

  return new Promise<DaemonResyncResult>((resolve, reject) => {
    queued = {
      bridge,
      store,
      registry,
      resolvers: [...(queued?.resolvers ?? []), resolve],
      rejecters: [...(queued?.rejecters ?? []), reject],
    };
  });
}

/** Test-only: clears the module-level in-flight/queued state so each test starts from a clean slate — same convention `session-boot.ts`'s own `resetSessionBootForTests` uses. Not exported from `@termhub/app`'s public surface (this module has none); imported directly by `daemon-resync.test.ts`. */
export function resetDaemonResyncForTests(): void {
  inFlight = undefined;
  queued = undefined;
}

// Re-exported only so `daemon-resync.test.ts`'s fakes can name the type —
// production code never needs to.
export type { Workspace };
