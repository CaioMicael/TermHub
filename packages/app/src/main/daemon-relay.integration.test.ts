import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { BridgeGateway } from './bridge-gateway.js';
import type { DaemonConnection } from './daemon-client.js';
import { IPC_CHANNEL } from './ipc-contract.js';
import type { RelayInboundMessage, RelayOutboundMessage } from './ipc-contract.js';

import { createBridge } from '../preload/bridge.js';
import type { MinimalIpcRenderer } from '../preload/bridge.js';

// The M2.2 acceptance test (section 4.A/4.B of the task): the *whole*
// pipeline, end to end —
//
//   real TransportServer -> real TransportClient -> BridgeGateway/DaemonRelay
//     -> a fake IPC that round-trips every message through structuredClone
//     -> the real preload createBridge() -> a "renderer" listener
//
// — with real timers throughout (the coalescing window is a real ~8ms
// wall-clock window; nothing here uses `vi.useFakeTimers`, on purpose: the
// whole point is proving the real timer-driven coalescer behaves correctly
// under a real socket). `daemon-relay.test.ts` covers `DaemonRelay` in
// isolation; `bridge-gateway.test.ts` covers `BridgeGateway`'s connection-
// state machine; `bridge.test.ts` covers `createBridge` in isolation. This
// file is the one that proves all four pieces actually fit together.

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `daemon-relay-integration-${label}-${randomUUID()}` });
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

/**
 * Wires a fake, in-memory pair of "main" and "preload" IPC endpoints,
 * structured-cloning every message that crosses either direction — the same
 * cloning Electron's own `ipcRenderer.send`/`webContents.send` perform, per
 * Electron's IPC documentation — so nothing in this test can pass by
 * relying on object identity or a prototype surviving the hop.
 *
 * `sendToRenderer` (handed to `BridgeGateway`'s constructor) and `rendererIpc`
 * (handed to `createBridge`) are independent of each other here — neither
 * needs a reference to the `BridgeGateway` instance itself, which matters
 * because `BridgeGateway`'s constructor calls it *synchronously* (the
 * initial `'connecting'` state message): closing over the `const gateway =
 * new BridgeGateway(...)` binding at that point would still be in its
 * temporal dead zone. `setInboundHandler` is the one piece wired up *after*
 * the gateway exists, since routing a renderer message obviously needs it.
 */
function createFakeIpc(): {
  rendererIpc: MinimalIpcRenderer;
  sendToRenderer: (message: RelayOutboundMessage) => void;
  setInboundHandler: (handler: (message: RelayInboundMessage) => void) => void;
} {
  let toRendererListener: ((event: unknown, message: RelayOutboundMessage) => void) | undefined;
  let inboundHandler: ((message: RelayInboundMessage) => void) | undefined;

  const rendererIpc: MinimalIpcRenderer = {
    send(channel, message) {
      if (channel !== IPC_CHANNEL.FROM_RENDERER) {
        throw new Error(`unexpected send channel "${channel}"`);
      }
      const cloned = structuredClone(message);
      inboundHandler?.(cloned);
    },
    on(channel, cb) {
      if (channel !== IPC_CHANNEL.TO_RENDERER) {
        throw new Error(`unexpected on channel "${channel}"`);
      }
      toRendererListener = cb;
    },
  };

  const sendToRenderer = (message: RelayOutboundMessage): void => {
    const cloned = structuredClone(message);
    toRendererListener?.(undefined, cloned);
  };

  return {
    rendererIpc,
    sendToRenderer,
    setInboundHandler(handler) {
      inboundHandler = handler;
    },
  };
}

interface Pipeline {
  client: TransportClient;
  server: TransportServer;
  gateway: BridgeGateway;
  bridge: ReturnType<typeof createBridge>;
}

async function buildPipeline(label: string): Promise<Pipeline> {
  const { server, client } = await startServerAndClient(label);
  const connectionPromise = Promise.resolve<DaemonConnection>({
    outcome: 'connected',
    client,
    info: {
      pid: 1,
      pipe: 'fake',
      token: 'fake',
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
    },
  });
  const { rendererIpc, sendToRenderer, setInboundHandler } = createFakeIpc();
  const gateway = new BridgeGateway({ sendToRenderer, connectionPromise });
  cleanup.push(() => gateway.dispose());
  setInboundHandler((message) => {
    gateway.handleRendererMessage(message);
  });
  const bridge = createBridge(rendererIpc);

  // Let the 'connected' state message land before returning, exactly as a
  // real renderer would see it before issuing its first request.
  await vi.waitFor(() => expect(bridge.getConnectionState()).toEqual({ state: 'connected' }), {
    timeout: 2000,
  });

  return { client, server, gateway, bridge };
}

/** Builds `frameCount` frames of `bytesPerFrame` bytes each from `content`, in order — `content.length` must equal `frameCount * bytesPerFrame`. */
function chunk(content: Uint8Array, bytesPerFrame: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < content.length; offset += bytesPerFrame) {
    frames.push(content.subarray(offset, offset + bytesPerFrame));
  }
  return frames;
}

describe('daemon bridge — full pipeline (transport -> DaemonRelay -> IPC -> preload bridge)', () => {
  it('1000 small frames across 2 interleaved sessions arrive byte-identical, in order, as Uint8Array, and visibly coalesced', async () => {
    const { server, bridge } = await buildPipeline('1000-frames');

    const FRAMES_PER_SESSION = 500;
    const BYTES_PER_FRAME = 2;
    const SESSION_A = 101;
    const SESSION_B = 202;

    // Deterministic content long enough to include a null byte and a
    // multi-byte UTF-8 character (the euro sign, 0xE2 0x82 0xAC) split
    // across a frame boundary. `BYTES_PER_FRAME` is 2 and the sign starts
    // at an even offset (500), so byte 501 (0x82) ends one frame and byte
    // 502 (0xAC) starts the next — the split is structural, not by chance.
    const contentA = new Uint8Array(FRAMES_PER_SESSION * BYTES_PER_FRAME);
    for (let i = 0; i < contentA.length; i += 1) {
      contentA[i] = (i * 37 + 11) % 256;
    }
    contentA[10] = 0x00; // explicit null byte
    contentA[500] = 0xe2;
    contentA[501] = 0x82;
    contentA[502] = 0xac; // '€', split across the [500,502) / [502,504) frame boundary

    const contentB = new Uint8Array(FRAMES_PER_SESSION * BYTES_PER_FRAME);
    for (let i = 0; i < contentB.length; i += 1) {
      contentB[i] = (i * 53 + 199) % 256;
    }
    contentB[42] = 0x00; // its own null byte

    const framesA = chunk(contentA, BYTES_PER_FRAME);
    const framesB = chunk(contentB, BYTES_PER_FRAME);
    expect(framesA).toHaveLength(FRAMES_PER_SESSION);
    expect(framesB).toHaveLength(FRAMES_PER_SESSION);

    const receivedA: Uint8Array[] = [];
    const receivedB: Uint8Array[] = [];
    let dataMessageCount = 0;
    bridge.onData((sessionId, data) => {
      dataMessageCount += 1;
      expect(data).toBeInstanceOf(Uint8Array);
      if (sessionId === SESSION_A) {
        receivedA.push(data);
      } else if (sessionId === SESSION_B) {
        receivedB.push(data);
      }
    });

    // Interleaved send order: A, B, A, B, ... — "em pelo menos 2 sessões
    // intercaladas" (task section 4.A).
    for (let i = 0; i < FRAMES_PER_SESSION; i += 1) {
      const frameA = framesA[i];
      const frameB = framesB[i];
      if (frameA === undefined || frameB === undefined) {
        throw new Error('frame generation produced fewer frames than expected');
      }
      server.broadcastData(SESSION_A, frameA);
      server.broadcastData(SESSION_B, frameB);
    }

    await vi.waitFor(
      () => {
        const totalA = receivedA.reduce((n, c) => n + c.byteLength, 0);
        const totalB = receivedB.reduce((n, c) => n + c.byteLength, 0);
        expect(totalA).toBe(contentA.byteLength);
        expect(totalB).toBe(contentB.byteLength);
      },
      { timeout: 5000, interval: 20 },
    );

    const gotA = concat(receivedA);
    const gotB = concat(receivedB);
    expect(Array.from(gotA)).toEqual(Array.from(contentA));
    expect(Array.from(gotB)).toEqual(Array.from(contentB));

    // Coalescing actually happened: far fewer *messages* than *frames*.
    // Required evidence for section 4.A of the task's acceptance criteria.
    console.log(
      `[daemon-relay.integration.test] 1000 frames sent, ${dataMessageCount} 'data' messages delivered to the renderer`,
    );
    expect(dataMessageCount).toBeLessThan(100);
  });

  it("armadilha 1 (RPC): data queued during a request handler arrives at the renderer before that request's response", async () => {
    const { server, bridge } = await buildPipeline('armadilha1-rpc');

    server.registerMethod<{ sessionId: number }, { session: { id: number } }>(
      'session.attach',
      (params, context) => {
        // Mirrors the real daemon's session.attach: the "snapshot" travels
        // as a data frame, written *before* this handler returns (and thus
        // before the response frame is ever written) — docs/specs/
        // m1.7-attach-detach.md section 3.4.
        server.sendDataTo(context.clientId, params.sessionId, new Uint8Array([1, 2, 3]));
        return { session: { id: params.sessionId } };
      },
    );

    const order: string[] = [];
    bridge.onData(() => order.push('data'));

    const result = await bridge.request('session.attach', { sessionId: 7 });
    order.push('response');

    expect(result).toEqual({ session: { id: 7 } });
    expect(order).toEqual(['data', 'response']);
  });

  it('armadilha 1 (event): data sent right before session.exit arrives at the renderer before that event', async () => {
    const { server, client, bridge } = await buildPipeline('armadilha1-event');

    server.registerMethod('_test.whoami', (_params, context) => ({ clientId: context.clientId }));
    const whoami = await client.request<{ clientId: string }>('_test.whoami', {});

    const order: string[] = [];
    bridge.onData(() => order.push('data'));
    bridge.onEvent((event) => order.push(event));

    // Mirrors the real daemon: last output written before session.exit.
    server.sendDataTo(whoami.clientId, 9, new Uint8Array([9, 9, 9]));
    server.sendEventTo(whoami.clientId, 'session.exit', { sessionId: 9, exitCode: 0 });

    await vi.waitFor(() => expect(order).toContain('session.exit'), { timeout: 2000 });
    expect(order).toEqual(['data', 'session.exit']);
  });

  it('a method outside RequestMethod is rejected by the bridge and never reaches the daemon', async () => {
    const { server, bridge } = await buildPipeline('reject-unknown-method');
    const evilHandler = vi.fn(() => ({}));
    server.registerMethod('evil.method', evilHandler);

    // Bypasses the typed `bridge.request<M>()` on purpose — a real renderer
    // bug (or a compromised renderer) could call `ipcRenderer.send` with any
    // string, so the enforcement this proves lives in the main process, not
    // in TypeScript's compile-time surface.
    const rawIpc = bridge as unknown as {
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    await expect(rawIpc.request('evil.method', {})).rejects.toEqual({
      code: 'bridge_rejected_method',
      message: 'method "evil.method" is not a recognized request method',
    });
    expect(evilHandler).not.toHaveBeenCalled();
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
