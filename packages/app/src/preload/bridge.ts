import type {
  EventPayloadByName,
  JsonEventName,
  RequestMethod,
  RequestParamsByMethod,
  RequestResultByMethod,
  SessionId,
} from '@termhub/shared';

import { IPC_CHANNEL } from '../main/ipc-contract.js';
import type {
  BridgeClipboardReadMessage,
  BridgeClipboardWriteMessage,
  BridgeConnectionState,
  BridgeContextMenuMessage,
  BridgeErrorPayload,
  BridgeHelloMessage,
  BridgeRequestMessage,
  BridgeSendDataMessage,
  RelayInboundMessage,
  RelayOutboundMessage,
} from '../main/ipc-contract.js';

// The preload-side half of the bridge: a factory, `createBridge`, that turns
// a minimal `ipcRenderer`-shaped object into the typed API `window.termhub`
// exposes. Deliberately free of any `electron` import — `preload/index.ts`
// is the only file that touches `contextBridge`/`ipcRenderer` for real; this
// module is plain TS/JS so it can be unit-tested with a fake `ipc` and no
// Electron process at all (see `bridge.test.ts`).
//
// Only `import type` reaches into `@termhub/shared` here (see
// `ipc-contract.ts`'s header comment on why — a sandboxed preload can only
// `require` `electron` and Node's own built-ins; a runtime import from any
// other workspace package left un-bundled turns into a `require` that fails
// silently at preload load time). `../main/ipc-contract.js`'s `IPC_CHANNEL`
// constant is a plain string map with zero further dependencies, so it is
// safe to import as a value even though it physically lives under
// `src/main` — see this task's final report for why the contract file lives
// there instead of duplicated in both places.

/** The minimal shape of Electron's real `ipcRenderer` this module actually uses — small enough to fake in a test without pulling in `electron`. */
export interface MinimalIpcRenderer {
  send(channel: string, message: RelayInboundMessage): void;
  on(channel: string, listener: (event: unknown, message: RelayOutboundMessage) => void): void;
}

export interface BridgeConnectionStateSnapshot {
  state: BridgeConnectionState;
  reason?: string;
}

/** The bridge surface `createBridge` returns — everything `window.termhub` exposes *except* `versions`, which `preload/index.ts` adds separately (it comes from `process.versions`, not from any IPC round-trip). */
export interface PreloadBridge {
  /**
   * Typed RPC. Resolves with the daemon's result; rejects with a plain
   * `BridgeErrorPayload` — not an `Error` — on any failure, including one
   * this bridge produces itself without ever reaching the daemon (an
   * unrecognized method, or no usable connection right now). See
   * `ipc-contract.ts`'s `BridgeErrorPayload` doc comment for why the
   * rejection reason is plain data instead of a thrown `Error`.
   */
  request<M extends RequestMethod>(
    method: M,
    params: RequestParamsByMethod[M],
  ): Promise<RequestResultByMethod[M]>;
  /** PTY keyboard/paste input. Fire-and-forget, no coalescing, no delay — see `daemon-relay.ts`'s `sendData` doc comment. */
  sendData(sessionId: SessionId, data: Uint8Array): void;
  /** Subscribes to coalesced PTY output. Bytes arrive as `Uint8Array` end to end — see `bridge.test.ts`/`daemon-relay.integration.test.ts` for proof this survives the IPC hop without becoming a string. Returns an unsubscribe function. */
  onData(listener: (sessionId: SessionId, data: Uint8Array) => void): () => void;
  /** Subscribes to `session.exit`/`session.status`. Narrow on `event` (e.g. `event === 'session.exit'`) to know `payload` is a `SessionExitPayload`. Returns an unsubscribe function. */
  onEvent(
    listener: (event: JsonEventName, payload: EventPayloadByName[JsonEventName]) => void,
  ): () => void;
  /** The connection state as of the last `BridgeStateMessage` received. Starts as `{ state: 'connecting' }` — the first real state message may not have arrived yet by the time a renderer script runs (main never waits for it before loading the window). */
  getConnectionState(): BridgeConnectionStateSnapshot;
  /** Subscribes to connection-state changes. Returns an unsubscribe function. */
  onConnectionStateChange(listener: (state: BridgeConnectionStateSnapshot) => void): () => void;
  /** M2.5, section 2.4: reads the OS clipboard's current text via the main process. Never `navigator.clipboard` — see `@termhub/ui`'s `TerminalBridge.readClipboardText` doc comment for why. */
  readClipboardText(): Promise<string>;
  /** M2.5: writes `text` to the OS clipboard via the main process. */
  writeClipboardText(text: string): Promise<void>;
  /** M2.5, section 2.3: opens the native OS context menu ("Copiar"/"Colar") and resolves with the user's choice, or `undefined` if dismissed without one. */
  openContextMenu(hasSelection: boolean): Promise<'copy' | 'paste' | undefined>;
}

/**
 * Generates one renderer-instance id (docs/specs/m2.6-boot-reattach.md
 * section 3.3) — used as the `instanceId` on this bridge's `hello` and on
 * every message it sends afterward. The only requirement is that it not
 * repeat between two loads of the *same* window (a fresh boot, a
 * `webContents.reload()`, a crash-and-recover) — not cryptographic
 * unguessability, so the fallback below is deliberately weak.
 *
 * `crypto.randomUUID()` is available here: this module runs inside the
 * preload's *isolated world*, which — even with `sandbox: true` — is a
 * Chromium renderer-process JS context, not Node's, so `crypto` is the Web
 * Crypto API global every modern browser exposes, not a Node built-in that
 * would need a `require('node:crypto')` this sandboxed preload can't do for
 * arbitrary modules. Confirmed against a real Electron window in both
 * `npm run dev` (renderer served from `http://localhost`) and a built app
 * (`file://`) — see this task's final report.
 */
function generateInstanceId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID !== undefined) {
    return webCrypto.randomUUID();
  }
  // Fallback per docs/specs/m2.6-boot-reattach.md section 3.3, for a
  // hypothetical environment without `crypto.randomUUID()` (not observed in
  // this task's own Electron verification — see the report).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface PendingRequest {
  // Erased to `unknown` for the same reason `TransportClient.request`'s own
  // `pendingRequests` map is (see that file's comment): one bridge
  // multiplexes concurrent requests of different `TResult` types, and
  // `resolve` closes over *this* call's own type at the point `request<M>`
  // constructs it — the cast there just restates what the caller already
  // told us.
  resolve: (value: unknown) => void;
  reject: (error: BridgeErrorPayload) => void;
}

/**
 * `instanceId` defaults to a freshly generated one (`generateInstanceId`) —
 * `preload/index.ts` (the real Electron wiring) always relies on that
 * default; tests pass an explicit one to make the M2.6 required tests
 * (multiple instances racing on one gateway) deterministic instead of
 * depending on two random ids never colliding.
 */
export function createBridge(
  ipc: MinimalIpcRenderer,
  instanceId: string = generateInstanceId(),
): PreloadBridge {
  const dataListeners = new Set<(sessionId: SessionId, data: Uint8Array) => void>();
  const eventListeners = new Set<
    (event: JsonEventName, payload: EventPayloadByName[JsonEventName]) => void
  >();
  const stateListeners = new Set<(state: BridgeConnectionStateSnapshot) => void>();
  const pendingRequests = new Map<string, PendingRequest>();
  let nextRequestSeq = 1;
  let currentState: BridgeConnectionStateSnapshot = { state: 'connecting' };

  ipc.on(IPC_CHANNEL.TO_RENDERER, (_event, message) => {
    switch (message.kind) {
      case 'data':
        for (const listener of dataListeners) {
          listener(message.sessionId, message.data);
        }
        return;
      case 'event':
        for (const listener of eventListeners) {
          listener(message.event, message.payload);
        }
        return;
      case 'state':
        currentState =
          message.reason !== undefined
            ? { state: message.state, reason: message.reason }
            : { state: message.state };
        for (const listener of stateListeners) {
          listener(currentState);
        }
        return;
      case 'response': {
        const pending = pendingRequests.get(message.id);
        if (pending === undefined) {
          return; // Stray/duplicate response, or the requester already gave up — nothing to resolve.
        }
        pendingRequests.delete(message.id);
        if (message.outcome.ok) {
          pending.resolve(message.outcome.result);
        } else {
          pending.reject(message.outcome.error);
        }
        return;
      }
    }
  });

  // The very first outbound message, before any request — the main
  // process's ordered-channel contract (docs/specs/m2.6-boot-reattach.md
  // section 3.3) depends on nothing else jumping ahead of it. Sent only
  // now, after the `ipc.on` listener above is already registered: `main`'s
  // reply to this `hello` (the current connection state, pulled per defect
  // 2.4) can arrive as early as this same synchronous call, in the fake IPC
  // this file's own tests and `daemon-relay.integration.test.ts` use.
  const hello: BridgeHelloMessage = { kind: 'hello', instanceId };
  ipc.send(IPC_CHANNEL.FROM_RENDERER, hello);

  /**
   * Shared plumbing for M2.5's three clipboard/context-menu messages: mints
   * an id, registers it in the same `pendingRequests` map `request()` uses
   * (a `'response'` from main resolves/rejects it identically regardless of
   * which message kind produced it — `ipc.on` above doesn't distinguish),
   * and sends `build(id)`.
   */
  function sendAwaitable<TResult>(build: (id: string) => RelayInboundMessage): Promise<TResult> {
    const id = `bridge-req-${nextRequestSeq}`;
    nextRequestSeq += 1;
    return new Promise<TResult>((resolve, reject) => {
      pendingRequests.set(id, {
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject,
      });
      ipc.send(IPC_CHANNEL.FROM_RENDERER, build(id));
    });
  }

  return {
    request<M extends RequestMethod>(
      method: M,
      params: RequestParamsByMethod[M],
    ): Promise<RequestResultByMethod[M]> {
      const id = `bridge-req-${nextRequestSeq}`;
      nextRequestSeq += 1;
      return new Promise<RequestResultByMethod[M]>((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: (value) => {
            resolve(value as RequestResultByMethod[M]);
          },
          reject,
        });
        const message: BridgeRequestMessage = { kind: 'request', id, instanceId, method, params };
        ipc.send(IPC_CHANNEL.FROM_RENDERER, message);
      });
    },

    sendData(sessionId, data) {
      const message: BridgeSendDataMessage = { kind: 'sendData', instanceId, sessionId, data };
      ipc.send(IPC_CHANNEL.FROM_RENDERER, message);
    },

    onData(listener) {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    getConnectionState() {
      return currentState;
    },

    onConnectionStateChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    readClipboardText() {
      return sendAwaitable<{ text: string }>((id) => {
        const message: BridgeClipboardReadMessage = { kind: 'clipboardRead', id, instanceId };
        return message;
      }).then((result) => result.text);
    },

    writeClipboardText(text) {
      return sendAwaitable<Record<string, never>>((id) => {
        const message: BridgeClipboardWriteMessage = {
          kind: 'clipboardWrite',
          id,
          instanceId,
          text,
        };
        return message;
      }).then(() => undefined);
    },

    openContextMenu(hasSelection) {
      return sendAwaitable<{ choice: 'copy' | 'paste' | undefined }>((id) => {
        const message: BridgeContextMenuMessage = {
          kind: 'contextMenu',
          id,
          instanceId,
          hasSelection,
        };
        return message;
      }).then((result) => result.choice);
    },
  };
}
