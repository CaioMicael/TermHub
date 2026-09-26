import { describe, expect, it, vi } from 'vitest';
import type { ShellProfile } from '@termhub/shared';

import {
  isProfileMenuCloseKey,
  loadShellProfiles,
  type ProfileMenuBridge,
} from './profile-menu-actions.js';

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

describe('loadShellProfiles', () => {
  it('calls profiles.list with no refresh flag and returns its profiles array', async () => {
    const list = [
      profile(),
      profile({ id: 'cmd', name: 'Command Prompt', kind: 'cmd', shell: 'cmd.exe' }),
    ];
    const request = vi.fn().mockResolvedValue({ profiles: list });
    const bridge: ProfileMenuBridge = { request };

    const result = await loadShellProfiles(bridge);

    expect(result).toEqual(list);
    expect(request).toHaveBeenCalledWith('profiles.list', {});
  });

  it('propagates a rejected profiles.list unchanged', async () => {
    const request = vi.fn().mockRejectedValue(new Error('daemon unreachable'));
    await expect(loadShellProfiles({ request })).rejects.toThrow('daemon unreachable');
  });
});

describe('isProfileMenuCloseKey', () => {
  it('is true for Escape', () => {
    expect(isProfileMenuCloseKey('Escape')).toBe(true);
  });

  it('is false for any other key', () => {
    expect(isProfileMenuCloseKey('Enter')).toBe(false);
    expect(isProfileMenuCloseKey('a')).toBe(false);
    expect(isProfileMenuCloseKey('')).toBe(false);
  });
});
