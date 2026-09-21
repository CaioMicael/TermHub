// The RPC protocol and framing shared between the daemon and its clients
// (message types, encodeFrame/FrameDecoder) lives in `protocol.ts` (M1.1).
export const PROTOCOL_VERSION = 1;

export * from './protocol.js';
