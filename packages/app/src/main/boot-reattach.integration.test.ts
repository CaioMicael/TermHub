import { randomUUID } from 'node:crypto';

import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionCreateResult } from '@termhub/shared';

import { Registry } from '@termhub/daemon/src/registry.js';
import type { SessionFactory, SessionLike } from '@termhub/daemon/src/registry.js';
import { registerSessionService } from '@termhub/daemon/src/service.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExitListener,
} from '@termhub/daemon/src/session.js';
import { resolvePipeAddress } from '@termhub/daemon/src/transport-address.js';
import { TransportClient } from '@termhub/daemon/src/transport-client.js';
import { TransportServer } from '@termhub/daemon/src/transport-server.js';

import { BridgeGateway } from './bridge-gateway.js';
import type { DaemonConnection } from './daemon-client.js';
import { IPC_CHANNEL } from './ipc-contract.js';
import type { RelayInboundMessage, RelayOutboundMessage } from './ipc-contract.js';
import { SessionAttachments } from './session-attachments.js';

import { createBridge } from '../preload/bridge.js';
import type { MinimalIpcRenderer, PreloadBridge } from '../preload/bridge.js';

// M2.6 required tests 2 and 6 (docs/specs/m2.6-boot-reattach.md section 5,
// parte A) — the full real pipeline: real daemon (TransportServer +
// registerSessionService, exactly M1.7's own `service.ts`, not a stand-in)
// -> real TransportClient (the main process's one connection) ->
// SessionAttachments -> BridgeGateway -> a fake IPC modeling *two separate
// page loads sharing one webContents* -> the real preload `createBridge`.
// Required tests 1 and 7 live next to the code they exercise directly
// (packages/daemon/src/service.test.ts, session-attachments.test.ts);
// required tests 3, 4, 5 are in bridge-gateway.test.ts, at the level they
// belong to. This file is specifically for the scenario only the *whole*
// pipeline together can reproduce or disprove: what a reloaded renderer
// instance actually ends up seeing.

function uniqueAddress(label: string): string {
  return resolvePipeAddress({ suffix: `boot-reattach-${label}-${randomUUID()}` });
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

// ---------------------------------------------------------------------------
// FakeSession — same pattern as packages/daemon/src/service.test.ts's own
// (not exported from there, so redefined here): a controllable session that
// emits chunks on command, without spawning a real PTY.
// ---------------------------------------------------------------------------

class FakeSession implements SessionLike {
  private static nextPid = 51_000;
  readonly pid = FakeSession.nextPid++;
  private aliveFlag = true;
  private readonly exitListeners: SessionExitListener[] = [];
  private dataListeners: SessionDataListener[] = [];

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  write(): void {
    // Keyboard input isn't exercised by these tests.
  }

  resize(): void {
    // Resize isn't exercised by these tests.
  }

  kill(): void {
    this.aliveFlag = false;
    for (const listener of this.exitListeners) {
      listener({ exitCode: 0 });
    }
  }

  onData(listener: SessionDataListener): Disposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => (this.dataListeners = this.dataListeners.filter((l) => l !== listener)),
    };
  }

  onExit(listener: SessionExitListener): Disposable {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
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

/** Every line currently in `terminal`'s active buffer, trimmed of trailing whitespace — same helper `service.test.ts`/`buffer.test.ts` use for line-by-line reattach comparisons (M1.6's own rule: never compare raw `serialize()` strings). */
function linesOf(terminal: Terminal): string[] {
  const lines: string[] = [];
  for (let y = 0; y < terminal.buffer.active.length; y++) {
    lines.push(terminal.buffer.active.getLine(y)?.translateToString(true) ?? '');
  }
  return lines;
}

function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

/** Starts a real daemon (transport + `registerSessionService`) with a controllable `FakeSession` factory, plus the main process's one real `TransportClient` connected to it. */
async function startDaemon(
  label: string,
): Promise<{ server: TransportServer; client: TransportClient; sessions: FakeSession[] }> {
  const address = uniqueAddress(label);
  const token = `tok-${randomUUID()}`;
  const { factory, sessions } = fakeFactory();
  const registry = new Registry({ sessionFactory: factory });
  const server = new TransportServer({ token, address });
  registerSessionService(server, registry);
  cleanup.push(() => server.close());
  await server.listen();

  const client = new TransportClient({ address, token, handshakeTimeoutMs: 2000 });
  cleanup.push(() => client.close());
  await client.connect();

  return { server, client, sessions };
}

/**
 * Models one `webContents`'s IPC channel across however many page loads it
 * sees. Each `makeIpc()` call is a fresh preload's own `ipcRenderer` view —
 * its own `send`/`on` — but they all share the same "wire" to `main`
 * (`setInboundHandler`'s target) and the same outbound sink, exactly like
 * two page loads of the same window share one Electron IPC channel.
 *
 * The key piece this models faithfully: registering a *new* `ipc.on(...)`
 * listener (a new page's preload loading) becomes the *only* one that
 * receives anything further — a real full page load tears down the
 * previous JS realm (and whatever `ipcRenderer.on` listener it had)
 * entirely, so `main`'s `webContents.send` only ever reaches whichever page
 * is *currently* loaded. Without this, a naive fake where both `ipc.on`
 * listeners stay wired to the same outbound sink would let a message this
 * gateway correctly dropped for the old instance still reach the old
 * bridge's own `pendingRequests`/`onData` bookkeeping directly, which is
 * not what real Electron does and would produce a false failure (or false
 * pass) unrelated to the guarantee these tests are about.
 */
function createReloadableFakeIpc(): {
  makeIpc: () => MinimalIpcRenderer;
  sendToRenderer: (message: RelayOutboundMessage) => void;
  setInboundHandler: (handler: (message: RelayInboundMessage) => void) => void;
} {
  let currentListener: ((event: unknown, message: RelayOutboundMessage) => void) | undefined;
  let inboundHandler: ((message: RelayInboundMessage) => void) | undefined;

  const makeIpc = (): MinimalIpcRenderer => ({
    send(channel, message) {
      if (channel !== IPC_CHANNEL.FROM_RENDERER) {
        throw new Error(`unexpected send channel "${channel}"`);
      }
      inboundHandler?.(structuredClone(message));
    },
    on(channel, cb) {
      if (channel !== IPC_CHANNEL.TO_RENDERER) {
        throw new Error(`unexpected on channel "${channel}"`);
      }
      currentListener = cb;
    },
  });

  return {
    makeIpc,
    sendToRenderer(message) {
      currentListener?.(undefined, structuredClone(message));
    },
    setInboundHandler(handler) {
      inboundHandler = handler;
    },
  };
}
describe('boot reattach — full pipeline (M2.6 required tests 2 and 6)', () => {
  it('required test 2: reload with the agent producing — the reloaded instance gets exactly the true screen, no loss, no duplication, including a variant with output still in flight when it subscribes', async () => {
    const { server, client, sessions } = await startDaemon('reload-with-output');
    const created = await client.request<SessionCreateResult>('session.create', {
      shell: 'pwsh.exe',
      cwd: 'C:\\',
      cols: 24,
      rows: 8,
    });
    const sessionId = created.session.id;
    const fake = sessions[0];
    if (fake === undefined) {
      throw new Error('test setup invariant broken: no FakeSession created');
    }

    const sessionAttachments = new SessionAttachments(client);
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

    const { makeIpc, sendToRenderer, setInboundHandler } = createReloadableFakeIpc();
    const gateway = new BridgeGateway({
      sendToRenderer,
      connectionPromise,
      sessionAttachments: Promise.resolve(sessionAttachments),
    });
    cleanup.push(() => gateway.dispose());
    setInboundHandler((message) => {
      gateway.handleRendererMessage(message);
    });

    const chunks: string[] = [];
    const emit = (text: string): void => {
      chunks.push(text);
      fake.emitData(text);
    };

    emit('BOOT-1\r\n');

    // Instance 1 (the original page): attaches and receives normally.
    const bridge1 = createBridge(makeIpc(), 'instance-1');
    await vi.waitFor(() => expect(bridge1.getConnectionState()).toEqual({ state: 'connected' }));
    let receivedByInstance1 = Buffer.alloc(0);
    bridge1.onData((sid, data) => {
      if (sid === sessionId) {
        receivedByInstance1 = Buffer.concat([receivedByInstance1, Buffer.from(data)]);
      }
    });
    await bridge1.request('session.attach', { sessionId });
    await vi.waitFor(() => expect(receivedByInstance1.toString('utf8')).toContain('BOOT-1'));

    emit('LIVE-BEFORE-RELOAD\r\n');
    await vi.waitFor(() =>
      expect(receivedByInstance1.toString('utf8')).toContain('LIVE-BEFORE-RELOAD'),
    );

    // The reload: instance 2 loads (superseding instance 1 — its `hello`
    // triggers `releaseAll('instance-1')`, which schedules `session.detach`)
    // *while the agent is still producing*. Chunks emitted right around
    // this boundary are the "variant with old chunks in flight" the spec
    // asks for: some land while instance 1's detach is still pending at the
    // daemon, some while instance 2's fresh attach is itself still pending
    // — both must end up exactly once in what instance 2 sees, never in
    // instance 1's (now-orphaned, and per this file's fake-IPC model,
    // unreachable) stream.
    emit('DURING-RELOAD-1\r\n');
    const bridge2 = createBridge(makeIpc(), 'instance-2'); // sends hello, superseding instance 1
    emit('DURING-RELOAD-2\r\n');
    let receivedByInstance2 = Buffer.alloc(0);
    bridge2.onData((sid, data) => {
      if (sid === sessionId) {
        receivedByInstance2 = Buffer.concat([receivedByInstance2, Buffer.from(data)]);
      }
    });
    const attach2 = bridge2.request('session.attach', { sessionId });
    emit('DURING-RELOAD-3\r\n');
    await attach2;

    emit('AFTER-RELOAD\r\n');
    await vi.waitFor(() => expect(receivedByInstance2.toString('utf8')).toContain('AFTER-RELOAD'));

    // Ground truth: every chunk instance 2 is entitled to see is everything
    // the session ever produced (TerminalBuffer captures unconditionally,
    // regardless of who is attached — docs/specs/m1.7-attach-detach.md
    // section 3.6) *except* whatever instance 1 already fully consumed
    // before the reload boundary — but since M1.7/M2.6's contract is "the
    // new attach's snapshot reflects the buffer's current state", and
    // nothing is ever removed from the buffer, instance 2's snapshot
    // legitimately includes the pre-reload history too. The true
    // reconstructed screen is therefore every marker, in order, exactly
    // once each.
    const reconstructed = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
    for (const chunk of receivedByInstance2.toString('utf8').split(/(?<=\n)/)) {
      if (chunk.length > 0) {
        await writeAndWait(reconstructed, chunk);
      }
    }
    const groundTruth = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
    for (const chunk of chunks) {
      await writeAndWait(groundTruth, chunk);
    }
    expect(linesOf(reconstructed)).toEqual(linesOf(groundTruth));

    const combined = receivedByInstance2.toString('utf8');
    for (const marker of [
      'BOOT-1',
      'LIVE-BEFORE-RELOAD',
      'DURING-RELOAD-1',
      'DURING-RELOAD-2',
      'DURING-RELOAD-3',
      'AFTER-RELOAD',
    ]) {
      expect(combined.split(marker).length - 1).toBe(1);
    }

    // Instance 2 went from 'connecting' straight to 'connected' via its own
    // `hello`'s answer — no separate transition in between (required test 3's
    // guarantee, reused here in the full pipeline).
    expect(bridge2.getConnectionState()).toEqual({ state: 'connected' });

    reconstructed.dispose();
    groundTruth.dispose();
    void server; // kept for readability of the setup above; no direct assertions against it in this test
  });

  it('required test 6: StrictMode-style double acquire from one renderer instance still reaches the daemon as a single session.attach (renderer ref-count + the main book, together)', async () => {
    const { client } = await startDaemon('strictmode-single-attach');
    const created = await client.request<SessionCreateResult>('session.create', {
      shell: 'pwsh.exe',
      cwd: 'C:\\',
      cols: 80,
      rows: 24,
    });
    const sessionId = created.session.id;

    // Wraps `client` only for what `SessionAttachments` itself calls,
    // counting `session.attach`/`session.detach` requests — the direct,
    // ground-truth way to prove the book sent the daemon exactly one
    // `session.attach`, not just that the daemon's own idempotent handling
    // (M1.7 section 4: "anexar duas vezes ... não reenviar snapshot")
    // happened to absorb a second one.
    const attachRequestCount = { attach: 0, detach: 0 };
    const countingClient = {
      request: <TResult>(method: string, params: unknown): Promise<TResult> => {
        if (method === 'session.attach') attachRequestCount.attach += 1;
        if (method === 'session.detach') attachRequestCount.detach += 1;
        return client.request<TResult>(method, params);
      },
    };
    const sessionAttachments = new SessionAttachments(countingClient);
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

    const { makeIpc, sendToRenderer, setInboundHandler } = createReloadableFakeIpc();
    const gateway = new BridgeGateway({
      sendToRenderer,
      connectionPromise,
      sessionAttachments: Promise.resolve(sessionAttachments),
    });
    cleanup.push(() => gateway.dispose());
    setInboundHandler((message) => {
      gateway.handleRendererMessage(message);
    });

    const bridge: PreloadBridge = createBridge(makeIpc(), 'instance-1');
    await vi.waitFor(() => expect(bridge.getConnectionState()).toEqual({ state: 'connected' }));

    // The scenario terminal-session.ts's own header comment documents:
    // React.StrictMode's mount -> cleanup -> remount would, without that
    // module's ref-counting, send session.attach twice on the *same*
    // instance for the *same* session. Simulated here directly at the
    // bridge/book layer — two `session.attach` requests, same instanceId,
    // same sessionId, issued back to back (no await between) — to prove
    // the book's own rule 1 (docs/specs/m2.6-boot-reattach.md section 3.2)
    // holds as the *second* line of defense, independent of whatever
    // terminal-session.ts's ref count already collapses upstream.
    const first = bridge.request('session.attach', { sessionId });
    const second = bridge.request('session.attach', { sessionId });

    await Promise.all([first, second]);
    expect(sessionAttachments.accepts('instance-1', sessionId)).toBe(true);

    // Only one real session.attach ever reached the daemon — the book's own
    // rule 1, not just the daemon's separate (M1.7 section 4) idempotent
    // no-op handling of a second attach for the same clientId.
    expect(attachRequestCount).toEqual({ attach: 1, detach: 0 });
  });
});
