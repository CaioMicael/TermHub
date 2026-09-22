import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { Session } from './session.js';

// Some dev machines only have Windows PowerShell 5.1 (`powershell.exe`)
// installed; CI's `windows-latest` image additionally ships PowerShell 7
// (`pwsh.exe`). Prefer pwsh when it's there, but don't hard-fail the suite
// on a machine that lacks it — both shells understand `echo hi`, which is
// all this test needs from them.
function resolveShell(): string {
  try {
    execFileSync('where', ['pwsh.exe'], { stdio: 'ignore' });
    return 'pwsh.exe';
  } catch {
    return 'powershell.exe';
  }
}

// `process.kill(pid, 0)` sends no signal on any platform, POSIX or Windows —
// it only probes whether the OS still knows about the PID, throwing ESRCH
// (or, on Windows, an equivalent error) once the process is gone. That's
// exactly what's needed to prove `Session#kill()` didn't leave the shell
// running as an orphan.
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ESC = '\x1b';
const BEL = '\x07';

// PowerShell's line editor (PSReadLine) echoes typed input back wrapped in
// SGR color codes (e.g. `ESC[93mecho ESC[37mhi`), and the real command
// output arrives glued to cursor-visibility codes too (e.g.
// `ESC[?25h ESC[m hi`). Strip CSI (`ESC [ ... final byte`) and OSC (`ESC ]
// ... BEL`, used for the window-title sequence) before matching, otherwise
// a plain `.trim()` never reduces either line down to a bare "hi". Written
// as a manual scan rather than a regex: a pattern matching these control
// characters on purpose would trip ESLint's `no-control-regex` (there to
// catch *accidental* control chars in a pattern, not intentional ones), and
// this project doesn't relax lint rules to get code to pass.
function stripAnsi(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input.charAt(i) === ESC && input.charAt(i + 1) === '[') {
      // CSI: ESC [ <params/intermediates> <final byte in '@'..'~'>
      let j = i + 2;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        j++;
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
      i = j;
      continue;
    }
    if (input.charAt(i) === ESC && input.charAt(i + 1) === ']') {
      // OSC: ESC ] <data> (BEL | ESC \)
      let j = i + 2;
      while (j < input.length && input.charAt(j) !== BEL) {
        if (input.charAt(j) === ESC && input.charAt(j + 1) === '\\') {
          j += 2;
          break;
        }
        j++;
      }
      if (input.charAt(j) === BEL) {
        j++;
      }
      i = j;
      continue;
    }
    out += input.charAt(i);
    i++;
  }
  return out;
}

// A line consisting of exactly "hi" can only be the `echo hi` command's
// *output*, never the echoed input line itself (that line reads "echo hi").
// Matching on `output.includes('hi')` alone would pass the instant the
// terminal echoes back the keystrokes, before the shell ever ran anything —
// this check waits for the real result.
function hasStandaloneHiLine(output: string): boolean {
  return stripAnsi(output)
    .split(/\r?\n/)
    .some((line) => line.trim() === 'hi');
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }
}

describe('Session', () => {
  // Spawns a real process and waits on real I/O, so it gets a generous
  // timeout instead of vitest's 5s default flaking on a loaded CI runner.
  it('spawns a real shell, captures its output, and leaves no orphan process behind on kill', async () => {
    const shell = resolveShell();
    const session = new Session({
      shell,
      args: ['-NoLogo', '-NoProfile'],
      cols: 80,
      rows: 24,
    });

    try {
      let output = '';
      session.onData((data) => {
        output += data;
      });

      session.write('echo hi\r');

      await waitFor(() => hasStandaloneHiLine(output), 15_000);
      expect(hasStandaloneHiLine(output)).toBe(true);

      const pid = session.pid;
      expect(processExists(pid)).toBe(true);

      const exited = new Promise<void>((resolve) => {
        session.onExit(() => resolve());
      });

      session.kill();
      await exited;
      expect(session.isAlive).toBe(false);

      // On Windows/ConPTY, killing walks the console's process list and
      // terminates each PID asynchronously (see session.ts) — the PID can
      // still briefly exist right after the synchronous kill() call and
      // even right after the exit event, so poll instead of asserting
      // immediately.
      await waitFor(() => !processExists(pid), 15_000);
      expect(processExists(pid)).toBe(false);
    } finally {
      // Guaranteed cleanup even if an assertion above throws midway:
      // never leave a shell running on the machine that ran this suite.
      // Safe to call again even if it already exited (see Session#kill).
      session.kill();
    }
  }, 30_000);
});
