import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionCreateResult, SessionListResult } from '@termhub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readDaemonInfo } from './daemon.js';
import type { DaemonInfo } from './daemon.js';
import { resolveAddressOverride } from './index.js';
import { TransportClient } from './transport-client.js';
import { resolvePipeAddress } from './transport-address.js';

// Reproduces, and then proves the fix for, the zombie-daemon bug the
// coordinator diagnosed on this machine: a daemon process idled out
// (idle-shutdown.ts's onIdleTimeout fires, daemon-runtime.ts's shutdown()
// runs and finishes — sessions closed, transport closed, daemon.json
// removed) but the OS *process* never terminated. `runDaemon`'s
// onIdleTimeout handler only ever called `shutdown()` and trusted the event
// loop to drain once it settled; the signal path in index.ts, by contrast,
// always called `process.exit(0)` explicitly. See this task's final report
// for what was actually still holding the event loop open, and why it only
// shows up once a real PTY session has existed (an idle daemon that never
// created one exits fine even without this fix).
//
// This has to spawn `index.ts` as a real, separate OS process: the bug is
// specifically "the process doesn't exit", which is unobservable from
// anything running in-process inside this test's own vitest worker (that
// process staying alive would just be vitest's own, not the daemon's).
//
// Running the raw `.ts` sources directly (`node --experimental-strip-types
// index.ts`) doesn't work in this repo at all: type stripping alone doesn't
// resolve this project's `./foo.js`-importing-`foo.ts` convention (meant
// for a build step, not direct execution — see daemon-paths.ts's own header
// comment on why M2.1 already concluded Electron can't run this package's
// TypeScript directly). So this test bundles `index.ts` the same way
// electron-vite's "daemon" Rollup input (packages/app/electron.vite.config.ts)
// does for the real packaged app — a single self-contained CJS file, only
// `node-pty` kept external — using `vite`'s own build API directly (a root
// devDependency already, and `electron-vite` is not: this stays inside
// packages/daemon's own file boundary rather than depending on
// packages/app's build config). This is what actually reproduces the real
// bug: the coordinator's zombie process was `electron.exe ... daemon.js`,
// a bundle, not a raw `.ts` file.
//
// Isolation for this spawned daemon — its own `daemon.json` location and
// its own pipe name — uses exactly the two mechanisms this task adds:
// `APPDATA` (already read by daemon.ts, untouched by this task) pointed at
// a fresh temp dir, and `TERMHUB_PIPE_SUFFIX` (new, index.ts-only) so this
// test's daemon never collides with a real daemon — or another test's —
// running on the same machine at the same time.

const require = createRequire(import.meta.url);
const daemonPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(daemonPackageRoot, '../..');
// Under packages/daemon/dist/ — already covered by the repo's own
// `.gitignore` (`dist/`, matched at any depth), same as every other
// package's real build output.
const bundleOutDir = join(daemonPackageRoot, 'dist', 'index-test-bundle');
const bundlePath = join(bundleOutDir, 'daemon-test-entry.cjs');

/**
 * Bundles `index.ts` once for this whole file, mirroring
 * electron.vite.config.ts's own "daemon" Rollup input closely enough to
 * reproduce the same runtime shape: ssr/node target, single CJS output,
 * `node-pty` external (it ships a prebuilt native binary Rollup can't
 * bundle), and the same `@xterm/headless` alias electron.vite.config.ts's
 * own header comment explains (that package's `"module"` field points at a
 * file that doesn't exist in the published package).
 */
async function bundleEntrypoint(): Promise<void> {
  const { build } = await import('vite');
  const xtermHeadlessEntry = require.resolve('@xterm/headless');
  await build({
    configFile: false,
    root: repoRoot,
    logLevel: 'warn',
    resolve: {
      alias: {
        '@xterm/headless': xtermHeadlessEntry,
      },
    },
    build: {
      ssr: true,
      target: 'node22',
      outDir: bundleOutDir,
      emptyOutDir: true,
      rollupOptions: {
        input: { 'daemon-test-entry': join(daemonPackageRoot, 'src', 'index.ts') },
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
        external: ['node-pty'],
      },
    },
  });
}

const spawnedChildren: ChildProcess[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  await bundleEntrypoint();
}, 30_000);

afterAll(async () => {
  await rm(bundleOutDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Belt-and-suspenders cleanup: every test below is expected to have
  // already asserted its spawned process exited on its own (that's the
  // whole point), but if an assertion above throws first, this makes sure
  // nothing spawned by *this* suite is left running — never touching any
  // process this suite didn't itself spawn (a real daemon on this machine
  // included).
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
    }
  }
  spawnedChildren.length = 0;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

interface SpawnedDaemon {
  child: ChildProcess;
  daemonJsonPath: string;
  /** Resolves with the child's exit code once it actually terminates. Never resolves if it doesn't — callers race it against a timeout. */
  exited: Promise<number | null>;
}

function spawnDaemonProcess(options: {
  idleTimeoutMs: number;
  idleCheckIntervalMs: number;
}): SpawnedDaemon {
  const appDataDir = join(tmpdir(), `termhub-index-test-${randomUUID()}`);
  tempDirs.push(appDataDir);
  const daemonJsonPath = join(appDataDir, 'TermHub', 'daemon.json');

  const child = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      APPDATA: appDataDir,
      TERMHUB_PIPE_SUFFIX: `index-idle-test-${randomUUID()}`,
      TERMHUB_IDLE_TIMEOUT_MS: String(options.idleTimeoutMs),
      TERMHUB_IDLE_CHECK_INTERVAL_MS: String(options.idleCheckIntervalMs),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  spawnedChildren.push(child);

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return { child, daemonJsonPath, exited };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForDaemonInfo(path: string, timeoutMs: number): Promise<DaemonInfo> {
  let info: DaemonInfo | undefined;
  await waitFor(async () => {
    info = await readDaemonInfo(path);
    return info !== undefined;
  }, timeoutMs);
  if (info === undefined) {
    throw new Error(`daemon.json never appeared at ${path}`);
  }
  return info;
}

async function waitForNoLiveSessions(client: TransportClient, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const result = await client.request<SessionListResult>('session.list');
    return result.sessions.every((session) => session.status === 'exited');
  }, timeoutMs);
}

/**
 * Drives one spawned daemon through the exact scenario the task prompt
 * asks for: a real PTY session created through it, the shell exiting on
 * its own, then the client disconnecting — the state idle-shutdown must
 * treat as "idle" (docs/specs/m1.8-single-instance.md section 3.4: zero
 * clients AND zero live sessions). A daemon that never creates a session at
 * all does *not* reproduce the zombie (confirmed manually while building
 * this test — see this task's final report): whatever keeps the event loop
 * alive after an idle shutdown is tied to a session having actually run a
 * real PTY, not idle-shutdown's logic in the abstract.
 */
async function driveSessionToIdle(info: DaemonInfo): Promise<void> {
  const client = new TransportClient({
    address: info.pipe,
    token: info.token,
    clientName: 'index-idle-test',
  });
  await client.connect();
  try {
    // `cmd.exe /c exit` starts and terminates itself immediately — no input
    // needs to be sent for "the shell exits" to happen, keeping this test's
    // own timing independent of the idle timeout it's trying to measure.
    await client.request<SessionCreateResult>('session.create', {
      shell: 'cmd.exe',
      args: ['/c', 'exit'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    await waitForNoLiveSessions(client, 10_000);
  } finally {
    await client.close();
  }
}

describe('index.ts: idle-shutdown actually exits the process', () => {
  it(
    'a daemon that idles out (zero clients, zero live sessions, after a real PTY session ran and ' +
      'exited) terminates its own OS process, not just its internal state',
    async () => {
      const idleTimeoutMs = 300;
      const idleCheckIntervalMs = 50;
      const { daemonJsonPath, exited } = spawnDaemonProcess({ idleTimeoutMs, idleCheckIntervalMs });

      const info = await waitForDaemonInfo(daemonJsonPath, 10_000);
      await driveSessionToIdle(info);

      // From here the daemon has zero clients and zero live sessions — the
      // idle poller (checkIntervalMs-granularity) must notice within
      // idleCheckIntervalMs, then wait idleTimeoutMs, then the process must
      // actually exit. Generous margin on top for process-spawn/PTY jitter
      // on a real machine, still far short of vitest's own per-test timeout
      // below.
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), idleTimeoutMs + idleCheckIntervalMs * 4 + 8_000);
        }),
      ]);

      expect(code).not.toBe('timeout');
      expect(code).toBe(0);
    },
    40_000,
  );
});

describe('index.ts: TERMHUB_PIPE_SUFFIX isolates a test daemon from a real one', () => {
  const originalSuffix = process.env.TERMHUB_PIPE_SUFFIX;

  afterEach(() => {
    if (originalSuffix === undefined) {
      delete process.env.TERMHUB_PIPE_SUFFIX;
    } else {
      process.env.TERMHUB_PIPE_SUFFIX = originalSuffix;
    }
  });

  it("unset: resolves to no override at all — byte-identical to today, where runDaemon falls through to startDaemon's own real default", () => {
    delete process.env.TERMHUB_PIPE_SUFFIX;
    expect(resolveAddressOverride()).toBeUndefined();
  });

  it('set: resolves to exactly resolvePipeAddress({ suffix }) — the same derivation every test in this package already relies on for isolation', () => {
    process.env.TERMHUB_PIPE_SUFFIX = 'unit-test-suffix';
    expect(resolveAddressOverride()).toBe(resolvePipeAddress({ suffix: 'unit-test-suffix' }));
  });

  it(
    'two real daemon processes with different suffixes run at the same time, each on its own ' +
      'pipe, without one losing the single-instance race to the other',
    async () => {
      const idleTimeoutMs = 60_000; // long enough that neither idles out mid-test
      const a = spawnDaemonProcess({ idleTimeoutMs, idleCheckIntervalMs: 1_000 });
      const b = spawnDaemonProcess({ idleTimeoutMs, idleCheckIntervalMs: 1_000 });

      const [infoA, infoB] = await Promise.all([
        waitForDaemonInfo(a.daemonJsonPath, 10_000),
        waitForDaemonInfo(b.daemonJsonPath, 10_000),
      ]);

      // Distinct pipes — the whole point of the suffix.
      expect(infoA.pipe).not.toBe(infoB.pipe);

      // Both are independently reachable: an RPC against each succeeds,
      // proving neither process lost the single-instance race (`listen()`
      // failing with EADDRINUSE) to the other and exited with code 3
      // instead of actually starting.
      const clientA = new TransportClient({
        address: infoA.pipe,
        token: infoA.token,
        clientName: 'isolation-test-a',
      });
      const clientB = new TransportClient({
        address: infoB.pipe,
        token: infoB.token,
        clientName: 'isolation-test-b',
      });
      await Promise.all([clientA.connect(), clientB.connect()]);
      try {
        const [listA, listB] = await Promise.all([
          clientA.request<SessionListResult>('session.list'),
          clientB.request<SessionListResult>('session.list'),
        ]);
        expect(listA.sessions).toEqual([]);
        expect(listB.sessions).toEqual([]);
      } finally {
        await Promise.all([clientA.close(), clientB.close()]);
      }

      // Both processes are still alive — neither daemon killed the other by
      // grabbing its pipe out from under it.
      expect(a.child.exitCode).toBeNull();
      expect(b.child.exitCode).toBeNull();
    },
    20_000,
  );
});
