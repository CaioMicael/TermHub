// Implements docs/specs/m1.8-single-instance.md section 3.4: the daemon
// shuts itself down when, at the same time, no client is connected AND no
// session is alive — never on either condition alone. A live session must
// keep the daemon up even with zero clients watching it (closing every
// window must never kill the user's agents — this is the whole reason
// TermHub's daemon is a separate process at all), which is exactly the case
// this module's own test suite (idle-shutdown.test.ts) is built around.
//
// ## Why this is a poller, not the event-driven design the spec's prose reads as
//
// Section 3.4 says to "reavaliar a cada desconexão de cliente e a cada
// saída de sessão" — reevaluate on every client disconnect and every
// session exit, arming/canceling a single timer as those events land. That
// reads as "subscribe to both events", but there is no sanctioned way to do
// that from outside `service.ts`/`transport-server.ts` (both largely off
// limits for this task) without a second consumer of a hook that already
// has exactly one:
//
// - `TransportServer.onConnectionClose` (transport-server.ts) is
//   documented and enforced as single-registration — a second call throws
//   rather than adding a second listener — and `registerSessionService`
//   (service.ts, out of bounds for this task) already claims that one slot
//   for its own attached-client cleanup (docs/specs/
//   m1.7-attach-detach.md section 3.7). There is no way to also observe a
//   disconnect from here without either double-registering (throws) or
//   editing service.ts/transport-server.ts beyond the one narrow section
//   3.3 change this task is authorized to make there.
// - Session creation/exit has no external hook at all: `Registry`
//   (registry.ts, also out of bounds) exposes no "a session was created or
//   closed" event, only synchronous `create`/`close`/`list` methods to poll.
//
// Both signals this module needs (is any client connected, is any session
// alive) are exposed as plain, cheap, side-effect-free reads, though
// (`TransportServer.connectionCount`, `Registry.list()`), so short-interval
// polling reaches the exact same observable behavior the spec asks for —
// "never kill a daemon with a live session; kill an idle one after the
// configured timeout" — just with up to `checkIntervalMs` of latency on
// *when the countdown starts*, not on whether it starts correctly. Given
// the default timeout is measured in minutes, that latency is immaterial in
// practice. This tradeoff — and the fact that this task's file boundary is
// what forces it — is called out in this task's own final report rather
// than silently presented as the literal event-driven mechanism the prose
// describes.

/** Default idle timeout: 10 minutes (docs/specs/m1.8-single-instance.md section 3.4's "Default de 10 minutos"). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Default polling interval for re-checking the idle condition. Small relative to any realistic `idleTimeoutMs`, so the "reevaluate on every relevant change" behavior the spec describes is approximated closely enough that the difference is unobservable outside a test that deliberately zooms in on it. */
export const DEFAULT_IDLE_CHECK_INTERVAL_MS = 5_000;

export interface IdleShutdownOptions {
  /** Whether at least one client is currently connected. Read fresh on every check — never cached. */
  hasClients: () => boolean;
  /** Whether at least one session is currently alive (not yet exited/closed). Read fresh on every check — never cached. */
  hasLiveSessions: () => boolean;
  /** Called at most once, the first time `hasClients() && hasLiveSessions()` are both false for a full uninterrupted `idleTimeoutMs`. Never called again after — see `dispose()`. */
  onIdleTimeout: () => void;
  /** Milliseconds of uninterrupted idleness before `onIdleTimeout` fires. Defaults to `DEFAULT_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /** Milliseconds between re-checks of the idle condition. Defaults to `DEFAULT_IDLE_CHECK_INTERVAL_MS`. */
  checkIntervalMs?: number;
}

export interface IdleShutdownController {
  /** Stops the poller and cancels any currently-armed timeout. Safe to call more than once. After this, `onIdleTimeout` is never called. */
  dispose: () => void;
}

/**
 * Starts watching `hasClients`/`hasLiveSessions` and arms a single
 * `idleTimeoutMs` timer whenever both go false, canceling it the moment
 * either becomes true again — see this module's header comment for why
 * that watching is done via polling rather than event subscriptions.
 *
 * Runs one evaluation immediately (synchronously, before returning) in
 * addition to the periodic ones: a daemon that starts with zero clients and
 * zero sessions (the normal case — nobody has connected yet) is idle from
 * its very first instant, and per section 3.4 that must start the countdown
 * right away, not wait a full `checkIntervalMs` for the first tick.
 */
export function startIdleShutdown(options: IdleShutdownOptions): IdleShutdownController {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;

  let idleTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(interval);
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const reevaluate = (): void => {
    if (disposed) {
      return;
    }
    const idle = !options.hasClients() && !options.hasLiveSessions();
    if (idle && idleTimer === undefined) {
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        // Fires at most once, ever: `onIdleTimeout` is documented as never
        // being called again after, and the only way to guarantee that
        // regardless of what the callback itself does (in production it
        // triggers the daemon's own shutdown, which is asynchronous — see
        // daemon-runtime.ts) is to stop this controller's own polling right
        // here, synchronously, rather than trust every caller to dispose()
        // promptly from inside the callback.
        dispose();
        options.onIdleTimeout();
      }, idleTimeoutMs);
    } else if (!idle && idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  reevaluate();
  const interval = setInterval(reevaluate, checkIntervalMs);

  return { dispose };
}
