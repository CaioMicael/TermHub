import { spawn } from 'node:child_process';

// The exact spawn recipe docs/specs/m2.1-daemon-client.md section 4
// mandates — each option is load-bearing there, not decorative. Split out
// from daemon-client.ts's connect/backoff orchestration so it has its own
// small, independently testable surface: given a script path, spawn it
// exactly this way, full stop.

/**
 * Spawns the daemon script at `scriptPath` as a detached, Electron-hosted
 * Node process (`ELECTRON_RUN_AS_NODE=1`) and immediately lets go of it.
 *
 * This function never keeps a handle to the child past `.unref()` and never
 * awaits its exit — both deliberate. Docs/specs/m2.1-daemon-client.md
 * section 2 is the project owner's non-negotiable decision that this app
 * must never be able to terminate a daemon: not holding a reference is what
 * makes "nothing in this module can call `process.kill` on the daemon" true
 * by construction, not just by discipline. A daemon that loses the
 * single-instance race (docs/specs/m1.8-single-instance.md section 3.1)
 * exits with code 3 on its own; this function isn't listening for that
 * either — daemon-client.ts's retry loop simply reconnects, per docs/specs/
 * m2.1-daemon-client.md section 5's own note that losing the race is
 * success, not failure.
 */
export function spawnDaemonProcess(scriptPath: string): void {
  spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}
