// Wire protocol between the termhub-daemon (owner of the PTYs) and its
// clients (the Electron app's main process today; a CLI diagnostic tool and,
// per plan.md's "fora do escopo do v1" note, potentially a web/mobile viewer
// later). Everything here is pure TypeScript over `Buffer` — no dependency
// on `net`, Electron, or a schema library. The transport (named pipe server,
// actually reading off a `net.Socket`) is packages/daemon's job (M1.2).
//
// Frame format, fixed by docs/plan.md section 3 ("Framing"):
//
//   [uint32 length][uint8 type][payload...]
//
// - `length` is big-endian and counts every byte *after* the length field
//   itself — i.e. it includes the 1-byte `type` field.
// - `type` 0 is a control frame: payload is a UTF-8 JSON-encoded
//   `ControlMessage`.
// - `type` 1 is a PTY data frame, carried in both directions: payload is
//   `[uint32 sessionId][raw bytes]`, sessionId also big-endian.
//   Daemon->client it's a session's output; client->daemon it's keyboard/
//   pasted input (see `SessionDataPayload`'s doc comment and the RPC-methods
//   section below). This is the whole reason a binary frame type exists: PTY
//   traffic can be megabytes per second across several agents in either
//   direction, and it must never pay JSON/base64 encoding cost.
// - Any other `type` is a protocol error.

// ---------------------------------------------------------------------------
// Protocol errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable protocol error codes. Framing-level failures
 * (`INVALID_FRAME`, `FRAME_TOO_LARGE`, `MALFORMED_JSON`) are raised by this
 * module. The rest are here so the daemon and its clients share one
 * vocabulary for RPC-level failures (`ResponseEnvelope`'s `error` field,
 * `HandshakeAckMessage`'s `error` field) instead of each task inventing its
 * own strings.
 */
export const PROTOCOL_ERROR_CODE = {
  /** Malformed framing: corrupt/truncated length, unknown type, a data frame too short to hold its sessionId. */
  INVALID_FRAME: 'invalid_frame',
  /** The `length` field (or an encode-time payload) exceeds `MAX_FRAME_LENGTH`. */
  FRAME_TOO_LARGE: 'frame_too_large',
  /** A type-0 payload's bytes are not a well-formed JSON `ControlMessage`. */
  MALFORMED_JSON: 'malformed_json',
  /** Handshake token missing or incorrect. */
  UNAUTHORIZED: 'unauthorized',
  /** Client and daemon disagree on `PROTOCOL_VERSION`. */
  VERSION_MISMATCH: 'version_mismatch',
  /** `sessionId` in a request doesn't match any known session. */
  SESSION_NOT_FOUND: 'session_not_found',
  /** Request named a method this daemon build doesn't implement. */
  UNKNOWN_METHOD: 'unknown_method',
  /** Request params failed validation for the given method. */
  INVALID_PARAMS: 'invalid_params',
  /** Anything else, including local misuse of this module's API. */
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODE)[keyof typeof PROTOCOL_ERROR_CODE];

/** Wire-safe shape of a protocol error, embedded in `ResponseEnvelope`/`HandshakeAckMessage` failures. */
export interface ProtocolErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Thrown by `encodeFrame`/`FrameDecoder` for anything that violates the
 * framing contract. Callers (the daemon's transport, the client) are
 * expected to catch this, treat it as "this connection is no longer
 * trustworthy" and tear it down — it is never allowed to become an unhandled
 * exception or an uncontrolled allocation.
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details?: unknown;

  constructor(code: ProtocolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }

  /** Converts this error into the wire payload shape used by `ResponseEnvelope`/`HandshakeAckMessage`. */
  toPayload(): ProtocolErrorPayload {
    // exactOptionalPropertyTypes: only include `details` when it was
    // actually provided, instead of assigning `details: undefined`.
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

// ---------------------------------------------------------------------------
// Session domain types
// ---------------------------------------------------------------------------

/**
 * Numeric session identifier. It is what actually travels on the wire in a
 * data frame's `[uint32 sessionId]` field, so it is a plain non-negative
 * integer below 2^32 rather than a UUID string — one id space, not a
 * separate "control plane id" that has to be mapped to a "wire id".
 * `packages/daemon/registry.ts` (M1.4) owns issuing these and must not
 * reuse one after its session is closed.
 */
export type SessionId = number;

/** `session.data`, `session.exit`, `session.status` — see `docs/plan.md`'s status-detector notes (M5) for the state machine behind `SessionStatus`. */
export type SessionStatus = 'running' | 'awaiting-input' | 'idle' | 'exited';

/** Snapshot of a session's metadata + lifecycle state, as returned by `session.create`, `session.list`, `session.attach`. */
export interface SessionSummary {
  id: SessionId;
  name: string;
  tag?: string;
  cwd: string;
  shell: string;
  /** Command run inside the shell instead of an interactive prompt (e.g. `claude`), if any. */
  command?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  cols: number;
  rows: number;
  status: SessionStatus;
  /**
   * Process exit code, present only once the session has died (`status`
   * `'exited'`). Mirrors `SessionExitPayload`/`session.ts`'s `SessionExit` so
   * a client that reconnects after missing the `session.exit` event — it
   * wasn't connected at the time — can still learn *why* a session it sees
   * in `session.list` is dead, instead of only that it is.
   */
  exitCode?: number;
  /** POSIX signal number that terminated the process, when applicable. Not set on Windows. */
  signal?: number;
}

// ---------------------------------------------------------------------------
// RPC methods: session.create / resize / close / list / attach / detach
//
// Keyboard/pasted input (formerly a `session.write` RPC here) travels as a
// binary `type: FRAME_TYPE.DATA` frame instead (`Frame` below), the same
// format `session.data` output already uses in the daemon->client direction.
// A JSON RPC per keystroke would double the message count on this product's
// most latency-sensitive path (pasting a large prompt is routine), and the
// data frame already carries `sessionId` without JSON string-escaping.
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  /** Defaults to the shell's name when omitted. */
  name?: string;
  tag?: string;
  cwd: string;
  shell: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}
export interface SessionCreateResult {
  session: SessionSummary;
}

export interface SessionResizeParams {
  sessionId: SessionId;
  cols: number;
  rows: number;
}
export type SessionResizeResult = Record<string, never>;

export interface SessionCloseParams {
  sessionId: SessionId;
}
export type SessionCloseResult = Record<string, never>;

export type SessionListParams = Record<string, never>;
export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface SessionAttachParams {
  sessionId: SessionId;
}
export interface SessionAttachResult {
  session: SessionSummary;
}
/**
 * `session.attach`'s result deliberately carries no snapshot field. The VT
 * sequence snapshot (produced by `@xterm/headless` + `addon-serialize`,
 * M1.6) travels as a binary `type: FRAME_TYPE.DATA` frame instead — the
 * same framing `session.data` output already uses — written to the
 * connection *before* this RPC's response, per the client contract
 * documented in `packages/daemon/src/transport-client.ts` and
 * `docs/specs/m1.7-attach-detach.md` section 3.4: install the data handler
 * before calling `session.attach`, since its frames arrive ahead of the
 * response. A megabyte-scale scrollback going through `JSON.stringify` here
 * would undo the M1.5 work that took keyboard input off the JSON path.
 */

export interface SessionDetachParams {
  sessionId: SessionId;
}
export type SessionDetachResult = Record<string, never>;

/** Every request method's params type, keyed by method name — the single source of truth `RequestMethod` and the discriminated envelopes below are derived from. */
export interface RequestParamsByMethod {
  'session.create': SessionCreateParams;
  'session.resize': SessionResizeParams;
  'session.close': SessionCloseParams;
  'session.list': SessionListParams;
  'session.attach': SessionAttachParams;
  'session.detach': SessionDetachParams;
}

/** Every request method's success result type, keyed by method name. */
export interface RequestResultByMethod {
  'session.create': SessionCreateResult;
  'session.resize': SessionResizeResult;
  'session.close': SessionCloseResult;
  'session.list': SessionListResult;
  'session.attach': SessionAttachResult;
  'session.detach': SessionDetachResult;
}

export type RequestMethod = keyof RequestParamsByMethod;

/**
 * A request envelope, discriminated by `method` so narrowing on `method`
 * also narrows `params` (e.g. `if (req.method === 'session.create')` gives
 * `req.params: SessionCreateParams`).
 */
export type RequestEnvelope = {
  [M in RequestMethod]: {
    kind: 'request';
    /** Correlates with the matching `ResponseEnvelope.id`. Caller-assigned, must be unique per in-flight request on a connection. */
    id: string;
    method: M;
    params: RequestParamsByMethod[M];
  };
}[RequestMethod];

/** A response envelope, discriminated by both `method` and `ok`. */
export type ResponseEnvelope = {
  [M in RequestMethod]:
    | { kind: 'response'; id: string; method: M; ok: true; result: RequestResultByMethod[M] }
    | { kind: 'response'; id: string; method: M; ok: false; error: ProtocolErrorPayload };
}[RequestMethod];

// ---------------------------------------------------------------------------
// Events: session.data / session.exit / session.status
// ---------------------------------------------------------------------------

/**
 * `session.data`'s payload shape. Unlike `session.exit` and `session.status`
 * it is never carried as a JSON `EventEnvelope` — PTY output goes out as a
 * binary `type: FRAME_TYPE.DATA` frame (`Frame` below) so it never pays
 * JSON/base64 cost. This type exists so consumers have a name for "the
 * logical session.data event's payload" when they reconstruct it from a
 * decoded data frame.
 */
export interface SessionDataPayload {
  sessionId: SessionId;
  data: Uint8Array;
}

export interface SessionExitPayload {
  sessionId: SessionId;
  /** Matches `session.ts`'s `SessionExit#exitCode`, which is always a `number` — node-pty/ConPTY never hands the wrapper a null/unknown code in practice. */
  exitCode: number;
  /** POSIX signal number that terminated the process, when applicable. Not set on Windows. */
  signal?: number;
}

export interface SessionStatusPayload {
  sessionId: SessionId;
  status: SessionStatus;
  /** Epoch milliseconds of the transition into `status`. */
  since: number;
}

/** Every event's payload type, keyed by event name — includes `session.data` for completeness even though it is never JSON-encoded (see `JsonEventName`). */
export interface EventPayloadByName {
  'session.data': SessionDataPayload;
  'session.exit': SessionExitPayload;
  'session.status': SessionStatusPayload;
}

export type EventName = keyof EventPayloadByName;

/** The subset of events actually carried as a JSON `EventEnvelope` (type-0 control frame). */
export type JsonEventName = Exclude<EventName, 'session.data'>;

export type EventEnvelope = {
  [E in JsonEventName]: { kind: 'event'; event: E; payload: EventPayloadByName[E] };
}[JsonEventName];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/** First message a client sends after connecting, before any request. Carries the protocol version it speaks and its auth token. */
export interface HandshakeMessage {
  kind: 'handshake';
  protocolVersion: number;
  token: string;
  /** Optional free-form identifier for logs/diagnostics (e.g. `"termhub-app"`, `"termhub-cli"`). */
  clientName?: string;
}

/** The daemon's reply to a `HandshakeMessage`. On mismatch/bad token the daemon is expected to send this and then close the connection. */
export type HandshakeAckMessage =
  | { kind: 'handshake-ack'; ok: true; protocolVersion: number }
  | { kind: 'handshake-ack'; ok: false; error: ProtocolErrorPayload };

// ---------------------------------------------------------------------------
// Control message union (the JSON payload of a type-0 frame)
// ---------------------------------------------------------------------------

export type ControlMessage =
  RequestEnvelope | ResponseEnvelope | EventEnvelope | HandshakeMessage | HandshakeAckMessage;

const CONTROL_MESSAGE_KINDS = new Set<ControlMessage['kind']>([
  'request',
  'response',
  'event',
  'handshake',
  'handshake-ack',
]);

/**
 * Shallow runtime validation of a JSON.parse'd control payload: confirms it
 * is an object with a recognized `kind` discriminant. It intentionally does
 * NOT validate every method's params/result shape (that would need a schema
 * library, and this package takes none — see M4.1's `config-schema.ts` for
 * where `zod` actually enters the workspace). Deeper validation is each
 * consumer's job; this only guarantees the decoder never silently hands back
 * JSON that isn't shaped like *some* `ControlMessage`.
 */
function isControlMessage(value: unknown): value is ControlMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // `as`: narrowing JSON.parse's `unknown` result to peek at one field
  // before validating it is unavoidable without a schema library.
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && CONTROL_MESSAGE_KINDS.has(kind as ControlMessage['kind']);
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export const FRAME_TYPE = {
  CONTROL: 0,
  DATA: 1,
} as const;

export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

const LENGTH_FIELD_BYTES = 4;
const TYPE_FIELD_BYTES = 1;
const SESSION_ID_FIELD_BYTES = 4;

/**
 * Upper bound on a frame's `[type][payload]` portion (i.e. the `length`
 * field's value). Exists so a corrupted or malicious `length` can never turn
 * into an attempt to allocate an unbounded buffer — both `encodeFrame` and
 * `FrameDecoder` enforce it, the decoder before it ever allocates anything
 * sized by the untrusted header.
 */
export const MAX_FRAME_LENGTH = 64 * 1024 * 1024; // 64 MiB

/** One decoded (or to-be-encoded) frame, matching `FrameDecoder`'s output and `encodeFrame`'s input. */
export type Frame =
  | { readonly type: typeof FRAME_TYPE.CONTROL; readonly message: ControlMessage }
  | {
      readonly type: typeof FRAME_TYPE.DATA;
      readonly sessionId: SessionId;
      readonly data: Uint8Array;
    };

function assertValidSessionId(sessionId: SessionId): void {
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODE.INVALID_FRAME,
      `sessionId ${sessionId} is not a valid uint32`,
    );
  }
}

function buildFrame(type: FrameType, payload: Buffer): Buffer {
  const bodyLength = TYPE_FIELD_BYTES + payload.length;
  if (bodyLength > MAX_FRAME_LENGTH) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODE.FRAME_TOO_LARGE,
      `frame body of ${bodyLength} bytes exceeds MAX_FRAME_LENGTH (${MAX_FRAME_LENGTH})`,
    );
  }
  const frame = Buffer.allocUnsafe(LENGTH_FIELD_BYTES + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt8(type, LENGTH_FIELD_BYTES);
  payload.copy(frame, LENGTH_FIELD_BYTES + TYPE_FIELD_BYTES);
  return frame;
}

/** Encodes a control frame: `type` 0, payload is `message` as UTF-8 JSON. */
export function encodeControlFrame(message: ControlMessage): Buffer {
  return buildFrame(FRAME_TYPE.CONTROL, Buffer.from(JSON.stringify(message), 'utf8'));
}

/** Encodes a data frame: `type` 1, payload is `[uint32 sessionId][data]`. `data` is copied verbatim — no JSON, no base64. */
export function encodeDataFrame(sessionId: SessionId, data: Uint8Array): Buffer {
  assertValidSessionId(sessionId);
  const sessionIdBuf = Buffer.allocUnsafe(SESSION_ID_FIELD_BYTES);
  sessionIdBuf.writeUInt32BE(sessionId, 0);
  return buildFrame(FRAME_TYPE.DATA, Buffer.concat([sessionIdBuf, Buffer.from(data)]));
}

/**
 * Encodes any `Frame` (control or data) into its wire bytes. This is the
 * single entry point requested by the protocol design; `encodeControlFrame`
 * / `encodeDataFrame` above are thin convenience wrappers over it for
 * callers that already know which kind they have.
 */
export function encodeFrame(frame: Frame): Buffer {
  switch (frame.type) {
    case FRAME_TYPE.CONTROL:
      return encodeControlFrame(frame.message);
    case FRAME_TYPE.DATA:
      return encodeDataFrame(frame.sessionId, frame.data);
  }
}

function parseControlPayload(payload: Buffer): ControlMessage {
  let json: unknown;
  try {
    json = JSON.parse(payload.toString('utf8')) as unknown;
  } catch (err) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODE.MALFORMED_JSON,
      'control frame payload is not valid JSON',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!isControlMessage(json)) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODE.MALFORMED_JSON,
      'control frame payload is valid JSON but not a recognized ControlMessage',
    );
  }
  return json;
}

function decodeBody(body: Buffer): Frame {
  const type = body.readUInt8(0);
  const payload = body.subarray(TYPE_FIELD_BYTES);
  switch (type) {
    case FRAME_TYPE.CONTROL:
      return { type: FRAME_TYPE.CONTROL, message: parseControlPayload(payload) };
    case FRAME_TYPE.DATA: {
      if (payload.length < SESSION_ID_FIELD_BYTES) {
        throw new ProtocolError(
          PROTOCOL_ERROR_CODE.INVALID_FRAME,
          `data frame payload of ${payload.length} bytes is smaller than the sessionId field`,
        );
      }
      return {
        type: FRAME_TYPE.DATA,
        sessionId: payload.readUInt32BE(0),
        data: payload.subarray(SESSION_ID_FIELD_BYTES),
      };
    }
    default:
      throw new ProtocolError(PROTOCOL_ERROR_CODE.INVALID_FRAME, `unknown frame type ${type}`);
  }
}

type DecoderPhase = { phase: 'length' } | { phase: 'body'; bodyLength: number };

/**
 * Incremental frame decoder: feed it chunks as they arrive off a socket, get
 * back the frames that became complete as a result. Handles any slicing —
 * a frame split across any number of chunks (including mid-`length`-field),
 * several complete frames in one chunk, or any mix of the two.
 *
 * Performance: chunks are kept in a queue (`this.queue`) alongside a running
 * byte count, never concatenated into one growing buffer on every `push`.
 * Bytes are only copied when a frame's header or body actually spans
 * multiple queued chunks (`consume`'s multi-buffer path); the common case of
 * a chunk boundary landing inside one contiguous queued buffer is a
 * zero-copy `subarray`. This keeps `push` amortized O(bytes received)
 * instead of the O(n^2) `Buffer.concat(accumulator, chunk)`-per-chunk
 * anti-pattern.
 *
 * Safety: the `length` field is validated against `MAX_FRAME_LENGTH` right
 * after being parsed, before any buffer sized by it is ever allocated — a
 * corrupted length becomes a thrown `ProtocolError`, never a multi-gigabyte
 * allocation attempt.
 *
 * Once `push` throws a `ProtocolError`, this instance is no longer usable
 * (its internal state may be inconsistent); callers should tear down the
 * connection and, if they reconnect, construct a fresh `FrameDecoder`.
 */
export class FrameDecoder {
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  private state: DecoderPhase = { phase: 'length' };
  private failed = false;

  /** Feeds one chunk of socket data in and returns every frame that became complete as a result (possibly zero, one, or several). Throws `ProtocolError` on any framing violation. */
  push(chunk: Uint8Array): Frame[] {
    if (this.failed) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
        'FrameDecoder already failed after a previous protocol error; construct a new instance',
      );
    }
    this.enqueue(chunk);

    try {
      const frames: Frame[] = [];
      for (;;) {
        if (this.state.phase === 'length') {
          if (this.queuedBytes < LENGTH_FIELD_BYTES) {
            break;
          }
          const header = this.consume(LENGTH_FIELD_BYTES);
          const bodyLength = header.readUInt32BE(0);
          if (bodyLength < TYPE_FIELD_BYTES) {
            throw new ProtocolError(
              PROTOCOL_ERROR_CODE.INVALID_FRAME,
              `frame length ${bodyLength} is too small to hold the type field`,
            );
          }
          if (bodyLength > MAX_FRAME_LENGTH) {
            throw new ProtocolError(
              PROTOCOL_ERROR_CODE.FRAME_TOO_LARGE,
              `frame length ${bodyLength} exceeds MAX_FRAME_LENGTH (${MAX_FRAME_LENGTH})`,
            );
          }
          this.state = { phase: 'body', bodyLength };
        }

        // Re-check phase (not `else if`): a header we just parsed above may
        // already have its full body queued, and we want to drain it in
        // this same pass instead of waiting for the next `push`.
        if (this.state.phase === 'body') {
          if (this.queuedBytes < this.state.bodyLength) {
            break;
          }
          const body = this.consume(this.state.bodyLength);
          this.state = { phase: 'length' };
          frames.push(decodeBody(body));
        }
      }
      return frames;
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  private enqueue(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.queue.push(buf);
    this.queuedBytes += buf.length;
  }

  /** Removes and returns exactly `n` bytes from the front of the queue. Caller must have already confirmed `this.queuedBytes >= n`. */
  private consume(n: number): Buffer {
    if (n === 0) {
      return Buffer.alloc(0);
    }
    const first = this.queue[0];
    if (first !== undefined && first.length >= n) {
      const result = first.subarray(0, n);
      if (first.length === n) {
        this.queue.shift();
      } else {
        this.queue[0] = first.subarray(n);
      }
      this.queuedBytes -= n;
      return result;
    }

    // Spans multiple queued buffers: this is the only path that copies.
    const result = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.queue[0];
      if (head === undefined) {
        // Unreachable if callers only call consume() after checking
        // queuedBytes >= n, but guards against a silent buffer underrun
        // turning into an out-of-bounds read instead of a clear error.
        throw new ProtocolError(
          PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
          'FrameDecoder buffer underrun: fewer queued bytes than expected',
        );
      }
      const take = Math.min(head.length, n - offset);
      head.copy(result, offset, 0, take);
      offset += take;
      if (take === head.length) {
        this.queue.shift();
      } else {
        this.queue[0] = head.subarray(take);
      }
    }
    this.queuedBytes -= n;
    return result;
  }
}
