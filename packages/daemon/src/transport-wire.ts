import { encodeControlFrame, encodeDataFrame } from '@termhub/shared';
import type {
  ControlMessage,
  Frame,
  HandshakeAckMessage,
  HandshakeMessage,
  ProtocolErrorPayload,
  SessionId,
} from '@termhub/shared';

// The generic RPC envelope shapes this transport actually puts on the wire,
// plus the one deliberately-documented boundary where they get cast into
// `@termhub/shared`'s `ControlMessage` so `encodeControlFrame` can turn them
// into bytes.
//
// ## Why this file exists instead of reusing `RequestEnvelope`/`ResponseEnvelope`/`EventEnvelope` directly
//
// `packages/shared/src/protocol.ts` (M1.1) types `RequestEnvelope` /
// `ResponseEnvelope` as a mapped union over `RequestMethod` (`keyof
// RequestParamsByMethod`), and `EventEnvelope` similarly over
// `JsonEventName`. Both are closed to the seven `session.*` RPCs / two
// `session.*` events M1.5+ will register. M1.2's job is explicitly the
// opposite: a transport that "não liga nada a sessões" — method handlers
// and events are registered from outside by name, and this task's own test
// suite registers a `ping` method that is not, and cannot be, a member of
// `RequestMethod`. There is no way to construct `{ kind: 'request', method:
// 'ping', ... }` that type-checks as `RequestEnvelope` without widening
// `RequestMethod` itself — which would mean editing packages/shared, out of
// scope for this task (see the final report for this as a flagged
// observation, not a change made here).
//
// So this module defines its own generic envelope types (`method`/`event`
// as `string`, `params`/`result`/`payload` as `unknown`) that are wire-
// compatible with what protocol.ts's `isControlMessage`/`FrameDecoder`
// actually validate at runtime (only the `kind` discriminant — see
// protocol.ts's `isControlMessage`, which never inspects `method` or
// `event`). `toControlMessage` below is the single, narrow, documented cast
// from "generic wire envelope" to "the closed `ControlMessage` type
// `encodeControlFrame` demands" — safe because `encodeControlFrame` only
// ever `JSON.stringify`s its argument, it does not branch on `method`
// either. Everything else in this transport works with the generic types,
// never with `RequestEnvelope`/`ResponseEnvelope`/`EventEnvelope` directly.

/** A request envelope for an arbitrary, transport-registered method (see `TransportServer.registerMethod`). */
export interface WireRequest {
  kind: 'request';
  id: string;
  method: string;
  params: unknown;
}

/** A response envelope for an arbitrary method, success or failure. */
export type WireResponse =
  | { kind: 'response'; id: string; method: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; method: string; ok: false; error: ProtocolErrorPayload };

/** A broadcast event envelope for an arbitrary, caller-chosen event name (see `TransportServer.broadcastEvent`). */
export interface WireEvent {
  kind: 'event';
  event: string;
  payload: unknown;
}

/** Every JSON (type-0) control message this transport sends or receives, generic version of protocol.ts's `ControlMessage`. */
export type WireControlMessage =
  WireRequest | WireResponse | WireEvent | HandshakeMessage | HandshakeAckMessage;

/**
 * The one cast boundary described in this file's header comment. `unknown`
 * as the intermediate step (rather than casting `WireControlMessage`
 * straight to `ControlMessage`) is deliberate: it is the idiomatic
 * TypeScript way to say "these two types are structurally incompatible by
 * design, and that's expected here", which is more honest than pretending
 * `WireControlMessage` is assignable to `ControlMessage` when the whole
 * point is that it deliberately isn't for the `method`/`event` fields.
 */
function toControlMessage(message: WireControlMessage): ControlMessage {
  return message as unknown as ControlMessage;
}

/** Encodes any generic control message (request, response, event, handshake, or handshake-ack) into wire bytes via protocol.ts's `encodeControlFrame`. */
export function encodeWireControl(message: WireControlMessage): Buffer {
  return encodeControlFrame(toControlMessage(message));
}

/** Encodes a PTY data frame. Thin re-export so callers of this module never need to import `@termhub/shared` directly just for framing. */
export function encodeWireData(sessionId: SessionId, data: Uint8Array): Buffer {
  return encodeDataFrame(sessionId, data);
}

/**
 * Widens a decoded control-frame's `message` (typed by protocol.ts as the
 * closed `ControlMessage`) to this module's generic `WireControlMessage`
 * for the transport's own dispatch logic. No cast needed for this
 * direction — every `ControlMessage` variant's `method`/`event` is a
 * string literal type, which is already assignable to
 * `WireControlMessage`'s plain `string`; only the reverse direction
 * (`toControlMessage`, above) narrows and needs an explicit assertion. This
 * function exists anyway so call sites read "convert wire message" the
 * same way on both sides of the transport, rather than the client/server
 * code relying on implicit structural assignability going one way and an
 * explicit cast the other.
 */
export function fromControlMessage(message: ControlMessage): WireControlMessage {
  return message;
}

/** Re-exported so callers only need to import from this module or transport.ts, not reach into `@termhub/shared` for framing types too. */
export type { Frame };

/**
 * Default milliseconds a connection gets to complete its handshake before
 * the server drops it (transport-server.ts), and the default a client
 * waits for the server's ack before giving up (transport-client.ts). One
 * constant, shared, so the two defaults can't silently drift apart.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
