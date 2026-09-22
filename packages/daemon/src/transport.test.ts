import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import {
  FRAME_TYPE,
  FrameDecoder,
  PROTOCOL_ERROR_CODE,
  PROTOCOL_VERSION,
  ProtocolError,
  encodeControlFrame,
} from '@termhub/shared';
import type { HandshakeMessage, ProtocolErrorCode } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePipeAddress } from './transport-address.js';
import { TransportClient } from './transport-client.js';
import { TransportServer } from './transport-server.js';

// Real client<->server integration tests over a real named pipe (unix
// socket off Windows) — no mocked `net`. Each test gets its own address
// (see `uniqueAddress` below) so tests in this file never collide with each
// other, with a parallel vitest worker running this same file, or with an
// actual termhub-daemon that happens to be running on the machine.
//
// Every server/client opened in a test is registered with `cleanup` and
// torn down in `afterEach`, even if the test's own assertions throw partway
// through — a leaked pipe server is exactly the kind of thing that hangs
// `vitest run` at the very end of the suite instead of failing the one test
// that leaked it.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function uniqueAddress(): string {
  return resolvePipeAddress({ suffix: `transport-test-${randomUUID()}` });
}

let cleanup: Array<() => Promise<void> | void>;

beforeEach(() => {
  cleanup = [];
});

afterEach(async () => {
  // Reverse order (last opened, first closed) and best-effort: one
  // teardown failing must not stop the rest from running, or a single bad
  // test would start leaking handles into every test after it.
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
  intervalMs = 10,
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

/** Awaits `promise`, asserts it rejected with a `ProtocolError` carrying `code`, and returns that error for further assertions (e.g. on `.message`). */
async function expectProtocolErrorRejection(
  promise: Promise<unknown>,
  code: ProtocolErrorCode,
): Promise<ProtocolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof ProtocolError)) {
    throw new Error(`expected a ProtocolError, got ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  return caught;
}

function startServer(overrides: {
  token: string;
  address?: string;
  protocolVersion?: number;
  handshakeTimeoutMs?: number;
}): TransportServer {
  const server = new TransportServer({
    token: overrides.token,
    address: overrides.address ?? uniqueAddress(),
    ...(overrides.protocolVersion !== undefined
      ? { protocolVersion: overrides.protocolVersion }
      : {}),
    ...(overrides.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: overrides.handshakeTimeoutMs }
      : {}),
  });
  cleanup.push(() => server.close());
  return server;
}

function makeClient(overrides: {
  address: string;
  token: string;
  protocolVersion?: number;
  handshakeTimeoutMs?: number;
}): TransportClient {
  const client = new TransportClient({
    address: overrides.address,
    token: overrides.token,
    ...(overrides.protocolVersion !== undefined
      ? { protocolVersion: overrides.protocolVersion }
      : {}),
    ...(overrides.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: overrides.handshakeTimeoutMs }
      : {}),
  });
  cleanup.push(() => client.close());
  return client;
}

// ---------------------------------------------------------------------------
// 1. Multiple simultaneous clients, one registered method serving both
// ---------------------------------------------------------------------------

describe('TransportServer + TransportClient', () => {
  it('serves a registered method (ping -> pong) to two simultaneously-connected clients', async () => {
    const address = uniqueAddress();
    const token = 'shared-secret-1';
    const server = startServer({ token, address });
    server.registerMethod<{ echo?: unknown }, { pong: true; echo?: unknown }>('ping', (params) => ({
      pong: true,
      ...(params.echo !== undefined ? { echo: params.echo } : {}),
    }));
    await server.listen();

    const clientA = makeClient({ address, token });
    const clientB = makeClient({ address, token });
    await Promise.all([clientA.connect(), clientB.connect()]);

    expect(server.connectionCount).toBe(2);
    expect(clientA.isReady).toBe(true);
    expect(clientB.isReady).toBe(true);

    const [resultA, resultB] = await Promise.all([
      clientA.request<{ pong: true; echo?: unknown }>('ping', { echo: 'a' }),
      clientB.request<{ pong: true; echo?: unknown }>('ping', { echo: 'b' }),
    ]);
    expect(resultA).toEqual({ pong: true, echo: 'a' });
    expect(resultB).toEqual({ pong: true, echo: 'b' });
  });

  // ---------------------------------------------------------------------------
  // 2. Wrong token drops the connection; the right token passes
  // ---------------------------------------------------------------------------

  it('drops a connection whose handshake token is wrong, and accepts one whose token is right', async () => {
    const server = startServer({ token: 'correct-token' });
    server.registerMethod('ping', () => 'pong');
    await server.listen();

    const wrongTokenClient = makeClient({ address: server.pipeAddress, token: 'totally-wrong' });
    const err = await expectProtocolErrorRejection(
      wrongTokenClient.connect(),
      PROTOCOL_ERROR_CODE.UNAUTHORIZED,
    );
    expect(err.message.length).toBeGreaterThan(0);
    expect(wrongTokenClient.isReady).toBe(false);

    const rightTokenClient = makeClient({ address: server.pipeAddress, token: 'correct-token' });
    await rightTokenClient.connect();
    expect(rightTokenClient.isReady).toBe(true);
    await expect(rightTokenClient.request('ping')).resolves.toBe('pong');
  });

  // ---------------------------------------------------------------------------
  // 3. Incompatible protocol version drops the connection
  // ---------------------------------------------------------------------------

  it('drops a connection whose declared protocol version does not match the server', async () => {
    const server = startServer({ token: 'tok-3' });
    await server.listen();

    const mismatchedClient = makeClient({
      address: server.pipeAddress,
      token: 'tok-3',
      protocolVersion: PROTOCOL_VERSION + 999,
    });
    const err = await expectProtocolErrorRejection(
      mismatchedClient.connect(),
      PROTOCOL_ERROR_CODE.VERSION_MISMATCH,
    );
    // "com erro que diga o que é esperado" — the message names both the
    // version the server wanted and the one it got.
    expect(err.message).toContain(String(PROTOCOL_VERSION));
    expect(err.message).toContain(String(PROTOCOL_VERSION + 999));
  });

  // ---------------------------------------------------------------------------
  // 4. A connection that never sends a handshake is dropped after the timeout
  // ---------------------------------------------------------------------------

  it('drops a connection that never sends a handshake within the configured timeout', async () => {
    const server = startServer({ token: 'tok-4', handshakeTimeoutMs: 150 });
    await server.listen();

    const silent: Socket = connect(server.pipeAddress);
    cleanup.push(() => {
      silent.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      silent.once('connect', resolve);
      silent.once('error', reject);
    });

    // The client's own 'connect' event and the server's connection-accepted
    // callback fire from independent event-loop turns, so poll rather than
    // asserting immediately — this is bookkeeping-race tolerance, not a
    // relaxation of what's being proven below.
    await waitFor(() => server.connectionCount === 1, 2_000);

    const closed = new Promise<void>((resolve) => {
      silent.once('close', resolve);
    });
    // Deliberately send nothing at all.
    await closed;

    await waitFor(() => server.connectionCount === 0, 2_000);
  }, 10_000);

  // ---------------------------------------------------------------------------
  // 5. Concurrency: interleaved requests whose handlers resolve out of order
  //    must still each reach the caller that sent them (the classic
  //    correlation bug this layer exists to avoid).
  // ---------------------------------------------------------------------------

  it('correlates concurrent, interleaved requests by id even when handlers resolve out of send order', async () => {
    const server = startServer({ token: 'tok-5' });
    server.registerMethod<{ id: number; delayMs: number }, { id: number }>(
      'echo-after-delay',
      (params) =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ id: params.id }), params.delayMs);
        }),
    );
    await server.listen();

    const client = makeClient({ address: server.pipeAddress, token: 'tok-5' });
    await client.connect();

    const total = 12;
    const resolutionOrder: number[] = [];
    // Request 0 is told to take the *longest*, request `total - 1` the
    // *shortest* — all `total` requests are fired in the same tick, fully
    // interleaved on the wire, and (because of the delays) the server's
    // handlers resolve in the *reverse* of send order. If responses were
    // ever matched by arrival/send order instead of by their own `id`, this
    // is exactly the shape of bug that would silently hand caller N the
    // result meant for a different caller.
    const requests = Array.from({ length: total }, (_, i) => {
      const delayMs = (total - i) * 15;
      return client
        .request<{ id: number }>('echo-after-delay', { id: i, delayMs })
        .then((result) => {
          resolutionOrder.push(result.id);
          return result;
        });
    });

    const results = await Promise.all(requests);

    results.forEach((result, i) => {
      expect(result.id).toBe(i);
    });
    // Confirms this test actually exercised out-of-order resolution, not
    // just out-of-order-by-coincidence-that-happens-to-match send order.
    expect(resolutionOrder[0]).toBe(total - 1);
    expect(resolutionOrder).not.toEqual(
      results
        .map((r) => r.id)
        .slice()
        .sort((a, b) => a - b),
    );
  }, 10_000);

  // ---------------------------------------------------------------------------
  // 6. A malformed frame drops only its own connection
  // ---------------------------------------------------------------------------

  it('drops only the connection that sent a malformed frame; the server and other clients keep working', async () => {
    const server = startServer({ token: 'tok-6' });
    server.registerMethod('ping', () => 'pong');
    await server.listen();

    const good = makeClient({ address: server.pipeAddress, token: 'tok-6' });
    await good.connect();
    await expect(good.request('ping')).resolves.toBe('pong');

    // Hand-rolled connection (bypassing TransportClient) so the test can
    // inject bytes FrameDecoder is guaranteed to reject, *after* a normal
    // handshake — proving isolation holds mid-session, not just during the
    // handshake phase.
    const bad: Socket = connect(server.pipeAddress);
    cleanup.push(() => {
      bad.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      bad.once('connect', resolve);
      bad.once('error', reject);
    });

    const decoder = new FrameDecoder();
    const ackReceived = new Promise<void>((resolve) => {
      bad.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === FRAME_TYPE.CONTROL && frame.message.kind === 'handshake-ack') {
            resolve();
          }
        }
      });
    });
    const handshake: HandshakeMessage = {
      kind: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-6',
    };
    bad.write(encodeControlFrame(handshake));
    await ackReceived;

    expect(server.connectionCount).toBe(2);

    const badClosed = new Promise<void>((resolve) => {
      bad.once('close', resolve);
    });
    // [uint32 length = 1][uint8 type = 99]: length is valid, but 99 is
    // neither FRAME_TYPE.CONTROL (0) nor FRAME_TYPE.DATA (1) — FrameDecoder
    // throws ProtocolError(INVALID_FRAME) on this, which per protocol.ts's
    // documented contract leaves that connection's decoder unusable.
    bad.write(Buffer.from([0, 0, 0, 1, 99]));
    await badClosed;

    await waitFor(() => server.connectionCount === 1, 2_000);
    expect(server.connectionCount).toBe(1);

    // The connection that was already open before the bad frame keeps
    // working...
    await expect(good.request('ping')).resolves.toBe('pong');

    // ...and the server is still accepting brand-new connections.
    const other = makeClient({ address: server.pipeAddress, token: 'tok-6' });
    await other.connect();
    await expect(other.request('ping')).resolves.toBe('pong');
  }, 10_000);

  // ---------------------------------------------------------------------------
  // 7. Binary broadcast integrity, byte-for-byte, including 0x00 bytes —
  //    and large enough to force the backpressure/drain path in
  //    transport-socket.ts to actually run, not just the single-write
  //    happy path.
  // ---------------------------------------------------------------------------

  it('broadcasts a binary data frame to every ready client byte-for-byte, including 0x00 bytes, under backpressure', async () => {
    const server = startServer({ token: 'tok-7' });
    await server.listen();

    const clientA = makeClient({ address: server.pipeAddress, token: 'tok-7' });
    const clientB = makeClient({ address: server.pipeAddress, token: 'tok-7' });
    await Promise.all([clientA.connect(), clientB.connect()]);

    // 1 MiB: comfortably past Node's default 16KB Writable highWaterMark,
    // so `socket.write()` is guaranteed to return `false` at least once
    // here — this is the `FramedSocket` queue-and-flush-on-'drain' path,
    // not the "one write, always succeeds" case.
    const size = 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
      payload[i] = i % 256; // 0x00 recurs every 256 bytes, among every other byte value
    }
    const sessionId = 4242;

    const receivedA = new Promise<{ sessionId: number; data: Uint8Array }>((resolve) => {
      clientA.onData((sid, data) => resolve({ sessionId: sid, data }));
    });
    const receivedB = new Promise<{ sessionId: number; data: Uint8Array }>((resolve) => {
      clientB.onData((sid, data) => resolve({ sessionId: sid, data }));
    });

    server.broadcastData(sessionId, payload);

    const [a, b] = await Promise.all([receivedA, receivedB]);
    expect(a.sessionId).toBe(sessionId);
    expect(b.sessionId).toBe(sessionId);
    // `Buffer.compare` (a native byte-for-byte comparison) rather than
    // `expect(...).toEqual(payload)`: vitest's deep-equality walks a
    // 1-MiB typed array element by element through generic assertion
    // machinery, which turned this single comparison into several
    // *seconds* of test time (measured directly — the actual pipe
    // round-trip for both clients finishes in under 10ms). `Buffer.compare`
    // proves the identical thing — every byte matches, including the 0x00
    // ones — without that cost.
    expect(Buffer.compare(Buffer.from(a.data), payload)).toBe(0);
    expect(Buffer.compare(Buffer.from(b.data), payload)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Extra coverage beyond the acceptance list, cheap enough to be worth
  // having: unregistered methods, handler failures, and broadcastEvent.
  // ---------------------------------------------------------------------------

  it('rejects a request for an unregistered method with UNKNOWN_METHOD', async () => {
    const server = startServer({ token: 'tok-8' });
    await server.listen();
    const client = makeClient({ address: server.pipeAddress, token: 'tok-8' });
    await client.connect();

    await expectProtocolErrorRejection(
      client.request('does.not.exist'),
      PROTOCOL_ERROR_CODE.UNKNOWN_METHOD,
    );
  });

  it("wraps a handler's thrown error as an INTERNAL_ERROR response instead of crashing the connection", async () => {
    const server = startServer({ token: 'tok-9' });
    server.registerMethod('boom', () => {
      throw new Error('handler exploded');
    });
    await server.listen();
    const client = makeClient({ address: server.pipeAddress, token: 'tok-9' });
    await client.connect();

    const err = await expectProtocolErrorRejection(
      client.request('boom'),
      PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
    );
    expect(err.message).toContain('handler exploded');
    // The connection itself must survive a handler throwing.
    server.registerMethod('ping', () => 'pong');
    await expect(client.request('ping')).resolves.toBe('pong');
  });

  it('broadcasts a JSON control event to every ready client', async () => {
    const server = startServer({ token: 'tok-10' });
    await server.listen();
    const client = makeClient({ address: server.pipeAddress, token: 'tok-10' });
    await client.connect();

    const received = new Promise<{ event: string; payload: unknown }>((resolve) => {
      client.onEvent((msg) => resolve(msg));
    });
    server.broadcastEvent('session.status', { sessionId: 1, status: 'running', since: 123 });

    const msg = await received;
    expect(msg.event).toBe('session.status');
    expect(msg.payload).toEqual({ sessionId: 1, status: 'running', since: 123 });
  });

  it('rejects registering the same method twice', () => {
    const server = startServer({ token: 'tok-11' });
    server.registerMethod('ping', () => 'pong');
    expect(() => server.registerMethod('ping', () => 'pong again')).toThrow(ProtocolError);
  });
});
