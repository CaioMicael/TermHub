import { describe, expect, it, vi } from 'vitest';

import {
  PROFILE_COMMAND_TIMEOUT_MS,
  createProfileService,
  detectShellProfiles,
  parseWslDistroList,
} from './profiles.js';
import type { CommandHandle, CommandResult, ProfileDetectionDeps } from './profiles.js';

// Pure unit tests for M4.6 (first half) shell detection: no PTY, no
// transport, no real process spawned — every OS interaction goes through a
// fake `ProfileDetectionDeps` (see profiles.ts's own header comment for why
// that's injected in the first place). The one describe block that spawns a
// real shell to prove a detected profile actually opens lives in
// service.test.ts instead (it needs the real transport/registry to do
// that), not here.

// ---------------------------------------------------------------------------
// parseWslDistroList — real UTF-16LE bytes, no process involved
// ---------------------------------------------------------------------------

function utf16le(text: string, withBom: boolean): Buffer {
  const body = Buffer.from(text, 'utf16le');
  return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

describe('parseWslDistroList', () => {
  it('parses UTF-16LE bytes with no BOM, CRLF-terminated', () => {
    const stdout = utf16le('Ubuntu\r\nDebian\r\n', false);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu', 'Debian']);
  });

  it('parses UTF-16LE bytes WITH a leading BOM the same way', () => {
    const stdout = utf16le('Ubuntu\r\nDebian\r\n', true);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu', 'Debian']);
  });

  it('skips blank lines between distros', () => {
    const stdout = utf16le('Ubuntu\r\n\r\n\r\nDebian\r\n', false);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu', 'Debian']);
  });

  it('trims trailing/leading spaces on an otherwise valid distro line', () => {
    const stdout = utf16le('  Ubuntu  \r\nDebian\r\n', false);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu', 'Debian']);
  });

  it('never turns the "no distributions installed" message into a distro', () => {
    // The real wsl.exe message (English locale), itself UTF-16LE — this is
    // exactly the bytes a machine with zero WSL distros produces.
    const stdout = utf16le(
      'Windows Subsystem for Linux has no installed distributions.\r\n' +
        'Distributions can be installed by visiting the Microsoft Store:\r\n' +
        'https://aka.ms/wslstore\r\n',
      false,
    );
    expect(parseWslDistroList(stdout)).toEqual([]);
  });

  it("hides the internal Docker Desktop utility distros (see this task's final report for why)", () => {
    const stdout = utf16le('Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\n', false);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu']);
  });

  it('deduplicates a distro name repeated (case-insensitively) in the listing', () => {
    const stdout = utf16le('Ubuntu\r\nubuntu\r\nUBUNTU\r\n', false);
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu']);
  });

  it('is a total no-op on empty stdout', () => {
    expect(parseWslDistroList(Buffer.alloc(0))).toEqual([]);
  });

  // Required proof (docs of this task, section 3.5): the same test seen
  // failing against the reintroduced defect, then passing again.
  it('would wrongly parse the no-distro message as a distro if stdout were decoded as UTF-8 instead of UTF-16LE', () => {
    const stdout = utf16le(
      'Windows Subsystem for Linux has no installed distributions.\r\n',
      false,
    );
    // This is the defect: decode as UTF-8, so every other byte becomes a
    // NUL/garbage character mixed into each letter, and naive splitting on
    // ASCII '\n' produces one "line" per UTF-16 code unit pair instead of
    // per real line — nothing usable, but critically NOT the empty array
    // the correct UTF-16LE decode produces either.
    const wrongDecode = Buffer.from(stdout.toString('utf8'), 'utf8');
    const linesIfDecodedAsUtf8 = wrongDecode
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(linesIfDecodedAsUtf8.length).not.toBe(0); // the bug: garbage "distro" lines appear
    // The real function, decoding correctly, sees no distros at all.
    expect(parseWslDistroList(stdout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fake ProfileDetectionDeps
// ---------------------------------------------------------------------------

function commandResult(stdout: string | Buffer, exitCode: number | null = 0): CommandResult {
  return { stdout: typeof stdout === 'string' ? utf16le(stdout, false) : stdout, exitCode };
}

function resolvedHandle(result: CommandResult): CommandHandle {
  return { result: Promise.resolve(result), kill: vi.fn() };
}

function rejectedHandle(error: Error): CommandHandle {
  return { result: Promise.reject(error), kill: vi.fn() };
}

/** Never resolves on its own — simulates `wsl.exe` hanging while the WSL service is still starting. `kill()` resolves it, the way a real killed process's `close` event eventually fires. */
function hangingHandle(): CommandHandle & { killed: boolean } {
  let resolveResult: (value: CommandResult) => void = () => {
    // reassigned synchronously below; placeholder keeps TS happy about
    // definite assignment without an `!` non-null assertion.
  };
  const result = new Promise<CommandResult>((resolve) => {
    resolveResult = resolve;
  });
  const handle = {
    result,
    killed: false,
    kill: vi.fn(() => {
      handle.killed = true;
      resolveResult({ stdout: Buffer.alloc(0), exitCode: null });
    }),
  };
  return handle;
}

interface WindowsSystemOptions {
  pwshOnPath?: boolean;
  pwshInstallDir?: boolean;
  hasGit?: boolean;
  wsl?: 'ok' | 'missing' | 'error' | 'hang';
  wslDistros?: string;
}

/** Builds a fake `ProfileDetectionDeps` for `platform: 'win32'`, entirely from an in-memory fake filesystem/registry — no real process, no real file, runnable from any host OS (this suite runs on Linux CI). */
function fakeWindowsDeps(options: WindowsSystemOptions = {}): {
  deps: Partial<ProfileDetectionDeps>;
  spawnCommand: ReturnType<typeof vi.fn>;
  fileExists: ReturnType<typeof vi.fn>;
} {
  const {
    pwshOnPath = true,
    pwshInstallDir = false,
    hasGit = true,
    wsl = 'ok',
    wslDistros = 'Ubuntu\r\n',
  } = options;

  const existingFiles = new Set<string>();
  if (pwshInstallDir) {
    existingFiles.add('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  }
  existingFiles.add('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  existingFiles.add('C:\\Windows\\System32\\cmd.exe');
  if (hasGit) {
    existingFiles.add('C:\\Program Files\\Git\\bin\\bash.exe');
  }

  const fileExists = vi.fn((path: string) => existingFiles.has(path));

  const spawnCommand = vi.fn((command: string, args: string[]): CommandHandle => {
    if (command === 'where.exe' && args[0] === 'pwsh') {
      return pwshOnPath
        ? resolvedHandle(commandResult('C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n', 0))
        : resolvedHandle(commandResult('', 1));
    }
    if (command === 'wsl.exe') {
      if (wsl === 'missing') {
        const err = new Error('spawn wsl.exe ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return rejectedHandle(err);
      }
      if (wsl === 'error') {
        return resolvedHandle(commandResult('', 1));
      }
      if (wsl === 'hang') {
        return hangingHandle();
      }
      return resolvedHandle(commandResult(wslDistros, 0));
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(' ')}`);
  });

  return {
    deps: {
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LocalAppData: 'C:\\Users\\caiom\\AppData\\Local',
      },
      fileExists,
      spawnCommand,
    },
    spawnCommand,
    fileExists,
  };
}

// ---------------------------------------------------------------------------
// detectShellProfiles — Windows, fake system (aceite item 2)
// ---------------------------------------------------------------------------

describe('detectShellProfiles: win32, fake system', () => {
  it('finds every profile when everything is present', async () => {
    const { deps } = fakeWindowsDeps();
    const profiles = await detectShellProfiles(deps);
    expect(profiles.map((p) => p.id)).toEqual([
      'pwsh',
      'powershell',
      'cmd',
      'git-bash',
      'wsl:Ubuntu',
    ]);
    const pwsh = profiles.find((p) => p.id === 'pwsh');
    expect(pwsh).toEqual({
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'pwsh',
      shell: 'pwsh.exe',
      args: [],
    });
    const wsl = profiles.find((p) => p.id === 'wsl:Ubuntu');
    expect(wsl).toEqual({
      id: 'wsl:Ubuntu',
      name: 'Ubuntu (WSL)',
      kind: 'wsl',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
    });
  });

  it('finds pwsh via the default install directory when `where.exe` fails to find it on PATH', async () => {
    const { deps } = fakeWindowsDeps({ pwshOnPath: false, pwshInstallDir: true });
    const profiles = await detectShellProfiles(deps);
    expect(profiles.some((p) => p.id === 'pwsh')).toBe(true);
  });

  it('omits pwsh entirely when neither PATH nor the default install directory has it', async () => {
    const { deps } = fakeWindowsDeps({ pwshOnPath: false, pwshInstallDir: false });
    const profiles = await detectShellProfiles(deps);
    expect(profiles.some((p) => p.id === 'pwsh')).toBe(false);
    // Windows PowerShell/cmd are unaffected by pwsh being absent.
    expect(profiles.some((p) => p.id === 'powershell')).toBe(true);
    expect(profiles.some((p) => p.id === 'cmd')).toBe(true);
  });

  it('omits Git Bash when Git is not installed, without affecting any other profile', async () => {
    const { deps } = fakeWindowsDeps({ hasGit: false });
    const profiles = await detectShellProfiles(deps);
    expect(profiles.some((p) => p.id === 'git-bash')).toBe(false);
    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'wsl:Ubuntu']);
  });

  it('omits every WSL entry when wsl.exe does not exist (ENOENT), without affecting any other profile', async () => {
    const { deps } = fakeWindowsDeps({ wsl: 'missing' });
    const profiles = await detectShellProfiles(deps);
    expect(profiles.some((p) => p.kind === 'wsl')).toBe(false);
    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash']);
  });

  it('omits every WSL entry when wsl.exe runs and exits with an error, without affecting any other profile', async () => {
    const { deps } = fakeWindowsDeps({ wsl: 'error' });
    const profiles = await detectShellProfiles(deps);
    expect(profiles.some((p) => p.kind === 'wsl')).toBe(false);
    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash']);
  });

  it(
    'a hanging wsl.exe is killed at PROFILE_COMMAND_TIMEOUT_MS (<= 3s) and detection still resolves ' +
      'with every other profile, instead of hanging forever',
    async () => {
      vi.useFakeTimers();
      try {
        expect(PROFILE_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(3_000);

        const { deps, spawnCommand } = fakeWindowsDeps({ wsl: 'hang' });
        const pending = detectShellProfiles(deps);

        // Nothing has settled yet: the hang is still in effect and no timer
        // has fired.
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(PROFILE_COMMAND_TIMEOUT_MS - 1);
        expect(settled).toBe(false);

        // Crossing the timeout kills the hung process and lets detection
        // finish.
        await vi.advanceTimersByTimeAsync(1);
        const profiles = await pending;

        const wslHandleCalls = spawnCommand.mock.results
          .map((r, i) => ({ call: spawnCommand.mock.calls[i], result: r }))
          .filter(({ call }) => call?.[0] === 'wsl.exe');
        expect(wslHandleCalls).toHaveLength(1);
        const wslHandle = wslHandleCalls[0]?.result.value as CommandHandle;
        expect(wslHandle.kill).toHaveBeenCalledTimes(1);

        expect(profiles.some((p) => p.kind === 'wsl')).toBe(false);
        expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash']);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('never throws, even when an injected dependency itself throws', async () => {
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      fileExists: () => {
        throw new Error('boom: fake filesystem exploded');
      },
      spawnCommand: () => {
        throw new Error('boom: fake process spawn exploded');
      },
    };
    await expect(detectShellProfiles(deps)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Required proof (section 3.5): each of the tests above seen FAILING against
// the reintroduced defect (UTF-8 decode of wsl's stdout; no timeout), then
// passing again. See this task's final report for the exact commands run
// and their output — reproduced here as an assertion so the regression stays
// caught by `npx vitest run` too, not only by a one-off manual repro.
// ---------------------------------------------------------------------------

describe('regression: decoding wsl.exe stdout as UTF-8 instead of UTF-16LE', () => {
  it('would silently show zero WSL profiles for a machine that actually has "Ubuntu" installed', () => {
    const stdout = utf16le('Ubuntu\r\n', false);
    // The defect: decode as UTF-8. Every ASCII character in "Ubuntu" is
    // followed by a NUL byte in UTF-16LE, and NUL bytes survive a UTF-8
    // decode as U+0000 characters glued onto each letter — no line ever
    // equals the bare string "Ubuntu" again.
    const wrongLines = stdout
      .toString('utf8')
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/\s/.test(l));
    expect(wrongLines).not.toEqual(['Ubuntu']); // proves the defect breaks parsing
    // The real, fixed parser still gets it right.
    expect(parseWslDistroList(stdout)).toEqual(['Ubuntu']);
  });
});

// ---------------------------------------------------------------------------
// detectShellProfiles — posix (this container's own real platform, PLUS a
// fully fake system so it's exercised deterministically too)
// ---------------------------------------------------------------------------

describe('detectShellProfiles: non-win32, fake system', () => {
  it('reports $SHELL plus every existing candidate, deduplicated by path, in a stable order', async () => {
    const existing = new Set(['/bin/zsh', '/bin/sh']);
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      fileExists: (path) => existing.has(path),
      spawnCommand: () => {
        throw new Error('posix detection must never spawn a process');
      },
    };
    const profiles = await detectShellProfiles(deps);
    expect(profiles).toEqual([
      { id: 'posix:/bin/zsh', name: 'zsh', kind: 'posix', shell: '/bin/zsh', args: [] },
      { id: 'posix:/bin/sh', name: 'sh', kind: 'posix', shell: '/bin/sh', args: [] },
    ]);
  });

  it('omits a candidate that does not exist, without throwing', async () => {
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'darwin',
      env: {},
      fileExists: (path) => path === '/bin/sh',
      spawnCommand: () => {
        throw new Error('posix detection must never spawn a process');
      },
    };
    const profiles = await detectShellProfiles(deps);
    expect(profiles).toEqual([
      { id: 'posix:/bin/sh', name: 'sh', kind: 'posix', shell: '/bin/sh', args: [] },
    ]);
  });

  it('never throws even when fileExists itself throws', async () => {
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      fileExists: () => {
        throw new Error('boom');
      },
      spawnCommand: () => {
        throw new Error('unused');
      },
    };
    await expect(detectShellProfiles(deps)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createProfileService — caching (aceite item 4)
// ---------------------------------------------------------------------------

describe('createProfileService: caching', () => {
  it('detects once on the first list(), and NOT again on a second list() without refresh', async () => {
    let calls = 0;
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'linux',
      env: { SHELL: '/bin/sh' },
      fileExists: (path) => {
        calls += 1;
        return path === '/bin/sh';
      },
      spawnCommand: () => {
        throw new Error('unused');
      },
    };
    const service = createProfileService(deps);

    const first = await service.list();
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await service.list();
    expect(calls).toBe(callsAfterFirst); // nothing new ran
    expect(second).toEqual(first);
  });

  it('refresh: true re-runs detection', async () => {
    let calls = 0;
    let existing = new Set(['/bin/sh']);
    const deps: Partial<ProfileDetectionDeps> = {
      platform: 'linux',
      env: {},
      fileExists: (path) => {
        calls += 1;
        return existing.has(path);
      },
      spawnCommand: () => {
        throw new Error('unused');
      },
    };
    const service = createProfileService(deps);

    const first = await service.list();
    expect(first.map((p) => p.shell)).toEqual(['/bin/sh']);
    const callsAfterFirst = calls;

    // Change what the fake filesystem reports, then force a fresh look.
    existing = new Set(['/bin/sh', '/bin/zsh']);
    const refreshed = await service.list(true);
    expect(calls).toBeGreaterThan(callsAfterFirst); // detection actually ran again
    expect(refreshed.map((p) => p.shell).sort()).toEqual(['/bin/sh', '/bin/zsh']);
  });
});
