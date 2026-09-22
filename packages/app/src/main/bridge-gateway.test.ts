import { randomUUID } from 'node:crypto';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { BridgeGateway } from './bridge-gateway.js';
import type { DaemonConnection, DaemonInfo } from './daemon-client.js';
import type { RelayOutboundMessage } from './ipc-contract.js';

// `BridgeGateway` is deliberately electron-free (see its own header comment)
// so these tests construct `DaemonConnection` values by hand — exactly the
// shape `daemon-client.ts`'s `connectToDaemon()` would produce — instead of
// going through that function's own retry/backoff machinery (already
// covered by daemon-client.test.ts). 'connected' scenarios use a real
// TransportServer/TransportClient pair (same real-integration style as the
// rest of this repo's transport tests) so the `onClose` wiring this file
// depends on is exercised for real.

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `bridge-gateway-test-${label}-${randomUUID()}` });
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
      // best-effort — one leaked handle's teardown throwing must not stop
      // the others from tearing down too.
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

  server.registerMethod('session.list', () => ({ sessions: [] }));

  const client = new TransportClient({ address, token, handshakeTimeoutMs: 1000 });
  await client.connect();
  cleanup.push(() => client.close());

  return { server, client };
}

function collectOutbound(): {
  sink: (message: RelayOutboundMessage) => void;
  messages: RelayOutboundMessage[];
} {
  const messages: RelayOutboundMessage[] = [];
  return { sink: (message) => messages.push(message), messages };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('BridgeGateway', () => {
  it('starts in "connecting" and moves to "connected" once the connection resolves', async () => {
    const { client } = await startServerAndClient('connecting-to-connected');
    const { promise, resolve } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();

    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise: promise });
    cleanup.push(() => gateway.dispose());

    expect(messages).toEqual([{ kind: 'state', state: 'connecting' }]);

    resolve({ outcome: 'connected', client, info: fakeInfo() });
    await flushMicrotasks();

    expect(messages).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'connected' },
    ]);
  });

  it('a request made before the connection resolves is rejected immediately with bridge_not_connected, never queued', () => {
    const { promise } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise: promise });
    cleanup.push(() => gateway.dispose());

    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r1',
      method: 'session.list',
      params: {},
    });

    const response = messages.find((m) => m.kind === 'response');
    expect(response).toEqual({
      kind: 'response',
      id: 'r1',
      outcome: {
        ok: false,
        error: {
          code: 'bridge_not_connected',
          message: 'cannot perform request "session.list": daemon connection is "connecting"',
        },
      },
    });
    // No later "it got queued" response should ever show up — that's the
    // whole point of rejecting instead of queueing; nothing more to await.
  });

  it('"blocked" outcome: state carries the reason, and requests are rejected', async () => {
    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'blocked',
      reason: 'zombie',
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    await flushMicrotasks();
    expect(messages).toContainEqual({ kind: 'state', state: 'blocked', reason: 'zombie' });

    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r1',
      method: 'session.list',
      params: {},
    });
    const response = messages.find((m) => m.kind === 'response');
    expect(response).toEqual({
      kind: 'response',
      id: 'r1',
      outcome: {
        ok: false,
        error: {
          code: 'bridge_not_connected',
          message: 'cannot perform request "session.list": daemon connection is "blocked" (zombie)',
        },
      },
    });
  });

  it('"failed" outcome: state carries the last error\'s message', async () => {
    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'failed',
      attempts: 5,
      lastError: new Error('no daemon.json found'),
      daemonPath: 'C:/fake/daemon.json',
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    await flushMicrotasks();
    expect(messages).toContainEqual({
      kind: 'state',
      state: 'failed',
      reason: 'no daemon.json found',
    });
  });

  it('once connected, requests are forwarded to the real daemon and resolved', async () => {
    const { client } = await startServerAndClient('forward-request');
    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    await flushMicrotasks();
    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r1',
      method: 'session.list',
      params: {},
    });

    // `handleRendererMessage` is fire-and-forget (mirrors real IPC's `send`,
    // which has no return value) and the request it triggers is a real
    // socket round trip, so this polls instead of assuming one macrotask
    // is enough.
    await vi.waitFor(() => expect(messages.some((m) => m.kind === 'response')).toBe(true), {
      timeout: 2000,
    });
    const response = messages.find((m) => m.kind === 'response');
    expect(response).toEqual({
      kind: 'response',
      id: 'r1',
      outcome: { ok: true, result: { sessions: [] } },
    });
  });

  it('the TransportClient closing transitions state to "disconnected", and further requests are rejected', async () => {
    const { client } = await startServerAndClient('client-closes');
    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    await flushMicrotasks();
    expect(messages).toContainEqual({ kind: 'state', state: 'connected' });

    // Simulates the daemon connection dropping out from under an already-
    // 'connected' bridge (a real client-side close, not a server-initiated
    // kill — this repo never kills the daemon, see docs/specs/
    // m2.1-daemon-client.md section 2).
    await client.close();
    await flushMicrotasks();

    expect(messages).toContainEqual({ kind: 'state', state: 'disconnected' });

    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r2',
      method: 'session.list',
      params: {},
    });
    const response = messages.filter((m) => m.kind === 'response').at(-1);
    expect(response).toEqual({
      kind: 'response',
      id: 'r2',
      outcome: {
        ok: false,
        error: {
          code: 'bridge_not_connected',
          message: 'cannot perform request "session.list": daemon connection is "disconnected"',
        },
      },
    });
  });

  it('dispose() before the connection resolves suppresses the eventual state message', async () => {
    const { promise, resolve } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise: promise });

    gateway.dispose();
    resolve({ outcome: 'blocked', reason: 'zombie', info: fakeInfo() });
    await flushMicrotasks();

    expect(messages).toEqual([{ kind: 'state', state: 'connecting' }]);
  });

  it('dispose() while connected tears down the relay but leaves the TransportClient open (armadilha 5 / never kill the daemon)', async () => {
    const { client } = await startServerAndClient('dispose-leaves-client-open');
    const { sink } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });

    await flushMicrotasks();
    gateway.dispose();

    expect(client.isReady).toBe(true);
  });

  it("reports a ProtocolError's code intact in the response envelope", async () => {
    const token = randomUUID();
    const address = uniqueAddress('protocol-error-code');
    const server = new TransportServer({ token, address });
    await server.listen();
    cleanup.push(() => server.close());
    server.registerMethod('session.attach', () => {
      throw new ProtocolError(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND, 'session 42 not found');
    });
    const client = new TransportClient({ address, token, handshakeTimeoutMs: 1000 });
    await client.connect();
    cleanup.push(() => client.close());

    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    await flushMicrotasks();
    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r1',
      method: 'session.attach',
      params: { sessionId: 42 },
    });

    await vi.waitFor(() => expect(messages.some((m) => m.kind === 'response')).toBe(true), {
      timeout: 2000,
    });
    const response = messages.find((m) => m.kind === 'response');
    expect(response).toEqual({
      kind: 'response',
      id: 'r1',
      outcome: { ok: false, error: { code: 'session_not_found', message: 'session 42 not found' } },
    });
  });
});

function fakeInfo(): DaemonInfo {
  return {
    pid: 12345,
    pipe: 'fake-pipe',
    token: 'fake-token',
    protocolVersion: 1,
    startedAt: new Date().toISOString(),
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
