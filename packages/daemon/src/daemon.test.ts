import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RENAME_RETRY_BASE_DELAY_MS,
  RENAME_RETRY_BUDGET_MS,
  RENAME_RETRY_MAX_DELAY_MS,
  readDaemonInfo,
  removeDaemonJsonIfOwnedByPid,
  renameWithRetry,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('writeDaemonJsonAtomic: no partial-write window (required test 5)', () => {
  it(
    'several readers sampling daemon.json repeatedly, across many repeated writes to the same path, never observe ' +
      'a truncated or malformed file — only a complete previous or complete next version, proving the write goes ' +
      'through a temp-file-then-rename rather than a direct write to the destination. Writes are sequential (never ' +
      "two writers racing the same rename at once — that scenario is required test 1/2's job, not this one's). " +
      'Each reader paces itself with a *randomized* pause between samples, not a fixed one: an earlier version of ' +
      "this test used a fixed 30ms pause and it worked, until it didn't — a fixed reader interval can drift into " +
      "phase with the writer's own retry interval (it used to be a fixed 20ms delay too), so every retry lands " +
      'while the reader happens to hold the file open, starving the rename outright rather than exercising the ' +
      'atomicity guarantee this test checks. `renameWithRetry` itself now backs off exponentially with jitter ' +
      'instead of a fixed interval for the same reason (see its doc comment in daemon.ts); randomizing the reader ' +
      'pause here too means neither side can lock into a resonant cadence with the other. The retry timing passed ' +
      'below is the same mechanism as production (still real timers, still exponential-with-jitter, still the ' +
      'same code path) scaled down via `RenameWithRetryOptions` — real NTFS lock contention under this reader ' +
      "load turned out to need several retries fairly often (measured), and production's multi-second budget " +
      'would make this specific stress test needlessly slow without adding coverage the smaller numbers here ' +
      "don't already provide.",
    async () => {
      const daemonJsonPath = daemonJsonPathFor('atomic');
      const totalWrites = 100;
      // Several independent readers, not one, purely to widen sampling
      // coverage across the run.
      const readerCount = 4;
      const readErrors: string[] = [];
      let stopReading = false;

      const makeReaderLoop = (): Promise<void> =>
        (async () => {
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
            // Randomized pause (not a fixed one) between samples — see this
            // describe block's own comment for why a fixed cadence is the
            // fragile choice here.
            await sleep(20 + Math.random() * 40);
          }
        })();

      const readerLoops = Array.from({ length: readerCount }, () => makeReaderLoop());

      for (let i = 0; i < totalWrites; i += 1) {
        await writeDaemonJsonAtomic(
          daemonJsonPath,
          {
            pid: 1000 + i,
            // Padded well past a single filesystem write's usual atomic
            // chunk size, so a hypothetical direct (non-atomic) write would
            // have a realistic window to be caught truncated mid-write.
            pipe: `pipe-${i}-${'x'.repeat(4096)}`,
            token: `${randomUUID()}${randomUUID()}${randomUUID()}`,
            protocolVersion: 1,
            startedAt: new Date().toISOString(),
          },
          // Scaled-down retry timing — see this test's own description.
          { baseDelayMs: 5, maxDelayMs: 40, budgetMs: 2000 },
        );
      }
      stopReading = true;
      await Promise.all(readerLoops);

      expect(readErrors).toEqual([]);

      // No leftover temp file once every write has settled.
      const entries = await readdir(dirname(daemonJsonPath));
      const leftoverTmpFiles = entries.filter((name) => name.includes('.tmp'));
      expect(leftoverTmpFiles).toEqual([]);
    },
    15_000,
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

describe('renameWithRetry: budgeted exponential backoff (production retry policy)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFakeClock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    waits: number[];
  } {
    let simulatedNow = 0;
    const waits: number[] = [];
    return {
      now: () => simulatedNow,
      sleep: (ms: number) => {
        waits.push(ms);
        simulatedNow += ms;
        return Promise.resolve();
      },
      waits,
    };
  }

  it('gives up once the total time budget is exhausted on a persistent transient error, instead of retrying forever', async () => {
    const clock = makeFakeClock();
    const transientErr = Object.assign(new Error('EPERM: rename blocked'), { code: 'EPERM' });
    const fakeRename = (): Promise<void> => Promise.reject(transientErr);

    await expect(
      renameWithRetry('tmp', 'dest', { rename: fakeRename, sleep: clock.sleep, now: clock.now }),
    ).rejects.toBe(transientErr);

    // The loop stops once simulated time crosses the budget, not before —
    // and it does stop, rather than looping until the test times out.
    expect(clock.now()).toBeGreaterThanOrEqual(RENAME_RETRY_BUDGET_MS);
    expect(clock.waits.length).toBeGreaterThan(1);
  });

  it('does not retry an error that is not transient (e.g. ENOENT) — it propagates on the first attempt', async () => {
    const clock = makeFakeClock();
    const notFoundErr = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    let attempts = 0;
    const fakeRename = (): Promise<void> => {
      attempts += 1;
      return Promise.reject(notFoundErr);
    };

    await expect(
      renameWithRetry('tmp', 'dest', { rename: fakeRename, sleep: clock.sleep, now: clock.now }),
    ).rejects.toBe(notFoundErr);

    expect(attempts).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it('succeeds once the transient error clears, after retrying with growing waits', async () => {
    // The random half of the equal jitter is deterministic here because
    // Math.random is pinned to its max: this isolates the *growth* of the
    // backoff cap from the randomness layered on top of it, which is what
    // this test exists to show.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const clock = makeFakeClock();
    const transientErr = Object.assign(new Error('EBUSY: rename blocked'), { code: 'EBUSY' });
    let attempts = 0;
    const failuresBeforeSuccess = 4;
    const fakeRename = (): Promise<void> => {
      attempts += 1;
      if (attempts <= failuresBeforeSuccess) {
        return Promise.reject(transientErr);
      }
      return Promise.resolve();
    };

    await expect(
      renameWithRetry('tmp', 'dest', { rename: fakeRename, sleep: clock.sleep, now: clock.now }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(failuresBeforeSuccess + 1);
    expect(clock.waits).toHaveLength(failuresBeforeSuccess);
    // With Math.random() pinned to 1, backoffDelayMs(attempt) is exactly
    // min(MAX, BASE * 2^(attempt-1)) — strictly growing until it saturates
    // at the cap.
    const expectedWaits = Array.from({ length: failuresBeforeSuccess }, (_, i) =>
      Math.min(RENAME_RETRY_MAX_DELAY_MS, RENAME_RETRY_BASE_DELAY_MS * 2 ** i),
    );
    expect(clock.waits).toEqual(expectedWaits);
    for (let i = 1; i < clock.waits.length; i += 1) {
      const previous = clock.waits[i - 1];
      const current = clock.waits[i];
      if (previous === undefined || current === undefined) {
        throw new Error('unreachable: indices within bounds of a non-empty array');
      }
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });
});
