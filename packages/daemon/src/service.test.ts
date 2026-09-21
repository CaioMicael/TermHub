import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionCreateResult, SessionExitPayload, SessionListResult } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Registry } from './registry.js';
import type { SessionFactory, SessionLike } from './registry.js';
import { registerSessionService, writeSessionInput } from './service.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExit,
  SessionExitListener,
} from './session.js';
import { TransportClient, TransportServer, resolvePipeAddress } from './transport.js';

// Real client<->server integration tests over a real named pipe (same style
// as transport.test.ts) plus a couple of fast, deterministic tests against a
// fake `SessionLike` (same style as registry.test.ts) for the cases where a
// real PTY's nondeterminism (exact exit codes on a forced kill, scheduler
// timing) would make an assertion flaky rather than meaningful.
//
// Binary input frames are sent with `TransportClient.sendData()` — the real
// wire, not a direct call into `writeSessionInput` — everywhere the ordering
// or the end-to-end path actually matters. `writeSessionInput` itself is
// only imported for the one spot (the unknown-sessionId case in the
// FakeSession suite) where calling it directly is what isolates the guard
// from everything else that also has to be true for a real client to reach
// it.
//
// Only ONE test in this file spawns a real shell — everything provable
// without node-pty (RPC wiring, broadcast fan-out, list bookkeeping, write-
// to-unknown-id safety, ordering) uses a `FakeSession`, kept fast on
// purpose.

// ---------------------------------------------------------------------------
// Shared test plumbing
// ---------------------------------------------------------------------------

function uniqueAddress(): string {
  return resolvePipeAddress({ suffix: `service-test-${randomUUID()}` });
}

let cleanup: Array<() => Promise<void> | void>;
let realRegistries: Registry[];

beforeEach(() => {
  cleanup = [];
  realRegistries = [];
});

afterEach(async () => {
  // Kill any still-alive *real* PTY session before tearing down the
  // transport, so a thrown assertion never leaves an orphan shell running —
  // same guarantee session.test.ts (M1.3) makes for its own suite.
  for (const registry of realRegistries) {
    for (const summary of registry.list()) {
      registry.close(summary.id);
    }
  }
  for (const teardown of cleanup.reverse()) {
    try {
      await teardown();
    } catch {
      // best-effort cleanup only
    }
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }
}

interface Harness {
  server: TransportServer;
  registry: Registry;
  client: TransportClient;
  /** Connects and handshakes another client against this same server, cleaned up the same way as the harness's own `client`. */
  addClient: () => Promise<TransportClient>;
}

/** Starts a server with the session service registered, a matching registry, and one connected+handshaked client. */
async function startHarness(options: { sessionFactory?: SessionFactory } = {}): Promise<Harness> {
  const address = uniqueAddress();
  const token = `tok-${randomUUID()}`;
  const registry = new Registry(
    options.sessionFactory !== undefined ? { sessionFactory: options.sessionFactory } : {},
  );
  const server = new TransportServer({ token, address });
  registerSessionService(server, registry);
  cleanup.push(() => server.close());
  await server.listen();

  const addClient = async (): Promise<TransportClient> => {
    const extra = new TransportClient({ address, token });
    cleanup.push(() => extra.close());
    await extra.connect();
    return extra;
  };

  const client = await addClient();

  return { server, registry, client, addClient };
}

// ---------------------------------------------------------------------------
// FakeSession — same pattern as registry.test.ts, plus a single unified
// `log` (rather than separate `writes`/`resizes` arrays) so ordering between
// *different* method calls can actually be asserted, not just each method's
// own call order against itself.
// ---------------------------------------------------------------------------

class FakeSession implements SessionLike {
  private static nextPid = 42_000;

  readonly pid = FakeSession.nextPid++;
  private aliveFlag = true;
  private exitListeners: SessionExitListener[] = [];
  private dataListeners: SessionDataListener[] = [];

  readonly log: string[] = [];
  killCalls = 0;

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  write(data: string): void {
    this.log.push(`write:${data}`);
  }

  resize(cols: number, rows: number): void {
    this.log.push(`resize:${cols}x${rows}`);
  }

  kill(): void {
    this.killCalls += 1;
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: SessionDataListener): Disposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => (this.dataListeners = this.dataListeners.filter((l) => l !== listener)),
    };
  }

  onExit(listener: SessionExitListener): Disposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => (this.exitListeners = this.exitListeners.filter((l) => l !== listener)),
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
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

function fakeFactory(): { factory: SessionFactory; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

function baseCreateParams(): { cwd: string; shell: string; cols: number; rows: number } {
  return { cwd: 'C:\\Users\\caiom\\project', shell: 'pwsh.exe', cols: 80, rows: 24 };
}

// ---------------------------------------------------------------------------
// Real-PTY end-to-end (the one slow test in this file)
// ---------------------------------------------------------------------------

function resolveShell(): string {
  try {
    execFileSync('where', ['pwsh.exe'], { stdio: 'ignore' });
    return 'pwsh.exe';
  } catch {
    return 'powershell.exe';
  }
}

const ESC = '\x1b';
const BEL = '\x07';

// Same ANSI-stripping approach as session.test.ts (M1.3), for the same
// reason: PSReadLine echoes the typed command back wrapped in SGR codes, so
// a naive `.includes('hi')` would false-positive on the echoed keystrokes
// ("echo hi") before the shell ever produced real output.
function stripAnsi(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input.charAt(i) === ESC && input.charAt(i + 1) === '[') {
      let j = i + 2;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        j++;
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
      i = j;
      continue;
    }
    if (input.charAt(i) === ESC && input.charAt(i + 1) === ']') {
      let j = i + 2;
      while (j < input.length && input.charAt(j) !== BEL) {
        if (input.charAt(j) === ESC && input.charAt(j + 1) === '\\') {
          j += 2;
          break;
        }
        j++;
      }
      if (input.charAt(j) === BEL) {
        j++;
      }
      i = j;
      continue;
    }
    out += input.charAt(i);
    i++;
  }
  return out;
}

function hasStandaloneLine(output: string, line: string): boolean {
  return stripAnsi(output)
    .split(/\r?\n/)
    .some((l) => l.trim() === line);
}

describe('session service: real PTY end to end over the real pipe', () => {
  it(
    'session.create spawns a real PTY whose prompt streams back as binary frames; ' +
      'sending "echo hi" via client.sendData() over the real pipe reaches the shell and "hi" streams back too; ' +
      'the shell exiting on its own reports the real exit code via session.exit and session.list; ' +
      'session.close afterward is a harmless no-op that removes it from session.list',
    async () => {
      const { registry, client } = await startHarness();
      realRegistries.push(registry);

      const createResult = await client.request<SessionCreateResult>('session.create', {
        shell: resolveShell(),
        args: ['-NoLogo', '-NoProfile'],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      const sessionId = createResult.session.id;

      let output = '';
      client.onData((sid, data) => {
        if (sid === sessionId) {
          output += Buffer.from(data).toString('utf8');
        }
      });

      // 1. session.create really spawned a PTY and its output (the initial
      // prompt) arrives at the client as a binary frame.
      await waitFor(() => output.length > 0, 15_000);

      // 2. End to end, over the real pipe: TransportClient.sendData() ->
      // TransportServer's registerDataHandler -> writeSessionInput -> real
      // PTY -> binary output frame back to the client. The PSReadLine-echo
      // false positive is guarded against exactly like session.test.ts does.
      client.sendData(sessionId, Buffer.from('echo hi\r', 'utf8'));
      await waitFor(() => hasStandaloneLine(output, 'hi'), 15_000);

      // The shell dies on its own (not via session.close) with a known exit
      // code, so session.exit and session.list can be checked against an
      // exact value instead of "some number".
      const exitEvent = new Promise<SessionExitPayload>((resolve) => {
        const sub = client.onEvent((msg) => {
          if (msg.event === 'session.exit') {
            sub.dispose();
            resolve(msg.payload as SessionExitPayload);
          }
        });
      });
      client.sendData(sessionId, Buffer.from('exit 5\r', 'utf8'));
      const exit = await exitEvent;
      expect(exit.sessionId).toBe(sessionId);
      expect(exit.exitCode).toBe(5);

      // 4. session.list carries the exit code of a session that died on its
      // own, for a client that reconnects after missing the event.
      const listedAfterDeath = await client.request<SessionListResult>('session.list', {});
      const listedSession = listedAfterDeath.sessions.find((s) => s.id === sessionId);
      expect(listedSession?.status).toBe('exited');
      expect(listedSession?.exitCode).toBe(5);

      // 5. session.close on an already-dead session doesn't throw and
      // session.list reflects the closure (registry.close()'s idempotency).
      await client.request('session.close', { sessionId });
      const listedAfterClose = await client.request<SessionListResult>('session.list', {});
      expect(listedAfterClose.sessions.some((s) => s.id === sessionId)).toBe(false);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Fast, deterministic tests against a FakeSession
// ---------------------------------------------------------------------------

describe('session service: RPC wiring and broadcast (fake session)', () => {
  it('session.resize reaches the session, and its ordering relative to a binary-input frame sent right after it — on the same connection, over the real pipe — is preserved in both directions', async () => {
    const { factory, sessions } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });

    const created = await client.request<SessionCreateResult>('session.create', baseCreateParams());
    const sessionId = created.session.id;
    const fake = sessions[0]!;

    // Order A: the resize request's control frame, then a binary-input
    // frame, written to the SAME socket back to back with no `await`
    // between the two sends — TransportClient.request()/sendData() both
    // hand their frame to the socket synchronously (before the request's
    // Promise is even returned; `new Promise(executor)` runs its executor
    // synchronously). The pipe delivers those bytes to the server in that
    // same order, and TransportServer.onFrame dispatches each decoded frame
    // synchronously as it comes off FrameDecoder — control before data, in
    // this order — so the server-side *application* order (`fake.log`)
    // matches wire *arrival* order, not just program order on one side.
    const resizeA = client.request('session.resize', { sessionId, cols: 100, rows: 40 });
    client.sendData(sessionId, Buffer.from('A', 'utf8'));
    await resizeA;
    await waitFor(() => fake.log.length >= 2, 2_000);
    expect(fake.log).toEqual(['resize:100x40', 'write:A']);

    // Order B: reversed — proving this isn't "resize always wins" but
    // genuinely "whichever frame the client wrote to the socket first is
    // what the server applied first".
    client.sendData(sessionId, Buffer.from('B', 'utf8'));
    const resizeB = client.request('session.resize', { sessionId, cols: 120, rows: 50 });
    await resizeB;
    await waitFor(() => fake.log.length >= 4, 2_000);
    expect(fake.log).toEqual(['resize:100x40', 'write:A', 'write:B', 'resize:120x50']);
  });

  it('session.resize on an unknown sessionId rejects with SESSION_NOT_FOUND instead of crashing the connection', async () => {
    const { factory } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });

    let caught: unknown;
    try {
      await client.request('session.resize', { sessionId: 999_999, cols: 80, rows: 24 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND);

    // The connection is still fine afterward.
    await expect(client.request('session.list', {})).resolves.toBeDefined();
  });

  it('session.list reflects creations and closures', async () => {
    const { factory } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });

    const a = await client.request<SessionCreateResult>('session.create', baseCreateParams());
    const b = await client.request<SessionCreateResult>('session.create', baseCreateParams());

    const afterCreate = await client.request<SessionListResult>('session.list', {});
    expect(afterCreate.sessions.map((s) => s.id).sort()).toEqual(
      [a.session.id, b.session.id].sort(),
    );

    await client.request('session.close', { sessionId: a.session.id });
    const afterClose = await client.request<SessionListResult>('session.list', {});
    expect(afterClose.sessions.map((s) => s.id)).toEqual([b.session.id]);
  });

  it('session.close kills the session and broadcasts session.exit with the exact code to every connected client', async () => {
    const { factory } = fakeFactory();
    const { client: clientA, addClient } = await startHarness({ sessionFactory: factory });
    const clientB = await addClient();

    const created = await clientA.request<SessionCreateResult>(
      'session.create',
      baseCreateParams(),
    );
    const sessionId = created.session.id;

    function waitForExit(client: TransportClient): Promise<SessionExitPayload> {
      return new Promise((resolve) => {
        const sub = client.onEvent((msg) => {
          if (msg.event === 'session.exit') {
            sub.dispose();
            resolve(msg.payload as SessionExitPayload);
          }
        });
      });
    }

    const [exitA, exitB] = await Promise.all([
      waitForExit(clientA),
      waitForExit(clientB),
      clientA.request('session.close', { sessionId }),
    ]);

    expect(exitA).toEqual({ sessionId, exitCode: 0 });
    expect(exitB).toEqual({ sessionId, exitCode: 0 });
  });

  it('writeSessionInput itself is a no-op (not a throw) for an unknown sessionId', () => {
    const { factory } = fakeFactory();
    const registry = new Registry({ sessionFactory: factory });

    expect(() => {
      writeSessionInput(registry, 424_242, Buffer.from('irrelevant', 'utf8'));
    }).not.toThrow();
  });

  it('a client sending a binary frame for an unknown sessionId over the real pipe does not crash the connection or the server', async () => {
    const { factory } = fakeFactory();
    const { server, client } = await startHarness({ sessionFactory: factory });

    // No response is expected for a data frame — this only proves the
    // connection/server survive it, by checking both are still usable
    // right after.
    client.sendData(424_242, Buffer.from('irrelevant', 'utf8'));

    await expect(client.request<SessionListResult>('session.list', {})).resolves.toEqual({
      sessions: [],
    });
    expect(server.connectionCount).toBe(1);
    expect(client.isReady).toBe(true);
  });
});
