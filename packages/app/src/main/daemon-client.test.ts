import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeDaemonJsonAtomic } from '@termhub/daemon/src/daemon.js';
import type { DaemonInfo } from '@termhub/daemon/src/daemon.js';
import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { connectToDaemon } from './daemon-client.js';
import type { SpawnDaemon } from './daemon-client.js';

// The 9 required tests of docs/specs/m2.1-daemon-client.md section 8. Every
// scenario uses a *real* TransportServer (or, for the zombie case, a raw
// `net` server) on a unique, per-test address — never a mocked `net` — the
// same real-integration style packages/daemon/src/transport.test.ts already
// uses, for the same reason its own header comment gives: this is what
// actually proves the wire-level classification (zombie / orphaned /
// version-mismatch / token-rejected) works, not just that some mock was
// configured to return the right label.
//
// `spawnDaemon` is always a fake, per section 7's own requirement ("testável
// sem spawnar Electron"): the real default (daemon-process.ts +
// daemon-paths.ts, wired as connectToDaemon()'s own default) spawns a real
// OS process running a script this repo only produces via electron-vite's
// build — exercised manually as part of this task instead of from this
// suite (see this task's final report).

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `app-daemon-client-test-${label}-${randomUUID()}` });
}

let tempDir: string;
let cleanup: Array<() => Promise<void> | void>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'termhub-app-daemon-client-test-'));
  cleanup = [];
});

afterEach(async () => {
  for (const teardown of cleanup.reverse()) {
    try {
      await teardown();
    } catch {
      // best-effort cleanup only — one leaked handle's teardown throwing
      // must not stop every other handle from being torn down too.
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

function daemonJsonPathFor(label: string): string {
  return join(tempDir, `daemon-${label}-${randomUUID()}.json`);
}

function fakeDaemonInfo(overrides: Partial<DaemonInfo> & Pick<DaemonInfo, 'pipe'>): DaemonInfo {
  return {
    pid: 999999,
    token: 'fake-token',
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Brings up a real, handshake-capable fake daemon: a real `TransportServer`
 * listening on `address`, with a matching `daemon.json` written at
 * `daemonJsonPath` — standing in for what `startDaemon()`
 * (packages/daemon/src/daemon.ts) does on a real win, without pulling in
 * that module's own single-instance-lock machinery (out of scope here, and
 * already covered by packages/daemon/src/daemon.test.ts).
 */
async function startFakeDaemon(params: {
  address: string;
  daemonJsonPath: string;
  protocolVersion?: number;
}): Promise<{ server: TransportServer; info: DaemonInfo }> {
  const token = randomUUID();
  const server = new TransportServer({
    token,
    address: params.address,
    ...(params.protocolVersion !== undefined ? { protocolVersion: params.protocolVersion } : {}),
  });
  await server.listen();
  const info: DaemonInfo = {
    pid: process.pid,
    pipe: server.pipeAddress,
    token,
    protocolVersion: server.protocolVersion,
    startedAt: new Date().toISOString(),
  };
  await writeDaemonJsonAtomic(params.daemonJsonPath, info);
  return { server, info };
}

/** Connects a throwaway probe socket to `address` and resolves once it actually connects — used to prove a listener is still alive without going through the full handshake protocol. */
function probeConnects(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe: Socket = connect(address);
    probe.once('connect', () => {
      probe.destroy();
      resolve();
    });
    probe.once('error', (err) => {
      probe.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * A raw server that accepts connections and never responds to anything —
 * the zombie daemon docs/specs/m2.1-daemon-client.md section 5 describes.
 * Tracks every socket it accepts and force-destroys them on `close()`:
 * `net.Server.close()` only stops accepting *new* connections and waits for
 * existing ones to end on their own before its callback fires, and a socket
 * the far end (`TransportClient`) already gave up on and destroyed can
 * still take a little while to be noticed as closed here (more so over a
 * Windows named pipe than a loopback TCP socket) — without forcing it,
 * `close()`'s callback can hang well past this suite's own hook timeout.
 */
function createZombieServer(): { server: Server; close: () => Promise<void> } {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const close = (): Promise<void> => {
    for (const socket of sockets) {
      socket.destroy();
    }
    return closeServer(server);
  };
  return { server, close };
}

/**
 * Resolves `promise` while repeatedly advancing Vitest's fake clock —
 * needed instead of a single `vi.runAllTimersAsync()` because
 * `connectToDaemon`'s loop interleaves fake-timer backoff waits with real
 * `fs.promises.readFile` calls (`readDaemonInfo`): at the instant this is
 * first called, no fake timer has been scheduled yet (the loop is still
 * awaiting that real read), so `runAllTimersAsync()` sees nothing to
 * advance and returns immediately, and a later backoff timer — scheduled
 * only once that real read resolves — then never gets to fire. Yielding a
 * real tick (`process.nextTick`) between each advance gives that pending
 * real I/O a chance to resolve and, in turn, register its next fake timer.
 */
async function advanceFakeTimersUntil<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const maxIterations = 200;
  for (let i = 0; i < maxIterations && !settled; i += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });
  }

  return promise;
}

describe('connectToDaemon', () => {
  // Required test 1 -----------------------------------------------------
  it('test 1: no daemon.json at all — spawns exactly once, then connects', async () => {
    const daemonJsonPath = daemonJsonPathFor('no-daemon');
    const address = uniqueAddress('no-daemon');

    const spawnDaemon: SpawnDaemon = vi.fn(async (spawnAddress: string) => {
      const { server } = await startFakeDaemon({ address: spawnAddress, daemonJsonPath });
      cleanup.push(() => server.close());
    });

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      handshakeTimeoutMs: 1000,
    });

    expect(result.outcome).toBe('connected');
    if (result.outcome === 'connected') {
      cleanup.push(() => result.client.close());
    }
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  // Required test 2 -----------------------------------------------------
  it('test 2: a daemon is already running — connects without ever spawning', async () => {
    const daemonJsonPath = daemonJsonPathFor('already-running');
    const address = uniqueAddress('already-running');

    const { server } = await startFakeDaemon({ address, daemonJsonPath });
    cleanup.push(() => server.close());

    const spawnDaemon: SpawnDaemon = vi.fn();

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      handshakeTimeoutMs: 1000,
    });

    expect(result.outcome).toBe('connected');
    if (result.outcome === 'connected') {
      cleanup.push(() => result.client.close());
    }
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  // Required test 3 -----------------------------------------------------
  it('test 3: a zombie daemon (accepts, never handshakes) is blocked within the timeout — and is proven still alive afterward, never killed', async () => {
    const daemonJsonPath = daemonJsonPathFor('zombie');
    const address = uniqueAddress('zombie');

    // Accepts connections and never responds to anything — the zombie this
    // test's fake process stands in for.
    const zombie = createZombieServer();
    await new Promise<void>((resolve) => {
      zombie.server.listen(address, resolve);
    });
    cleanup.push(() => zombie.close());

    await writeDaemonJsonAtomic(daemonJsonPath, fakeDaemonInfo({ pipe: address }));

    const spawnDaemon: SpawnDaemon = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      handshakeTimeoutMs: 150,
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.reason).toBe('zombie');
    }
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    // Prove the fake process was left alive: it still accepts a fresh
    // connection after connectToDaemon() has already returned.
    await expect(probeConnects(address)).resolves.toBeUndefined();

    killSpy.mockRestore();
  });

  // Required test 4 -----------------------------------------------------
  it('test 4: a protocolVersion mismatch in daemon.json is blocked, without ever connecting or spawning', async () => {
    const daemonJsonPath = daemonJsonPathFor('version-mismatch');
    // Nothing ever listens here — proves the mismatch is caught from
    // daemon.json alone, before any socket is even opened.
    const address = uniqueAddress('version-mismatch');

    await writeDaemonJsonAtomic(
      daemonJsonPath,
      fakeDaemonInfo({ pipe: address, protocolVersion: PROTOCOL_VERSION + 1 }),
    );

    const spawnDaemon: SpawnDaemon = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      protocolVersion: PROTOCOL_VERSION,
      handshakeTimeoutMs: 200,
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.reason).toBe('version-mismatch');
    }
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  // Required test 5 -----------------------------------------------------
  it('test 5: an orphaned daemon.json (its pipe does not exist) is treated as absent — spawns and connects normally', async () => {
    const daemonJsonPath = daemonJsonPathFor('orphaned');
    const address = uniqueAddress('orphaned');

    // daemon.json points at `address`, but nobody is listening there yet —
    // exactly what a daemon that crashed without cleaning up looks like.
    await writeDaemonJsonAtomic(daemonJsonPath, fakeDaemonInfo({ pipe: address }));

    const spawnDaemon: SpawnDaemon = vi.fn(async (spawnAddress: string) => {
      const { server } = await startFakeDaemon({ address: spawnAddress, daemonJsonPath });
      cleanup.push(() => server.close());
    });

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      handshakeTimeoutMs: 1000,
    });

    expect(result.outcome).toBe('connected');
    if (result.outcome === 'connected') {
      cleanup.push(() => result.client.close());
    }
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  // Required test 6 -----------------------------------------------------
  it('test 6: a spawned daemon that exits with code 3 (lost the race) still ends connected, because another daemon is already up', async () => {
    const daemonJsonPath = daemonJsonPathFor('code-3');
    const address = uniqueAddress('code-3');

    const spawnDaemon: SpawnDaemon = vi.fn(async (spawnAddress: string) => {
      // A real OS process, spawned and left to run exactly like the real
      // spawnDaemon (daemon-process.ts) does: fire-and-forget, never
      // awaited, never inspected for its exit code. It exits with code 3 —
      // docs/specs/m1.8-single-instance.md section 3.1's "lost the race".
      const loser = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
      loser.unref();

      // Meanwhile "another app instance" already won that race — bring up
      // the daemon that's actually listening, the way a winning
      // startDaemon() call would have.
      const { server } = await startFakeDaemon({ address: spawnAddress, daemonJsonPath });
      cleanup.push(() => server.close());
    });

    const result = await connectToDaemon({
      daemonJsonPath,
      address,
      spawnDaemon,
      handshakeTimeoutMs: 1000,
    });

    expect(result.outcome).toBe('connected');
    if (result.outcome === 'connected') {
      cleanup.push(() => result.client.close());
    }
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  // Required test 7 -----------------------------------------------------
  it('test 7: backoff is finite — gives up with "failed" when spawning never produces a daemon (fake timers, no real waiting)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const daemonJsonPath = daemonJsonPathFor('backoff-exhausted');
      const address = uniqueAddress('backoff-exhausted');

      // Never brings up anything: daemon.json stays absent for the whole
      // test, on purpose.
      const spawnDaemon: SpawnDaemon = vi.fn(async () => {});

      const resultPromise = connectToDaemon({
        daemonJsonPath,
        address,
        spawnDaemon,
        maxAttempts: 3,
        initialBackoffMs: 50,
        maxBackoffMs: 200,
      });

      const result = await advanceFakeTimersUntil(resultPromise);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.attempts).toBe(3);
        expect(result.daemonPath).toBe(daemonJsonPath);
        expect(result.lastError).toBeInstanceOf(Error);
      }
      // 3 attempts, backing off between each but the last => 2 spawns.
      expect(spawnDaemon).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Required test 8 -----------------------------------------------------
  it('test 8: never calls process.kill, across every outcome (connected / blocked-zombie / blocked-version-mismatch / failed)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // connected, via the spawn path (mirrors test 1).
    {
      const daemonJsonPath = daemonJsonPathFor('kill-spy-connected');
      const address = uniqueAddress('kill-spy-connected');
      const spawnDaemon: SpawnDaemon = vi.fn(async (spawnAddress: string) => {
        const { server } = await startFakeDaemon({ address: spawnAddress, daemonJsonPath });
        cleanup.push(() => server.close());
      });
      const result = await connectToDaemon({
        daemonJsonPath,
        address,
        spawnDaemon,
        handshakeTimeoutMs: 1000,
      });
      expect(result.outcome).toBe('connected');
      if (result.outcome === 'connected') {
        cleanup.push(() => result.client.close());
      }
    }

    // blocked: zombie (mirrors test 3).
    {
      const daemonJsonPath = daemonJsonPathFor('kill-spy-zombie');
      const address = uniqueAddress('kill-spy-zombie');
      const zombie = createZombieServer();
      await new Promise<void>((resolve) => {
        zombie.server.listen(address, resolve);
      });
      cleanup.push(() => zombie.close());
      await writeDaemonJsonAtomic(daemonJsonPath, fakeDaemonInfo({ pipe: address }));

      const result = await connectToDaemon({
        daemonJsonPath,
        address,
        spawnDaemon: vi.fn(),
        handshakeTimeoutMs: 150,
      });
      expect(result.outcome).toBe('blocked');
    }

    // blocked: version-mismatch (mirrors test 4).
    {
      const daemonJsonPath = daemonJsonPathFor('kill-spy-version');
      const address = uniqueAddress('kill-spy-version');
      await writeDaemonJsonAtomic(
        daemonJsonPath,
        fakeDaemonInfo({ pipe: address, protocolVersion: PROTOCOL_VERSION + 1 }),
      );

      const result = await connectToDaemon({
        daemonJsonPath,
        address,
        spawnDaemon: vi.fn(),
        protocolVersion: PROTOCOL_VERSION,
        handshakeTimeoutMs: 150,
      });
      expect(result.outcome).toBe('blocked');
    }

    // failed: backoff exhausted (mirrors test 7), fake timers scoped to
    // just this block.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const daemonJsonPath = daemonJsonPathFor('kill-spy-failed');
      const address = uniqueAddress('kill-spy-failed');
      const resultPromise = connectToDaemon({
        daemonJsonPath,
        address,
        spawnDaemon: vi.fn(async () => {}),
        maxAttempts: 2,
        initialBackoffMs: 10,
        maxBackoffMs: 20,
      });
      const result = await advanceFakeTimersUntil(resultPromise);
      expect(result.outcome).toBe('failed');
    } finally {
      vi.useRealTimers();
    }

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
