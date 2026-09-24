import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DAEMON_SCRIPT_FILENAME, resolveDaemonScriptPath } from './daemon-paths.js';

// Not one of docs/specs/m2.1-daemon-client.md's 9 required tests, but
// section 3's requirement 3 ("o erro tem que dizer qual caminho foi
// tentado") is specific enough to deserve its own direct coverage rather
// than only being exercised incidentally through daemon-client.test.ts.

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'termhub-app-daemon-paths-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('resolveDaemonScriptPath', () => {
  it('resolves to "<baseDir>/daemon.js" when the file exists', async () => {
    const scriptPath = join(tempDir, DAEMON_SCRIPT_FILENAME);
    await writeFile(scriptPath, '// fake daemon bundle\n', 'utf8');

    expect(resolveDaemonScriptPath({ baseDir: tempDir })).toBe(scriptPath);
  });

  it('throws an error naming the exact path it tried, when daemon.js is missing (section 3, requirement 3)', () => {
    const expectedPath = join(tempDir, DAEMON_SCRIPT_FILENAME);

    let thrown: unknown;
    try {
      resolveDaemonScriptPath({ baseDir: tempDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(expectedPath);
  });

  it('uses an injected `exists` override instead of touching the real filesystem', () => {
    const scriptPath = join(tempDir, DAEMON_SCRIPT_FILENAME);

    expect(resolveDaemonScriptPath({ baseDir: tempDir, exists: () => true })).toBe(scriptPath);
    expect(() => resolveDaemonScriptPath({ baseDir: tempDir, exists: () => false })).toThrowError(
      scriptPath,
    );
  });
});
