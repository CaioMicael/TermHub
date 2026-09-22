import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readDaemonInfo,
  removeDaemonJsonIfOwnedByPid,
  startDaemon,
  writeDaemonJsonAtomic,
} from './daemon.js';
import type { DaemonInfo, StartResult } from './daemon.js';
import { resolvePipeAddress } from './transport-address.js';

// Required tests 1, 2, 4, 5, 7 (docs/specs/m1.8-single-instance.md section
// 5). Tests 1 and 2 are the reason this spec exists at all — section 2's
// own words: an existsSync-then-write implementation passes test 2 "por
// acaso metade das vezes". Both loop many real races rather than running
// once, specifically to rule that out rather than get lucky on a single
// run — see each test's own comment for how many iterations and why.

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `daemon-test-${label}-${randomUUID()}` });
}

function isStarted(result: StartResult): result is Extract<StartResult, { outcome: 'started' }> {
  return result.outcome === 'started';
}

let tempDir: string;
let cleanup: Array<() => Promise<void> | void>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'termhub-daemon-test-'));
  cleanup = [];
});

afterEach(async () => {
  for (const teardown of cleanup.reverse()) {
    try {
      await teardown();
    } catch {
      // best-effort cleanup only
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

function daemonJsonPathFor(label: string): string {
  return join(tempDir, `daemon-${label}-${randomUUID()}.json`);
}

describe('startDaemon: the race (docs/specs/m1.8-single-instance.md sections 3.1-3.2)', () => {
  it(
    'exactly one of two startDaemon() calls fired in parallel at the same address wins — the other gets ' +
      '"already-running", never a second live daemon (required test 1). Both promises are created before either ' +
      "is awaited, per this task's own instruction: sequencing them tests nothing about the race the lock exists " +
      'to resolve. Repeated across many fresh addresses in one test, not run once, to rule out a lock that only ' +
      'sometimes behaves — see required test 2 below for why that distinction matters here specifically.',
    async () => {
      const iterations = 15;
      for (let i = 0; i < iterations; i += 1) {
        const address = uniqueAddress(`race-${i}`);
        const daemonJsonPath = daemonJsonPathFor(`race-${i}`);

        // Fired in parallel: both calls happen here, before either `await`.
        const p1 = startDaemon({ address, daemonJsonPath });
        const p2 = startDaemon({ address, daemonJsonPath });
        const [r1, r2] = await Promise.all([p1, p2]);

        expect([r1.outcome, r2.outcome].sort()).toEqual(['already-running', 'started']);

        const winner = isStarted(r1) ? r1 : r2;
        if (isStarted(winner)) {
          cleanup.push(() => winner.server.close());
        }
      }
    },
  );

  it(
    "the daemon.json left on disk after the race carries the WINNER's token and pid, never the loser's — the " +
      'exact failure mode docs/specs/m1.8-single-instance.md section 2 describes (a daemon alive, a token on disk ' +
      'that belongs to a process that lost and exited, every client rejected at handshake). Since both calls in ' +
      "this test run in the SAME process, `pid` alone can't distinguish winner from loser (it would read the same " +
      'value either way) — the token can and does, since each call generates its own random one before knowing ' +
      'whether it will win. Looped for the same reason as required test 1: this is the exact assertion a naive ' +
      "`existsSync`-then-write implementation only satisfies about half the time, per section 2's own words, so a " +
      'single passing run would prove nothing.',
    async () => {
      const iterations = 15;
      for (let i = 0; i < iterations; i += 1) {
        const address = uniqueAddress(`winner-${i}`);
        const daemonJsonPath = daemonJsonPathFor(`winner-${i}`);

        const p1 = startDaemon({ address, daemonJsonPath });
        const p2 = startDaemon({ address, daemonJsonPath });
        const [r1, r2] = await Promise.all([p1, p2]);

        const started = [r1, r2].filter(isStarted);
        expect(started).toHaveLength(1);
        const winner = started[0];
        if (winner === undefined) {
          throw new Error('unreachable: already asserted exactly one started');
        }
        cleanup.push(() => winner.server.close());

        const onDisk = await readDaemonInfo(daemonJsonPath);
        expect(onDisk).toBeDefined();
        expect(onDisk?.token).toBe(winner.info.token);
        expect(onDisk?.pid).toBe(winner.info.pid);
        expect(onDisk?.pipe).toBe(winner.info.pipe);
        expect(onDisk?.protocolVersion).toBe(winner.info.protocolVersion);
      }
    },
  );
});

describe('startDaemon: daemon.json is never a gate (required test 4)', () => {
  it('an orphaned daemon.json (dead pid, stale token) does not block a new daemon from starting, and is overwritten with the new data', async () => {
    const address = uniqueAddress('orphan');
    const daemonJsonPath = daemonJsonPathFor('orphan');

    const staleInfo: DaemonInfo = {
      // Not a real pid this test process owns — standing in for a daemon
      // that crashed a while ago. section 3.1 means the *content* of this
      // file is never even consulted to decide whether to start, so its
      // pid doesn't actually need to be verified dead for this test to be
      // meaningful; it documents the scenario regardless.
      pid: 999_999,
      pipe: 'stale-pipe-address-nobody-listens-on',
      token: 'stale-token-that-must-not-survive',
      protocolVersion: 1,
      startedAt: new Date(0).toISOString(),
    };
    await mkdir(dirname(daemonJsonPath), { recursive: true });
    await writeFile(daemonJsonPath, JSON.stringify(staleInfo), 'utf8');

    const result = await startDaemon({ address, daemonJsonPath });
    expect(result.outcome).toBe('started');
    if (!isStarted(result)) {
      throw new Error('unreachable: already asserted outcome === started');
    }
    cleanup.push(() => result.server.close());

    const onDisk = await readDaemonInfo(daemonJsonPath);
    expect(onDisk?.pid).toBe(process.pid);
    expect(onDisk?.pipe).toBe(address);
    expect(onDisk?.token).toBe(result.info.token);
    expect(onDisk?.token).not.toBe('stale-token-that-must-not-survive');
  });
});

describe('writeDaemonJsonAtomic: no partial-write window (required test 5)', () => {
  it(
    'a reader sampling daemon.json continuously, in a tight loop, across many repeated writes to the same path ' +
      'never observes a truncated or malformed file — only a complete previous or complete next version, proving ' +
      'the write goes through a temp-file-then-rename rather than a direct write to the destination. Writes are ' +
      "sequential (never two writers racing the same rename at once — that scenario is required test 1/2's job, " +
      "not this one's: in production there is never more than one live daemon holding the lock, so more than one " +
      'legitimate writer to a given daemon.json never happens); what is realistic and worth stressing here is a ' +
      'reader — a client resolving the daemon to connect to — sampling the file at the exact instant it gets ' +
      'rewritten, repeated many times over.',
    async () => {
      const daemonJsonPath = daemonJsonPathFor('atomic');
      const totalWrites = 40;
      const readErrors: string[] = [];
      let stopReading = false;

      const readerLoop = (async () => {
        while (!stopReading) {
          try {
            const raw = await readFile(daemonJsonPath, 'utf8');
            try {
              const parsed = JSON.parse(raw) as Partial<Record<keyof DaemonInfo, unknown>>;
              const looksComplete =
                typeof parsed.pid === 'number' &&
                typeof parsed.pipe === 'string' &&
                typeof parsed.token === 'string' &&
                typeof parsed.protocolVersion === 'number' &&
                typeof parsed.startedAt === 'string';
              if (!looksComplete) {
                readErrors.push(`parsed but incomplete: ${raw}`);
              }
            } catch {
              readErrors.push(`unparsable JSON (truncated write?): ${JSON.stringify(raw)}`);
            }
          } catch {
            // ENOENT before the very first write lands is expected and
            // fine — that is "the previous complete state (nothing)", not
            // a partial one.
          }
        }
      })();

      for (let i = 0; i < totalWrites; i += 1) {
        await writeDaemonJsonAtomic(daemonJsonPath, {
          pid: 1000 + i,
          // Padded well past a single filesystem write's usual atomic
          // chunk size, so a hypothetical direct (non-atomic) write would
          // have a realistic window to be caught truncated mid-write.
          pipe: `pipe-${i}-${'x'.repeat(4096)}`,
          token: `${randomUUID()}${randomUUID()}${randomUUID()}`,
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
        });
      }
      stopReading = true;
      await readerLoop;

      expect(readErrors).toEqual([]);

      // No leftover temp file once every write has settled.
      const entries = await readdir(dirname(daemonJsonPath));
      const leftoverTmpFiles = entries.filter((name) => name.includes('.tmp'));
      expect(leftoverTmpFiles).toEqual([]);
    },
  );
});

describe('removeDaemonJsonIfOwnedByPid: clean shutdown (required test 7)', () => {
  it("removes daemon.json when its pid matches ours, and leaves a different pid's file alone", async () => {
    const daemonJsonPath = daemonJsonPathFor('shutdown');
    const ourInfo: DaemonInfo = {
      pid: process.pid,
      pipe: 'pipe-x',
      token: 'token-x',
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
    };
    await writeDaemonJsonAtomic(daemonJsonPath, ourInfo);

    // A takeover scenario (docs/specs/m1.8-single-instance.md section 3.5):
    // another daemon already won a later race and overwrote the file with
    // its own pid before this one gets around to shutting down. Cleanup
    // must not remove someone else's live daemon's only advertised address.
    await removeDaemonJsonIfOwnedByPid(daemonJsonPath, process.pid + 1);
    expect(await readDaemonInfo(daemonJsonPath)).toEqual(ourInfo);

    // Our own pid: removed.
    await removeDaemonJsonIfOwnedByPid(daemonJsonPath, process.pid);
    expect(await readDaemonInfo(daemonJsonPath)).toBeUndefined();

    // Idempotent against an already-missing file.
    await expect(
      removeDaemonJsonIfOwnedByPid(daemonJsonPath, process.pid),
    ).resolves.toBeUndefined();
  });
});
