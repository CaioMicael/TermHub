import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionAttachResult, SessionId } from '@termhub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { BridgeGateway, wireWebContentsLifecycle } from './bridge-gateway.js';
import type { DaemonConnection, DaemonInfo } from './daemon-client.js';
import type { RelayOutboundMessage } from './ipc-contract.js';
import { SessionAttachments } from './session-attachments.js';

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
    // 'session.resize', not 'session.attach': as of M2.6, 'session.attach'/
    // 'session.detach' from the renderer no longer reach DaemonRelay at all
    // — BridgeGateway routes them to SessionAttachments instead (docs/specs/
    // m2.6-boot-reattach.md section 3.2). This test is about DaemonRelay's
    // generic ProtocolError-forwarding, still exercised the same way by any
    // other allowlisted method.
    server.registerMethod('session.resize', () => {
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
      method: 'session.resize',
      params: { sessionId: 42, cols: 80, rows: 24 },
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

// ---------------------------------------------------------------------------
// M2.6 required tests 3, 4, 5 (docs/specs/m2.6-boot-reattach.md section 5,
// parte A) — renderer-instance handshake and lifecycle, at the `BridgeGateway`
// level. Required tests 1, 2, 6, 7 live elsewhere: 1 in
// packages/daemon/src/service.test.ts (the daemon-side fix), 7 in
// session-attachments.test.ts (the book's own rejection path), 2 and 6 in
// boot-reattach.integration.test.ts (the full real-daemon pipeline).
// ---------------------------------------------------------------------------

describe('BridgeGateway — M2.6 renderer instances', () => {
  it('required test 3: state is pulled on hello — a second hello (reload) gets the same state again, with no separate transition push in between', async () => {
    const { client } = await startServerAndClient('pulled-state');
    const { sink, messages } = collectOutbound();
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise });
    cleanup.push(() => gateway.dispose());

    // The connection settles ('connected' pushed) before any renderer is
    // even listening — docs/specs/m2.6-boot-reattach.md's defect 2.4: a
    // push made before the preload's own `ipc.on` is registered has no
    // listener. Clearing `messages` here simulates a renderer that starts
    // paying attention only from its own `hello` onward.
    await flushMicrotasks();
    messages.length = 0;

    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-1' });
    expect(messages).toEqual([{ kind: 'state', state: 'connected' }]);

    // A second `hello` (the reload) also gets 'connected' — the connection
    // itself never changed, so there is no separate transition to observe
    // in between; the *answer* to hello is what carries the state.
    messages.length = 0;
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-2' });
    expect(messages).toEqual([{ kind: 'state', state: 'connected' }]);
  });

  it("required test 4: a stale response from instance 1 never resolves instance 2's request sharing the same numbered id (docs/specs/m2.6-boot-reattach.md section 2.5)", async () => {
    const token = randomUUID();
    const address = uniqueAddress('id-collision');
    const server = new TransportServer({ token, address });
    await server.listen();
    cleanup.push(() => server.close());
    const held: Array<(value: unknown) => void> = [];
    server.registerMethod('session.list', () => new Promise((resolve) => held.push(resolve)));
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

    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-1' });
    // Instance 1's request — id 'bridge-req-1', matching what `preload/
    // bridge.ts`'s own per-page counter would generate for its first call —
    // stays in flight (the daemon hasn't answered it yet).
    gateway.handleRendererMessage({
      kind: 'request',
      id: 'bridge-req-1',
      instanceId: 'instance-1',
      method: 'session.list',
      params: {},
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));

    // The reload: instance 2 arrives (superseding instance 1) and its own
    // preload's counter also starts at 1 — the exact same wire id.
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-2' });
    gateway.handleRendererMessage({
      kind: 'request',
      id: 'bridge-req-1',
      instanceId: 'instance-2',
      method: 'session.list',
      params: {},
    });
    await vi.waitFor(() => expect(held).toHaveLength(2));

    // The adversarial order the spec calls out: instance 1's (now stale)
    // request settles FIRST, after instance 2's is already in flight under
    // the identical id.
    held[0]?.({ sessions: [], tag: 'stale-instance-1' });
    await flushMicrotasks();
    expect(messages.filter((m) => m.kind === 'response')).toHaveLength(0);

    held[1]?.({ sessions: [], tag: 'instance-2' });
    await vi.waitFor(() => expect(messages.some((m) => m.kind === 'response')).toBe(true));

    const responses = messages.filter((m) => m.kind === 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      kind: 'response',
      id: 'bridge-req-1',
      outcome: { ok: true, result: { sessions: [], tag: 'instance-2' } },
    });
  });

  it('required test 5: destroyed/render-process-gone releases the current instance — session.detach is sent, and no chunk reaches the renderer afterward', async () => {
    const sessionId = 42 as SessionId;
    const token = randomUUID();
    const address = uniqueAddress('lifecycle-release');
    const server = new TransportServer({ token, address });
    await server.listen();
    cleanup.push(() => server.close());

    let holderClientId: string | undefined;
    const detachCalls: SessionId[] = [];
    server.registerMethod<{ sessionId: SessionId }, SessionAttachResult>(
      'session.attach',
      (params, context) => {
        holderClientId = context.clientId;
        return {
          session: {
            id: params.sessionId,
            name: 'test',
            cwd: 'C:\\',
            shell: 'pwsh.exe',
            cols: 80,
            rows: 24,
            status: 'running',
            createdAt: 0,
          },
        };
      },
    );
    server.registerMethod<{ sessionId: SessionId }, Record<string, never>>(
      'session.detach',
      (params) => {
        detachCalls.push(params.sessionId);
        return {};
      },
    );

    const client = new TransportClient({ address, token, handshakeTimeoutMs: 1000 });
    await client.connect();
    cleanup.push(() => client.close());

    const sessionAttachments = Promise.resolve<SessionAttachments | undefined>(
      new SessionAttachments(client),
    );
    const connectionPromise = Promise.resolve<DaemonConnection>({
      outcome: 'connected',
      client,
      info: fakeInfo(),
    });
    const { sink, messages } = collectOutbound();
    const gateway = new BridgeGateway({
      sendToRenderer: sink,
      connectionPromise,
      sessionAttachments,
    });
    cleanup.push(() => gateway.dispose());
    await flushMicrotasks();

    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'inst-1' });
    gateway.handleRendererMessage({
      kind: 'request',
      id: 'r1',
      instanceId: 'inst-1',
      method: 'session.attach',
      params: { sessionId },
    });
    await vi.waitFor(() =>
      expect(messages.some((m) => m.kind === 'response' && m.id === 'r1')).toBe(true),
    );
    if (holderClientId === undefined) {
      throw new Error('test setup invariant broken: session.attach never reached the daemon');
    }

    // A chunk reaches the renderer normally while attached.
    server.sendDataTo(holderClientId, sessionId, new Uint8Array([1]));
    await vi.waitFor(() => expect(messages.some((m) => m.kind === 'data')).toBe(true));
    messages.length = 0;

    // Simulate the renderer process crashing — a fake `webContents`-shaped
    // emitter, exactly `wireWebContentsLifecycle`'s own contract (its doc
    // comment: narrow enough to fake without any `electron` import).
    const webContents = new EventEmitter();
    wireWebContentsLifecycle(webContents, gateway);
    webContents.emit('render-process-gone');

    await vi.waitFor(() => expect(detachCalls).toEqual([sessionId]));

    // Any chunk arriving after that — even for the same session, even
    // still addressed to the same underlying daemon client — is dropped:
    // routing rule 4, docs/specs/m2.6-boot-reattach.md section 3.2.
    server.sendDataTo(holderClientId, sessionId, new Uint8Array([2]));
    await flushMicrotasks();
    expect(messages.some((m) => m.kind === 'data')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M2.5: clipboard/context-menu messages travel over the same ordered
// channel and instance bookkeeping as any RPC request (`ipc-contract.ts`'s
// doc comments on `BridgeClipboardReadMessage`/`BridgeContextMenuMessage`),
// but never touch the daemon — `options.clipboard`/`options.openContextMenu`
// are plain fakes here, exactly the shape `main/index.ts` supplies backed by
// Electron's `clipboard` module and `Menu.popup`.
// ---------------------------------------------------------------------------

describe('BridgeGateway — M2.5 clipboard/context menu', () => {
  it('clipboardRead/clipboardWrite round-trip over the single ordered channel, without touching REQUEST_METHODS', async () => {
    const { promise, resolve } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    let written: string | undefined;
    const gateway = new BridgeGateway({
      sendToRenderer: sink,
      connectionPromise: promise,
      clipboard: {
        readText: () => Promise.resolve('clipboard contents'),
        writeText: (text) => {
          written = text;
          return Promise.resolve();
        },
      },
    });
    cleanup.push(() => gateway.dispose());
    resolve({ outcome: 'blocked', reason: 'zombie', info: fakeInfo() });
    await flushMicrotasks();
    messages.length = 0;

    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'inst-1' });
    messages.length = 0;

    gateway.handleRendererMessage({ kind: 'clipboardRead', id: 'c1', instanceId: 'inst-1' });
    await flushMicrotasks();
    expect(messages).toEqual([
      { kind: 'response', id: 'c1', outcome: { ok: true, result: { text: 'clipboard contents' } } },
    ]);
    messages.length = 0;

    gateway.handleRendererMessage({
      kind: 'clipboardWrite',
      id: 'c2',
      instanceId: 'inst-1',
      text: 'to write',
    });
    await flushMicrotasks();
    expect(written).toBe('to write');
    expect(messages).toEqual([{ kind: 'response', id: 'c2', outcome: { ok: true, result: {} } }]);
  });

  it('clipboard read/write work with no daemon connection at all — they never depend on it', async () => {
    const { promise } = deferred<DaemonConnection>(); // never resolves — gateway stays 'connecting'
    const { sink, messages } = collectOutbound();
    const gateway = new BridgeGateway({
      sendToRenderer: sink,
      connectionPromise: promise,
      clipboard: {
        readText: () => Promise.resolve('still works'),
        writeText: () => Promise.resolve(),
      },
    });
    cleanup.push(() => gateway.dispose());
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'inst-1' });
    messages.length = 0;

    gateway.handleRendererMessage({ kind: 'clipboardRead', id: 'c1', instanceId: 'inst-1' });
    await flushMicrotasks();
    expect(messages).toEqual([
      { kind: 'response', id: 'c1', outcome: { ok: true, result: { text: 'still works' } } },
    ]);
  });

  it('clipboardRead without a configured clipboard fails closed with bridge_internal_error', async () => {
    const { promise } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    const gateway = new BridgeGateway({ sendToRenderer: sink, connectionPromise: promise });
    cleanup.push(() => gateway.dispose());
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'inst-1' });
    messages.length = 0;

    gateway.handleRendererMessage({ kind: 'clipboardRead', id: 'c1', instanceId: 'inst-1' });
    await flushMicrotasks();
    expect(messages).toEqual([
      {
        kind: 'response',
        id: 'c1',
        outcome: {
          ok: false,
          error: {
            code: 'bridge_internal_error',
            message: 'clipboard is not available in this environment',
          },
        },
      },
    ]);
  });

  it('contextMenu resolves with the choice, or undefined if dismissed — never depends on the daemon connection', async () => {
    const { promise } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    let lastHasSelection: boolean | undefined;
    let resolveMenu!: (choice: 'copy' | 'paste' | undefined) => void;
    const gateway = new BridgeGateway({
      sendToRenderer: sink,
      connectionPromise: promise,
      openContextMenu: (hasSelection) => {
        lastHasSelection = hasSelection;
        return new Promise((resolve) => {
          resolveMenu = resolve;
        });
      },
    });
    cleanup.push(() => gateway.dispose());
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'inst-1' });
    messages.length = 0;

    gateway.handleRendererMessage({
      kind: 'contextMenu',
      id: 'm1',
      instanceId: 'inst-1',
      hasSelection: true,
    });
    expect(lastHasSelection).toBe(true);
    expect(messages).toEqual([]); // the user hasn't picked anything yet

    resolveMenu('copy');
    await flushMicrotasks();
    expect(messages).toEqual([
      { kind: 'response', id: 'm1', outcome: { ok: true, result: { choice: 'copy' } } },
    ]);
  });

  it("a context menu opened by a reloaded-away instance delivers its choice to nobody (the new instance's hello supersedes it first)", async () => {
    const { promise } = deferred<DaemonConnection>();
    const { sink, messages } = collectOutbound();
    let resolveMenu!: (choice: 'copy' | 'paste' | undefined) => void;
    const gateway = new BridgeGateway({
      sendToRenderer: sink,
      connectionPromise: promise,
      openContextMenu: () =>
        new Promise((resolve) => {
          resolveMenu = resolve;
        }),
    });
    cleanup.push(() => gateway.dispose());

    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-1' });
    gateway.handleRendererMessage({
      kind: 'contextMenu',
      id: 'm1',
      instanceId: 'instance-1',
      hasSelection: false,
    });

    // The reload happens while the native menu is still open (the user
    // hasn't clicked anything yet) — a fresh `hello` supersedes instance 1.
    gateway.handleRendererMessage({ kind: 'hello', instanceId: 'instance-2' });
    messages.length = 0;

    // The user finally clicks "Colar" on the (now orphaned) menu instance 1 opened.
    resolveMenu('paste');
    await flushMicrotasks();
    expect(messages.filter((m) => m.kind === 'response')).toHaveLength(0);
  });

  it('REQUEST_METHODS is untouched by M2.5 — clipboard/menu are not daemon methods', async () => {
    const { REQUEST_METHODS } = await import('./ipc-contract.js');
    expect(REQUEST_METHODS).toEqual([
      'session.create',
      'session.resize',
      'session.close',
      'session.list',
      'session.attach',
      'session.detach',
    ]);
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
