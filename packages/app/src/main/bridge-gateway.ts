import type { SessionId } from '@termhub/shared';

import type { DaemonConnection } from './daemon-client.js';
import { DaemonRelay, toBridgeError } from './daemon-relay.js';
import type { DaemonRelayOptions } from './daemon-relay.js';
import type {
  BridgeConnectionState,
  BridgeRequestMessage,
  RelayInboundMessage,
  RelayOutboundMessage,
} from './ipc-contract.js';
import type { SessionAttachments } from './session-attachments.js';

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
//
// ## Renderer instances (docs/specs/m2.6-boot-reattach.md section 3.3)
//
// Every message the renderer sends now carries an `instanceId` (set by the
// preload's own `hello`, `ipc-contract.ts`'s `BridgeHelloMessage`) — one per
// page load, so a window reload (or a crash-and-recover) is a *new*
// instance sharing the same `webContents`/`ipcMain` channel as the old one.
// This class is the only place that:
//
// - Tracks which instance is "current" for this window (`currentInstanceId`)
//   and ignores any inbound message tagged with a different one (a stale
//   page still finishing up after a reload) — closing defect 2.5's request-
//   id collision, since a request only ever gets dispatched if it belongs
//   to the instance that is current *at the time it arrives*.
// - Drops a *response* whose owning instance was superseded by the time the
//   daemon answered, even though the request itself was legitimately
//   dispatched before that happened (`requestOwners`, `sendFiltered`) —
//   the other half of 2.5: a same-numbered request from the *new* page must
//   never be resolved by the *old* page's late answer.
// - Gates every outbound `session.data` chunk through `SessionAttachments.
//   accepts()` (routing rule 4) — a session leaving `attaching`/`attached`
//   for this window's holder (a `release`/`releaseAll`, e.g. this window's
//   own reload) stops delivering that session's bytes immediately, closing
//   defect 2.3 without any timing assumption.
// - Intercepts `session.attach`/`session.detach` requests from the renderer
//   and routes them to `SessionAttachments` instead of forwarding them raw
//   to `DaemonRelay` — `SessionAttachments` is the only thing allowed to
//   call those two methods on the daemon (section 3.2).
//
// `sessionAttachments` is optional at the type level so every pre-M2.6 test
// that constructs a `BridgeGateway` without it (this file's own tests that
// never send a `hello`, and `daemon-relay.integration.test.ts`'s pipeline)
// keeps working exactly as before: with no book, `session.data` passes
// through unfiltered (the M2.2 behavior) and `session.attach`/`session.
// detach` fail closed with the same `'bridge_not_connected'`-shaped error
// every other method gets without a usable connection.

export interface BridgeGatewayOptions {
  /** Delivers one outbound message to this gateway's window. Always the same mechanism regardless of `message.kind` (see `ipc-contract.ts`'s header comment). */
  sendToRenderer: (message: RelayOutboundMessage) => void;
  /** Settles once (`connectToDaemon()`'s own contract) with the outcome this gateway should reflect as connection state. */
  connectionPromise: Promise<DaemonConnection>;
  /**
   * The app-wide `session.attach`/`session.detach` book (docs/specs/
   * m2.6-boot-reattach.md section 3.2), one per daemon connection, shared
   * by every window's `BridgeGateway` — never constructed here, since this
   * class is per-window and the book explicitly is not. `main/index.ts`
   * builds one promise (derived from the same `connectionPromise` every
   * gateway gets) and passes it to each gateway it creates. Omitted
   * entirely by tests that don't need attach/detach routing at all.
   */
  sessionAttachments?: Promise<SessionAttachments | undefined>;
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

  private sessionAttachments: SessionAttachments | undefined;
  /** The `instanceId` of the most recent `hello` this gateway has processed — `undefined` until the first one arrives. */
  private currentInstanceId: string | undefined;
  /**
   * Every in-flight request's **internal** id -> `{ instanceId, originalId }`
   * (docs/specs/m2.6-boot-reattach.md section 2.5/3.3). `originalId` is
   * whatever the renderer itself sent as `BridgeRequestMessage.id` —
   * `preload/bridge.ts`'s own counter, which restarts at every page load —
   * so two different instances can (and, in the exact required test 4
   * scenario, do) send the *same* string id.
   *
   * Keying this map by `originalId` directly would be wrong: instance A's
   * still-in-flight request and instance B's brand new one could share a
   * key, and whichever one's daemon response settled second would silently
   * overwrite the other's ownership record — turning a request-id
   * collision the renderer-instance tagging is supposed to catch into a
   * response-id collision one layer down instead. `handleRendererMessage`
   * mints a fresh, gateway-wide-unique `internalId` for every request
   * before handing it to `DaemonRelay`/`handleAttachmentRequest`, so this
   * map's own keys never collide regardless of what the renderer chose;
   * `sendFiltered` rewrites a response's `id` back to `originalId` only
   * once it has confirmed, via this map, which instance actually owns it.
   */
  private readonly requestOwners = new Map<
    string,
    { instanceId: string | undefined; originalId: string }
  >();
  private nextInternalRequestId = 1;

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

    options.sessionAttachments
      ?.then((book) => {
        if (!this.disposed) {
          this.sessionAttachments = book;
        }
      })
      .catch((err: unknown) => {
        // Same stance as the connection promise above: not documented to
        // reject (`main/index.ts` derives it from `connectionPromise` with
        // a `.then` that never throws), so this only guards against a
        // genuinely unexpected failure.
        console.error('[TermHub] session attachments promise rejected unexpectedly', err);
      });
  }

  /** Current connection state, for a renderer that asks after this gateway already settled (this class has no async "get state" of its own — `main/index.ts` only ever needs this for tests/diagnostics; the renderer learns state via `BridgeStateMessage`). */
  get connectionState(): { state: BridgeConnectionState; reason?: string } {
    return this.reason === undefined
      ? { state: this.state }
      : { state: this.state, reason: this.reason };
  }

  /** Routes one message from the renderer: a `hello` handshake, an RPC request, or PTY input. */
  handleRendererMessage(message: RelayInboundMessage): void {
    if (this.disposed) {
      return;
    }

    if (message.kind === 'hello') {
      this.handleHello(message.instanceId);
      return;
    }

    // docs/specs/m2.6-boot-reattach.md section 3.3: "Mensagem com instanceId
    // diferente da corrente é ignorada." `message.instanceId` and
    // `this.currentInstanceId` being *both* `undefined` (no `hello` was
    // ever sent, or this message predates it) counts as a match on purpose
    // — see `ipc-contract.ts`'s `BridgeRequestMessage.instanceId` doc
    // comment for why: it is what keeps every pre-M2.6 test that never
    // sends a `hello` working unmodified.
    if (message.instanceId !== this.currentInstanceId) {
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

    // `message.kind === 'request'` from here on. Every request gets a fresh,
    // gateway-wide-unique internal id — never `message.id` itself, which is
    // only unique *within one renderer instance's own counter* (see
    // `requestOwners`'s doc comment for why reusing it directly would
    // reopen exactly the collision this rewriting exists to prevent). The
    // rewritten copy (`internalMessage`) is what every downstream path —
    // this method's own attach/detach handling, or `DaemonRelay`
    // asynchronously — actually dispatches and answers; `sendFiltered`
    // rewrites the id back to `originalId` only after confirming ownership.
    const internalId = `gw-req-${this.nextInternalRequestId}`;
    this.nextInternalRequestId += 1;
    this.requestOwners.set(internalId, { instanceId: message.instanceId, originalId: message.id });
    const internalMessage: BridgeRequestMessage = { ...message, id: internalId };

    if (message.method === 'session.attach' || message.method === 'session.detach') {
      // docs/specs/m2.6-boot-reattach.md section 3.2: these two methods are
      // never forwarded raw to the daemon by `DaemonRelay` — `
      // SessionAttachments` is the only caller of `session.attach`/
      // `session.detach` on the real connection.
      this.handleAttachmentRequest(internalMessage);
      return;
    }

    if (this.relay === undefined) {
      this.sendFiltered({
        kind: 'response',
        id: internalId,
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

    this.relay.handleRequest(internalMessage).catch((err: unknown) => {
      // `DaemonRelay.handleRequest` catches everything it can attribute to
      // the request itself (see that method) — reaching here would be a
      // bug in the relay, not a daemon/renderer failure, so it is logged
      // rather than silently dropped.
      console.error('[TermHub] unexpected error handling bridge request', err);
    });
  }

  /**
   * Releases every session the *current* renderer instance holds — via
   * `SessionAttachments.releaseAll` — and retires that instance's still-
   * pending request bookkeeping, without tearing down this gateway's
   * connection to the daemon. Called from three places (docs/specs/
   * m2.6-boot-reattach.md section 3.3): a new `hello` (releasing the
   * *previous* instance before adopting the new one), `dispose()` (a
   * closed/destroyed window), and `wireWebContentsLifecycle`'s
   * `'render-process-gone'` handler (a crashed renderer that might still
   * recover with a fresh `hello`, so the gateway itself must not be
   * disposed for that case). Safe to call with no current instance (a
   * no-op) — idempotent.
   */
  releaseCurrentInstance(): void {
    const previous = this.currentInstanceId;
    if (previous !== undefined) {
      const book = this.sessionAttachments;
      // Captured *before* `releaseAll` — once it runs, `holderSessions`
      // would already report none of these as `previous`'s anymore, and
      // this list is exactly what needs its coalescer discarded (see
      // `DaemonRelay.discardPending`'s doc comment for why gating only at
      // flush time is not enough).
      const sessionsToDiscard = book?.holderSessions(previous) ?? [];
      book?.releaseAll(previous);
      for (const sessionId of sessionsToDiscard) {
        this.relay?.discardPending(sessionId);
      }
      // Best-effort memory hygiene: a response for one of these ids would
      // still be correctly dropped by `sendFiltered`'s ownership check even
      // without this (the entry, if left in place, still says `instanceId:
      // previous`, which will never again equal `this.currentInstanceId`)
      // — this just stops the map from growing for a request that never
      // gets an answer.
      for (const [internalId, owner] of this.requestOwners) {
        if (owner.instanceId === previous) {
          this.requestOwners.delete(internalId);
        }
      }
    }
    this.currentInstanceId = undefined;
  }

  /** Tears down this window's bridge: unsubscribes from the `TransportClient` (via the `DaemonRelay`, if any), releases everything the current instance holds, and stops sending anything further. Safe to call before the connection has even settled. Does not touch the `TransportClient` itself (armadilha 5 — see `DaemonRelay.dispose`'s doc comment). Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseCurrentInstance();
    this.relay?.dispose();
    this.relay = undefined;
    this.closeSubscription?.dispose();
    this.closeSubscription = undefined;
  }

  private handleHello(instanceId: string): void {
    // Release whatever the *previous* instance (if any) still held before
    // adopting the new one — section 3.3's "faz releaseAll da instância
    // anterior". A no-op the very first time (no previous instance yet).
    this.releaseCurrentInstance();
    this.currentInstanceId = instanceId;
    // Answer with the connection's current state over the same ordered
    // channel — closing defect 2.4 by making state *pullable*, not only
    // pushed on transitions. Reuses the exact same `BridgeStateMessage`
    // shape/path a real transition uses, so the renderer's handling of it
    // doesn't need to know "pushed" from "answered".
    this.sendState();
  }

  /**
   * `session.attach`/`session.detach` from the renderer, routed to
   * `SessionAttachments` instead of `DaemonRelay` (docs/specs/
   * m2.6-boot-reattach.md section 3.2). `message.params` is cast, not
   * validated — same trust boundary `DaemonRelay`/`TransportServer.
   * registerMethod` already take with `unknown` wire params elsewhere in
   * this bridge: a malformed `params` here reaches `SessionAttachments`
   * with a `sessionId` of whatever shape the (already-sandboxed, only-
   * allowlisted-method) renderer sent, exactly as every other forwarded
   * request already does.
   */
  private handleAttachmentRequest(message: BridgeRequestMessage): void {
    const book = this.sessionAttachments;
    if (book === undefined) {
      this.sendFiltered({
        kind: 'response',
        id: message.id,
        outcome: {
          ok: false,
          error: {
            code: 'bridge_not_connected',
            message: `cannot perform request "${message.method}": daemon connection is "${this.state}"`,
          },
        },
      });
      return;
    }

    // `''` for a request with no `instanceId` (the pre-hello/test-only
    // case `ipc-contract.ts`'s doc comment describes) — a concrete,
    // consistent holder key rather than `undefined`, since `SessionAttachments`
    // keys its `Set<RendererKey>`/`Map` by value and has no `undefined`
    // holder concept of its own.
    const holder = message.instanceId ?? '';
    const params = message.params as { sessionId: SessionId };

    if (message.method === 'session.attach') {
      void book.acquire(holder, params.sessionId).then(
        (result) => {
          this.sendFiltered({ kind: 'response', id: message.id, outcome: { ok: true, result } });
        },
        (err: unknown) => {
          this.sendFiltered({
            kind: 'response',
            id: message.id,
            outcome: { ok: false, error: toBridgeError(err) },
          });
        },
      );
      return;
    }

    // session.detach: synchronous and void at the book level (`release`
    // never throws), and — per protocol.ts's `SessionDetachResult` /
    // docs/specs/m1.7-attach-detach.md section 4 — always resolves
    // successfully to the renderer even when it doesn't reach the daemon
    // (other holders remain, so nothing is actually sent).
    book.release(holder, params.sessionId);
    // Same reasoning as `releaseCurrentInstance` — see `DaemonRelay.
    // discardPending`'s doc comment. Harmless if this holder never actually
    // held `params.sessionId` (nothing pending to discard) or if the
    // session stays accepted for other holders (their own window has its
    // own `DaemonRelay`/coalescer, untouched by this one).
    this.relay?.discardPending(params.sessionId);
    this.sendFiltered({ kind: 'response', id: message.id, outcome: { ok: true, result: {} } });
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
        sendToRenderer: (message) => {
          this.sendFiltered(message);
        },
        // Routing rule 4 at admission (docs/specs/m2.6-boot-reattach.md
        // section 3.2), not only at flush time — see `DaemonRelayOptions.
        // admitData`'s doc comment for why the flush-time check in
        // `sendFiltered` alone cannot prevent stale, pre-detach live output
        // from mixing into the same coalesced buffer as a following fresh
        // attach's snapshot. Reads `this.sessionAttachments`/
        // `this.currentInstanceId` fresh on every call, since both can
        // change over this relay's lifetime (a reload, a new connection).
        admitData: (sessionId) => {
          const book = this.sessionAttachments;
          if (book === undefined) {
            return true; // no book configured: preserve the M2.2 broadcast-everything behavior
          }
          const holder = this.currentInstanceId;
          return holder !== undefined && book.accepts(holder, sessionId);
        },
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
    this.sendFiltered({
      kind: 'state',
      state: this.state,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    });
  }

  /**
   * The single choke point every outbound message (this gateway's own
   * `'state'` sends, `DaemonRelay`'s responses/data/events, and this
   * gateway's own synthesized `session.attach`/`session.detach` responses)
   * passes through, applying docs/specs/m2.6-boot-reattach.md section 3.2's
   * routing rule 4 and section 3.3's stale-response guard before finally
   * calling `options.sendToRenderer`:
   *
   * - `'response'`: dropped if the request it answers belonged to an
   *   instance this gateway has since superseded (a `hello` arrived before
   *   the answer did) — closing defect 2.5. Passes through unfiltered if no
   *   owner was ever recorded for this id (the same "no hello ever sent"
   *   backward-compatibility case `handleRendererMessage`'s own instance
   *   check documents).
   * - `'data'`: dropped unless `sessionAttachments` is configured *and*
   *   the current instance is an accepted holder of that session right now
   *   (`SessionAttachments.accepts`) — closing defect 2.3. Passes through
   *   unfiltered when no book is configured at all, preserving the M2.2
   *   broadcast-everything behavior for callers/tests that never wire one.
   * - Anything else (`'state'`, `'event'`): unfiltered, exactly as before.
   */
  private sendFiltered(message: RelayOutboundMessage): void {
    if (message.kind === 'response') {
      // `message.id` here is the *internal* id `handleRendererMessage`
      // minted — never `originalId` yet (see `requestOwners`'s doc comment
      // on why using the renderer's own id as this map's key would be
      // wrong). Every response reaching this method was produced from an
      // `internalMessage` this gateway itself constructed, so a missing
      // entry is defensive-only (would mean this id was never registered,
      // or was already delivered/dropped once).
      const owner = this.requestOwners.get(message.id);
      this.requestOwners.delete(message.id);
      if (owner === undefined || owner.instanceId !== this.currentInstanceId) {
        return;
      }
      this.options.sendToRenderer({ ...message, id: owner.originalId });
      return;
    }

    if (message.kind === 'data') {
      const book = this.sessionAttachments;
      if (book === undefined) {
        this.options.sendToRenderer(message);
        return;
      }
      const holder = this.currentInstanceId;
      if (holder === undefined || !book.accepts(holder, message.sessionId)) {
        return;
      }
      this.options.sendToRenderer(message);
      return;
    }

    this.options.sendToRenderer(message);
  }
}

/**
 * Minimal structural shape of Electron's `WebContents` this helper needs —
 * narrow enough to satisfy with a plain `EventEmitter` in tests (this
 * file's own "no `electron` import" contract; a real `BrowserWindow.
 * webContents` satisfies it too, structurally, with no adapter needed).
 */
export interface MinimalWebContentsForLifecycle {
  on(event: 'destroyed' | 'render-process-gone', listener: (...args: unknown[]) => void): unknown;
}

/**
 * Wires `webContents`'s `'destroyed'` and `'render-process-gone'` events to
 * `gateway.releaseCurrentInstance()` — docs/specs/m2.6-boot-reattach.md
 * section 3.3's "closed, destroyed e render-process-gone do webContents
 * fazem releaseAll da instância corrente". `main/index.ts` calls this with
 * a real `BrowserWindow`'s `webContents`; `bridge-gateway.test.ts` calls it
 * with a fake emitter (required test 5).
 *
 * `'closed'` itself (`BrowserWindow`'s own event, not `webContents`'s) is
 * handled separately in `main/index.ts`, by calling `gateway.dispose()` —
 * which already calls `releaseCurrentInstance()` as part of tearing the
 * whole bridge down — because a closed window's bridge should stop
 * responding entirely, unlike a `render-process-gone` crash the window can
 * still recover from with a fresh `hello`.
 */
export function wireWebContentsLifecycle(
  webContents: MinimalWebContentsForLifecycle,
  gateway: BridgeGateway,
): void {
  webContents.on('destroyed', () => {
    gateway.releaseCurrentInstance();
  });
  webContents.on('render-process-gone', () => {
    gateway.releaseCurrentInstance();
  });
}
