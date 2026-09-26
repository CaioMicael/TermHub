import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionCreateResult, SessionListResult } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDaemon } from './daemon-runtime.js';
import type { DaemonRuntime } from './daemon-runtime.js';
import { readDaemonInfo } from './daemon.js';
import { Graveyard } from './graveyard.js';
import type { GraveyardClock } from './graveyard.js';
import type { SessionFactory, SessionLike } from './registry.js';
import { resolvePipeAddress } from './transport-address.js';
import { TransportClient } from './transport-client.js';
import type { Disposable, SessionExit, SessionExitListener } from './session.js';

// Integration coverage for daemon-runtime.ts, the layer that assembles
// startDaemon() (the race/lock — daemon.test.ts), registerSessionService
// (service.ts, M1.7, untouched here) and startIdleShutdown (idle-
// shutdown.ts, its own precise fake-timer suite) into one running daemon.
// Not itself one of docs/specs/m1.8-single-instance.md section 5's 9
// required tests (those are covered in daemon.test.ts, idle-shutdown.test.ts,
// transport-server.test.ts and cli.test.ts) — this file exists to prove the
// *wiring* between those pieces actually holds together end to end, using a
// FakeSession (same pattern as registry.test.ts/service.test.ts) so it stays
// fast and doesn't spawn a real shell.

class FakeSession implements SessionLike {
  private static nextPid = 77_000;

  readonly pid = FakeSession.nextPid++;
  private aliveFlag = true;
  private readonly exitListeners: SessionExitListener[] = [];

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  write(): void {
    // unused by these tests
  }

  resize(): void {
    // unused by these tests
  }

  kill(): void {
    this.emitExit({ exitCode: 0 });
  }

  onData(): Disposable {
    return { dispose: () => {} };
  }

  onExit(listener: SessionExitListener): Disposable {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }

  emitExit(exit: SessionExit): void {
    if (!this.aliveFlag) {
      return;
    }
    this.aliveFlag = false;
    for (const listener of this.exitListeners) {
      listener(exit);
    }
  }
}

function fakeSessionFactory(): { factory: SessionFactory; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `daemon-runtime-test-${label}-${randomUUID()}` });
}

let tempDir: string;
let cleanup: Array<() => Promise<void> | void>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'termhub-daemon-runtime-test-'));
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

describe('runDaemon', () => {
  it('a started runtime serves session.create/session.list over the real pipe, using the injected session factory', async () => {
    const { factory } = fakeSessionFactory();
    const address = uniqueAddress('service');
    const daemonJsonPath = daemonJsonPathFor('service');

    const result = await runDaemon({ address, daemonJsonPath, sessionFactory: factory });
    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }
    cleanup.push(() => result.runtime.shutdown());

    const client = new TransportClient({ address, token: result.runtime.info.token });
    cleanup.push(() => client.close());
    await client.connect();

    const created = await client.request<SessionCreateResult>('session.create', {
      shell: 'fake-shell',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    expect(created.session.status).toBe('running');

    const listed = await client.request<SessionListResult>('session.list', {});
    expect(listed.sessions.map((s) => s.id)).toContain(created.session.id);
  });

  it('shutdown() closes the server and removes daemon.json (pid matches ours)', async () => {
    const address = uniqueAddress('shutdown');
    const daemonJsonPath = daemonJsonPathFor('shutdown');

    const result = await runDaemon({ address, daemonJsonPath });
    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') {
      throw new Error('unreachable');
    }

    expect(await readDaemonInfo(daemonJsonPath)).toBeDefined();

    await result.runtime.shutdown();

    expect(await readDaemonInfo(daemonJsonPath)).toBeUndefined();

    // The server really stopped: a fresh listen() at the same address now
    // succeeds instead of hitting EADDRINUSE.
    const reclaimed = await runDaemon({ address, daemonJsonPath: daemonJsonPathFor('shutdown-2') });
    expect(reclaimed.outcome).toBe('started');
    if (reclaimed.outcome === 'started') {
      cleanup.push(() => reclaimed.runtime.shutdown());
    }
  });

  it(
    'a live session keeps the daemon up past the idle timeout even with zero clients; once it exits, the daemon ' +
      'shuts itself down on its own shortly after (short real timers — the precise timer-boundary behavior is ' +
      "idle-shutdown.test.ts's job with fake timers; this just proves runDaemon wires it up for real)",
    async () => {
      const { factory, sessions } = fakeSessionFactory();
      const address = uniqueAddress('idle');
      const daemonJsonPath = daemonJsonPathFor('idle');

      const result = await runDaemon({
        address,
        daemonJsonPath,
        sessionFactory: factory,
        idleTimeoutMs: 150,
        idleCheckIntervalMs: 20,
      });
      expect(result.outcome).toBe('started');
      if (result.outcome !== 'started') {
        throw new Error('unreachable');
      }
      let runtime: DaemonRuntime | undefined = result.runtime;
      cleanup.push(() => runtime?.shutdown());

      // session.create is driven directly against the registry here rather
      // than through a connected client, which proves the point more
      // sharply: zero clients ever connect in this test at all, and a live
      // session alone still has to hold the daemon up.
      result.runtime.registry.create({
        shell: 'fake-shell',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      // Comfortably longer than the idle timeout: with a live session and
      // zero clients, shutdown must never fire.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await readDaemonInfo(daemonJsonPath)).toBeDefined();

      // The session exits on its own.
      const fake = sessions[0];
      if (fake === undefined) {
        throw new Error('unreachable: registry.create() should have used the injected factory');
      }
      fake.emitExit({ exitCode: 0 });

      // Now zero clients AND zero live sessions — the idle timer should
      // fire and shutdown() should run on its own, removing daemon.json
      // without anything else calling shutdown() explicitly.
      await waitForFileRemoved(daemonJsonPath, 2_000);
      runtime = undefined; // already shut itself down; afterEach's cleanup call becomes a harmless idempotent no-op via `?.`
    },
  );

  // M4.4: a buried session must hold the daemon up exactly like a live one
  // does above — the "cemitério" is worthless if an idle daemon kills it
  // before the user gets a chance to session.restore it. The graveyard's own
  // TTL is made to elapse via a hand-stepped `GraveyardClock` (see this
  // file's own `manualGraveyardClock` below) instead of a real wait, since
  // `session.close`'s `ttlMs` has an enforced 60-second floor
  // (graveyard.ts's `MIN_TTL_MS`) that would otherwise make this test far
  // slower than the short *idle-timeout* boundary it actually cares about.
  it(
    'zero clients + only a buried (graveyard) session keeps the daemon up past the idle timeout; once its TTL ' +
      'elapses, idleness resumes counting and the daemon shuts itself down on its own (short real idle timers; ' +
      'the graveyard TTL itself is driven by a fake clock, not real time)',
    async () => {
      const manual = manualGraveyardClock();
      const graveyard = new Graveyard({ clock: manual.clock });
      const { factory } = fakeSessionFactory();
      const address = uniqueAddress('graveyard-idle');
      const daemonJsonPath = daemonJsonPathFor('graveyard-idle');

      const result = await runDaemon({
        address,
        daemonJsonPath,
        sessionFactory: factory,
        graveyard,
        idleTimeoutMs: 150,
        idleCheckIntervalMs: 20,
      });
      expect(result.outcome).toBe('started');
      if (result.outcome !== 'started') {
        throw new Error('unreachable');
      }
      let runtime: DaemonRuntime | undefined = result.runtime;
      cleanup.push(() => runtime?.shutdown());

      const client = new TransportClient({ address, token: result.runtime.info.token });
      cleanup.push(() => client.close());
      await client.connect();

      const created = await client.request<SessionCreateResult>('session.create', {
        shell: 'fake-shell',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      // Buries it — the minimum allowed ttlMs, though its exact value is
      // irrelevant here since the fake clock's own `fire()` is what actually
      // triggers the expiry below, not real elapsed time.
      await client.request('session.close', { sessionId: created.session.id, ttlMs: 60_000 });

      // No clients from here on: closing this connection is what actually
      // exercises "zero clients AND a buried session" — with the client
      // still connected, hasClients() alone would already hold the daemon
      // up, which would prove nothing about the graveyard.
      await client.close();

      // Comfortably longer than the idle timeout: with zero clients but a
      // still-buried session, shutdown must never fire.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await readDaemonInfo(daemonJsonPath)).toBeDefined();

      // The graveyard's TTL elapses (simulated, not waited for): the
      // buried session is killed and removed from the graveyard.
      manual.fire();

      // Now zero clients AND the graveyard is empty — idleness resumes
      // counting from here, and shutdown() should run on its own shortly
      // after, same as the live-session test above.
      await waitForFileRemoved(daemonJsonPath, 2_000);
      runtime = undefined;
    },
  );
});

/**
 * A `GraveyardClock` this test steps by hand instead of waiting on real
 * time — see graveyard.ts's own header comment for why an injectable clock
 * (not `vi.useFakeTimers()`) is what this module needs: `runDaemon` here
 * still relies on real, short-interval `setInterval`/`setTimeout` polling
 * (idle-shutdown.ts) and a real named pipe, both of which a globally faked
 * clock would freeze right along with the graveyard's own timer.
 */
function manualGraveyardClock(): { clock: GraveyardClock; fire: () => void } {
  let currentTime = 0;
  const pending: Array<() => void> = [];
  const clock: GraveyardClock = {
    now: () => currentTime,
    setTimeout: (handler) => {
      pending.push(handler);
      return handler;
    },
    clearTimeout: (handle) => {
      const idx = pending.indexOf(handle as () => void);
      if (idx !== -1) {
        pending.splice(idx, 1);
      }
    },
  };
  return {
    clock,
    fire: () => {
      currentTime += 1;
      const toFire = pending.splice(0);
      for (const handler of toFire) {
        handler();
      }
    },
  };
}

async function waitForFileRemoved(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await readDaemonInfo(path);
    if (info === undefined) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`daemon.json at ${path} was not removed within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
