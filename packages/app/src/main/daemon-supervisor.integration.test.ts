import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionCreateResult } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeDaemonJsonAtomic } from '@termhub/daemon/src/daemon.js';
import { Registry } from '@termhub/daemon/src/registry.js';
import { registerSessionService } from '@termhub/daemon/src/service.js';
import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { connectToDaemon } from './daemon-client.js';
import { createDaemonSupervisor } from './daemon-supervisor.js';
import type { DaemonSupervisor, DaemonSupervisorState } from './daemon-supervisor.js';

// docs/specs/m4.8-daemon-resilience.md section 4, required test 6 —
// "integração com daemon real": a real daemon (a real `TransportServer` +
// `registerSessionService`, exactly `boot-reattach.integration.test.ts`'s
// own definition of "real" — that file's header comment explains why that
// counts and a mocked transport wouldn't) with a session and real content;
// the daemon *this test itself started* is torn down (never a daemon this
// test didn't create — `.claude/rules/agent-workflow.md`'s own precedent);
// the supervisor comes back up on a fresh one, with the generation bumped.
//
// The supervisor never spawns a replacement on its own initiative (section
// 2.1) — it only ever calls the real `connectToDaemon()`. What plays the
// part of "a fresh daemon process" here is a fake `spawnDaemon` that stands
// up a *second* real `TransportServer` + `registerSessionService` and
// rewrites `daemon.json` to point at it — the same substitution
// `daemon-client.test.ts` already uses for "a daemon starts" (that file's
// own header comment: `spawnDaemon` is always a fake in this repo's test
// suite, since the real default spawns a real OS process this repo only
// produces via electron-vite's build, exercised manually per that module's
// own doc comment).

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `daemon-supervisor-integration-${label}-${randomUUID()}` });
}

function platformShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }
  return { shell: '/bin/sh', args: [] };
}

/**
 * Whether `marker` shows up as the *output* of `echo <marker>`, not only as
 * the typed command — same helper and same reasoning as
 * `packages/daemon/src/service.test.ts`'s own `hasEchoOutput` (not exported
 * from there, so reproduced here): a line-based check is not enough under
 * ConPTY, whose repaint can land the next prompt right after the echoed
 * text with no line break in between.
 */
function hasEchoOutput(output: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const at = output.indexOf(marker, from);
    if (at === -1) {
      return false;
    }
    if (!output.slice(Math.max(0, at - 5), at).endsWith('echo ')) {
      return true;
    }
    from = at + marker.length;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let tempDir: string;
let cleanup: Array<() => Promise<void> | void>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'termhub-daemon-supervisor-integration-'));
  cleanup = [];
});

afterEach(async () => {
  for (const teardown of cleanup.reverse()) {
    try {
      await teardown();
    } catch {
      // best-effort cleanup only.
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe('daemon-supervisor — real daemon integration (M4.8 required test 6)', () => {
  it('a real daemon with a live session and content is torn down (only the one this test started); the supervisor reconnects to a fresh one, with the generation bumped', async () => {
    const daemonJsonPath = join(tempDir, 'daemon.json');

    // ---- Daemon 1: a real TransportServer + registerSessionService, with
    // a real shell session producing real content. ----
    const address1 = uniqueAddress('daemon-1');
    const token1 = randomUUID();
    const registry1 = new Registry();
    const server1 = new TransportServer({ token: token1, address: address1 });
    registerSessionService(server1, registry1);
    await server1.listen();
    cleanup.push(() => server1.close());
    await writeDaemonJsonAtomic(daemonJsonPath, {
      pid: process.pid,
      pipe: server1.pipeAddress,
      token: token1,
      protocolVersion: server1.protocolVersion,
      startedAt: new Date().toISOString(),
    });

    // ---- Daemon 2: not started yet — only stood up by the fake
    // `spawnDaemon` below, the moment the supervisor's retry loop actually
    // needs one (i.e. once daemon 1's pipe is confirmed gone). ----
    let server2: TransportServer | undefined;
    const spawnDaemon = (): void => {
      void (async () => {
        const address2 = uniqueAddress('daemon-2');
        const token2 = randomUUID();
        const registry2 = new Registry();
        const server = new TransportServer({ token: token2, address: address2 });
        registerSessionService(server, registry2);
        await server.listen();
        cleanup.push(() => server.close());
        server2 = server;
        await writeDaemonJsonAtomic(daemonJsonPath, {
          pid: process.pid + 1,
          pipe: server.pipeAddress,
          token: token2,
          protocolVersion: server.protocolVersion,
          startedAt: new Date().toISOString(),
        });
      })();
    };

    const supervisor: DaemonSupervisor = createDaemonSupervisor({
      connect: () =>
        connectToDaemon({
          daemonJsonPath,
          spawnDaemon,
          handshakeTimeoutMs: 1000,
          // Section 5's own algorithm re-reads daemon.json between
          // attempts; a handful of attempts, with a short backoff, is
          // plenty for a fake spawn that writes the file synchronously.
          maxAttempts: 10,
        }),
      initialBackoffMs: 50,
      maxBackoffMs: 200,
    });
    cleanup.push(() => supervisor.dispose());

    const result1 = await supervisor.firstConnection;
    expect(result1.outcome).toBe('connected');
    if (result1.outcome !== 'connected') {
      throw new Error('unreachable');
    }
    expect(supervisor.current()).toMatchObject({ state: 'connected', epoch: 1 });

    // A real session, with real content — proving this is a genuine daemon
    // and not just a bare transport handshake.
    const { shell, args } = platformShell();
    const created = await result1.client.request<SessionCreateResult>('session.create', {
      shell,
      args,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    const sessionId = created.session.id;
    let output = '';
    result1.client.onData((sid, data) => {
      if (sid === sessionId) {
        output += Buffer.from(data).toString('utf8');
      }
    });
    await result1.client.request('session.attach', { sessionId });
    // `\r`, not `\n`: the Enter key a terminal sends (service.test.ts's own
    // established reasoning — ConPTY only runs the line on `\r`).
    result1.client.sendData(sessionId, Buffer.from('echo M4-8-MARKER\r', 'utf8'));
    await waitFor(() => hasEchoOutput(output, 'M4-8-MARKER'), 15_000);

    const states: DaemonSupervisorState[] = [];
    supervisor.onChange((state) => states.push(state));

    // Tear down *only* the daemon this test started (daemon 1) — never a
    // process this test didn't create (.claude/rules/agent-workflow.md).
    await server1.close();

    await waitFor(() => {
      const state = supervisor.current();
      return state?.state === 'connected' && state.epoch === 2;
    }, 15_000);
    expect(states.some((s) => s.state === 'disconnected')).toBe(true);
    expect(supervisor.current()).toMatchObject({ state: 'connected', epoch: 2 });
    expect(server2).toBeDefined();

    // The reconnected client really is a fresh daemon (a new registry —
    // the old session id means nothing to it).
    const current = supervisor.current();
    if (current?.state !== 'connected') {
      throw new Error('unreachable');
    }
    await expect(current.client.request('session.attach', { sessionId })).rejects.toBeTruthy();
  }, 30_000);
});
