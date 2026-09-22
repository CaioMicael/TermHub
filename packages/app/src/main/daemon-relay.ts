import { ProtocolError } from '@termhub/shared';
import type { EventPayloadByName, JsonEventName, SessionId } from '@termhub/shared';

import type { TransportClient } from '@termhub/daemon/src/transport-client.js';
import type { WireEvent } from '@termhub/daemon/src/transport-wire.js';

import { REQUEST_METHODS } from './ipc-contract.js';
import type {
  BridgeErrorPayload,
  BridgeRequestMessage,
  RelayOutboundMessage,
} from './ipc-contract.js';

// The main-side half of the IPC bridge that actually talks to a *connected*
// `TransportClient` — relaying its RPC responses, `session.data` output and
// `session.exit`/`session.status` events to the renderer, plus the ~8ms
// output coalescer (docs/plan.md section 5). Deliberately does not import
// `electron`: it is constructed with a `TransportClient` and a
// `sendToRenderer` callback, both supplied by the caller
// (`bridge-gateway.ts`, then ultimately `main/index.ts`), so this class is
// testable with a real `TransportServer`/`TransportClient` pair and a fake
// `sendToRenderer` — no Electron process required (see
// `daemon-relay.integration.test.ts`).
//
// ## Ordering contract (docs/specs/m1.7-attach-detach.md section 3.4, extended)
//
// The daemon guarantees data-before-control on its own wire: a
// `session.attach`'s snapshot frames arrive before that RPC's response, and
// a session's last output arrives before its `session.exit` event
// (`TransportClient.onData`'s own doc comment restates this). Coalescing
// output for up to `coalesceWindowMs` before it reaches the renderer would
// silently break that guarantee one hop later — the renderer could observe
// the RPC response, or the exit event, *before* the data it depended on,
// simply because that data was still sitting in this class's buffer waiting
// for its window to close. `flushAll()` is the fix: every session's pending
// buffer is flushed synchronously, in this same call stack, before any
// response or event is handed to `sendToRenderer`. See `handleRequest` and
// `onEvent` below — neither ever calls `sendToRenderer` for a response/event
// without calling `flushAll()` immediately first.

const DEFAULT_COALESCE_WINDOW_MS = 8;

interface PendingSessionOutput {
  chunks: Uint8Array[];
  byteLength: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface DaemonRelayOptions {
  client: TransportClient;
  /** Delivers one outbound message to the renderer. Always the same IPC mechanism regardless of `message.kind` — see `ipc-contract.ts`'s header comment (armadilha 2). */
  sendToRenderer: (message: RelayOutboundMessage) => void;
  /** Coalescing window, in milliseconds. Defaults to `DEFAULT_COALESCE_WINDOW_MS` (8, docs/plan.md section 5). */
  coalesceWindowMs?: number;
  /**
   * Optional early-flush threshold: once a session's buffered-but-unsent
   * output reaches this many bytes, it is flushed immediately instead of
   * waiting out the rest of the window. `undefined` (the default) disables
   * this — coalescing is then purely window-based. Exists so a burst
   * (e.g. `cat` on a large file) doesn't grow an unbounded buffer for the
   * whole 8ms if the daemon happens to hand it over in many small frames.
   */
  coalesceByteLimitBytes?: number;
}

function concatUint8Arrays(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (only !== undefined) {
    return only;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Converts whatever `TransportClient.request` rejected with into the plain, `contextBridge`-safe shape `ipc-contract.ts`'s `BridgeErrorPayload` documents. */
function toBridgeError(err: unknown): BridgeErrorPayload {
  if (err instanceof ProtocolError) {
    return err.details === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof Error) {
    return { code: 'bridge_internal_error', message: err.message };
  }
  return { code: 'bridge_internal_error', message: String(err) };
}

/** `Set.prototype.has` typed against `RequestMethod` would reject a plain `string` at the call site; the renderer's message is untrusted wire data, so the check has to start from `string` anyway. A `Set<string>` built once from `REQUEST_METHODS` is the allowlist check itself — see `ipc-contract.ts`'s doc comment on why `REQUEST_METHODS` stays a plain array there. */
const ALLOWED_METHODS = new Set<string>(REQUEST_METHODS);

export class DaemonRelay {
  private readonly client: TransportClient;
  private readonly sendToRenderer: (message: RelayOutboundMessage) => void;
  private readonly coalesceWindowMs: number;
  private readonly coalesceByteLimitBytes: number | undefined;
  private readonly pending = new Map<SessionId, PendingSessionOutput>();
  private readonly subscriptions: Array<{ dispose: () => void }> = [];
  private disposed = false;

  constructor(options: DaemonRelayOptions) {
    this.client = options.client;
    this.sendToRenderer = options.sendToRenderer;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.coalesceByteLimitBytes = options.coalesceByteLimitBytes;

    this.subscriptions.push(
      this.client.onData((sessionId, data) => {
        this.onData(sessionId, data);
      }),
    );
    this.subscriptions.push(
      this.client.onEvent((message) => {
        this.onEvent(message);
      }),
    );
  }

  /** Client -> daemon PTY input. Synchronous, no delay, no coalescing — this is the typing-latency path (see this task's final report for why the opposite direction is coalesced and this one deliberately is not). */
  sendData(sessionId: SessionId, data: Uint8Array): void {
    if (this.disposed) {
      return;
    }
    this.client.sendData(sessionId, data);
  }

  /** Handles one renderer RPC request: allowlist-checks the method, forwards it to the daemon, and relays the result — flushing this relay's coalescer (`flushAll`) first, per this file's ordering contract. */
  async handleRequest(message: BridgeRequestMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!ALLOWED_METHODS.has(message.method)) {
      this.sendToRenderer({
        kind: 'response',
        id: message.id,
        outcome: {
          ok: false,
          error: {
            code: 'bridge_rejected_method',
            message: `method "${message.method}" is not a recognized request method`,
          },
        },
      });
      return;
    }

    try {
      const result = await this.client.request(message.method, message.params);
      if (this.disposed) {
        return;
      }
      this.flushAll();
      this.sendToRenderer({ kind: 'response', id: message.id, outcome: { ok: true, result } });
    } catch (err) {
      if (this.disposed) {
        return;
      }
      this.flushAll();
      this.sendToRenderer({
        kind: 'response',
        id: message.id,
        outcome: { ok: false, error: toBridgeError(err) },
      });
    }
  }

  /** Unsubscribes from the `TransportClient`, clears every pending coalescer timer, and stops sending anything further — safe to call from a `webContents`/`BrowserWindow` `'closed'` handler with data still buffered (armadilha 5: no send after this, no timer left running). Idempotent. Does **not** touch `this.client` itself — the daemon connection and its sessions outlive one window's bridge (M2.6's job, not this one's). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    for (const [sessionId] of this.pending) {
      this.clearTimer(sessionId);
    }
    this.pending.clear();
  }

  private onData(sessionId: SessionId, data: Uint8Array): void {
    if (this.disposed) {
      return;
    }
    let entry = this.pending.get(sessionId);
    if (entry === undefined) {
      entry = { chunks: [], byteLength: 0, timer: undefined };
      this.pending.set(sessionId, entry);
    }
    entry.chunks.push(data);
    entry.byteLength += data.byteLength;

    if (
      this.coalesceByteLimitBytes !== undefined &&
      entry.byteLength >= this.coalesceByteLimitBytes
    ) {
      this.flushSession(sessionId);
      return;
    }
    if (entry.timer === undefined) {
      entry.timer = setTimeout(() => {
        this.flushSession(sessionId);
      }, this.coalesceWindowMs);
    }
  }

  private onEvent(message: WireEvent): void {
    if (this.disposed) {
      return;
    }
    // `session.data` never travels as a JSON event (protocol.ts's
    // `JsonEventName`) — only `session.exit`/`session.status` reach here.
    // Anything else is ignored for forward-compatibility, same stance
    // `TransportClient.onFrame` already takes for unrecognized control
    // messages.
    if (message.event !== 'session.exit' && message.event !== 'session.status') {
      return;
    }
    this.flushAll();
    this.sendToRenderer({
      kind: 'event',
      // The guard above already narrows `message.event` (declared `string`
      // on `WireEvent` — transport-wire.ts is deliberately generic, see that
      // file's own header comment) down to exactly `JsonEventName`, so no
      // cast is needed for it. `payload` (`unknown` on `WireEvent`) has
      // nothing to narrow *from* — this cast documents the assumption that
      // whatever sent this event (the daemon) shaped it correctly, the same
      // trust boundary `TransportServer.registerMethod`'s own doc comment
      // describes for RPC params/results.
      event: message.event,
      payload: message.payload as EventPayloadByName[JsonEventName],
    });
  }

  private clearTimer(sessionId: SessionId): void {
    const entry = this.pending.get(sessionId);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private flushSession(sessionId: SessionId): void {
    const entry = this.pending.get(sessionId);
    if (entry === undefined) {
      return;
    }
    this.clearTimer(sessionId);
    this.pending.delete(sessionId);
    if (entry.chunks.length === 0) {
      return;
    }
    const data = concatUint8Arrays(entry.chunks, entry.byteLength);
    this.sendToRenderer({ kind: 'data', sessionId, data });
  }

  /** Flushes every session with pending coalesced output, synchronously. See this file's header comment — this is the ordering fix, called right before any response/event reaches the renderer. */
  private flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.flushSession(sessionId);
    }
  }
}
