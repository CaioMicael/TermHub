import { PROTOCOL_ERROR_CODE, PROTOCOL_VERSION, ProtocolError } from '@termhub/shared';

import { defaultDaemonJsonPath, readDaemonInfo } from '@termhub/daemon/src/daemon.js';
import type { DaemonInfo } from '@termhub/daemon/src/daemon.js';
import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';

import { resolveDaemonScriptPath } from './daemon-paths.js';
import { spawnDaemonProcess } from './daemon-process.js';

// Finds, starts and reconnects to the daemon — docs/specs/
// m2.1-daemon-client.md, the whole spec. Section 1 already closed the
// startup-race half of this task (two apps spawning at once is safe, one
// level down, per M1.8); what is left is section 5's algorithm: read
// daemon.json, decide whether to connect or to treat it as absent, and only
// ever spawn a new daemon in the cases that are actually safe to.
//
// Section 2 is this module's one hard constraint, repeated here because it
// is the thing every other decision below serves: this app never calls
// `process.kill` on a daemon, never deletes another process's daemon.json,
// and never spawns a *replacement* for a daemon it merely couldn't talk to.
// A daemon it can't reach might own live agent sessions; the only paths out
// of "can't reach it" here are `'blocked'` (surfaced to the UI, M2.1's own
// scope stops at that signal — the warning banner itself is M2.2/M2.3) or
// retrying the exact same daemon, never replacing it.

/** Mirrors `@termhub/daemon`'s own `DaemonInfo` shape (docs/specs/m2.1-daemon-client.md section 7) without importing a type across the deep path twice under two different names. */
export type { DaemonInfo };

export type DaemonConnection =
  | { outcome: 'connected'; client: TransportClient; info: DaemonInfo }
  | {
      outcome: 'blocked';
      reason: 'zombie' | 'version-mismatch' | 'token-rejected';
      info: DaemonInfo;
    }
  | { outcome: 'failed'; attempts: number; lastError: Error; daemonPath: string };

/**
 * Spawns (or starts spawning) a daemon expected to end up listening on
 * `address`. May return before the daemon is actually reachable — the
 * caller's retry loop is what re-checks, not this function's return.
 *
 * `address` is forwarded rather than used to *decide* anything here: the
 * real daemon binary (packages/daemon/src/index.ts) always binds its own
 * default address (`resolvePipeAddress()`, the same default this module
 * uses), so nothing is actually passed to it — see `defaultSpawnDaemon`.
 * Tests inject a fake that *does* use it, to bring up an isolated fake
 * daemon on exactly the address the test itself is polling, without
 * duplicating that address into a second closure by hand.
 */
export type SpawnDaemon = (address: string) => void | Promise<void>;

export interface ConnectToDaemonOptions {
  /** Where to look for `daemon.json`. Defaults to `defaultDaemonJsonPath()`. */
  daemonJsonPath?: string;
  /** Pipe/socket address a freshly spawned daemon is expected to use — forwarded to `spawnDaemon`. Connecting to an *existing* daemon always uses the `pipe` its own daemon.json advertises, never this value; see `SpawnDaemon`'s doc comment. Defaults to `resolvePipeAddress()`. */
  address?: string;
  /** Protocol version this client speaks. Defaults to `PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Forwarded to `TransportClient` as the handshake's `clientName`. */
  clientName?: string;
  /** Forwarded to `TransportClient`. Defaults to that class's own default (5000ms) — tests exercising the zombie/timeout path should pass something much shorter. */
  handshakeTimeoutMs?: number;
  /** Defaults to the real detached-Electron-as-node spawn (`daemon-process.ts` + `daemon-paths.ts`). Tests inject a fake — this is the hook docs/specs/m2.1-daemon-client.md section 7 requires: "testável sem spawnar Electron". */
  spawnDaemon?: SpawnDaemon;
  /** Hard cap on read-then-maybe-connect cycles. Finite by design (section 5: "nunca um loop infinito de spawn"). Defaults to `DEFAULT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** First backoff wait, doubled each retry up to `maxBackoffMs`. Defaults to `DEFAULT_INITIAL_BACKOFF_MS`. */
  initialBackoffMs?: number;
  /** Cap on any single backoff wait. Defaults to `DEFAULT_MAX_BACKOFF_MS`. */
  maxBackoffMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 150;
export const DEFAULT_MAX_BACKOFF_MS = 1500;

/** Substring of the `Error` `TransportClient.connect()` rejects with when the socket connected but no handshake ack arrived in time (transport-client.ts) — the wire-level signature of a zombie daemon (docs/specs/m2.1-daemon-client.md section 5, step 3's second bullet). Matched by substring rather than a dedicated error type/code because that message is TransportClient's own generic "nobody answered in time" wording, not a protocol-level rejection (a real daemon never sends an explicit "you're a zombie" anything — that is exactly the failure being detected). */
const HANDSHAKE_TIMEOUT_MESSAGE_FRAGMENT = 'did not acknowledge the handshake';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff (`initial * 2^(attempt-1)`), capped at `max` — "espera crescente, teto total na casa de poucos segundos" (section 5). */
function computeBackoffMs(attempt: number, initial: number, max: number): number {
  const raw = initial * 2 ** (attempt - 1);
  return Math.min(raw, max);
}

type ConnectAttemptResult =
  | { outcome: 'connected'; client: TransportClient }
  | { outcome: 'blocked'; reason: 'zombie' | 'version-mismatch' | 'token-rejected' }
  | { outcome: 'unreachable'; error: Error };

/**
 * Connects and hands shakes against one already-known `DaemonInfo`,
 * classifying the outcome per section 5 step 3. Always leaves the socket it
 * opened either handed off (on `'connected'`) or closed (every other
 * branch) — never leaked back to the caller with no reference to it.
 */
async function attemptConnect(
  info: DaemonInfo,
  options: {
    protocolVersion: number;
    clientName: string | undefined;
    handshakeTimeoutMs: number | undefined;
  },
): Promise<ConnectAttemptResult> {
  const client = new TransportClient({
    address: info.pipe,
    token: info.token,
    protocolVersion: options.protocolVersion,
    ...(options.clientName !== undefined ? { clientName: options.clientName } : {}),
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  });

  try {
    await client.connect();
    return { outcome: 'connected', client };
  } catch (err) {
    // Whatever went wrong, this client is not the one we're keeping — close
    // it before deciding what the error means. (Closing a socket *we*
    // opened is not the "matar o daemon" section 2 forbids: it is us
    // hanging up on our own outbound connection attempt, nothing the
    // daemon process itself ever observes as anything but a client
    // disconnecting.)
    await client.close();

    if (isEnoent(err)) {
      // The pipe daemon.json pointed at doesn't exist — an orphaned file,
      // not a live daemon we're failing to reach. Section 5 step 3's first
      // bullet: treat this the same as "no daemon.json at all".
      return { outcome: 'unreachable', error: toError(err) };
    }
    if (err instanceof ProtocolError) {
      if (err.code === PROTOCOL_ERROR_CODE.UNAUTHORIZED) {
        return { outcome: 'blocked', reason: 'token-rejected' };
      }
      if (err.code === PROTOCOL_ERROR_CODE.VERSION_MISMATCH) {
        // Belt-and-suspenders: the daemon.json protocolVersion check above
        // this function's caller already handles the common case before a
        // socket is ever opened. A live daemon rejecting the handshake
        // itself over version would only happen if daemon.json's own
        // advertised protocolVersion were stale relative to what the
        // process behind it actually enforces — still section 2's
        // territory (a live daemon we won't talk over), not "absent".
        return { outcome: 'blocked', reason: 'version-mismatch' };
      }
      // Any other ProtocolError (malformed frame, etc.) isn't one of the
      // three reasons DaemonConnection's 'blocked' variant can name — fall
      // through to 'unreachable' rather than inventing a fourth.
      return { outcome: 'unreachable', error: err };
    }
    if (err instanceof Error && err.message.includes(HANDSHAKE_TIMEOUT_MESSAGE_FRAGMENT)) {
      // Connected, sent the handshake, nobody ever answered: the wire-level
      // definition of a zombie (section 5 step 3's second bullet).
      return { outcome: 'blocked', reason: 'zombie' };
    }
    // Anything else (the socket closed for some other/unknown reason before
    // completing the handshake) is treated the same as "couldn't reach it" —
    // not as positive proof of a zombie or a rejected token, which are the
    // only two things this function will ever call 'blocked'. Erring toward
    // "try again" here is safe by construction: a spawn this triggers can
    // only ever race a *possibly*-live daemon for the single-instance lock
    // (docs/specs/m1.8-single-instance.md section 3.1), which is
    // unconditionally safe — the loser exits quietly with code 3. Erring
    // the other way (silently trusting an ambiguous error to represent a
    // real daemon we know we shouldn't disturb) has no such safety net and
    // is not owed to a failure mode nobody's produced a working repro for.
    return { outcome: 'unreachable', error: toError(err) };
  }
}

/**
 * The real, production `spawnDaemon` default: resolves the daemon's built
 * script (`daemon-paths.ts`) and fires it off (`daemon-process.ts`). Logs
 * both the resolved script path and the address a caller expects it to
 * come up on — genuinely useful for diagnosing "why didn't this connect"
 * during dev, and matches this package's own src/main/index.ts precedent
 * of logging real state at these startup junctures rather than staying
 * silent.
 */
function defaultSpawnDaemon(address: string): void {
  const scriptPath = resolveDaemonScriptPath();
  console.log('[TermHub] spawning daemon', { scriptPath, address });
  spawnDaemonProcess(scriptPath);
}

/**
 * Finds, connects to, and — only when it is actually safe to (section 2) —
 * starts the daemon. Implements docs/specs/m2.1-daemon-client.md section 5
 * end to end: every dependency (where daemon.json lives, what address a
 * fresh daemon would use, how to spawn one) is a parameter with a real
 * default, precisely so this is testable without ever touching Electron —
 * section 7's own requirement, and the reason every required test in
 * section 8 can run as a plain Vitest test against a fake `spawnDaemon` and
 * a real (but disposable, uniquely-addressed) `TransportServer`/`net`
 * server standing in for "a daemon", instead of a real OS process.
 */
export async function connectToDaemon(
  options: ConnectToDaemonOptions = {},
): Promise<DaemonConnection> {
  const daemonJsonPath = options.daemonJsonPath ?? defaultDaemonJsonPath();
  const address = options.address ?? resolvePipeAddress();
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let lastError: Error = new Error(
    `no daemon.json found (or readable) at "${daemonJsonPath}", and no daemon could be started there`,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Sequential by design: section 5's algorithm is a strict read -> maybe
    // connect -> maybe spawn -> backoff chain, each step depending on the
    // previous one's outcome, not independent work to run concurrently.
    const info = await readDaemonInfo(daemonJsonPath);

    if (info !== undefined) {
      if (info.protocolVersion !== protocolVersion) {
        // Section 5 step 2: a version mismatch is decided from daemon.json
        // alone, before ever opening a socket — spawning over it would only
        // ever produce a process that loses the single-instance race.
        return { outcome: 'blocked', reason: 'version-mismatch', info };
      }

      const attemptResult = await attemptConnect(info, {
        protocolVersion,
        clientName: options.clientName,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
      });

      if (attemptResult.outcome === 'connected') {
        return { outcome: 'connected', client: attemptResult.client, info };
      }
      if (attemptResult.outcome === 'blocked') {
        return { outcome: 'blocked', reason: attemptResult.reason, info };
      }
      lastError = attemptResult.error;
    }

    if (attempt === maxAttempts) {
      // Final iteration already read (and, if present, tried) daemon.json
      // above — spawning again here would just be one more process nothing
      // will ever retry connecting to.
      break;
    }

    try {
      await spawnDaemon(address);
    } catch (err) {
      lastError = toError(err);
    }
    // The backoff wait between attempts is the entire point of this loop
    // being sequential — see the comment above the `readDaemonInfo` call.
    await sleep(computeBackoffMs(attempt, initialBackoffMs, maxBackoffMs));
  }

  return { outcome: 'failed', attempts: maxAttempts, lastError, daemonPath: daemonJsonPath };
}
