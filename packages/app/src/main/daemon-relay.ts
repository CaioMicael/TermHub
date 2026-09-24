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
  /**
   * Optional per-chunk admission gate (docs/specs/m2.6-boot-reattach.md
   * section 3.2 routing rule 4), consulted synchronously the instant a data
   * chunk arrives from `client.onData` — *before* it ever enters this
   * relay's coalescer — and dropped outright if it returns `false`.
   *
   * This is not redundant with gating only at flush time
   * (`sendToRenderer` only being called for an accepted session, which
   * `bridge-gateway.ts` also does). The coalescer accumulates every
   * incoming chunk for a session into *one* buffer regardless of
   * attachment state; gating only when that buffer is flushed cannot stop
   * a chunk that arrived *before* a `session.detach` from sitting in the
   * same buffer as one that arrives *after* a following fresh
   * `session.attach`, and being flushed together as if both belonged to
   * the new attachment — reordering stale, pre-detach live output ahead of
   * (or mixed into) the new attach's own snapshot.
   *
   * Gating at admission instead is exactly what the daemon's own FIFO
   * guarantee (docs/specs/m2.6-boot-reattach.md section 3.2: "o daemon
   * apaga o anexo de forma síncrona ao processar o detach e só depois
   * escreve a resposta; o socket é FIFO") makes safe: any chunk the daemon
   * sent while a connection was still attached arrives at `client.onData`
   * strictly *before* that `session.detach`'s own response frame — so by
   * the time this gate is consulted for such a chunk, whatever caller
   * tracks attachment state (`SessionAttachments`, via `bridge-gateway.ts`)
   * has not yet processed that response either, and still correctly
   * reports the chunk as not currently accepted.
   */
  admitData?: (sessionId: SessionId) => boolean;
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

/**
 * Converts whatever `TransportClient.request` rejected with into the plain,
 * `contextBridge`-safe shape `ipc-contract.ts`'s `BridgeErrorPayload`
 * documents. Exported (not just used internally) because `bridge-gateway.ts`
 * needs the exact same mapping for `session.attach`/`session.detach`
 * failures it now handles itself, via `SessionAttachments`, instead of
 * forwarding them through this class (docs/specs/m2.6-boot-reattach.md
 * section 3.2) — the renderer-visible error shape must stay identical
 * either way.
 */
export function toBridgeError(err: unknown): BridgeErrorPayload {
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
  private readonly admitData: ((sessionId: SessionId) => boolean) | undefined;
  private readonly pending = new Map<SessionId, PendingSessionOutput>();
  private readonly subscriptions: Array<{ dispose: () => void }> = [];
  private disposed = false;

  constructor(options: DaemonRelayOptions) {
    this.client = options.client;
    this.sendToRenderer = options.sendToRenderer;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.coalesceByteLimitBytes = options.coalesceByteLimitBytes;
    this.admitData = options.admitData;

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

  /**
   * Discards `sessionId`'s not-yet-flushed coalesced output, without
   * sending it and without touching any other session's buffer or timer.
   *
   * docs/specs/m2.6-boot-reattach.md section 3.2 rule 5: "O relay descarta
   * também o dado de S que ainda estava no coalescer (M2.2) quando S sai de
   * attaching/attached para aquele holder." `bridge-gateway.ts` calls this
   * the instant `SessionAttachments.release`/`releaseAll` stops accepting a
   * session for the current holder — gating *only* at flush time (checking
   * `accepts()` right before calling `sendToRenderer`) is not enough on its
   * own: this coalescer accumulates every incoming chunk for a session into
   * one buffer regardless of attachment state, so a chunk that arrived
   * *before* a `release` and one that arrives *after* a following fresh
   * `attach` can land in the *same* buffer and the *same* eventual flush if
   * nothing empties it in between — reordering a stale, pre-detach live
   * chunk ahead of the new attach's own snapshot in what the renderer
   * receives. Discarding synchronously, right when the session stops being
   * accepted, is what rules that out; a no-op if nothing is pending for
   * `sessionId`.
   */
  discardPending(sessionId: SessionId): void {
    this.clearTimer(sessionId);
    this.pending.delete(sessionId);
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
    if (this.admitData !== undefined && !this.admitData(sessionId)) {
      // Dropped before ever entering the coalescer — see `DaemonRelayOptions.
      // admitData`'s doc comment for why this has to happen here, not only
      // when a session's buffer is eventually flushed.
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
