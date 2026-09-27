import { describe, expect, it } from 'vitest';
import type { ShellProfile } from '@termhub/shared';

import { pickDefaultShellProfile } from './default-shell-profile.js';

function profile(overrides: Partial<ShellProfile> = {}): ShellProfile {
  return {
    id: 'pwsh',
    name: 'PowerShell 7',
    kind: 'pwsh',
    shell: 'pwsh.exe',
    args: [],
    ...overrides,
  };
}

describe('pickDefaultShellProfile', () => {
  it('Windows with pwsh installed: picks pwsh even when powershell/cmd are also present', () => {
    const pwsh = profile();
    const powershell = profile({
      id: 'powershell',
      name: 'Windows PowerShell 5.1',
      kind: 'powershell',
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    const cmd = profile({
      id: 'cmd',
      name: 'Command Prompt',
      kind: 'cmd',
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(pickDefaultShellProfile([powershell, cmd, pwsh])).toEqual(pwsh);
  });

  it('Windows without pwsh: falls back to powershell, then cmd', () => {
    const powershell = profile({
      id: 'powershell',
      name: 'Windows PowerShell 5.1',
      kind: 'powershell',
      shell: 'powershell.exe',
    });
    const cmd = profile({ id: 'cmd', name: 'Command Prompt', kind: 'cmd', shell: 'cmd.exe' });
    const gitBash = profile({
      id: 'git-bash',
      name: 'Git Bash',
      kind: 'git-bash',
      shell: 'bash.exe',
      args: ['--login', '-i'],
    });

    expect(pickDefaultShellProfile([gitBash, cmd, powershell])).toEqual(powershell);
    expect(pickDefaultShellProfile([gitBash, cmd])).toEqual(cmd);
  });

  it('never defaults to git-bash or a WSL distro, even when they are the only Windows-ish profiles', () => {
    const gitBash = profile({
      id: 'git-bash',
      name: 'Git Bash',
      kind: 'git-bash',
      shell: 'bash.exe',
      args: ['--login', '-i'],
    });
    const wsl = profile({
      id: 'wsl:Ubuntu',
      name: 'Ubuntu (WSL)',
      kind: 'wsl',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
    });

    expect(pickDefaultShellProfile([gitBash, wsl])).toBeUndefined();
  });

  it('posix: picks the first posix profile in the list (already $SHELL-first per detection order)', () => {
    const shellEnv = profile({
      id: 'posix:/usr/bin/zsh',
      name: 'zsh',
      kind: 'posix',
      shell: '/usr/bin/zsh',
      args: [],
    });
    const bash = profile({
      id: 'posix:/bin/bash',
      name: 'bash',
      kind: 'posix',
      shell: '/bin/bash',
      args: [],
    });

    expect(pickDefaultShellProfile([shellEnv, bash])).toEqual(shellEnv);
    expect(pickDefaultShellProfile([bash])).toEqual(bash);
  });

  it('empty profile list: undefined', () => {
    expect(pickDefaultShellProfile([])).toBeUndefined();
  });
});
