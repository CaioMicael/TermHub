import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempFilePrefix, writeFileAtomic } from './atomic-file.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'termhub-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the temporary file after the destination basename, in the same directory', async () => {
    const dest = join(dir, 'workspaces.json');
    const renamed: Array<{ from: string; to: string }> = [];

    await writeFileAtomic(dest, '{}', {
      rename: (from, to) => {
        renamed.push({ from, to });
        return Promise.resolve();
      },
    });

    expect(renamed).toHaveLength(1);
    const [call] = renamed;
    if (call === undefined) {
      throw new Error('unreachable: length checked above');
    }
    expect(call.to).toBe(dest);
    expect(dirname(call.from)).toBe(dir);
    expect(call.from.slice(dir.length + 1)).toMatch(/^\.workspaces\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
  });

  it('leaves the full contents at the destination and no temporary file behind', async () => {
    const dest = join(dir, 'nested', 'config.json');
    const contents = JSON.stringify({ version: 1, padding: 'x'.repeat(8192) });

    await writeFileAtomic(dest, contents);

    await expect(readFile(dest, 'utf8')).resolves.toBe(contents);
    await expect(readdir(dirname(dest))).resolves.toEqual(['config.json']);
  });

  it('keeps the daemon.json temporary name exactly as it was before the move', () => {
    expect(tempFilePrefix(join(dir, 'daemon.json'))).toBe('.daemon.json.');
  });
});
