import { describe, expect, it } from 'vitest';

import {
  FRAME_TYPE,
  MAX_FRAME_LENGTH,
  PROTOCOL_ERROR_CODE,
  ProtocolError,
  encodeControlFrame,
  encodeDataFrame,
  encodeFrame,
  FrameDecoder,
  type ControlMessage,
  type Frame,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_CONTROL_MESSAGES: ControlMessage[] = [
  {
    kind: 'handshake',
    protocolVersion: 1,
    token: 'test-token-abc123',
    clientName: 'termhub-cli',
  },
  { kind: 'handshake-ack', ok: true, protocolVersion: 1 },
  {
    kind: 'handshake-ack',
    ok: false,
    error: { code: PROTOCOL_ERROR_CODE.UNAUTHORIZED, message: 'bad token' },
  },
  {
    kind: 'request',
    id: 'req-1',
    method: 'session.create',
    params: { cwd: 'C:\\repo', shell: 'pwsh', cols: 120, rows: 30, name: 'agent-1' },
  },
  {
    kind: 'response',
    id: 'req-1',
    method: 'session.create',
    ok: true,
    result: {
      session: {
        id: 7,
        name: 'agent-1',
        cwd: 'C:\\repo',
        shell: 'pwsh',
        createdAt: 1700000000000,
        cols: 120,
        rows: 30,
        status: 'running',
      },
    },
  },
  {
    kind: 'response',
    id: 'req-2',
    method: 'session.attach',
    ok: false,
    error: { code: PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND, message: 'no such session' },
  },
  {
    kind: 'event',
    event: 'session.exit',
    payload: { sessionId: 7, exitCode: 0 },
  },
  {
    kind: 'event',
    event: 'session.status',
    payload: { sessionId: 7, status: 'awaiting-input', since: 1700000001000 },
  },
];

/** Builds a buffer of every byte value 0x00-0xff repeated, including 0x00 runs and lone bytes that are invalid UTF-8 continuation/lead bytes on their own (e.g. 0x80, 0xff). */
function fullByteRangePayload(): Buffer {
  const buf = Buffer.alloc(256 * 3);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = i % 256;
  }
  return buf;
}

/** Splits `buf` into chunks of exactly `size` bytes (last chunk may be shorter). */
function chunkBy(buf: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += size) {
    chunks.push(buf.subarray(offset, Math.min(offset + size, buf.length)));
  }
  return chunks;
}

function expectFrameEqual(actual: Frame, expected: Frame): void {
  expect(actual.type).toBe(expected.type);
  if (actual.type === FRAME_TYPE.CONTROL && expected.type === FRAME_TYPE.CONTROL) {
    expect(actual.message).toEqual(expected.message);
  } else if (actual.type === FRAME_TYPE.DATA && expected.type === FRAME_TYPE.DATA) {
    expect(actual.sessionId).toBe(expected.sessionId);
    expect(Buffer.compare(Buffer.from(actual.data), Buffer.from(expected.data))).toBe(0);
  } else {
    throw new Error('frame type mismatch');
  }
}

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe('control frame round-trip', () => {
  it.each(SAMPLE_CONTROL_MESSAGES.map((message, i) => [i, message] as const))(
    'sample #%i round-trips through encodeControlFrame + FrameDecoder',
    (_i, message) => {
      const encoded = encodeControlFrame(message);
      const decoder = new FrameDecoder();
      const frames = decoder.push(encoded);
      expect(frames).toHaveLength(1);
      expectFrameEqual(frames[0]!, { type: FRAME_TYPE.CONTROL, message });
    },
  );

  it('also round-trips via the unified encodeFrame entry point', () => {
    const message = SAMPLE_CONTROL_MESSAGES[3]!;
    const encoded = encodeFrame({ type: FRAME_TYPE.CONTROL, message });
    const decoder = new FrameDecoder();
    const frames = decoder.push(encoded);
    expect(frames).toHaveLength(1);
    expectFrameEqual(frames[0]!, { type: FRAME_TYPE.CONTROL, message });
  });
});

describe('binary data frame round-trip', () => {
  it('round-trips a sessionId + raw byte payload, including 0x00 and invalid-UTF-8 sequences', () => {
    const original = fullByteRangePayload();
    const encoded = encodeDataFrame(42, original);
    const decoder = new FrameDecoder();
    const frames = decoder.push(encoded);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe(FRAME_TYPE.DATA);
    if (frame.type !== FRAME_TYPE.DATA) throw new Error('expected data frame');
    expect(frame.sessionId).toBe(42);
    // Byte-for-byte identity, not "looks similar after a UTF-8 round trip".
    expect(Buffer.compare(Buffer.from(frame.data), original)).toBe(0);
    expect(frame.data.length).toBe(original.length);
  });

  it('never mangles a payload that would break UTF-8 decoding (lone continuation/lead bytes, unpaired surrogate-style sequences)', () => {
    const original = Buffer.from([
      0x00, 0x00, 0x80, 0xff, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x00,
    ]);
    const encoded = encodeDataFrame(1, original);
    const decoder = new FrameDecoder();
    const [frame] = decoder.push(encoded);
    expect(frame?.type).toBe(FRAME_TYPE.DATA);
    if (frame?.type !== FRAME_TYPE.DATA) throw new Error('expected data frame');
    expect(Buffer.compare(Buffer.from(frame.data), original)).toBe(0);
  });

  it('round-trips via the unified encodeFrame entry point', () => {
    const data = Buffer.from('hello pty', 'utf8');
    const encoded = encodeFrame({ type: FRAME_TYPE.DATA, sessionId: 9, data });
    const decoder = new FrameDecoder();
    const [frame] = decoder.push(encoded);
    expectFrameEqual(frame!, { type: FRAME_TYPE.DATA, sessionId: 9, data });
  });

  it('rejects an invalid sessionId at encode time instead of writing a corrupt frame', () => {
    expect(() => encodeDataFrame(-1, Buffer.from('x'))).toThrow(ProtocolError);
    expect(() => encodeDataFrame(1.5, Buffer.from('x'))).toThrow(ProtocolError);
    expect(() => encodeDataFrame(0x1_0000_0000, Buffer.from('x'))).toThrow(ProtocolError);
  });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe('chunked delivery', () => {
  it('reassembles a control frame split across many small chunks', () => {
    const encoded = encodeControlFrame(SAMPLE_CONTROL_MESSAGES[3]!);
    const decoder = new FrameDecoder();
    const collected: Frame[] = [];
    for (const chunk of chunkBy(encoded, 3)) {
      collected.push(...decoder.push(chunk));
    }
    expect(collected).toHaveLength(1);
    expectFrameEqual(collected[0]!, {
      type: FRAME_TYPE.CONTROL,
      message: SAMPLE_CONTROL_MESSAGES[3]!,
    });
  });

  it('reassembles a data frame split across many small chunks, byte for byte', () => {
    const original = fullByteRangePayload();
    const encoded = encodeDataFrame(5, original);
    const decoder = new FrameDecoder();
    const collected: Frame[] = [];
    for (const chunk of chunkBy(encoded, 7)) {
      collected.push(...decoder.push(chunk));
    }
    expect(collected).toHaveLength(1);
    expectFrameEqual(collected[0]!, { type: FRAME_TYPE.DATA, sessionId: 5, data: original });
  });

  it('handles a cut that lands in the middle of the 4-byte length field itself', () => {
    const encoded = encodeDataFrame(3, Buffer.from('abcdef'));
    const decoder = new FrameDecoder();

    // First chunk: only 2 of the 4 length bytes.
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    // Second chunk: 1 more length byte (3 of 4 so far) plus nothing else.
    expect(decoder.push(encoded.subarray(2, 3))).toEqual([]);
    // Third chunk: the rest of everything.
    const frames = decoder.push(encoded.subarray(3));
    expect(frames).toHaveLength(1);
    expectFrameEqual(frames[0]!, {
      type: FRAME_TYPE.DATA,
      sessionId: 3,
      data: Buffer.from('abcdef'),
    });
  });

  it('emits nothing until the frame is fully available, even one byte at a time', () => {
    const encoded = encodeControlFrame({ kind: 'handshake-ack', ok: true, protocolVersion: 1 });
    const decoder = new FrameDecoder();
    let total = 0;
    for (let i = 0; i < encoded.length - 1; i++) {
      total += decoder.push(encoded.subarray(i, i + 1)).length;
    }
    expect(total).toBe(0);
    const last = decoder.push(encoded.subarray(encoded.length - 1));
    expect(last).toHaveLength(1);
  });

  it('decodes two or more complete frames delivered in a single chunk, in order', () => {
    const a = encodeControlFrame(SAMPLE_CONTROL_MESSAGES[0]!);
    const b = encodeDataFrame(11, Buffer.from('output chunk'));
    const c = encodeControlFrame(SAMPLE_CONTROL_MESSAGES[6]!);
    const combined = Buffer.concat([a, b, c]);

    const decoder = new FrameDecoder();
    const frames = decoder.push(combined);

    expect(frames).toHaveLength(3);
    expectFrameEqual(frames[0]!, {
      type: FRAME_TYPE.CONTROL,
      message: SAMPLE_CONTROL_MESSAGES[0]!,
    });
    expectFrameEqual(frames[1]!, {
      type: FRAME_TYPE.DATA,
      sessionId: 11,
      data: Buffer.from('output chunk'),
    });
    expectFrameEqual(frames[2]!, {
      type: FRAME_TYPE.CONTROL,
      message: SAMPLE_CONTROL_MESSAGES[6]!,
    });
  });

  it('decodes N complete frames plus a trailing partial frame in one chunk, then finishes the partial on the next push', () => {
    const a = encodeDataFrame(1, Buffer.from('first'));
    const b = encodeDataFrame(2, Buffer.from('second'));
    const c = encodeDataFrame(3, Buffer.from('third, longer payload to split'));
    const combined = Buffer.concat([a, b, c]);
    // Cut partway through the third frame.
    const splitPoint = a.length + b.length + 5;

    const decoder = new FrameDecoder();
    const firstBatch = decoder.push(combined.subarray(0, splitPoint));
    expect(firstBatch).toHaveLength(2);
    expectFrameEqual(firstBatch[0]!, {
      type: FRAME_TYPE.DATA,
      sessionId: 1,
      data: Buffer.from('first'),
    });
    expectFrameEqual(firstBatch[1]!, {
      type: FRAME_TYPE.DATA,
      sessionId: 2,
      data: Buffer.from('second'),
    });

    const secondBatch = decoder.push(combined.subarray(splitPoint));
    expect(secondBatch).toHaveLength(1);
    expectFrameEqual(secondBatch[0]!, {
      type: FRAME_TYPE.DATA,
      sessionId: 3,
      data: Buffer.from('third, longer payload to split'),
    });
  });
});

// ---------------------------------------------------------------------------
// Protocol errors
// ---------------------------------------------------------------------------

describe('protocol violations', () => {
  it('rejects a length above MAX_FRAME_LENGTH without allocating a giant buffer or crashing', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_LENGTH + 1, 0);

    let caught: unknown;
    try {
      // Only the 4-byte header is ever sent — if the decoder tried to
      // allocate a buffer sized by this length before validating it, this
      // call would hang/OOM instead of throwing synchronously.
      decoder.push(header);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.FRAME_TOO_LARGE);
  });

  it('rejects an absurd length (0xffffffff) the same way', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff, 0);
    expect(() => decoder.push(header)).toThrow(ProtocolError);
  });

  it('rejects an unknown frame type', () => {
    const payload = Buffer.from('irrelevant');
    const frame = Buffer.alloc(4 + 1 + payload.length);
    frame.writeUInt32BE(1 + payload.length, 0);
    frame.writeUInt8(2, 4); // type 2 does not exist
    payload.copy(frame, 5);

    const decoder = new FrameDecoder();
    let caught: unknown;
    try {
      decoder.push(frame);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.INVALID_FRAME);
  });

  it('rejects a control frame whose payload is not valid JSON', () => {
    const payload = Buffer.from('{not json', 'utf8');
    const frame = Buffer.alloc(4 + 1 + payload.length);
    frame.writeUInt32BE(1 + payload.length, 0);
    frame.writeUInt8(FRAME_TYPE.CONTROL, 4);
    payload.copy(frame, 5);

    const decoder = new FrameDecoder();
    expect(() => decoder.push(frame)).toThrow(ProtocolError);
  });

  it('rejects a data frame too short to hold its sessionId', () => {
    const frame = Buffer.alloc(4 + 1 + 2); // only 2 bytes after type, sessionId needs 4
    frame.writeUInt32BE(1 + 2, 0);
    frame.writeUInt8(FRAME_TYPE.DATA, 4);

    const decoder = new FrameDecoder();
    expect(() => decoder.push(frame)).toThrow(ProtocolError);
  });

  it('becomes permanently unusable after a protocol error, rather than silently recovering', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_LENGTH + 1, 0);
    expect(() => decoder.push(header)).toThrow(ProtocolError);

    const validFrame = encodeDataFrame(1, Buffer.from('x'));
    expect(() => decoder.push(validFrame)).toThrow(ProtocolError);
  });

  it('rejects an oversized payload at encode time too, before ever writing bytes', () => {
    const tooBig = Buffer.alloc(MAX_FRAME_LENGTH + 1);
    expect(() => encodeDataFrame(1, tooBig)).toThrow(ProtocolError);
  });
});

// ---------------------------------------------------------------------------
// Random slicing (seeded, deterministic)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the random-slicing test is reproducible across runs/machines. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

describe('random slicing (seeded, deterministic)', () => {
  const SEED = 0xc0ffee;

  it('reassembles the exact original sequence of frames when cut into arbitrary-sized pieces', () => {
    const rng = mulberry32(SEED);

    // A varied sequence: control messages of different shapes, plus data
    // frames of very different sizes (including one large enough to force
    // several chunk boundaries inside a single frame's payload).
    const originalFrames: Frame[] = [];
    for (const message of SAMPLE_CONTROL_MESSAGES) {
      originalFrames.push({ type: FRAME_TYPE.CONTROL, message });
    }
    for (let i = 0; i < 5; i++) {
      const size = [0, 1, 3, 4096, 250_000][i]!;
      const data = Buffer.alloc(size);
      for (let j = 0; j < size; j++) data[j] = (i * 31 + j) % 256;
      originalFrames.push({ type: FRAME_TYPE.DATA, sessionId: 100 + i, data });
    }
    // Interleave a couple more control frames after the big data frames, so
    // a length header can land right after a huge payload.
    originalFrames.push({ type: FRAME_TYPE.CONTROL, message: SAMPLE_CONTROL_MESSAGES[4]! });
    originalFrames.push({ type: FRAME_TYPE.CONTROL, message: SAMPLE_CONTROL_MESSAGES[5]! });

    const encodedFrames = originalFrames.map((f) => encodeFrame(f));
    const wire = Buffer.concat(encodedFrames);

    // Cut `wire` into random-sized pieces, 1..17 bytes each (deliberately
    // small and irregular — no alignment with frame or field boundaries).
    const pieces: Buffer[] = [];
    let offset = 0;
    while (offset < wire.length) {
      const size = randomInt(rng, 1, 17);
      const end = Math.min(offset + size, wire.length);
      pieces.push(wire.subarray(offset, end));
      offset = end;
    }

    const decoder = new FrameDecoder();
    const decoded: Frame[] = [];
    for (const piece of pieces) {
      decoded.push(...decoder.push(piece));
    }

    console.log(
      `[random slicing] seed=0x${SEED.toString(16)} totalBytes=${wire.length} ` +
        `pieces=${pieces.length} originalFrames=${originalFrames.length} decodedFrames=${decoded.length}`,
    );

    expect(decoded).toHaveLength(originalFrames.length);
    for (let i = 0; i < originalFrames.length; i++) {
      expectFrameEqual(decoded[i]!, originalFrames[i]!);
    }
  });

  it('also holds for a different seed and a different piece-size range (1..64 bytes)', () => {
    const rng = mulberry32(0x1234_5678);
    const originalFrames: Frame[] = [
      { type: FRAME_TYPE.CONTROL, message: SAMPLE_CONTROL_MESSAGES[0]! },
      { type: FRAME_TYPE.DATA, sessionId: 1, data: fullByteRangePayload() },
      { type: FRAME_TYPE.CONTROL, message: SAMPLE_CONTROL_MESSAGES[3]! },
      { type: FRAME_TYPE.DATA, sessionId: 2, data: Buffer.from('') },
      { type: FRAME_TYPE.DATA, sessionId: 3, data: Buffer.from('a') },
      { type: FRAME_TYPE.CONTROL, message: SAMPLE_CONTROL_MESSAGES[7]! },
    ];
    const wire = Buffer.concat(originalFrames.map((f) => encodeFrame(f)));

    const pieces: Buffer[] = [];
    let offset = 0;
    while (offset < wire.length) {
      const size = randomInt(rng, 1, 64);
      const end = Math.min(offset + size, wire.length);
      pieces.push(wire.subarray(offset, end));
      offset = end;
    }

    const decoder = new FrameDecoder();
    const decoded: Frame[] = [];
    for (const piece of pieces) {
      decoded.push(...decoder.push(piece));
    }

    console.log(
      `[random slicing #2] seed=0x12345678 totalBytes=${wire.length} pieces=${pieces.length} ` +
        `originalFrames=${originalFrames.length} decodedFrames=${decoded.length}`,
    );

    expect(decoded).toHaveLength(originalFrames.length);
    for (let i = 0; i < originalFrames.length; i++) {
      expectFrameEqual(decoded[i]!, originalFrames[i]!);
    }
  });
});
