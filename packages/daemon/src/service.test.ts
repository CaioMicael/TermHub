import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Terminal } from '@xterm/headless';
import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type {
  SessionCreateResult,
  SessionExitPayload,
  SessionId,
  SessionListResult,
} from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TerminalBuffer } from './buffer.js';
import { Registry } from './registry.js';
import type { SessionFactory, SessionLike } from './registry.js';
import {
  attachClient,
  detachClient,
  detachClientEverywhere,
  registerSessionService,
  wireSessionDelivery,
  writeSessionInput,
} from './service.js';
import type { AttachTransport, SessionRuntime, SessionService } from './service.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExit,
  SessionExitListener,
} from './session.js';
import { TransportClient, TransportServer, resolvePipeAddress } from './transport.js';

// `@xterm/headless`'s `buffer` accessor is still marked "proposed" in
// xterm.js, so every raw comparison `Terminal` this test file creates
// directly (i.e. not through `TerminalBuffer`, which already sets this) —
// used to reconstruct what a client actually saw, from the raw frames it
// received, and compare it against ground truth — needs the same flag
// buffer.test.ts's own comparison terminals need.
const COMPARISON_OPTS = { allowProposedApi: true } as const;

/** Promisifies `Terminal#write`, resolving once the parser has fully processed `data`. Same helper buffer.test.ts uses, redefined here to keep this file's M1.7 tests self-contained. */
function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

/** Every line currently in `terminal`'s active buffer (scrollback + viewport), trimmed of trailing whitespace. */
function linesOf(terminal: Terminal): string[] {
  const lines: string[] = [];
  for (let y = 0; y < terminal.buffer.active.length; y++) {
    lines.push(terminal.buffer.active.getLine(y)?.translateToString(true) ?? '');
  }
  return lines;
}

/**
 * Records what `attachClient`/`wireSessionDelivery` actually sent, per
 * client, without needing a real `TransportServer`/socket — see
 * `AttachTransport`'s own doc comment (service.ts) for why this structural
 * interface exists. Used by the M1.7 tests that need precise control over
 * *when* a chunk arrives relative to an in-flight `buffer.serialize()`,
 * which going through a real socket round-trip cannot deterministically
 * provide (see this describe block's header comment).
 */
class RecordingTransport implements AttachTransport {
  readonly sentData = new Map<string, Buffer[]>();
  readonly sentEvents = new Map<string, Array<{ event: string; payload: unknown }>>();

  sendDataTo(clientId: string, _sessionId: SessionId, data: Uint8Array): void {
    const list = this.sentData.get(clientId) ?? [];
    list.push(Buffer.from(data));
    this.sentData.set(clientId, list);
  }

  sendEventTo(clientId: string, event: string, payload: unknown): void {
    const list = this.sentEvents.get(clientId) ?? [];
    list.push({ event, payload });
    this.sentEvents.set(clientId, list);
  }
}

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
  /** `registerSessionService`'s own introspection surface — see `SessionService`'s doc comment (service.ts) for why it exists: verifying M1.7's disconnect cleanup through the real wire without reaching into private state. */
  service: SessionService;
}

/** Starts a server with the session service registered, a matching registry, and one connected+handshaked client. */
async function startHarness(options: { sessionFactory?: SessionFactory } = {}): Promise<Harness> {
  const address = uniqueAddress();
  const token = `tok-${randomUUID()}`;
  const registry = new Registry(
    options.sessionFactory !== undefined ? { sessionFactory: options.sessionFactory } : {},
  );
  const server = new TransportServer({ token, address });
  const service = registerSessionService(server, registry);
  cleanup.push(() => server.close());
  await server.listen();

  const addClient = async (): Promise<TransportClient> => {
    const extra = new TransportClient({ address, token });
    cleanup.push(() => extra.close());
    await extra.connect();
    return extra;
  };

  const client = await addClient();

  return { server, registry, client, addClient, service };
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
    'session.create spawns a real PTY, and (once attached, per M1.7) its prompt streams back as binary frames; ' +
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
      // Per M1.7's client contract (docs/specs/m1.7-attach-detach.md section
      // 3.4, documented on transport-client.ts): the data handler is
      // installed *before* calling session.attach, since the snapshot's
      // frame(s) arrive ahead of that RPC's response, on the same ordered
      // stream.
      client.onData((sid, data) => {
        if (sid === sessionId) {
          output += Buffer.from(data).toString('utf8');
        }
      });
      // Output is only delivered to attached clients as of M1.7 — a session
      // with nobody attached still runs (test 9 below covers that), but this
      // test wants to see the live stream.
      await client.request('session.attach', { sessionId });

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

  it('session.close kills the session and sends session.exit with the exact code to every client attached to it (M1.7: targeted, not broadcast)', async () => {
    const { factory } = fakeFactory();
    const { client: clientA, addClient } = await startHarness({ sessionFactory: factory });
    const clientB = await addClient();

    const created = await clientA.request<SessionCreateResult>(
      'session.create',
      baseCreateParams(),
    );
    const sessionId = created.session.id;

    // session.exit is delivered only to clients attached to this session as
    // of M1.7 (docs/specs/m1.7-attach-detach.md section 3.6) — both have to
    // attach first to still see it.
    await Promise.all([
      clientA.request('session.attach', { sessionId }),
      clientB.request('session.attach', { sessionId }),
    ]);

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

// ---------------------------------------------------------------------------
// M1.7 — session.attach / session.detach
//
// `docs/specs/m1.7-attach-detach.md` section 2 is explicit: the bug this
// spec exists to prevent only shows up when output arrives *during* the
// in-flight `buffer.serialize()` an attach triggers, and getting that to
// happen deterministically — not by racing real socket I/O and hoping the
// timing works out — requires calling `attachClient`/`wireSessionDelivery`
// directly (as plain, local, synchronous-until-their-first-real-await
// function calls) instead of through a real `TransportClient` request.
// Calling `attachClient(...)` without awaiting it yet, then synchronously
// calling `FakeSession#emitData` right after, is guaranteed (not just
// likely) to land "during" `TerminalBuffer.serialize()`'s own internal
// await: nothing in this process yields to the event loop between issuing
// the call and that follow-up `emitData`, so no other code — including
// xterm's own internal parser callback — can run in between. Tests 1-3
// below use this; tests 4-9 don't need that precision and go through the
// real client/server pipe like the rest of this file, matching how
// `session.attach` actually gets called in production.
// ---------------------------------------------------------------------------

describe('session.attach / session.detach (M1.7)', () => {
  const COLS = 24;
  const ROWS = 8;

  interface AttachBurstResult {
    transport: RecordingTransport;
    clientId: string;
    sessionId: SessionId;
    runtime: SessionRuntime;
    /** Every chunk emitted, in the exact order it was emitted — the ground truth tests 1/2 replay independently to compare against. */
    chunks: string[];
  }

  /**
   * Builds the exact scenario `docs/specs/m1.7-attach-detach.md`'s tests 1
   * and 2 require: one chunk written *before* `session.attach` (so it's
   * only ever reachable via the snapshot), one chunk that arrives strictly
   * *during* `buffer.serialize()`'s in-flight await (so it's only ever
   * reachable via the flushed `pending` queue), and one chunk written
   * *after* attach completes (a normal live chunk, proving the stream
   * actually continues afterward rather than the test stopping short).
   */
  async function runAttachDuringSerializeBurst(): Promise<AttachBurstResult> {
    const sessionId = 1 as SessionId;
    const clientId = 'client-A';
    const session = new FakeSession();
    const runtime: SessionRuntime = {
      buffer: new TerminalBuffer({ cols: COLS, rows: ROWS }),
      attached: new Map(),
    };
    const transport = new RecordingTransport();
    wireSessionDelivery(transport, sessionId, session, runtime);

    const chunks: string[] = [];
    const emit = (text: string): void => {
      chunks.push(text);
      session.emitData(text);
    };

    emit('MARK-A1\r\n'); // before attach — only reachable via the snapshot

    const attachPromise = attachClient(transport, sessionId, runtime, clientId);
    // Deterministic, not a race: see this describe block's header comment.
    emit('MARK-A2\r\n'); // during the in-flight serialize() — only reachable via pending

    await attachPromise;

    emit('MARK-A3\r\n'); // after attach — a normal live chunk

    return { transport, clientId, sessionId, runtime, chunks };
  }

  // -------------------------------------------------------------------------
  // Required test 1
  // -------------------------------------------------------------------------
  it('1. loses nothing: the client can reconstruct the exact same screen (snapshot + everything delivered after) as an independent terminal fed every chunk in original order, including output that arrived during the in-flight serialize()', async () => {
    const { transport, clientId, chunks, runtime } = await runAttachDuringSerializeBurst();

    const received = transport.sentData.get(clientId) ?? [];
    expect(received.length).toBeGreaterThan(0);

    const reconstructed = new Terminal({ cols: COLS, rows: ROWS, ...COMPARISON_OPTS });
    for (const frame of received) {
      await writeAndWait(reconstructed, frame.toString('utf8'));
    }

    const groundTruth = new Terminal({ cols: COLS, rows: ROWS, ...COMPARISON_OPTS });
    for (const chunk of chunks) {
      await writeAndWait(groundTruth, chunk);
    }

    expect(linesOf(reconstructed)).toEqual(linesOf(groundTruth));
    expect(reconstructed.buffer.active.cursorX).toBe(groundTruth.buffer.active.cursorX);
    expect(reconstructed.buffer.active.cursorY).toBe(groundTruth.buffer.active.cursorY);

    reconstructed.dispose();
    groundTruth.dispose();
    runtime.buffer.dispose();
  });

  // -------------------------------------------------------------------------
  // Required test 2
  // -------------------------------------------------------------------------
  it('2. duplicates nothing, in the same during-serialize() window: each unique marker is delivered exactly once', async () => {
    const { transport, clientId, runtime } = await runAttachDuringSerializeBurst();

    const received = transport.sentData.get(clientId) ?? [];
    const combined = Buffer.concat(received).toString('utf8');

    // Unique, trackable markers — not repeated text (repeated text would
    // hide a duplicate, per docs/specs/m1.7-attach-detach.md's own test 2
    // wording) — one for the pre-attach chunk (only in the snapshot), one
    // for the during-serialize() chunk (only in the flushed pending queue),
    // one for the post-attach chunk (a normal live send).
    for (const marker of ['MARK-A1', 'MARK-A2', 'MARK-A3']) {
      const occurrences = combined.split(marker).length - 1;
      expect(occurrences).toBe(1);
    }

    runtime.buffer.dispose();
  });

  // -------------------------------------------------------------------------
  // Required test 3 — the one that actually exercises the seq filter
  // -------------------------------------------------------------------------
  it("3. the seq filter is what prevents duplication, not the order attach's steps happen to run in: a chunk forced into both the snapshot's boundary and a pending queue is still sent exactly once", async () => {
    const sessionId = 1 as SessionId;
    const clientId = 'client-A';
    const session = new FakeSession();
    const runtime: SessionRuntime = {
      buffer: new TerminalBuffer({ cols: COLS, rows: ROWS }),
      attached: new Map(),
    };
    const transport = new RecordingTransport();
    wireSessionDelivery(transport, sessionId, session, runtime);

    session.emitData('BEFORE\r\n'); // buffer.sequence becomes 1

    const attachPromise = attachClient(transport, sessionId, runtime, clientId);

    // Plant the exact collision docs/specs/m1.7-attach-detach.md section 2
    // describes as possible ("um chunk que chegou nessa janela pode estar
    // dentro do snapshot e, ao mesmo tempo, dentro da fila de pendentes"):
    // a pending entry whose seq (1) is the SAME as the write BEFORE's
    // content got, i.e. already fully covered by the snapshot boundary
    // buffer.serialize() is about to return. A correct buffer.ts (see
    // buffer.test.ts) makes this impossible to produce "naturally" through
    // timing alone in this design, which is exactly why this test
    // constructs the collision directly instead of racing for it — the
    // point is to prove the *filter* discards it, not to prove it can
    // happen by accident.
    const state = runtime.attached.get(clientId);
    if (state === undefined || state.phase !== 'snapshotting') {
      throw new Error('test setup invariant broken: client should still be snapshotting here');
    }
    state.pending.push({ seq: 1, data: Buffer.from('BEFORE\r\n', 'utf8') });

    // A genuinely later chunk too, for contrast — this one legitimately
    // arrived after the boundary and must still be delivered once.
    session.emitData('AFTER\r\n');

    await attachPromise;

    const received = transport.sentData.get(clientId) ?? [];
    const combined = Buffer.concat(received).toString('utf8');
    // BEFORE reaches the client exactly once — via the snapshot only. If the
    // filter were skipped in favor of "whatever's in pending must be safe to
    // send, since attach registered before serialize() was called" (the
    // simplification the spec warns about), this would be 2.
    expect(combined.split('BEFORE').length - 1).toBe(1);
    expect(combined.split('AFTER').length - 1).toBe(1);

    runtime.buffer.dispose();
  });

  // -------------------------------------------------------------------------
  // Required test 4
  // -------------------------------------------------------------------------
  it('4. attach on a session with existing scrollback returns the history, and the live stream continues from where it left off', async () => {
    const { factory, sessions } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });
    const created = await client.request<SessionCreateResult>('session.create', baseCreateParams());
    const sessionId = created.session.id;
    const fake = sessions[0]!;

    fake.emitData('OLD-LINE-1\r\n');
    fake.emitData('OLD-LINE-2\r\n');

    let received = Buffer.alloc(0);
    client.onData((sid, data) => {
      if (sid === sessionId) {
        received = Buffer.concat([received, Buffer.from(data)]);
      }
    });
    await client.request('session.attach', { sessionId });

    const afterAttach = new Terminal({ cols: 80, rows: 24, ...COMPARISON_OPTS });
    await writeAndWait(afterAttach, received.toString('utf8'));
    expect(linesOf(afterAttach).join('\n')).toContain('OLD-LINE-1');
    expect(linesOf(afterAttach).join('\n')).toContain('OLD-LINE-2');
    afterAttach.dispose();

    fake.emitData('NEW-LINE\r\n');
    await waitFor(() => received.toString('utf8').includes('NEW-LINE'), 2_000);

    const final = new Terminal({ cols: 80, rows: 24, ...COMPARISON_OPTS });
    await writeAndWait(final, received.toString('utf8'));
    const text = linesOf(final).join('\n');
    expect(text).toContain('OLD-LINE-1');
    expect(text).toContain('OLD-LINE-2');
    expect(text).toContain('NEW-LINE');
    final.dispose();
  });

  // -------------------------------------------------------------------------
  // Required test 5
  // -------------------------------------------------------------------------
  it('5. two attached clients both receive output; detaching one does not affect the other', async () => {
    const { factory, sessions } = fakeFactory();
    const { client: clientA, addClient } = await startHarness({ sessionFactory: factory });
    const clientB = await addClient();

    const created = await clientA.request<SessionCreateResult>(
      'session.create',
      baseCreateParams(),
    );
    const sessionId = created.session.id;
    const fake = sessions[0]!;

    let receivedA = '';
    let receivedB = '';
    clientA.onData((sid, data) => {
      if (sid === sessionId) receivedA += Buffer.from(data).toString('utf8');
    });
    clientB.onData((sid, data) => {
      if (sid === sessionId) receivedB += Buffer.from(data).toString('utf8');
    });

    await Promise.all([
      clientA.request('session.attach', { sessionId }),
      clientB.request('session.attach', { sessionId }),
    ]);

    fake.emitData('BOTH\r\n');
    await waitFor(() => receivedA.includes('BOTH') && receivedB.includes('BOTH'), 2_000);

    await clientA.request('session.detach', { sessionId });

    fake.emitData('ONLY-B\r\n');
    await waitFor(() => receivedB.includes('ONLY-B'), 2_000);
    // Deterministic, not a timing gap: delivery for this chunk already ran
    // (synchronously, inside wireSessionDelivery's onData handler) by the
    // time B's receipt is confirmed above — A was already out of the
    // attached map when that single delivery pass happened, so there is no
    // later moment where a stray copy could still arrive.
    expect(receivedA).not.toContain('ONLY-B');
  });

  // -------------------------------------------------------------------------
  // Required test 6
  // -------------------------------------------------------------------------
  it('6a. a client whose connection drops without detach is actually removed from the attached list — proven through the real pipe, by inspecting state, not just by the server surviving — and a fresh client can still attach to the same session afterward', async () => {
    const { factory, sessions } = fakeFactory();
    const {
      server,
      client: clientA,
      addClient,
      service,
    } = await startHarness({
      sessionFactory: factory,
    });
    const clientB = await addClient();

    const created = await clientA.request<SessionCreateResult>(
      'session.create',
      baseCreateParams(),
    );
    const sessionId = created.session.id;
    const fake = sessions[0]!;

    let receivedA = '';
    clientA.onData((sid, data) => {
      if (sid === sessionId) receivedA += Buffer.from(data).toString('utf8');
    });

    await Promise.all([
      clientA.request('session.attach', { sessionId }),
      clientB.request('session.attach', { sessionId }),
    ]);
    expect(service.attachedCount(sessionId)).toBe(2);

    // B "crashes": its connection closes without ever calling
    // session.detach. This goes through the real production path —
    // TransportServer's own socket 'close' handling -> onConnectionClose
    // (transport-server.ts) -> detachClientEverywhere (service.ts) — not a
    // direct call into any M1.7 function from this test.
    await clientB.close();
    await waitFor(() => server.connectionCount === 1, 2_000);

    // The actual point of this test: B is gone from the attached *state*,
    // not just "the server didn't throw". attachedCount reads
    // SessionRuntime.attached directly (via SessionService, service.ts) —
    // this is state inspection, not a behavioral proxy for it.
    await waitFor(() => service.attachedCount(sessionId) === 1, 2_000);

    fake.emitData('AFTER-CRASH\r\n');
    await waitFor(() => receivedA.includes('AFTER-CRASH'), 2_000);

    // The server itself is unharmed and keeps answering requests...
    await expect(clientA.request<SessionListResult>('session.list', {})).resolves.toBeDefined();

    // ...and a brand new client can still attach to the same session: the
    // crash didn't leave the session, or this module's bookkeeping for it,
    // in a broken state.
    const clientC = await addClient();
    await clientC.request('session.attach', { sessionId });
    expect(service.attachedCount(sessionId)).toBe(2); // A and the new C — not B
  });

  it(
    "6b. detachClientEverywhere removes a client from every session's attached list " +
      '(the pure cleanup function on its own — 6a above proves production actually calls ' +
      'it when a connection drops; this proves the function itself is correct)',
    () => {
      const runtimeA: SessionRuntime = {
        buffer: new TerminalBuffer({ cols: 80, rows: 24 }),
        attached: new Map(),
      };
      const runtimeB: SessionRuntime = {
        buffer: new TerminalBuffer({ cols: 80, rows: 24 }),
        attached: new Map(),
      };
      runtimeA.attached.set('client-A', { phase: 'live' });
      runtimeA.attached.set('client-B', { phase: 'live' });
      runtimeB.attached.set('client-B', { phase: 'live' });

      detachClientEverywhere([runtimeA, runtimeB], 'client-B');

      expect(runtimeA.attached.has('client-B')).toBe(false);
      expect(runtimeB.attached.has('client-B')).toBe(false);
      expect(runtimeA.attached.has('client-A')).toBe(true); // untouched

      runtimeA.buffer.dispose();
      runtimeB.buffer.dispose();
    },
  );

  // -------------------------------------------------------------------------
  // Required test 7
  // -------------------------------------------------------------------------
  it('7. detach is idempotent: twice, or without ever having attached, is not an error', async () => {
    const { factory } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });
    const created = await client.request<SessionCreateResult>('session.create', baseCreateParams());
    const sessionId = created.session.id;

    // Never attached.
    await expect(client.request('session.detach', { sessionId })).resolves.toEqual({});

    await client.request('session.attach', { sessionId });
    await expect(client.request('session.detach', { sessionId })).resolves.toEqual({});
    // Twice.
    await expect(client.request('session.detach', { sessionId })).resolves.toEqual({});

    // Also true directly at the lower level.
    const runtime: SessionRuntime = {
      buffer: new TerminalBuffer({ cols: 80, rows: 24 }),
      attached: new Map(),
    };
    expect(() => detachClient(runtime, 'never-attached')).not.toThrow();
    runtime.buffer.dispose();
  });

  // -------------------------------------------------------------------------
  // Required test 8
  // -------------------------------------------------------------------------
  it('8. attach on an unknown sessionId rejects with a protocol error; the connection keeps working', async () => {
    const { factory } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });

    let caught: unknown;
    try {
      await client.request('session.attach', { sessionId: 987_654 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND);

    await expect(client.request<SessionListResult>('session.list', {})).resolves.toEqual({
      sessions: [],
    });
  });

  // -------------------------------------------------------------------------
  // Required test 9
  // -------------------------------------------------------------------------
  it('9. a session with nobody attached stays alive and keeps feeding its buffer; attaching later reveals everything produced in the meantime', async () => {
    const { factory, sessions } = fakeFactory();
    const { client } = await startHarness({ sessionFactory: factory });
    const created = await client.request<SessionCreateResult>('session.create', baseCreateParams());
    const sessionId = created.session.id;
    const fake = sessions[0]!;

    fake.emitData('UNSEEN-1\r\n');
    fake.emitData('UNSEEN-2\r\n');
    fake.emitData('UNSEEN-3\r\n');

    // Alive and tracked the whole time, with zero attached clients.
    const listed = await client.request<SessionListResult>('session.list', {});
    expect(listed.sessions.find((s) => s.id === sessionId)?.status).toBe('running');

    let received = Buffer.alloc(0);
    client.onData((sid, data) => {
      if (sid === sessionId) received = Buffer.concat([received, Buffer.from(data)]);
    });
    await client.request('session.attach', { sessionId });

    const target = new Terminal({ cols: 80, rows: 24, ...COMPARISON_OPTS });
    await writeAndWait(target, received.toString('utf8'));
    const text = linesOf(target).join('\n');
    expect(text).toContain('UNSEEN-1');
    expect(text).toContain('UNSEEN-2');
    expect(text).toContain('UNSEEN-3');
    target.dispose();
  });

  // -------------------------------------------------------------------------
  // Not one of section 5's numbered 10, but explicitly specified in section 4
  // ("Anexar duas vezes à mesma sessão pelo mesmo cliente -> a segunda
  // chamada é no-op que responde sucesso, sem reenviar snapshot"): cheap
  // enough to verify directly given RecordingTransport is already at hand.
  // -------------------------------------------------------------------------
  it('bonus (section 4): attaching twice as the same client is a no-op that does not re-send the snapshot', async () => {
    const sessionId = 1 as SessionId;
    const clientId = 'client-A';
    const session = new FakeSession();
    const runtime: SessionRuntime = {
      buffer: new TerminalBuffer({ cols: COLS, rows: ROWS }),
      attached: new Map(),
    };
    const transport = new RecordingTransport();
    wireSessionDelivery(transport, sessionId, session, runtime);

    session.emitData('ONCE\r\n');

    await attachClient(transport, sessionId, runtime, clientId);
    const sentAfterFirstAttach = (transport.sentData.get(clientId) ?? []).length;
    expect(sentAfterFirstAttach).toBeGreaterThan(0); // the snapshot did go out

    await attachClient(transport, sessionId, runtime, clientId);
    const sentAfterSecondAttach = (transport.sentData.get(clientId) ?? []).length;
    expect(sentAfterSecondAttach).toBe(sentAfterFirstAttach); // nothing new was sent

    const state = runtime.attached.get(clientId);
    expect(state).toEqual({ phase: 'live' });

    runtime.buffer.dispose();
  });
});
