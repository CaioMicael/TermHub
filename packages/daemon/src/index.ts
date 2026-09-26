import { pathToFileURL } from 'node:url';

import { ALREADY_RUNNING_EXIT_CODE } from './daemon.js';
import { runDaemon } from './daemon-runtime.js';
import type { RunDaemonOptions } from './daemon-runtime.js';
import { resolvePipeAddress } from './transport-address.js';

// The daemon's real OS-process entrypoint (docs/milestones.md M1.8's own
// "packages/daemon/index.ts", and docs/specs/m1.8-single-instance.md
// section 3). This is intentionally a thin wrapper: `runDaemon`
// (daemon-runtime.ts) does everything actually worth testing — winning the
// lock, wiring the session service, arming idle-shutdown — in a way that's
// callable without spawning a process at all (docs/specs/
// m1.8-single-instance.md section 4's own requirement). What only makes
// sense as a real running process lives here: exiting with the code section
// 3.1 specifies on losing the race, and turning SIGINT/SIGTERM into the
// clean-shutdown path of section 3.5.
//
// M2.1 (out of scope here) is what will actually spawn this — as a
// detached Electron-hosted Node process via `ELECTRON_RUN_AS_NODE`, with
// its own retry/backoff and zombie-daemon detection. This file doesn't need
// to know any of that: it only needs to behave correctly when *something*
// runs it as `node index.ts` (or, in production, the Electron equivalent).

/**
 * Reads `TERMHUB_PIPE_SUFFIX`, the one env var this entrypoint (and only
 * this entrypoint — daemon-runtime.ts stays a library that never touches
 * `process.env`) understands for test isolation: a test app with its own
 * `APPDATA` reads a `daemon.json` from its own isolated directory, but
 * without this, the daemon it spawns would still resolve the *same* pipe
 * name a real daemon on the same machine uses (`derivePipeName` /
 * `resolvePipeAddress` in transport-address.ts key only off the OS
 * username), so the two would collide on `listen()` — the test daemon
 * either loses the race and never starts, or wins it and silently steals
 * the real daemon's address. Folding an extra suffix into the same hash
 * (transport-address.ts's own `suffix` option, already used by every test
 * in this package) gives the test daemon a distinct pipe end to end,
 * without the app itself needing to change: it just connects to whatever
 * pipe the daemon it spawned announces in its own `daemon.json`.
 *
 * Unset (the default), this returns `undefined` and `main()` below passes
 * no `address` to `runDaemon`, which falls through to `startDaemon`'s own
 * default (`resolvePipeAddress()` with no suffix) — byte-identical to
 * today's behavior.
 *
 * Exported for index.test.ts's isolation test to exercise directly, in
 * addition to that same test spawning two real daemon processes with
 * distinct suffixes end to end.
 */
export function resolveAddressOverride(): string | undefined {
  const suffix = process.env.TERMHUB_PIPE_SUFFIX;
  if (suffix === undefined || suffix.length === 0) {
    return undefined;
  }
  return resolvePipeAddress({ suffix });
}

/**
 * Reads `TERMHUB_IDLE_TIMEOUT_MS`/`TERMHUB_IDLE_CHECK_INTERVAL_MS` —
 * entrypoint-only escape hatches (same reasoning as
 * `resolveAddressOverride` above) so a test can spawn this file as a real
 * process with a short idle timeout, rather than waiting out the real
 * 10-minute default. `runDaemon` already accepts both as options; nothing
 * about their meaning changes here, this just plumbs them from the
 * environment. Unset, both are `undefined` and `runDaemon` falls through to
 * its own real defaults, exactly as today.
 */
function readOptionalMs(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const address = resolveAddressOverride();
  const idleTimeoutMs = readOptionalMs('TERMHUB_IDLE_TIMEOUT_MS');
  const idleCheckIntervalMs = readOptionalMs('TERMHUB_IDLE_CHECK_INTERVAL_MS');
  const runDaemonOptions: RunDaemonOptions = {
    ...(address !== undefined ? { address } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(idleCheckIntervalMs !== undefined ? { idleCheckIntervalMs } : {}),
  };

  const result = await runDaemon(runDaemonOptions);
  if (result.outcome === 'already-running') {
    // Section 3.1: losing the race is an expected, quiet outcome, not a
    // failure — a distinct exit code lets a caller (M2.1's spawn logic)
    // tell "someone else already owns this address" apart from "this
    // daemon actually failed to start", without parsing stderr.
    process.exit(ALREADY_RUNNING_EXIT_CODE);
    return;
  }

  const { runtime } = result;
  let shuttingDown = false;

  // The single place this process decides to exit, for *any* shutdown
  // trigger — signal or idle-shutdown alike. Before this fix, only the
  // signal path below called `process.exit` explicitly; the idle path
  // (daemon-runtime.ts's `onIdleTimeout`, which only calls
  // `runtime.shutdown()`) relied on the event loop draining once
  // `shutdown()`'s own steps finished, which never happened in practice —
  // a daemon idled out this way stayed alive indefinitely (see this task's
  // final report for what was actually still holding the event loop open).
  // Registering this before either trigger can fire (nothing above this
  // line awaits) makes both paths converge on the exact same exit
  // behavior the old signal-only code had, without duplicating it.
  runtime.onShutdownComplete((err) => {
    if (err !== undefined) {
      // Section 3.5's shutdown steps (kill live sessions, close the
      // transport, remove daemon.json if it's still ours) are each
      // individually best-effort/idempotent already — this is only a
      // safety net for something unexpected in that chain, so the process
      // still exits deliberately instead of hanging on a shutdown that's
      // supposed to mean "stop".
      console.error('error while shutting down', err);
    }
    process.exit(0);
  });

  const handleSignal = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void runtime.shutdown();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

// ESM equivalent of `require.main === module` — mirrors cli.ts's own guard.
// Nothing in this package imports index.ts as a library today (daemon-
// runtime.ts is what tests and cli.ts build on instead), but guarding this
// the same way keeps `main()` from ever running as a side effect of a
// future import, e.g. from a test that wants to reuse a type this file
// exports.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('daemon failed to start', err);
    process.exit(1);
  });
}
