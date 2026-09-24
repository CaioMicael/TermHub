// The wire contract between `main`'s daemon bridge and `preload`'s exposed
// `window.termhub` API — imported by both sides (M2.2, docs/milestones.md).
//
// This file is loaded by the sandboxed preload script, so it must never pull
// in a runtime dependency beyond plain JS/TS: `import type` from
// `@termhub/shared` is fine (erased at compile time, nothing left to
// `require`), but a *value* import from `@termhub/shared` — or from any
// other workspace package — is not (see this task's final report,
// "armadilha 4": a stray `require` left in `dist/preload/index.js` makes the
// sandboxed preload fail to load silently, and `window.termhub` ends up
// `undefined` with no error a Vitest suite would ever see).
//
// Every message shape below is plain, JSON-clonable data: no class
// instances, no `Error`, nothing with a prototype chain that needs to
// survive a `structuredClone`-style boundary (Node's real one between main
// and renderer, and this repo's own fake one in tests — see
// `daemon-relay.integration.test.ts`). That is deliberate: see
// `BridgeErrorPayload`'s doc comment for why RPC errors are carried as plain
// data instead of thrown `Error`s.

import type {
  EventPayloadByName,
  JsonEventName,
  ProtocolErrorCode,
  RequestMethod,
  SessionId,
} from '@termhub/shared';

/**
 * Both directions use exactly one Electron IPC channel each — not one
 * channel per message kind. `RelayOutboundMessage`'s `kind` field is what a
 * listener switches on instead. This is armadilha 2 from the task prompt
 * taken to its simplest conclusion: `webContents.send`/`ipcRenderer.send`
 * only promise delivery order *within* a channel (the same underlying
 * ordered Chromium IPC stream carries every message sent through them,
 * regardless of channel name, but this repo doesn't need to lean on that
 * cross-channel claim at all when a single channel already trivially
 * guarantees it). See the final report for the alternative considered
 * (one channel per kind) and why it was dropped.
 */
export const IPC_CHANNEL = {
  FROM_RENDERER: 'termhub:from-renderer',
  TO_RENDERER: 'termhub:to-renderer',
} as const;

/**
 * Wire-safe shape of an RPC failure, deliberately **not** an `Error`
 * instance and deliberately **not** thrown across `contextBridge`.
 *
 * Electron's `contextBridge` clones values crossing the isolated-world
 * boundary, and `Error` objects are a documented lossy special case there:
 * a thrown/rejected `Error`'s custom properties (here, `code`/`details`) and
 * its prototype chain (so `instanceof ProtocolError` stays true) do not
 * survive the crossing — see this task's final report for the exact
 * Electron documentation this is based on. A *plain* object, by contrast,
 * clones with every enumerable own property intact, no matter how it is
 * used (returned, or used as a rejection reason). `request()`'s returned
 * `Promise` therefore rejects with a `BridgeErrorPayload` value, not an
 * `Error` — callers distinguish failures with `err.code`, never
 * `instanceof`.
 */
export interface BridgeErrorPayload {
  code:
    | ProtocolErrorCode
    // Bridge-level failures that never reach the daemon at all — a request
    // for a method outside `RequestMethod`, or one made while there is no
    // usable daemon connection (see `BridgeConnectionState`).
    | 'bridge_rejected_method'
    | 'bridge_not_connected'
    | 'bridge_internal_error';
  message: string;
  details?: unknown;
}

/**
 * Renderer -> main: the first message a freshly loaded preload sends,
 * before anything else (docs/specs/m2.6-boot-reattach.md section 3.3). Each
 * page load (initial boot, a `webContents.reload()`, a crash-and-recover)
 * gets its own `instanceId`, generated in the preload — see
 * `preload/bridge.ts`'s `createBridge` for how, and this task's report for
 * whether `crypto.randomUUID()` is actually available there.
 *
 * `main`'s job on `hello`: adopt `instanceId` as the current instance for
 * this `webContents` (`bridge-gateway.ts`'s `BridgeGateway`), release
 * whatever the *previous* instance (if any) still held via
 * `SessionAttachments.releaseAll`, discard that previous instance's
 * still-in-flight request bookkeeping, and answer with the connection's
 * current state over the same ordered channel — closing defect 2.4 ("o
 * renderer novo não descobre o estado da conexão") by making state
 * *pullable*, not just pushed.
 */
export interface BridgeHelloMessage {
  kind: 'hello';
  instanceId: string;
}

/** Renderer -> main: an RPC call. `params` stays `unknown` on the wire — the typed `request<M>` surface lives only in `preload/bridge.ts`'s `PreloadBridge` interface, the layer a renderer consumer actually calls. */
export interface BridgeRequestMessage {
  kind: 'request';
  /** Correlates with the matching `BridgeResponseMessage.id`. Generated in the preload, per call — and, since the preload's own id counter restarts at every page load (M2.2's original design), no longer unique *across* instances on its own (docs/specs/m2.6-boot-reattach.md section 2.5). */
  id: string;
  /**
   * The `hello` instance this request came from (`BridgeHelloMessage`'s
   * `instanceId`) — optional at the *type* level only so tests exercising
   * `DaemonRelay`/`BridgeGateway` directly, without a `hello` handshake at
   * all (`daemon-relay.test.ts`, several of `bridge-gateway.test.ts`'s own
   * cases), don't have to fabricate one: `BridgeGateway` treats "no
   * `instanceId` on the message" and "no `hello` ever received" as the same
   * (both `undefined`) instance, so those tests keep working unmodified.
   * The real preload (`preload/bridge.ts`) always sets it, on every
   * request, once its own `hello` has gone out.
   */
  instanceId?: string;
  method: string;
  params: unknown;
}

/** Renderer -> main: PTY keyboard/paste input. No response, no coalescing (see `DaemonRelay.sendData`'s doc comment) — this is the latency-sensitive path the M2.2 prompt calls out by name. `instanceId` is optional for the same reason `BridgeRequestMessage.instanceId` is (see its doc comment). */
export interface BridgeSendDataMessage {
  kind: 'sendData';
  instanceId?: string;
  sessionId: SessionId;
  data: Uint8Array;
}

export type RelayInboundMessage = BridgeHelloMessage | BridgeRequestMessage | BridgeSendDataMessage;

/** Main -> renderer: the reply to one `BridgeRequestMessage`. */
export interface BridgeResponseMessage {
  kind: 'response';
  id: string;
  outcome: { ok: true; result: unknown } | { ok: false; error: BridgeErrorPayload };
}

/** Main -> renderer: coalesced PTY output for one session (see `DaemonRelay`'s coalescing window). */
export interface BridgeDataMessage {
  kind: 'data';
  sessionId: SessionId;
  data: Uint8Array;
}

/** Main -> renderer: `session.exit` / `session.status` (never `session.data` — that is `BridgeDataMessage`). */
export interface BridgeEventMessage {
  kind: 'event';
  event: JsonEventName;
  payload: EventPayloadByName[JsonEventName];
}

/**
 * Renderer-visible state of the main process's connection to the daemon.
 * Mirrors `daemon-client.ts`'s `DaemonConnection` outcomes plus one state
 * that module never produces on its own: `'connecting'` (before the first
 * `connectToDaemon()` call settles — `main/index.ts` never awaits it before
 * opening the window, on purpose) and `'disconnected'` (the `TransportClient`
 * of an already-`'connected'` bridge closed).
 */
export type BridgeConnectionState =
  'connecting' | 'connected' | 'blocked' | 'failed' | 'disconnected';

/** Main -> renderer: a connection-state transition. `reason` is a human-readable string (e.g. `daemon-client.ts`'s `'blocked'` reason, or a `'failed'` outcome's last error message) — never a structured code; nothing here has parsed it as one anywhere in this bridge. */
export interface BridgeStateMessage {
  kind: 'state';
  state: BridgeConnectionState;
  reason?: string;
}

export type RelayOutboundMessage =
  BridgeResponseMessage | BridgeDataMessage | BridgeEventMessage | BridgeStateMessage;

/**
 * The explicit allowlist of request methods the main process will ever
 * forward to the daemon. Any `BridgeRequestMessage.method` outside this set
 * is rejected (`'bridge_rejected_method'`) before `TransportClient.request`
 * is ever called — the renderer cannot reach an arbitrary daemon RPC by
 * naming it.
 *
 * Kept as a plain runtime array (not derived from `RequestMethod` through
 * some type-level trick) so this file stays free of value-level dependence
 * on `@termhub/shared`'s exports; `readonly RequestMethod[]` is enough for
 * the compiler to flag this list drifting out of sync with
 * `RequestParamsByMethod`'s keys (a method added or renamed in
 * `packages/shared/src/protocol.ts` without a matching edit here is a type
 * error, not a silent gap).
 */
export const REQUEST_METHODS: readonly RequestMethod[] = [
  'session.create',
  'session.resize',
  'session.close',
  'session.list',
  'session.attach',
  'session.detach',
];
