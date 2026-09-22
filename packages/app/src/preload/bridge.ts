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
  BridgeConnectionState,
  BridgeErrorPayload,
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

export function createBridge(ipc: MinimalIpcRenderer): PreloadBridge {
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
        const message: BridgeRequestMessage = { kind: 'request', id, method, params };
        ipc.send(IPC_CHANNEL.FROM_RENDERER, message);
      });
    },

    sendData(sessionId, data) {
      const message: BridgeSendDataMessage = { kind: 'sendData', sessionId, data };
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
  };
}
