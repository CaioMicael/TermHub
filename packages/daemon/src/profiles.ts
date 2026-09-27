import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

import type { ShellProfile } from '@termhub/shared';

// M4.6 (first half): detects the shells actually available on this machine
// and backs the `profiles.list` RPC service.ts registers. This module is
// pure detection — no transport, and no change to `session.create`/the
// shells the UI launches today (that's this milestone's second half: the
// `+` button menu and making profiles user-configurable — see this task's
// final report for the exact split).
//
// Every actual interaction with the OS — spawning a process, checking a
// file exists, reading an env var — goes through `ProfileDetectionDeps`
// instead of calling node:child_process/node:fs/process.env directly. That
// is the same "the platform is an injectable parameter" shape M1.8
// established for exactly this reason (.claude/rules/agent-workflow.md):
// it's what lets Windows detection (the Git Bash/WSL scan, `wsl.exe`'s
// UTF-16LE output and its very real tendency to hang while the WSL service
// is still starting) run — and be made to fail on purpose — from a test on
// this Linux container, and lets the posix detection path be exercised the
// same way from a Windows host.

// ---------------------------------------------------------------------------
// Injected system dependencies
// ---------------------------------------------------------------------------

/**
 * One command's outcome. `stdout` is always raw bytes — decoding is left to
 * whichever caller actually cares (only WSL detection does, and decodes it
 * as UTF-16LE; see `parseWslDistroList`). `exitCode` is `null` when the
 * process never exited on its own, i.e. it was `kill()`ed (by
 * `runCommand`'s timeout, below).
 */
export interface CommandResult {
  stdout: Buffer;
  exitCode: number | null;
}

/** A running (or already-finished) command, as `ProfileDetectionDeps.spawnCommand` hands it back. */
export interface CommandHandle {
  /**
   * Resolves once the process exits, however that happens — including
   * having been `kill()`ed. Never rejects for "the process ran and exited
   * nonzero", which every caller here treats as a normal "not
   * installed"/"nothing to report" outcome by inspecting `exitCode`, not as
   * a thrown error. Only rejects if the process could never be spawned at
   * all (e.g. `ENOENT` — the executable doesn't exist), which every caller
   * here also treats as "not found", never as an uncaught exception.
   */
  result: Promise<CommandResult>;
  /** Kills the process. Safe to call again, or after it already exited on its own — a no-op then, same contract `Session#kill` (session.ts) already makes. */
  kill: () => void;
}

/**
 * Every OS interaction this module performs, injected so detection is
 * deterministic and testable from any host OS — see this module's own
 * header comment. `platform`/`env` default to `process.platform`/
 * `process.env`; `fileExists`/`spawnCommand` default to real `fs`/
 * `child_process` calls (`defaultProfileDetectionDeps`, below). Callers
 * normally pass a `Partial<ProfileDetectionDeps>` (see `detectShellProfiles`/
 * `createProfileService`) and get the real ones for whatever they don't
 * override.
 */
export interface ProfileDetectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether a file exists at `path`. Every call site here is a local, synchronous check — never a network path. */
  fileExists: (path: string) => boolean;
  /** Spawns `command args` to completion. See `CommandHandle`'s own doc comment for the resolve/reject contract. */
  spawnCommand: (command: string, args: string[]) => CommandHandle;
}

function defaultSpawnCommand(command: string, args: string[]): CommandHandle {
  let child: ChildProcess | undefined;
  const result = new Promise<CommandResult>((resolve, reject) => {
    child = execFile(command, args, { encoding: 'buffer' }, (error, stdout) => {
      if (error !== null && typeof error.code === 'string') {
        // The executable itself could not even be spawned (e.g. ENOENT) —
        // the only outcome this promise rejects for.
        reject(
          error instanceof Error
            ? error
            : new Error(`spawn "${command}" failed: ${String(error.code)}`),
        );
        return;
      }
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ stdout, exitCode });
    });
  });
  return {
    result,
    kill: () => {
      child?.kill('SIGKILL');
    },
  };
}

function defaultProfileDetectionDeps(): ProfileDetectionDeps {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: existsSync,
    spawnCommand: defaultSpawnCommand,
  };
}

/**
 * Upper bound on how long any single detection command (`where.exe`,
 * `wsl.exe`) is allowed to run before it's killed and treated as "not
 * found". `wsl.exe -l -q` genuinely hangs while the WSL service is still
 * coming up (docs/milestones.md M4.6's own named pitfall) — detection must
 * never wait on it forever, and must not leave it running in the
 * background after giving up on it.
 */
export const PROFILE_COMMAND_TIMEOUT_MS = 3_000;

/**
 * Runs `command args` and waits for it, killing it and treating it as "not
 * found" (`undefined`) if it hasn't exited within `PROFILE_COMMAND_TIMEOUT_MS`
 * — or if it couldn't be spawned at all. Never throws: every caller here
 * relies on that to keep one shell's detection failing from taking any
 * other shell's down with it.
 */
async function runCommand(
  deps: ProfileDetectionDeps,
  command: string,
  args: string[],
): Promise<CommandResult | undefined> {
  const handle = deps.spawnCommand(command, args);
  const timer = setTimeout(() => handle.kill(), PROFILE_COMMAND_TIMEOUT_MS);
  try {
    return await handle.result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Windows detection
// ---------------------------------------------------------------------------

function pwshProfile(): ShellProfile {
  return { id: 'pwsh', name: 'PowerShell 7', kind: 'pwsh', shell: 'pwsh.exe', args: [] };
}

async function detectPwsh(deps: ProfileDetectionDeps): Promise<ShellProfile | undefined> {
  try {
    const viaPath = await runCommand(deps, 'where.exe', ['pwsh']);
    if (viaPath !== undefined && viaPath.exitCode === 0) {
      return pwshProfile();
    }
    const installRoots = [deps.env.ProgramFiles, deps.env['ProgramFiles(x86)']].filter(
      (root): root is string => root !== undefined,
    );
    for (const root of installRoots) {
      if (deps.fileExists(pathWin32.join(root, 'PowerShell', '7', 'pwsh.exe'))) {
        return pwshProfile();
      }
    }
    return undefined;
  } catch {
    // Defensive only: runCommand already never throws, and fileExists is a
    // caller-supplied dependency — a broken one must still leave every
    // other profile detectable (docs/milestones.md M4.6: "shell que falha
    // só não aparece").
    return undefined;
  }
}

function detectWindowsPowerShell(deps: ProfileDetectionDeps): ShellProfile | undefined {
  try {
    const systemRoot = deps.env.SystemRoot ?? pathWin32.join('C:', 'Windows');
    const shell = pathWin32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (!deps.fileExists(shell)) {
      return undefined;
    }
    return {
      id: 'powershell',
      name: 'Windows PowerShell 5.1',
      kind: 'powershell',
      shell,
      args: [],
    };
  } catch {
    return undefined;
  }
}

function detectCmd(deps: ProfileDetectionDeps): ShellProfile | undefined {
  try {
    const shell = deps.env.ComSpec;
    if (shell === undefined || !deps.fileExists(shell)) {
      return undefined;
    }
    return { id: 'cmd', name: 'Command Prompt', kind: 'cmd', shell, args: [] };
  } catch {
    return undefined;
  }
}

function detectGitBash(deps: ProfileDetectionDeps): ShellProfile | undefined {
  try {
    const installRoots = [
      deps.env.ProgramFiles,
      deps.env['ProgramFiles(x86)'],
      deps.env.LocalAppData,
    ].filter((root): root is string => root !== undefined);
    for (const root of installRoots) {
      // `bin\bash.exe`, not `usr\bin\bash.exe`: the former sets up Git
      // Bash's own environment (MSYSTEM, PATH translation, …) on launch;
      // the latter doesn't (docs/milestones.md M4.6's own named pitfall).
      const shell = pathWin32.join(root, 'Git', 'bin', 'bash.exe');
      if (deps.fileExists(shell)) {
        return {
          id: 'git-bash',
          name: 'Git Bash',
          kind: 'git-bash',
          shell,
          args: ['--login', '-i'],
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Distro names `wsl.exe -l -q` can report that are internal WSL plumbing —
 * Docker Desktop's own utility distros, never something meant to be entered
 * as an interactive shell — filtered out of the profile list on purpose.
 * See this task's final report for why: they aren't a decision this
 * module's prompt spelled out, and a caller of `wsl -d docker-desktop`
 * lands in a distro with no normal user shell/login setup, not a usable
 * terminal.
 */
const HIDDEN_WSL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/**
 * Parses `wsl.exe -l -q`'s stdout into distro names. Exported so this exact
 * parsing is unit-testable against real captured bytes without spawning
 * anything.
 *
 * `wsl.exe` writes UTF-16LE — with or without a leading BOM; `TextDecoder`
 * strips one when present — `\r\n`-terminated, one distro per line, no
 * header (the `-q`/`--quiet` flag suppresses it). A line is only ever kept
 * if it's letters/digits/`.`/`_`/`-` (a real distro name never contains
 * anything else) — that is what keeps the (itself UTF-16LE, and however
 * it's localized) "no distributions installed" message from ever being
 * parsed as one, without this function having to match its exact wording:
 * its prose lines contain spaces, and its follow-up URL
 * (`https://aka.ms/wslstore`) contains `:`/`/`, so a whitespace-only filter
 * alone would not have been enough.
 */
export function parseWslDistroList(stdout: Buffer): string[] {
  const text = new TextDecoder('utf-16le').decode(stdout);
  const seen = new Set<string>();
  const distros: string[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    // A real distro name (Microsoft Store, `wsl --install`, or a custom
    // import) is letters/digits/`.`/`_`/`-` only — never whitespace, and
    // never punctuation like `:`/`/`. That second part matters as much as
    // the first: the "no distributions installed" message's own follow-up
    // lines include a bare URL (e.g. `https://aka.ms/wslstore`), which has
    // no whitespace at all and would slip past a whitespace-only filter.
    if (!/^[A-Za-z0-9._-]+$/.test(line)) {
      continue;
    }
    const key = line.toLowerCase();
    if (HIDDEN_WSL_DISTROS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    distros.push(line);
  }
  return distros;
}

async function detectWslDistros(deps: ProfileDetectionDeps): Promise<ShellProfile[]> {
  try {
    const outcome = await runCommand(deps, 'wsl.exe', ['-l', '-q']);
    if (outcome === undefined || outcome.exitCode !== 0) {
      // Covers: wsl.exe missing entirely, it hung and got killed by
      // runCommand's timeout, or it ran and exited non-zero (which is what
      // "no distributions installed" does on a real machine) — all "no WSL
      // profiles to offer", never a thrown error.
      return [];
    }
    return parseWslDistroList(outcome.stdout).map((distro): ShellProfile => ({
      id: `wsl:${distro}`,
      name: `${distro} (WSL)`,
      kind: 'wsl',
      shell: 'wsl.exe',
      args: ['-d', distro],
    }));
  } catch {
    return [];
  }
}

async function detectWindowsProfiles(deps: ProfileDetectionDeps): Promise<ShellProfile[]> {
  const [pwsh, wsl] = await Promise.all([detectPwsh(deps), detectWslDistros(deps)]);
  const powershell = detectWindowsPowerShell(deps);
  const cmd = detectCmd(deps);
  const gitBash = detectGitBash(deps);

  const profiles: ShellProfile[] = [];
  if (pwsh !== undefined) profiles.push(pwsh);
  if (powershell !== undefined) profiles.push(powershell);
  if (cmd !== undefined) profiles.push(cmd);
  if (gitBash !== undefined) profiles.push(gitBash);
  profiles.push(...wsl);
  return profiles;
}

// ---------------------------------------------------------------------------
// Posix detection
// ---------------------------------------------------------------------------

const POSIX_SHELL_CANDIDATES = ['/bin/bash', '/bin/zsh', '/bin/sh'];

function detectPosixProfiles(deps: ProfileDetectionDeps): ShellProfile[] {
  const candidates = [deps.env.SHELL, ...POSIX_SHELL_CANDIDATES].filter(
    (path): path is string => path !== undefined,
  );
  const seen = new Set<string>();
  const profiles: ShellProfile[] = [];
  for (const shell of candidates) {
    if (seen.has(shell)) {
      continue;
    }
    seen.add(shell);
    let exists: boolean;
    try {
      exists = deps.fileExists(shell);
    } catch {
      continue;
    }
    if (!exists) {
      continue;
    }
    profiles.push({
      id: `posix:${shell}`,
      name: pathPosix.basename(shell),
      kind: 'posix',
      shell,
      args: [],
    });
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Runs detection once, right now, ignoring any cache. `createProfileService`
 * below is the cached, cheap-to-call-repeatedly wrapper around this that
 * `service.ts` actually registers as `profiles.list`.
 */
export async function detectShellProfiles(
  overrides: Partial<ProfileDetectionDeps> = {},
): Promise<ShellProfile[]> {
  const deps: ProfileDetectionDeps = { ...defaultProfileDetectionDeps(), ...overrides };
  return deps.platform === 'win32' ? detectWindowsProfiles(deps) : detectPosixProfiles(deps);
}

/** `profiles.list`'s backing service: detection runs once, on the first `list()` call, and stays cached for the daemon's lifetime; `list(true)` (`refresh: true` on the wire) re-detects. */
export interface ProfileService {
  list(refresh?: boolean): Promise<ShellProfile[]>;
}

/**
 * Builds the `ProfileService` `service.ts` registers `profiles.list`
 * against. `overrides` — normally left empty in production — is threaded
 * straight through to every `detectShellProfiles` call this service ever
 * makes, so a test can inject a fake system once here instead of passing it
 * to every `list()` call individually.
 */
export function createProfileService(
  overrides: Partial<ProfileDetectionDeps> = {},
): ProfileService {
  let cache: ShellProfile[] | undefined;
  let inFlight: Promise<ShellProfile[]> | undefined;

  return {
    async list(refresh = false): Promise<ShellProfile[]> {
      if (refresh) {
        cache = undefined;
      }
      if (cache !== undefined) {
        return cache;
      }
      if (inFlight === undefined) {
        inFlight = detectShellProfiles(overrides).then((profiles) => {
          cache = profiles;
          inFlight = undefined;
          return profiles;
        });
      }
      return inFlight;
    },
  };
}
