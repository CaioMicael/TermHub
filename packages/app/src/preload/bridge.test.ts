import { describe, expect, it } from 'vitest';

import { IPC_CHANNEL } from '../main/ipc-contract.js';
import type { RelayInboundMessage, RelayOutboundMessage } from '../main/ipc-contract.js';

import { createBridge } from './bridge.js';
import type { MinimalIpcRenderer } from './bridge.js';

// Unit tests for `createBridge` in isolation: a fake `ipcRenderer` (no
// Electron, no real IPC), with every outbound message from "main" round-
// tripped through a real `structuredClone` before delivery — the same
// serialization Electron's `ipcRenderer`/`webContents` hop actually performs
// on the wire, per Electron's docs (IPC messages are structured-cloned) —
// so this proves the bridge does not silently rely on anything (a class
// instance, a shared closure reference) that wouldn't actually survive that
// hop. `daemon-relay.integration.test.ts` covers the full pipeline
// (real TransportServer/TransportClient -> DaemonRelay -> this bridge);
// this file is the fast, isolated half.

function createFakeIpc(): {
  ipc: MinimalIpcRenderer;
  sent: RelayInboundMessage[];
  deliver: (message: RelayOutboundMessage) => void;
} {
  const sent: RelayInboundMessage[] = [];
  let listener: ((event: unknown, message: RelayOutboundMessage) => void) | undefined;

  const ipc: MinimalIpcRenderer = {
    send(channel, message) {
      if (channel !== IPC_CHANNEL.FROM_RENDERER) {
        throw new Error(`unexpected send channel "${channel}"`);
      }
      sent.push(message);
    },
    on(channel, cb) {
      if (channel !== IPC_CHANNEL.TO_RENDERER) {
        throw new Error(`unexpected on channel "${channel}"`);
      }
      listener = cb;
    },
  };

  return {
    ipc,
    sent,
    deliver(message) {
      const cloned = structuredClone(message);
      listener?.(undefined, cloned);
    },
  };
}

describe('createBridge', () => {
  it('request(): sends a correlated request and resolves with the result on a matching response', async () => {
    const { ipc, sent, deliver } = createFakeIpc();
    const bridge = createBridge(ipc);

    const resultPromise = bridge.request('session.list', {});
    expect(sent).toHaveLength(1);
    const req = sent[0];
    if (req === undefined || req.kind !== 'request') {
      throw new Error('expected a request message');
    }
    expect(req.method).toBe('session.list');

    deliver({ kind: 'response', id: req.id, outcome: { ok: true, result: { sessions: [] } } });

    await expect(resultPromise).resolves.toEqual({ sessions: [] });
  });

  it('request(): rejects with a plain BridgeErrorPayload (code intact) on a failure response — armadilha 3', async () => {
    const { ipc, sent, deliver } = createFakeIpc();
    const bridge = createBridge(ipc);

    const resultPromise = bridge.request('session.attach', { sessionId: 999 });
    const req = sent[0];
    if (req === undefined || req.kind !== 'request') {
      throw new Error('expected a request message');
    }

    deliver({
      kind: 'response',
      id: req.id,
      outcome: {
        ok: false,
        error: {
          code: 'session_not_found',
          message: 'session 999 not found',
          details: { sessionId: 999 },
        },
      },
    });

    await expect(resultPromise).rejects.not.toBeInstanceOf(Error);
    try {
      await resultPromise;
      throw new Error('expected resultPromise to reject');
    } catch (err) {
      expect(err).toEqual({
        code: 'session_not_found',
        message: 'session 999 not found',
        details: { sessionId: 999 },
      });
    }
  });

  it('request(): correlates concurrent requests by id even when responses arrive out of order', async () => {
    const { ipc, sent, deliver } = createFakeIpc();
    const bridge = createBridge(ipc);

    const first = bridge.request('session.list', {});
    const second = bridge.request('session.list', {});
    expect(sent).toHaveLength(2);
    const [reqA, reqB] = sent;
    if (
      reqA === undefined ||
      reqA.kind !== 'request' ||
      reqB === undefined ||
      reqB.kind !== 'request'
    ) {
      throw new Error('expected two request messages');
    }

    // Deliver the *second* request's response first.
    deliver({
      kind: 'response',
      id: reqB.id,
      outcome: { ok: true, result: { sessions: [], tag: 'B' } },
    });
    deliver({
      kind: 'response',
      id: reqA.id,
      outcome: { ok: true, result: { sessions: [], tag: 'A' } },
    });

    await expect(first).resolves.toEqual({ sessions: [], tag: 'A' });
    await expect(second).resolves.toEqual({ sessions: [], tag: 'B' });
  });

  it('sendData(): sends a sendData message with the Uint8Array intact', () => {
    const { ipc, sent } = createFakeIpc();
    const bridge = createBridge(ipc);

    const data = new Uint8Array([104, 105]); // "hi"
    bridge.sendData(7, data);

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    if (msg === undefined || msg.kind !== 'sendData') {
      throw new Error('expected a sendData message');
    }
    expect(msg.sessionId).toBe(7);
    expect(msg.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(msg.data)).toEqual([104, 105]);
  });

  it('onData(): delivers Uint8Array output to subscribed listeners, and unsubscribe stops delivery', () => {
    const { deliver, ipc } = createFakeIpc();
    const bridge = createBridge(ipc);

    const received: Array<{ sessionId: number; data: Uint8Array }> = [];
    const unsubscribe = bridge.onData((sessionId, data) => {
      received.push({ sessionId, data });
    });

    deliver({ kind: 'data', sessionId: 1, data: new Uint8Array([1, 2, 3]) });
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]?.data ?? [])).toEqual([1, 2, 3]);

    unsubscribe();
    deliver({ kind: 'data', sessionId: 1, data: new Uint8Array([4, 5]) });
    expect(received).toHaveLength(1);
  });

  it('onEvent(): delivers session.exit/session.status events, and unsubscribe stops delivery', () => {
    const { deliver, ipc } = createFakeIpc();
    const bridge = createBridge(ipc);

    const received: Array<{ event: string; payload: unknown }> = [];
    const unsubscribe = bridge.onEvent((event, payload) => {
      received.push({ event, payload });
    });

    deliver({
      kind: 'event',
      event: 'session.exit',
      payload: { sessionId: 3, exitCode: 0 },
    });
    expect(received).toEqual([{ event: 'session.exit', payload: { sessionId: 3, exitCode: 0 } }]);

    unsubscribe();
    deliver({
      kind: 'event',
      event: 'session.status',
      payload: { sessionId: 3, status: 'idle', since: 0 },
    });
    expect(received).toHaveLength(1);
  });

  it('getConnectionState()/onConnectionStateChange(): starts as connecting, updates on state messages, unsubscribe stops delivery', () => {
    const { deliver, ipc } = createFakeIpc();
    const bridge = createBridge(ipc);

    expect(bridge.getConnectionState()).toEqual({ state: 'connecting' });

    const received: Array<{ state: string; reason?: string }> = [];
    const unsubscribe = bridge.onConnectionStateChange((state) => {
      received.push(state);
    });

    deliver({ kind: 'state', state: 'connected' });
    expect(bridge.getConnectionState()).toEqual({ state: 'connected' });
    expect(received).toEqual([{ state: 'connected' }]);

    deliver({ kind: 'state', state: 'blocked', reason: 'zombie' });
    expect(bridge.getConnectionState()).toEqual({ state: 'blocked', reason: 'zombie' });
    expect(received).toEqual([{ state: 'connected' }, { state: 'blocked', reason: 'zombie' }]);

    unsubscribe();
    deliver({ kind: 'state', state: 'disconnected' });
    expect(received).toHaveLength(2);
    // getConnectionState() itself keeps tracking regardless of subscriptions.
    expect(bridge.getConnectionState()).toEqual({ state: 'disconnected' });
  });
});
