import { Registry } from './registry.js';
import type { SessionFactory } from './registry.js';
import { registerSessionService } from './service.js';
import type { SessionService } from './service.js';
import { TransportServer } from './transport-server.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  startIdleShutdown,
} from './idle-shutdown.js';
import { defaultDaemonJsonPath, removeDaemonJsonIfOwnedByPid, startDaemon } from './daemon.js';
import type { DaemonInfo, StartDaemonOptions } from './daemon.js';

// Assembles the pieces docs/specs/m1.8-single-instance.md section 3
// describes into one running daemon: the lock + daemon.json (daemon.ts),
// the session registry and its `session.*` RPCs (registry.ts/service.ts,
// both M1.4/M1.7 — untouched by this task), and idle-shutdown (idle-
// shutdown.ts). `startDaemon` on its own only resolves the race; this is
// the layer that turns a won race into an actually-functioning daemon
// process, and the layer both `index.ts` (the real OS process entrypoint)
// and `cli.ts` (the M1.8 diagnostic) build on instead of duplicating this
// wiring.

export { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_IDLE_CHECK_INTERVAL_MS };

export interface RunDaemonOptions extends StartDaemonOptions {
  /** Milliseconds of no clients + no live sessions before this daemon shuts itself down. Defaults to `DEFAULT_IDLE_TIMEOUT_MS` (10 minutes). */
  idleTimeoutMs?: number;
  /** How often the idle condition is re-checked. Defaults to `DEFAULT_IDLE_CHECK_INTERVAL_MS`. See idle-shutdown.ts's header comment for why this is a poll rather than an event subscription. */
  idleCheckIntervalMs?: number;
  /** Overrides how sessions are spawned — tests inject a fake in place of a real `node-pty`-backed `Session` (registry.ts's own `SessionFactory` pattern). Production callers leave this unset. */
  sessionFactory?: SessionFactory;
}

/** Everything a caller needs to operate a running daemon: its advertised connection info, the underlying pieces (mainly useful for tests), and how to shut it down cleanly. */
export interface DaemonRuntime {
  readonly info: DaemonInfo;
  readonly server: TransportServer;
  readonly registry: Registry;
  readonly service: SessionService;
  /**
   * Implements docs/specs/m1.8-single-instance.md section 3.5 in order:
   * stop the idle poller, close every live session (they are this
   * process's children — leaving them running would orphan `conhost`/shell
   * processes), close the transport, then remove `daemon.json` only if it
   * is still this instance's own (pid match) — see
   * `removeDaemonJsonIfOwnedByPid`'s doc comment (daemon.ts) for why a
   * mismatch is a silent no-op rather than an error. Idempotent: a second
   * call while the first is still in flight (or after it finished) returns
   * the same settling promise instead of repeating any of this.
   */
  shutdown: () => Promise<void>;
  /**
   * Registers a listener called once a `shutdown()` — however it was
   * triggered, whether `index.ts`'s own signal handler or idle-shutdown's
   * `onIdleTimeout` below — finishes settling, successfully or not. `error`
   * is the rejection reason when settling failed, `undefined` otherwise.
   *
   * This exists so `index.ts` has exactly one place to decide "the process
   * should now exit", instead of duplicating that decision once per
   * shutdown trigger. Before this, only the signal path called
   * `process.exit` explicitly (in its own `.finally`); the idle path
   * (`onIdleTimeout` below) only ever called `shutdown()` and let the event
   * loop empty on its own — which is exactly the zombie-daemon bug this
   * task fixes (see index.ts's own comment on `onShutdownComplete`'s
   * registration for what was actually keeping the event loop alive).
   *
   * Registering after a shutdown has already settled still calls the
   * listener (with that settled outcome) rather than silently dropping it,
   * but production code always registers synchronously right after
   * `runDaemon()` resolves — before any signal or idle timer could
   * possibly have fired — so that path only matters for tests that call
   * `shutdown()` directly before registering.
   */
  onShutdownComplete: (listener: (error?: unknown) => void) => void;
}

export type RunDaemonResult =
  { outcome: 'started'; runtime: DaemonRuntime } | { outcome: 'already-running' };

/** Every session currently tracked whose status isn't `'exited'` — the "sessão viva" idle-shutdown must never fire while any of these exist (docs/specs/m1.8-single-instance.md section 3.4). */
function hasLiveSessions(registry: Registry): boolean {
  return registry.list().some((summary) => summary.status !== 'exited');
}

/**
 * Wins (or loses) the single-instance race via `startDaemon`, and — only on
 * a win — brings up the rest of the daemon: registers the `session.*` RPCs
 * against a fresh `Registry`, and arms idle-shutdown. Mirrors
 * `startDaemon`'s own two-outcome shape one level up.
 */
export async function runDaemon(options: RunDaemonOptions = {}): Promise<RunDaemonResult> {
  const registry = new Registry(
    options.sessionFactory !== undefined ? { sessionFactory: options.sessionFactory } : {},
  );

  // Resolved once, here, rather than left to startDaemon()'s own internal
  // default: shutdown() below needs to know exactly which path daemon.json
  // was written to, and startDaemon()'s result doesn't carry that back out
  // (docs/specs/m1.8-single-instance.md section 4's DaemonInfo has no slot
  // for it). Passing the same resolved value into startOptions keeps both
  // layers looking at the identical path instead of each re-deriving
  // "the real default" independently.
  const daemonJsonPath = options.daemonJsonPath ?? defaultDaemonJsonPath();

  const startOptions: StartDaemonOptions = {
    daemonJsonPath,
    ...(options.address !== undefined ? { address: options.address } : {}),
    ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  };
  const started = await startDaemon(startOptions);
  if (started.outcome === 'already-running') {
    return { outcome: 'already-running' };
  }

  const { server, info } = started;
  const service = registerSessionService(server, registry);

  let settling: Promise<void> | undefined;
  const shutdownListeners: Array<(error?: unknown) => void> = [];

  function onShutdownComplete(listener: (error?: unknown) => void): void {
    shutdownListeners.push(listener);
  }

  // Declared before `startIdleShutdown` so `onIdleTimeout` (invoked well
  // after this function returns) can close over it. Function declarations
  // are hoisted, so referencing `shutdown` from inside `idle`'s options
  // object below — itself constructed before `shutdown` is *defined* in
  // reading order — is safe.
  function shutdown(): Promise<void> {
    if (settling !== undefined) {
      return settling;
    }
    settling = (async () => {
      idle.dispose();
      for (const summary of registry.list()) {
        registry.close(summary.id);
      }
      await server.close();
      await removeDaemonJsonIfOwnedByPid(daemonJsonPath, info.pid);
    })();
    // Notified once settling resolves or rejects, whatever listeners have
    // been registered by then (see `onShutdownComplete`'s doc comment on
    // `DaemonRuntime` for why registration ordering isn't a real concern in
    // production). `void` because nothing here awaits this chain — it only
    // exists to fan the outcome out to listeners, and a listener throwing
    // is not this function's problem to handle (same reasoning `index.ts`'s
    // own former `.catch` used for the signal path).
    void settling.then(
      () => {
        for (const listener of shutdownListeners) {
          listener();
        }
      },
      (err: unknown) => {
        for (const listener of shutdownListeners) {
          listener(err);
        }
      },
    );
    return settling;
  }

  const idle = startIdleShutdown({
    hasClients: () => server.connectionCount > 0,
    hasLiveSessions: () => hasLiveSessions(registry),
    onIdleTimeout: () => {
      // Fire-and-forget from idle-shutdown's own perspective — see
      // idle-shutdown.ts: it only guarantees `onIdleTimeout` runs, not that
      // anything async it kicks off is awaited by anything. The outcome
      // (success or a shutdown step failing, e.g. `server.close()` itself
      // erroring) isn't dropped, though: `shutdown()` fans it out to
      // whoever registered via `onShutdownComplete` above — `index.ts` is
      // where the real process log/exit for that belongs, not this
      // library-level function.
      void shutdown();
    },
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.idleCheckIntervalMs !== undefined
      ? { checkIntervalMs: options.idleCheckIntervalMs }
      : {}),
  });

  return {
    outcome: 'started',
    runtime: { info, server, registry, service, shutdown, onShutdownComplete },
  };
}
