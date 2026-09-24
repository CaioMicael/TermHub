import { randomUUID } from 'node:crypto';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { DaemonRelay } from './daemon-relay.js';
import type { RelayOutboundMessage } from './ipc-contract.js';

// Unit-level tests for `DaemonRelay` in isolation, against a real
// `TransportServer`/`TransportClient` pair (never a mocked `net` — same
// convention `transport.test.ts`/`daemon-client.test.ts` already use) but
// without the gateway/bridge layers above it. `daemon-relay.integration.
// test.ts` covers the full pipeline (real transport -> this relay -> fake
// IPC -> the real preload bridge); this file is the fast, focused half:
// coalescing itself, the byte-limit early flush, the method allowlist, and
// the dispose-with-pending-data guarantee (armadilha 5).

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `daemon-relay-test-${label}-${randomUUID()}` });
}

let cleanup: Array<() => Promise<void> | void>;

beforeEach(() => {
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
});

async function startServerAndClient(
  label: string,
): Promise<{ server: TransportServer; client: TransportClient }> {
  const token = randomUUID();
  const address = uniqueAddress(label);
  const server = new TransportServer({ token, address });
  await server.listen();
  cleanup.push(() => server.close());

  const client = new TransportClient({ address, token, handshakeTimeoutMs: 1000 });
  await client.connect();
  cleanup.push(() => client.close());

  return { server, client };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DaemonRelay', () => {
  it('sendData() forwards to the daemon immediately — no coalescing, no artificial delay', async () => {
    const { server, client } = await startServerAndClient('send-data-immediate');
    const received: Array<{ sessionId: number; data: Uint8Array; at: number }> = [];
    const start = Date.now();
    server.registerDataHandler((sessionId, data) => {
      received.push({ sessionId, data, at: Date.now() - start });
    });

    const relay = new DaemonRelay({ client, sendToRenderer: () => {} });
    cleanup.push(() => relay.dispose());

    relay.sendData(1, new Uint8Array([104, 105]));
    // Well under the 8ms coalescing window this class applies to the
    // *opposite* (daemon -> renderer) direction — proving this path never
    // goes anywhere near that timer.
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 200 });
    expect(received[0]?.at).toBeLessThan(50);
    expect(Array.from(received[0]?.data ?? [])).toEqual([104, 105]);
  });

  it('coalesces several data chunks for one session into a single outbound message once the window closes', async () => {
    const { server, client } = await startServerAndClient('coalesce-window');
    const outbound: RelayOutboundMessage[] = [];
    const relay = new DaemonRelay({
      client,
      sendToRenderer: (message) => outbound.push(message),
      coalesceWindowMs: 30,
    });
    cleanup.push(() => relay.dispose());

    for (let i = 0; i < 20; i += 1) {
      server.broadcastData(1, new Uint8Array([i]));
    }

    // Nothing yet — still inside the window.
    await sleep(10);
    expect(outbound.filter((m) => m.kind === 'data')).toHaveLength(0);

    await sleep(40);
    const dataMessages = outbound.filter((m) => m.kind === 'data');
    expect(dataMessages).toHaveLength(1);
    const only = dataMessages[0];
    if (only === undefined || only.kind !== 'data') {
      throw new Error('expected one data message');
    }
    expect(Array.from(only.data)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('an optional byte limit flushes a session early, before the rest of the window elapses', async () => {
    const { server, client } = await startServerAndClient('coalesce-byte-limit');
    const outbound: RelayOutboundMessage[] = [];
    const start = Date.now();
    const timestamps: number[] = [];
    const relay = new DaemonRelay({
      client,
      sendToRenderer: (message) => {
        outbound.push(message);
        if (message.kind === 'data') {
          timestamps.push(Date.now() - start);
        }
      },
      coalesceWindowMs: 500,
      coalesceByteLimitBytes: 8,
    });
    cleanup.push(() => relay.dispose());

    server.broadcastData(1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    await vi.waitFor(() => expect(outbound.filter((m) => m.kind === 'data')).toHaveLength(1), {
      timeout: 200,
    });
    // Flushed almost immediately, nowhere near the 500ms window.
    expect(timestamps[0]).toBeLessThan(200);
  });

  it('handleRequest(): a method outside the allowlist is rejected without ever reaching the daemon', async () => {
    const { server, client } = await startServerAndClient('allowlist-rejection');
    const evilHandler = vi.fn(() => ({}));
    server.registerMethod('evil.method', evilHandler);

    const outbound: RelayOutboundMessage[] = [];
    const relay = new DaemonRelay({ client, sendToRenderer: (message) => outbound.push(message) });
    cleanup.push(() => relay.dispose());

    await relay.handleRequest({ kind: 'request', id: 'r1', method: 'evil.method', params: {} });

    expect(evilHandler).not.toHaveBeenCalled();
    expect(outbound).toEqual([
      {
        kind: 'response',
        id: 'r1',
        outcome: {
          ok: false,
          error: {
            code: 'bridge_rejected_method',
            message: 'method "evil.method" is not a recognized request method',
          },
        },
      },
    ]);
  });

  it('handleRequest(): a ProtocolError from the daemon is reported with its code and details intact', async () => {
    const { server, client } = await startServerAndClient('protocol-error-mapping');
    server.registerMethod('session.attach', () => {
      throw new ProtocolError(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND, 'session 42 not found', {
        sessionId: 42,
      });
    });

    const outbound: RelayOutboundMessage[] = [];
    const relay = new DaemonRelay({ client, sendToRenderer: (message) => outbound.push(message) });
    cleanup.push(() => relay.dispose());

    await relay.handleRequest({
      kind: 'request',
      id: 'r1',
      method: 'session.attach',
      params: { sessionId: 42 },
    });

    expect(outbound).toEqual([
      {
        kind: 'response',
        id: 'r1',
        outcome: {
          ok: false,
          error: {
            code: 'session_not_found',
            message: 'session 42 not found',
            details: { sessionId: 42 },
          },
        },
      },
    ]);
  });

  it('dispose(): with data pending in the coalescer, nothing is sent afterward and no timer is left running', async () => {
    // Connection setup uses real timers (TransportClient.connect() relies
    // on real socket I/O interleaved with a real handshake-timeout timer);
    // fake timers are switched on only for the part of this test that
    // actually needs to observe/advance DaemonRelay's own setTimeout.
    const { client, server } = await startServerAndClient('dispose-pending-data');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const outbound: RelayOutboundMessage[] = [];
      const relay = new DaemonRelay({
        client,
        sendToRenderer: (message) => outbound.push(message),
        coalesceWindowMs: 8,
      });

      // A real frame, over the real (already-connected) socket — delivery
      // is driven by libuv's own I/O callbacks, not by `setTimeout`, so it
      // still arrives normally while `setTimeout`/`clearTimeout` are faked.
      // A second, independent `onData` subscription (the public API —
      // `TransportClient.onData` supports any number of listeners) is used
      // only to learn *when* that delivery has happened and, with it, that
      // `DaemonRelay`'s own listener (registered first, in its constructor)
      // has already run synchronously in the same frame-dispatch call.
      const arrived = new Promise<void>((resolve) => {
        const subscription = client.onData(() => {
          subscription.dispose();
          resolve();
        });
      });
      server.broadcastData(1, new Uint8Array([1, 2, 3]));
      await arrived;

      expect(vi.getTimerCount()).toBeGreaterThan(0);

      relay.dispose();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(outbound).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
