import type { SessionCreateParams, SessionSummary } from '@termhub/shared';

// Provisional session-selection policy for M2.3's "run one terminal"
// milestone gate — **M2.6 replaces this whole module** with the real
// reattach-on-boot policy (docs/milestones.md M2.6, `docs/specs/
// m2.6-boot-reattach.md`). Until then: reuse the first non-exited session
// the daemon already knows about, or create exactly one.
//
// Why reuse at all, instead of always creating fresh: sessions outlive the
// window closing (that's the whole product, docs/plan.md section 1) — a
// fresh `session.create` on every `npm run dev` would leave a new
// `powershell.exe` alive in the daemon forever, one per boot.
//
// ## Why this has to be idempotent against React.StrictMode
//
// React 18 StrictMode double-invokes effects in dev: mount -> cleanup ->
// mount again, synchronously. If the code below ran straight from inside
// that effect, the second invocation would race the first's still-pending
// `session.list`/`session.create` round trip and could create a second
// session. `resolveBootSession` guards against that with a module-level
// singleton promise: the first call actually resolves sessions/creates one;
// every call after that (regardless of what `size` it's given) just
// awaits the same in-flight-or-settled promise. See `session-boot.test.ts`
// for a StrictMode-shaped test (two synchronous calls) proving exactly one
// `session.create` happens.

/** Every RPC method this module's boot policy calls, keyed to its real wire params/result shape (`@termhub/shared`'s `protocol.ts`) — a minimal, locally-typed slice of `window.termhub`, mirroring the same "small interface, structurally compatible" approach `@termhub/ui`'s `TerminalBridge` uses. */
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
 * The shell/cwd this provisional policy asks the daemon to spawn when it
 * has to create a session.
 *
 * **Known gap, reported rather than worked around** (see this task's final
 * report): the sandboxed, `contextIsolation`-on renderer this module runs
 * in has no Node/OS API surface at all — no `process.env`, no
 * `os.homedir()`, no way to shell out to `where pwsh.exe` — and this
 * task's file boundary forbids adding one via `packages/app/src/preload`
 * or `src/main` (permanent additions there belong to a different task).
 * `packages/daemon/src/cli.ts` already has the real PATH-aware
 * pwsh-vs-powershell logic; the right home for *this* renderer to reach it
 * is a bridge method that doesn't exist yet, not a copy of that logic
 * re-implemented somewhere it can't actually probe PATH from. Until that
 * bridge method exists, this hardcodes both values instead of guessing
 * wrong silently.
 */
export const DEFAULT_SHELL = 'powershell.exe';
/** See `DEFAULT_SHELL`'s doc comment — same gap, same reasoning. Not the user's actual home directory; a fixed, always-present Windows path chosen only so a freshly created session has somewhere valid to start. */
export const DEFAULT_CWD = 'C:\\';

let bootPromise: Promise<SessionSummary> | null = null;

/** Test-only: clears the module-level singleton so each test starts from a clean slate. Not exported from `@termhub/app`'s public surface — this module has none; it's imported directly by `App.tsx` and by its own test. */
export function resetSessionBootForTests(): void {
  bootPromise = null;
}

/**
 * Resolves to the one session this window's `Terminal` should attach to:
 * the first non-`'exited'` session already known to the daemon, or a
 * freshly created one sized to `size` if none is reusable. Safe to call
 * more than once (including concurrently, before the first call has
 * resolved) — every call after the first returns the same promise instead
 * of repeating the `session.list`/`session.create` round trip.
 */
export function resolveBootSession(
  bridge: SessionBootBridge,
  size: SessionBootSize,
): Promise<SessionSummary> {
  bootPromise ??= bootSessionOnce(bridge, size);
  return bootPromise;
}

async function bootSessionOnce(
  bridge: SessionBootBridge,
  size: SessionBootSize,
): Promise<SessionSummary> {
  const { sessions } = await bridge.request('session.list', {});
  const reusable = sessions.find((session) => session.status !== 'exited');
  if (reusable !== undefined) {
    return reusable;
  }
  const params: SessionCreateParams = {
    shell: DEFAULT_SHELL,
    cwd: DEFAULT_CWD,
    cols: size.cols,
    rows: size.rows,
  };
  const { session } = await bridge.request('session.create', params);
  return session;
}
