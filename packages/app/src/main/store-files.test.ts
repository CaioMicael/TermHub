import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigSchema,
  CONFIG_VERSION,
  defaultConfig,
  defaultWorkspacesFile,
  WorkspacesFileSchema,
  WORKSPACES_VERSION,
  type ConfigFile,
  type WorkspacesFile,
} from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadStateFile,
  MAX_CORRUPT_BACKUPS,
  openAppStateFiles,
  type StateFileIo,
  type StateFileLogger,
  type StateFileSpec,
  type StateFileTimers,
} from './store-files.js';

const silentLogger: StateFileLogger = { info: () => undefined, warn: () => undefined };

function workspacesSpec(path: string): StateFileSpec<WorkspacesFile> {
  return {
    path,
    version: WORKSPACES_VERSION,
    schema: WorkspacesFileSchema,
    defaults: defaultWorkspacesFile,
  };
}

function configSpec(path: string): StateFileSpec<ConfigFile> {
  return { path, version: CONFIG_VERSION, schema: ConfigSchema, defaults: defaultConfig };
}

/** A valid layout whose single workspace's name carries `tag`, so tests can tell versions apart. */
function layout(tag: string): WorkspacesFile {
  return {
    version: 1,
    activeWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: tag, cwd: 'C:\\w', root: { kind: 'leaf', sessionId: 1 } }],
  };
}

describe('loadStateFile on a real disk: a bad file never crashes and is never destroyed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'termhub-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const badContents: Array<[string, Buffer]> = [
    ['truncated JSON', Buffer.from('{"version":1,"workspaces":[{"id":"ws","na')],
    ['random bytes', randomBytes(512)],
    ['valid JSON, wrong schema', Buffer.from(JSON.stringify({ version: 1, workspaces: 'nope' }))],
  ];

  for (const [label, bytes] of badContents) {
    it(`workspaces.json with ${label}: defaults, and the original bytes moved to a .corrupt-* backup`, async () => {
      const path = join(dir, 'workspaces.json');
      await writeFile(path, bytes);

      const { file, outcome } = await loadStateFile(workspacesSpec(path), { logger: silentLogger });

      expect(file.get()).toEqual(defaultWorkspacesFile());
      expect(outcome.kind).toBe('discarded');
      if (outcome.kind !== 'discarded') {
        throw new Error('unreachable');
      }
      expect(outcome.backupPath.startsWith(`${path}.corrupt-`)).toBe(true);
      expect((await readFile(outcome.backupPath)).equals(bytes)).toBe(true);

      // The next save writes the new layout; the backup is untouched.
      expect(file.save(layout('after'))).toBe(true);
      await file.flush();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(layout('after'));
      expect((await readFile(outcome.backupPath)).equals(bytes)).toBe(true);
    });
  }

  it('config.json with random bytes: defaults and a backup', async () => {
    const path = join(dir, 'config.json');
    const bytes = randomBytes(64);
    await writeFile(path, bytes);

    const { file, outcome } = await loadStateFile(configSpec(path), { logger: silentLogger });

    expect(file.get()).toEqual(defaultConfig());
    expect(outcome.kind).toBe('discarded');
  });

  it('config.json with one invalid field keeps the valid ones and leaves the file alone', async () => {
    const path = join(dir, 'config.json');
    const raw = JSON.stringify({ version: 'garbage', graveyardTtlMinutes: 45 });
    await writeFile(path, raw);

    const { file, outcome } = await loadStateFile(configSpec(path), { logger: silentLogger });

    expect(outcome).toEqual({ kind: 'loaded' });
    expect(file.get()).toEqual({ version: 1, graveyardTtlMinutes: 45 });
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);
    await expect(readdir(dir)).resolves.toEqual(['config.json']);
  });

  it('a file from a newer version is moved to .newer-*, never overwritten', async () => {
    const path = join(dir, 'workspaces.json');
    const raw = JSON.stringify({ version: 2, somethingNew: true });
    await writeFile(path, raw);

    const { file, outcome } = await loadStateFile(workspacesSpec(path), { logger: silentLogger });

    expect(file.get()).toEqual(defaultWorkspacesFile());
    expect(outcome.kind).toBe('discarded');
    if (outcome.kind !== 'discarded') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('newer');
    expect(outcome.backupPath.startsWith(`${path}.newer-`)).toBe(true);
    await expect(readFile(outcome.backupPath, 'utf8')).resolves.toBe(raw);
  });

  it('a missing file gives defaults and creates nothing', async () => {
    const path = join(dir, 'workspaces.json');

    const { file, outcome } = await loadStateFile(workspacesSpec(path), { logger: silentLogger });

    expect(outcome).toEqual({ kind: 'missing' });
    expect(file.get()).toEqual(defaultWorkspacesFile());
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("removes this file's orphan temporaries and nobody else's", async () => {
    const path = join(dir, 'workspaces.json');
    const keep = ['.daemon.json.123.abcdef012345.tmp', 'config.json', '.config.json.9.aa.tmp'];
    const remove = ['.workspaces.json.123.abcdef012345.tmp', '.workspaces.json.456.00.tmp'];
    for (const name of [...keep, ...remove]) {
      await writeFile(join(dir, name), 'x');
    }

    await loadStateFile(workspacesSpec(path), { logger: silentLogger });

    expect((await readdir(dir)).sort()).toEqual([...keep].sort());
  });

  it(`keeps only the newest ${MAX_CORRUPT_BACKUPS} .corrupt-* backups`, async () => {
    const path = join(dir, 'workspaces.json');
    const backups: string[] = [];
    for (let i = 0; i < MAX_CORRUPT_BACKUPS + 1; i += 1) {
      await writeFile(path, `broken ${i}`);
      const at = new Date(Date.UTC(2026, 8, 26, 12, 0, i));
      const { outcome } = await loadStateFile(workspacesSpec(path), {
        logger: silentLogger,
        now: () => at,
      });
      if (outcome.kind !== 'discarded') {
        throw new Error(`load ${i}: expected a discard, got ${outcome.kind}`);
      }
      backups.push(outcome.backupPath);
    }

    const remaining = (await readdir(dir)).map((name) => join(dir, name)).sort();
    expect(remaining).toEqual(backups.slice(1).sort());
    await expect(readFile(backups[1] ?? '', 'utf8')).resolves.toBe('broken 1');
  });

  it('readers looping over the file during 100 writes never see invalid JSON', async () => {
    const path = join(dir, 'workspaces.json');
    const { file } = await loadStateFile(workspacesSpec(path), {
      logger: silentLogger,
      debounceMs: 0,
    });
    const readErrors: string[] = [];
    let stop = false;
    let reads = 0;
    const reader = async (): Promise<void> => {
      while (!stop) {
        reads += 1;
        try {
          const raw = await readFile(path, 'utf8');
          WorkspacesFileSchema.parse(JSON.parse(raw));
        } catch (err) {
          const code = err instanceof Error && 'code' in err ? err.code : undefined;
          if (code !== 'ENOENT') {
            readErrors.push(String(err));
          }
        }
        // Same randomized 20-60 ms pause as daemon.test.ts's test 5, and for
        // its reason. A reader that barely pauses keeps the file open almost
        // all the time, and on NTFS that starves the rename outright: with
        // 1-6 ms here, CI on Windows failed with EPERM after the full retry
        // budget. That tests the reader, not atomicity.
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
      }
    };
    const readers = [reader(), reader(), reader()];

    for (let i = 0; i < 100; i += 1) {
      const next = layout(`v${i}-${'x'.repeat(2048)}`);
      expect(file.save(next)).toBe(true);
      await file.flush();
      // Spreads the run out so the readers sample across all of it, without
      // shortening their own pause (see above).
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop = true;
    await Promise.all(readers);

    expect(readErrors).toEqual([]);
    // Enough samples to mean something: a run too short to read the file
    // proves nothing about truncation.
    expect(reads).toBeGreaterThan(50);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(layout(`v99-${'x'.repeat(2048)}`));
  }, 30_000);
});

// ─── Injected I/O and timers: the write queue ─────────────────────────────

interface Deferred {
  contents: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

function makeControlledIo(): {
  io: StateFileIo;
  pending: Deferred[];
  written: string[];
  maxConcurrent: () => number;
} {
  const pending: Deferred[] = [];
  const written: string[] = [];
  let concurrent = 0;
  let max = 0;
  const io: StateFileIo = {
    readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    readdir: () => Promise.resolve([]),
    unlink: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    writeFileAtomic: (_path, contents) => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      return new Promise<void>((resolve, reject) => {
        pending.push({
          contents,
          resolve: () => {
            concurrent -= 1;
            written.push(contents);
            resolve();
          },
          reject: (err) => {
            concurrent -= 1;
            reject(err);
          },
        });
      });
    },
  };
  return { io, pending, written, maxConcurrent: () => max };
}

function makeManualTimers(): StateFileTimers & { fireAll: () => void; count: () => number } {
  const callbacks = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout: (callback) => {
      next += 1;
      callbacks.set(next, callback);
      return next;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') {
        callbacks.delete(handle);
      }
    },
    fireAll: () => {
      const toRun = [...callbacks.values()];
      callbacks.clear();
      for (const callback of toRun) {
        callback();
      }
    },
    count: () => callbacks.size,
  };
}

/** Lets every already-settled promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function nameOf(contents: string | undefined): string | undefined {
  if (contents === undefined) {
    return undefined;
  }
  return WorkspacesFileSchema.parse(JSON.parse(contents)).workspaces[0]?.name;
}

describe('StateFile write queue', () => {
  async function load(io: StateFileIo, timers: StateFileTimers) {
    const { file } = await loadStateFile(workspacesSpec('/state/workspaces.json'), {
      io,
      timers,
      logger: silentLogger,
    });
    return file;
  }

  it('50 saves racing writes in flight: never two writes at once, and the last value wins', async () => {
    const { io, pending, written, maxConcurrent } = makeControlledIo();
    const timers = makeManualTimers();
    const file = await load(io, timers);

    for (let i = 0; i < 50; i += 1) {
      file.save(layout(`v${i}`));
      timers.fireAll();
      // Finish writes out of step with the saves: only every third one.
      if (i % 3 === 0) {
        pending.shift()?.resolve();
        await settle();
      }
    }
    const flushed = file.flush();
    while (pending.length > 0) {
      pending.shift()?.resolve();
      await settle();
    }
    await flushed;

    expect(maxConcurrent()).toBe(1);
    expect(nameOf(written.at(-1))).toBe('v49');
  });

  it('debounces: several saves in the window become one write of the last value', async () => {
    const { io, pending } = makeControlledIo();
    const timers = makeManualTimers();
    const file = await load(io, timers);

    file.save(layout('a'));
    file.save(layout('b'));
    file.save(layout('c'));
    expect(timers.count()).toBe(1);
    expect(pending).toHaveLength(0);

    timers.fireAll();
    expect(pending).toHaveLength(1);
    expect(nameOf(pending[0]?.contents)).toBe('c');
  });

  it('flush with nothing pending does not write', async () => {
    const { io, pending } = makeControlledIo();
    const file = await load(io, makeManualTimers());

    await file.flush();

    expect(pending).toHaveLength(0);
  });

  it('flush during a write waits for it, then writes the newer pending value', async () => {
    const { io, pending, written } = makeControlledIo();
    const timers = makeManualTimers();
    const file = await load(io, timers);

    file.save(layout('old'));
    timers.fireAll();
    expect(pending).toHaveLength(1);
    file.save(layout('new'));

    let flushed = false;
    const flushing = file.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(pending).toHaveLength(1); // still only the first write
    expect(flushed).toBe(false);

    pending.shift()?.resolve();
    await settle();
    expect(pending).toHaveLength(1);
    expect(nameOf(pending[0]?.contents)).toBe('new');
    pending.shift()?.resolve();
    await flushing;

    expect(written.map(nameOf)).toEqual(['old', 'new']);
  });

  it('refuses an invalid value: returns false, writes nothing, keeps the previous value', async () => {
    const { io, pending } = makeControlledIo();
    const timers = makeManualTimers();
    const file = await load(io, timers);
    const valid = layout('valid');
    file.save(valid);

    const badRatio: WorkspacesFile = {
      version: 1,
      workspaces: [
        {
          id: 'ws',
          name: 'bad',
          cwd: 'C:\\w',
          root: {
            kind: 'split',
            id: 'n',
            dir: 'row',
            ratio: 0.95,
            a: { kind: 'leaf', sessionId: 1 },
            b: { kind: 'leaf', sessionId: 2 },
          },
        },
      ],
    };
    const duplicateSession: WorkspacesFile = {
      version: 1,
      workspaces: [
        { id: 'a', name: 'a', cwd: '', root: { kind: 'leaf', sessionId: 7 } },
        { id: 'b', name: 'b', cwd: '', root: { kind: 'leaf', sessionId: 7 } },
      ],
    };
    const missingActive: WorkspacesFile = { ...layout('x'), activeWorkspaceId: 'nope' };

    for (const bad of [badRatio, duplicateSession, missingActive]) {
      expect(file.save(bad)).toBe(false);
    }
    expect(file.get()).toEqual(valid);

    timers.fireAll();
    expect(pending).toHaveLength(1);
    expect(nameOf(pending[0]?.contents)).toBe('valid');
  });

  it('a failed write keeps the value pending: flush rejects, the next flush writes it', async () => {
    const { io, pending, written } = makeControlledIo();
    const timers = makeManualTimers();
    const file = await load(io, timers);
    file.save(layout('keep-me'));

    const failing = file.flush();
    await settle();
    const boom = Object.assign(new Error('EPERM: rename blocked'), { code: 'EPERM' });
    pending.shift()?.reject(boom);
    await expect(failing).rejects.toBe(boom);

    const retry = file.flush();
    await settle();
    expect(nameOf(pending[0]?.contents)).toBe('keep-me');
    pending.shift()?.resolve();
    await retry;
    expect(written.map(nameOf)).toEqual(['keep-me']);
  });

  it('a bad file that cannot be moved aside is never overwritten this run', async () => {
    const { io, pending } = makeControlledIo();
    io.readFile = () => Promise.resolve('{ not json');
    io.rename = () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const timers = makeManualTimers();
    const { file, outcome } = await loadStateFile(workspacesSpec('/state/workspaces.json'), {
      io,
      timers,
      logger: silentLogger,
    });

    expect(outcome.kind).toBe('discarded-unmovable');
    expect(file.save(layout('in-memory'))).toBe(true);
    await file.flush();

    expect(pending).toHaveLength(0);
    expect(file.get()).toEqual(layout('in-memory'));
  });
});

describe('loadStateFile reads the directory it is given', () => {
  it('creates missing parent directories on the first write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'termhub-state-'));
    try {
      const path = join(root, 'TermHub', 'workspaces.json');
      const { file } = await loadStateFile(workspacesSpec(path), { logger: silentLogger });
      file.save(layout('first'));
      await file.flush();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(layout('first'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('openAppStateFiles', () => {
  it('defaults to APPDATA/TermHub, so a test isolated by APPDATA never touches the real files', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'termhub-appdata-'));
    const previous = process.env.APPDATA;
    process.env.APPDATA = isolated;
    try {
      const files = await openAppStateFiles(undefined, { logger: silentLogger });
      files.workspaces.save(layout('isolated'));
      await files.workspaces.flush();

      const written = await readFile(join(isolated, 'TermHub', 'workspaces.json'), 'utf8');
      expect(JSON.parse(written)).toEqual(layout('isolated'));
      expect(files.config.get()).toEqual(defaultConfig());
    } finally {
      if (previous === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previous;
      }
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
