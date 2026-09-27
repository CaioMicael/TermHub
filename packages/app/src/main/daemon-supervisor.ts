import { connectToDaemon } from './daemon-client.js';
import type { DaemonConnection } from './daemon-client.js';

// docs/specs/m4.8-daemon-resilience.md section 3.1: the supervisor that
// replaces `main/index.ts`'s single `connectionPromise` for everything that
// happens *after* the very first connection settles. Section 2.1's own
// warning is this module's one hard constraint, same as `daemon-client.ts`'s
// own header comment: never spawn a *replacement* for a daemon this app
// merely lost touch with, and never `process.kill` one — reconnection is
// always another call to `connectToDaemon()` (injected here as `connect`,
// defaulting to the real thing), never bespoke "should I spawn?" logic of
// this module's own.
//
// The very first connection (section 3.1: "faz a primeira conexão com
// connectToDaemon(), como hoje") is exactly today's one-shot call —
// `connectToDaemon()`'s own internal read/connect/spawn/backoff algorithm
// (docs/specs/m2.1-daemon-client.md section 5) already owns deciding
// connected/blocked/failed for it, bounded by its own `maxAttempts`. This
// module does not wrap that first call in any further retry: `firstConnection`
// is that one call's result, verbatim, so every existing caller of
// `connectToDaemon()` (the boot-time logger in `index.ts`, every test that
// only exercises a single unchanging connection) keeps working unmodified.
//
// What this module adds is everything `connectToDaemon()` was never asked to
// do: once a connection that *did* succeed later drops (`TransportClient.
// onClose`), retry **indefinitely** (section 3.1: "sem limite de tentativas,
// enquanto o app estiver vivo") with exponential backoff (250ms→5s), unless
// the daemon it finds is `'blocked'` — in which case, per section 2's policy
// (never resolved automatically), it stops trying altogether and stays
// `'blocked'` until the app itself restarts. A `'failed'` outcome from a
// retry counts as one attempt and simply continues the same backoff loop.

/** One of the three reasons `connectToDaemon()` (docs/specs/m2.1-daemon-client.md section 2) will never resolve automatically — surfaced here only so this module doesn't need to import `DaemonConnection`'s whole shape into every branch. */
export type DaemonBlockedReason = 'zombie' | 'version-mismatch' | 'token-rejected';

/**
 * The supervisor's own state, reported to every `onChange` listener and by
 * `current()`. Never reports `'connecting'` — that is `firstConnection`
 * still being awaited, which every caller already has its own way to wait
 * on (see this file's header comment); once it settles, this is always one
 * of these four.
 */
export type DaemonSupervisorState =
  | {
      state: 'connected';
      /** Increases by exactly one on every distinct successful connection, starting at 1 — docs/specs/m4.8-daemon-resilience.md section 3.1's "geração". */
      epoch: number;
      client: Extract<DaemonConnection, { outcome: 'connected' }>['client'];
      info: Extract<DaemonConnection, { outcome: 'connected' }>['info'];
    }
  | {
      state: 'blocked';
      reason: DaemonBlockedReason;
      info: Extract<DaemonConnection, { outcome: 'blocked' }>['info'];
    }
  | { state: 'disconnected' }
  | {
      state: 'failed';
      attempts: number;
      lastError: Error;
      daemonPath: string;
    };

export interface CreateDaemonSupervisorOptions {
  /** Defaults to `() => connectToDaemon()`. Tests inject a fake, per required test 1 — this is the seam that makes the whole retry/backoff/epoch state machine testable without a real daemon or real timers. */
  connect?: () => Promise<DaemonConnection>;
  /** First backoff wait after a drop, doubled each retry up to `maxBackoffMs`. Defaults to 250 (section 3.1). */
  initialBackoffMs?: number;
  /** Cap on any single backoff wait. Defaults to 5000 (section 3.1). */
  maxBackoffMs?: number;
}

export interface DaemonSupervisor {
  /**
   * The very first `connectToDaemon()` call's own result — see this file's
   * header comment. Resolves exactly once; awaiting it more than once is
   * fine (it's a plain `Promise`, memoized like any other).
   */
  readonly firstConnection: Promise<DaemonConnection>;
  /** The most recent state this supervisor has settled into, or `undefined` before `firstConnection` has resolved. */
  current(): DaemonSupervisorState | undefined;
  /**
   * Subscribes to every state change *after* whatever `current()` already
   * reports at subscribe time — never replays the current state (a fresh
   * subscriber that wants to know "connected right now" calls `current()`
   * itself first). Returns an unsubscribe function.
   */
  onChange(listener: (state: DaemonSupervisorState) => void): () => void;
  /**
   * Stops retrying — the app is quitting (section 3.1: "no app saindo, para
   * de tentar"). Never touches whatever client is currently connected (this
   * module never held the authority to close it in the first place — see
   * this file's header comment). Idempotent.
   */
  dispose(): void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toSupervisorState(result: DaemonConnection, epoch: number): DaemonSupervisorState {
  switch (result.outcome) {
    case 'connected':
      return { state: 'connected', epoch, client: result.client, info: result.info };
    case 'blocked':
      return { state: 'blocked', reason: result.reason, info: result.info };
    case 'failed':
      return {
        state: 'failed',
        attempts: result.attempts,
        lastError: result.lastError,
        daemonPath: result.daemonPath,
      };
  }
}

export function createDaemonSupervisor(
  options: CreateDaemonSupervisorOptions = {},
): DaemonSupervisor {
  const connect = options.connect ?? (() => connectToDaemon());
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const listeners = new Set<(state: DaemonSupervisorState) => void>();
  let currentState: DaemonSupervisorState | undefined;
  let epoch = 0;
  let disposed = false;

  function emit(state: DaemonSupervisorState): void {
    currentState = state;
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  }

  /**
   * The post-drop retry loop (section 3.1's second bullet). Runs until a
   * fresh connection succeeds, the daemon reports `'blocked'` (permanent,
   * per section 2 — no further attempts), or `dispose()` is called.
   */
  async function retryLoop(): Promise<void> {
    let backoffMs = initialBackoffMs;
    for (;;) {
      if (disposed) {
        return;
      }
      await sleep(backoffMs);
      if (disposed) {
        return;
      }
      const result = await connect();
      if (disposed) {
        return;
      }
      if (result.outcome === 'connected') {
        epoch += 1;
        emit(toSupervisorState(result, epoch));
        watchClient(result.client);
        return;
      }
      if (result.outcome === 'blocked') {
        emit(toSupervisorState(result, epoch));
        return; // Section 2: never resolved automatically — stop retrying.
      }
      // 'failed': counts as an attempt, keep backing off (section 3.1: "sem
      // limite de tentativas"). State stays 'disconnected' — nothing new to
      // report to listeners already showing that.
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }

  function watchClient(
    client: Extract<DaemonConnection, { outcome: 'connected' }>['client'],
  ): void {
    client.onClose(() => {
      if (disposed) {
        return;
      }
      emit({ state: 'disconnected' });
      retryLoop().catch((err: unknown) => {
        // `retryLoop` only ever `await`s `sleep`/`connect()`, neither of
        // which this function expects to throw synchronously into a
        // rejection it doesn't already handle above — logged rather than
        // silently swallowed, same stance `bridge-gateway.ts`'s own
        // `awaitConnection` takes for its analogous "should never happen"
        // guard.
        console.error('[daemon-supervisor] unexpected error in the reconnect loop', err);
      });
    });
  }

  const firstConnection = connect().then((result) => {
    if (result.outcome === 'connected') {
      epoch = 1;
    }
    emit(toSupervisorState(result, epoch));
    if (result.outcome === 'connected') {
      watchClient(result.client);
    }
    return result;
  });

  return {
    firstConnection,
    current: () => currentState,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      disposed = true;
    },
  };
}
