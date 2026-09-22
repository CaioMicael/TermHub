import { pathToFileURL } from 'node:url';

import { ALREADY_RUNNING_EXIT_CODE } from './daemon.js';
import { runDaemon } from './daemon-runtime.js';

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

async function main(): Promise<void> {
  const result = await runDaemon();
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

  const handleSignal = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime
      .shutdown()
      .catch((err: unknown) => {
        // Section 3.5's shutdown steps (kill live sessions, close the
        // transport, remove daemon.json if it's still ours) are each
        // individually best-effort/idempotent already — this is only a
        // safety net for something unexpected in that chain, so the
        // process still exits deliberately instead of hanging on a signal
        // that's supposed to mean "stop".
        console.error('error while shutting down', err);
      })
      .finally(() => {
        process.exit(0);
      });
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
