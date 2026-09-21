// The daemon's transport layer (M1.2): a `net` server on a named pipe (unix
// socket off Windows) speaking the wire protocol packages/shared/src/
// protocol.ts (M1.1) defines, plus the client that talks to it. This is
// where the UI (via M2.1's daemon-client.ts) and the M1.8 CLI diagnostic
// will eventually connect — but this module itself knows nothing about
// sessions, PTYs, or the registry. It is generic RPC plumbing:
//
// - `TransportServer` (transport-server.ts): listens, handshakes each
//   connecting client (token + protocol version, with a timeout), and
//   dispatches `request`s to handlers registered by name
//   (`registerMethod`). `session.create`/`write`/`resize`/`close`/`list`/
//   `attach`/`detach` are M1.5's handlers, registered from outside — this
//   package's own tests register a throwaway `ping` handler instead.
// - `TransportClient` (transport-client.ts): connects, handshakes, and
//   exposes `request(method, params)` plus subscriptions for broadcast
//   events/data.
// - `transport-wire.ts`: the generic (non-session-specific) JSON envelope
//   shapes both sides speak, and the one documented cast boundary to
//   protocol.ts's closed `ControlMessage` type — see that file's header
//   comment for why the boundary exists and why it's safe.
// - `transport-socket.ts`: the shared per-connection plumbing (frame
//   decoding, backpressure-aware writes) both the server's per-client
//   connections and the client's own socket are built on.
// - `transport-address.ts`: derives the pipe/socket path from the OS
//   username (docs/plan.md section 3).
//
// See this module's own test suite (transport.test.ts) for the real
// client<->server integration coverage — concurrent/interleaved requests,
// bad-token/version-mismatch/handshake-timeout rejection, a malformed frame
// taking down only its own connection, and binary broadcast integrity.

export { resolvePipeAddress, derivePipeName, formatPipePath } from './transport-address.js';
export type { PipeAddressOptions } from './transport-address.js';

export { TransportServer } from './transport-server.js';
export type { MethodHandler, RequestContext, TransportServerOptions } from './transport-server.js';

export { TransportClient } from './transport-client.js';
export type { Disposable, TransportClientOptions } from './transport-client.js';

export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  encodeWireControl,
  encodeWireData,
  fromControlMessage,
} from './transport-wire.js';
export type { WireControlMessage, WireEvent, WireRequest, WireResponse } from './transport-wire.js';
