import type { DaemonConnection } from './daemon-client.js';
import { DaemonRelay } from './daemon-relay.js';
import type { DaemonRelayOptions } from './daemon-relay.js';
import type {
  BridgeConnectionState,
  RelayInboundMessage,
  RelayOutboundMessage,
} from './ipc-contract.js';

// Owns one window's worth of bridge state, from before `connectToDaemon()`
// settles through to the `TransportClient` (if any) closing. Deliberately
// does not import `electron`: constructed with a `Promise<DaemonConnection>`
// (`daemon-client.ts`'s own return type) and a `sendToRenderer` callback, so
// it is testable with a fake/real `DaemonConnection` and no `BrowserWindow`
// — see `bridge-gateway.test.ts`. `main/index.ts` is the only place that
// wires this to a real window and `ipcMain`.
//
// ## Requests before/without a connection
//
// `main/index.ts` never awaits `connectToDaemon()` before opening the
// window (docs/specs/m2.1-daemon-client.md; the comment on
// `startDaemonConnection` in the current `index.ts` says so explicitly), so
// a renderer request can always arrive before this gateway has a
// `DaemonRelay` to hand it to — and, once connected, the `TransportClient`
// can still close later (`'disconnected'`). This gateway's answer, chosen
// for M2.2 (see the task's final report for the reasoning): **reject
// immediately**, in every state other than `'connected'`, with
// `'bridge_not_connected'` and the current state/reason in the message.
// Never queue. A queue would mean a `session.create` typed by the user
// during a `'blocked'`/`'failed'` window fires an unknown amount of time
// later, possibly after the user has moved on — a silent surprise instead
// of a clear, immediate failure the UI (M2.3) can show and let the user
// retry.

export interface BridgeGatewayOptions {
  /** Delivers one outbound message to this gateway's window. Always the same mechanism regardless of `message.kind` (see `ipc-contract.ts`'s header comment). */
  sendToRenderer: (message: RelayOutboundMessage) => void;
  /** Settles once (`connectToDaemon()`'s own contract) with the outcome this gateway should reflect as connection state. */
  connectionPromise: Promise<DaemonConnection>;
  /** Forwarded to the `DaemonRelay` created on `'connected'`. */
  coalesceWindowMs?: DaemonRelayOptions['coalesceWindowMs'];
  coalesceByteLimitBytes?: DaemonRelayOptions['coalesceByteLimitBytes'];
}

function outcomeReason(result: DaemonConnection): string | undefined {
  switch (result.outcome) {
    case 'connected':
      return undefined;
    case 'blocked':
      return result.reason;
    case 'failed':
      return result.lastError.message;
  }
}

export class BridgeGateway {
  private readonly options: BridgeGatewayOptions;
  private state: BridgeConnectionState = 'connecting';
  private reason: string | undefined;
  private relay: DaemonRelay | undefined;
  private closeSubscription: { dispose: () => void } | undefined;
  private disposed = false;

  constructor(options: BridgeGatewayOptions) {
    this.options = options;
    this.sendState();
    this.awaitConnection().catch((err: unknown) => {
      // `connectToDaemon()` resolves with a `DaemonConnection` for every
      // outcome it knows about (connected/blocked/failed) and is not
      // documented to reject — this only fires on a genuinely unexpected
      // failure of the promise itself, and there is no renderer request in
      // flight yet to reject in response to it, so this is logged rather
      // than silently swallowed.
      console.error('[TermHub] daemon connection promise rejected unexpectedly', err);
      if (this.disposed) {
        return;
      }
      this.state = 'failed';
      this.reason = err instanceof Error ? err.message : String(err);
      this.sendState();
    });
  }

  /** Current connection state, for a renderer that asks after this gateway already settled (this class has no async "get state" of its own — `main/index.ts` only ever needs this for tests/diagnostics; the renderer learns state via `BridgeStateMessage`). */
  get connectionState(): { state: BridgeConnectionState; reason?: string } {
    return this.reason === undefined
      ? { state: this.state }
      : { state: this.state, reason: this.reason };
  }

  /** Routes one message from the renderer: an RPC request or PTY input. */
  handleRendererMessage(message: RelayInboundMessage): void {
    if (this.disposed) {
      return;
    }
    if (message.kind === 'sendData') {
      if (this.relay !== undefined) {
        this.relay.sendData(message.sessionId, message.data);
      }
      // No connection to send PTY input to: dropped silently. There is no
      // response channel for `sendData` (see `ipc-contract.ts`), so there is
      // nothing meaningful to reject — the renderer already knows the
      // connection state via `BridgeStateMessage` and is expected not to be
      // sending input while it isn't `'connected'`.
      return;
    }

    if (this.relay === undefined) {
      this.options.sendToRenderer({
        kind: 'response',
        id: message.id,
        outcome: {
          ok: false,
          error: {
            code: 'bridge_not_connected',
            message:
              this.reason === undefined
                ? `cannot perform request "${message.method}": daemon connection is "${this.state}"`
                : `cannot perform request "${message.method}": daemon connection is "${this.state}" (${this.reason})`,
          },
        },
      });
      return;
    }

    this.relay.handleRequest(message).catch((err: unknown) => {
      // `DaemonRelay.handleRequest` catches everything it can attribute to
      // the request itself (see that method) — reaching here would be a
      // bug in the relay, not a daemon/renderer failure, so it is logged
      // rather than silently dropped.
      console.error('[TermHub] unexpected error handling bridge request', err);
    });
  }

  /** Tears down this window's bridge: unsubscribes from the `TransportClient` (via the `DaemonRelay`, if any) and stops sending anything further. Safe to call before the connection has even settled. Does not touch the `TransportClient` itself (armadilha 5 — see `DaemonRelay.dispose`'s doc comment). Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.relay?.dispose();
    this.relay = undefined;
    this.closeSubscription?.dispose();
    this.closeSubscription = undefined;
  }

  private async awaitConnection(): Promise<void> {
    const result = await this.options.connectionPromise;
    if (this.disposed) {
      return;
    }
    this.onConnectionSettled(result);
  }

  private onConnectionSettled(result: DaemonConnection): void {
    this.reason = outcomeReason(result);
    if (result.outcome === 'connected') {
      this.state = 'connected';
      this.relay = new DaemonRelay({
        client: result.client,
        sendToRenderer: this.options.sendToRenderer,
        ...(this.options.coalesceWindowMs !== undefined
          ? { coalesceWindowMs: this.options.coalesceWindowMs }
          : {}),
        ...(this.options.coalesceByteLimitBytes !== undefined
          ? { coalesceByteLimitBytes: this.options.coalesceByteLimitBytes }
          : {}),
      });
      this.closeSubscription = result.client.onClose(() => {
        this.onClientClosed();
      });
    } else {
      this.state = result.outcome;
    }
    this.sendState();
  }

  private onClientClosed(): void {
    if (this.disposed) {
      return;
    }
    this.relay?.dispose();
    this.relay = undefined;
    this.closeSubscription = undefined;
    this.state = 'disconnected';
    this.reason = undefined;
    this.sendState();
  }

  private sendState(): void {
    this.options.sendToRenderer({
      kind: 'state',
      state: this.state,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    });
  }
}
