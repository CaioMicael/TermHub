import { describe, expect, it } from 'vitest';

import { derivePipeName, formatPipePath, resolvePipeAddress } from './transport-address.js';

describe('derivePipeName', () => {
  it('is deterministic for the same username', () => {
    expect(derivePipeName({ username: 'alice' })).toBe(derivePipeName({ username: 'alice' }));
  });

  it('differs for different usernames', () => {
    expect(derivePipeName({ username: 'alice' })).not.toBe(derivePipeName({ username: 'bob' }));
  });

  it('differs for the same username with different suffixes, and matches with the same suffix', () => {
    const a = derivePipeName({ username: 'alice', suffix: 'test-run-1' });
    const b = derivePipeName({ username: 'alice', suffix: 'test-run-2' });
    const aAgain = derivePipeName({ username: 'alice', suffix: 'test-run-1' });
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
    expect(a).not.toBe(derivePipeName({ username: 'alice' }));
  });

  it('never leaks the raw username into the name (handles characters invalid in a pipe/path segment)', () => {
    const name = derivePipeName({ username: 'weird user\\name äöü' });
    expect(name).toMatch(/^termhub-[0-9a-f]{16}$/);
  });
});

describe('formatPipePath', () => {
  it('formats a Windows named pipe path', () => {
    expect(formatPipePath('termhub-abc123', 'win32')).toBe('\\\\.\\pipe\\termhub-abc123');
  });

  it('formats a POSIX unix-socket filesystem path under the temp dir', () => {
    const path = formatPipePath('termhub-abc123', 'linux');
    expect(path).not.toMatch(/^\\\\\.\\pipe\\/);
    expect(path.endsWith('termhub-abc123.sock')).toBe(true);
  });
});

describe('resolvePipeAddress', () => {
  it('combines name derivation and platform formatting', () => {
    const address = resolvePipeAddress({ username: 'alice', suffix: 'x', platform: 'win32' });
    expect(address.startsWith('\\\\.\\pipe\\termhub-')).toBe(true);
  });

  it('is stable across calls with identical options', () => {
    const options = { username: 'alice', suffix: 'stable', platform: 'linux' as const };
    expect(resolvePipeAddress(options)).toBe(resolvePipeAddress(options));
  });
});
