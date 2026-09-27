import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import {
  MAX_OSC_PAYLOAD,
  SignalScanner,
  TerminalSignalParser,
  interpretOsc,
  type RawSignal,
  type TerminalSignal,
} from './osc-parser.js';

// No PTY is opened anywhere in this file: the module under test is pure, and
// the only external thing touched is `@xterm/headless`, used purely as an
// oracle in the differential test (test 7) — never as the thing being tested.

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`; // 7-bit string terminator
const CAN = '\x18';
const SUB = '\x1a';
const C1_OSC = '\u009d'; // OSC start, C1 form
const C1_ST = '\u009c'; // ST, C1 form

/** Feeds `chunk` in one call, on a brand new parser, and returns the signals produced. */
function signalsOf(chunk: string): TerminalSignal[] {
  return new TerminalSignalParser().feed(chunk);
}

/** Feeds `chunk` in one call, on a brand new scanner, and returns the raw signals produced. */
function rawOf(chunk: string): RawSignal[] {
  return new SignalScanner().feed(chunk);
}

describe('interpretOsc', () => {
  it('maps each id from spec section 3.3', () => {
    expect(interpretOsc(0, 'hello')).toEqual({ kind: 'title', title: 'hello' });
    expect(interpretOsc(2, '')).toEqual({ kind: 'title', title: '' });
    expect(interpretOsc(1, 'icon.png')).toBeNull(); // icon name: ignored

    expect(interpretOsc(9, 'build finished')).toEqual({
      kind: 'notification',
      source: 'osc9',
      title: null,
      body: 'build finished',
    });
    expect(interpretOsc(9, '')).toBeNull();
    // ConEmu commands: `^\d+(;|$)`. Only `4` (progress) is interpreted.
    expect(interpretOsc(9, '9;C:\\x')).toBeNull();
    expect(interpretOsc(9, '4;1;50')).toEqual({ kind: 'progress', state: 1, value: 50 });
    expect(interpretOsc(9, '4;0')).toEqual({ kind: 'progress', state: 0, value: null });
    expect(interpretOsc(9, '4;9;50')).toBeNull(); // state out of range
    expect(interpretOsc(9, '4')).toBeNull(); // state missing
    expect(interpretOsc(9, '4;1;150')).toEqual({ kind: 'progress', state: 1, value: null }); // value out of range

    expect(interpretOsc(777, 'notify;Title;Body')).toEqual({
      kind: 'notification',
      source: 'osc777',
      title: 'Title',
      body: 'Body',
    });
    expect(interpretOsc(777, 'notify;Title')).toEqual({
      kind: 'notification',
      source: 'osc777',
      title: 'Title',
      body: '',
    });
    expect(interpretOsc(777, 'precmd;whatever')).toBeNull();

    expect(interpretOsc(133, 'A')).toEqual({ kind: 'shell-mark', mark: 'A', exitCode: null });
    expect(interpretOsc(133, 'A;cl=m;aid=12')).toEqual({
      kind: 'shell-mark',
      mark: 'A',
      exitCode: null,
    });
    expect(interpretOsc(133, 'B')).toEqual({ kind: 'shell-mark', mark: 'B', exitCode: null });
    expect(interpretOsc(133, 'C')).toEqual({ kind: 'shell-mark', mark: 'C', exitCode: null });
    expect(interpretOsc(133, 'D;0')).toEqual({ kind: 'shell-mark', mark: 'D', exitCode: 0 });
    expect(interpretOsc(133, 'D;130')).toEqual({ kind: 'shell-mark', mark: 'D', exitCode: 130 });
    expect(interpretOsc(133, 'D')).toEqual({ kind: 'shell-mark', mark: 'D', exitCode: null });
    expect(interpretOsc(133, 'D;abc')).toEqual({ kind: 'shell-mark', mark: 'D', exitCode: null });
    expect(interpretOsc(133, 'E')).toBeNull();

    expect(interpretOsc(633, 'A')).toBeNull(); // out of scope for M5.1
  });
});

describe('TerminalSignalParser — test 1: each signal, isolated, BEL and ST terminators, plus a C1 case', () => {
  const cases: Array<{
    name: string;
    make: (terminator: string) => string;
    expected: TerminalSignal[];
  }> = [
    {
      name: 'OSC 0 title',
      make: (t) => `${ESC}]0;hello${t}`,
      expected: [{ kind: 'title', title: 'hello' }],
    },
    {
      name: 'OSC 2 title',
      make: (t) => `${ESC}]2;hello${t}`,
      expected: [{ kind: 'title', title: 'hello' }],
    },
    {
      name: 'OSC 9 notification',
      make: (t) => `${ESC}]9;build ok${t}`,
      expected: [{ kind: 'notification', source: 'osc9', title: null, body: 'build ok' }],
    },
    {
      name: 'OSC 9;4 progress',
      make: (t) => `${ESC}]9;4;1;50${t}`,
      expected: [{ kind: 'progress', state: 1, value: 50 }],
    },
    {
      name: 'OSC 777 notify',
      make: (t) => `${ESC}]777;notify;Title;Body${t}`,
      expected: [{ kind: 'notification', source: 'osc777', title: 'Title', body: 'Body' }],
    },
    {
      name: 'OSC 133;A',
      make: (t) => `${ESC}]133;A${t}`,
      expected: [{ kind: 'shell-mark', mark: 'A', exitCode: null }],
    },
    {
      name: 'OSC 133;D exit code',
      make: (t) => `${ESC}]133;D;0${t}`,
      expected: [{ kind: 'shell-mark', mark: 'D', exitCode: 0 }],
    },
  ];

  for (const { name, make, expected } of cases) {
    it(`${name} — BEL terminator`, () => {
      expect(signalsOf(make(BEL))).toEqual(expected);
    });
    it(`${name} — ST terminator`, () => {
      expect(signalsOf(make(ST))).toEqual(expected);
    });
  }

  it('C1 form: OSC start and ST as single code units', () => {
    expect(signalsOf(`${C1_OSC}0;hello${C1_ST}`)).toEqual([{ kind: 'title', title: 'hello' }]);
  });
});

describe('TerminalSignalParser — test 2: BEL as OSC terminator is not a bell', () => {
  it('a BEL-terminated title produces exactly one title, no bell', () => {
    expect(signalsOf(`${ESC}]0;title${BEL}`)).toEqual([{ kind: 'title', title: 'title' }]);
  });

  it('a BEL inside a DCS string produces zero events', () => {
    // ESC P ... BEL ... ESC \ — the whole thing is a DCS, which this module
    // never interprets, and the BEL inside it must not be reported as a bell.
    expect(signalsOf(`${ESC}Psome dcs data${BEL}more${ST}`)).toEqual([]);
  });

  it('a BEL inside an APC string produces zero events', () => {
    expect(signalsOf(`${ESC}_some apc data${BEL}more${ST}`)).toEqual([]);
  });
});

describe('TerminalSignalParser — test 3: every possible split between two chunks', () => {
  // Every fixture from tests 1 and 2, individually...
  const fixtures = [
    `${ESC}]0;hello${BEL}`,
    `${ESC}]0;hello${ST}`,
    `${ESC}]9;build ok${BEL}`,
    `${ESC}]9;4;1;50${ST}`,
    `${ESC}]777;notify;Title;Body${BEL}`,
    `${ESC}]133;A${BEL}`,
    `${ESC}]133;D;0${ST}`,
    `${C1_OSC}0;hello${C1_ST}`,
    `${ESC}]0;title${BEL}`,
    `${ESC}Psome dcs data${BEL}more${ST}`,
    `${ESC}_some apc data${BEL}more${ST}`,
  ];

  // ...and one long stream that concatenates all of them with plain text in
  // between, since a real chunk boundary can land anywhere across a whole
  // burst of unrelated sequences, not just inside a single one of them.
  const longStream = fixtures.join('--plain text between sequences--');

  function expectSameRegardlessOfSplit(stream: string, cut: number): void {
    const whole = rawOf(stream);
    const split = new SignalScanner();
    const got = [...split.feed(stream.slice(0, cut)), ...split.feed(stream.slice(cut))];
    expect(got).toEqual(whole);
  }

  for (const fixture of [...fixtures, longStream]) {
    it(`splits identically for every cut point of: ${JSON.stringify(fixture).slice(0, 60)}`, () => {
      for (let cut = 0; cut <= fixture.length; cut++) {
        expectSameRegardlessOfSplit(fixture, cut);
      }
    });
  }

  it('splits identically for every pair of cut points, three chunks, on a stream with an ST', () => {
    const stream = `${ESC}]0;hi${ST}`;
    const whole = rawOf(stream);
    for (let a = 0; a <= stream.length; a++) {
      for (let b = a; b <= stream.length; b++) {
        const scanner = new SignalScanner();
        const got = [
          ...scanner.feed(stream.slice(0, a)),
          ...scanner.feed(stream.slice(a, b)),
          ...scanner.feed(stream.slice(b)),
        ];
        expect(got).toEqual(whole);
      }
    }
  });

  it('named case: the cut lands exactly between the ESC and the backslash of the ST — the title is emitted exactly once', () => {
    const stream = `${ESC}]0;hello${ESC}\\`;
    const escIndex = stream.lastIndexOf(ESC);
    const cut = escIndex + 1; // right between ESC and '\'
    const scanner = new SignalScanner();
    const got = [...scanner.feed(stream.slice(0, cut)), ...scanner.feed(stream.slice(cut))];
    expect(got).toEqual([{ type: 'osc', id: 0, payload: 'hello' }]);
  });
});

describe('TerminalSignalParser — test 4: OSC without a terminator', () => {
  it('caps memory at MAX_OSC_PAYLOAD and emits nothing for an overflowed OSC', () => {
    const scanner = new SignalScanner();
    scanner.feed(`${ESC}]0;`);
    expect(scanner.pendingPayloadLength).toBeLessThanOrEqual(MAX_OSC_PAYLOAD);

    // Feed ~1 MB of plain text with no terminator, in chunks, checking the
    // cap holds throughout — not just at the very end.
    const chunk = 'x'.repeat(4096);
    for (let i = 0; i < 256; i++) {
      scanner.feed(chunk);
      expect(scanner.pendingPayloadLength).toBeLessThanOrEqual(MAX_OSC_PAYLOAD);
    }

    // The BEL that finally arrives terminates the (overflowed) OSC: no event.
    expect(scanner.feed(BEL)).toEqual([]);
    expect(scanner.pendingPayloadLength).toBe(0);

    // Now we're back in ground: a second BEL is a real bell.
    expect(scanner.feed(BEL)).toEqual([{ type: 'bell' }]);
  });

  it('an OSC aborted by CAN, followed by BEL, yields exactly one bell and no title', () => {
    const scanner = new SignalScanner();
    const got = [
      ...scanner.feed(`${ESC}]0;partial title`),
      ...scanner.feed(CAN),
      ...scanner.feed(BEL),
    ];
    expect(got).toEqual([{ type: 'bell' }]);
  });
});

describe('TerminalSignalParser — test 5: the ConEmu side of OSC 9', () => {
  it('9;9;<cwd> is a ConEmu command, not a notification', () => {
    expect(signalsOf(`${ESC}]9;9;C:\\x${BEL}`)).toEqual([]);
  });

  it('9;4;1;50 is progress state 1, value 50', () => {
    expect(signalsOf(`${ESC}]9;4;1;50${BEL}`)).toEqual([{ kind: 'progress', state: 1, value: 50 }]);
  });

  it('9;4;0 is progress state 0, value null', () => {
    expect(signalsOf(`${ESC}]9;4;0${BEL}`)).toEqual([{ kind: 'progress', state: 0, value: null }]);
  });

  it('9;4;9;50 has an out-of-range state and is dropped', () => {
    expect(signalsOf(`${ESC}]9;4;9;50${BEL}`)).toEqual([]);
  });

  it('9;oi is a real notification', () => {
    expect(signalsOf(`${ESC}]9;oi${BEL}`)).toEqual([
      { kind: 'notification', source: 'osc9', title: null, body: 'oi' },
    ]);
  });

  it('a Windows Terminal prompt (9;9 cwd + 133;A/B shell marks) produces zero notifications', () => {
    const stream = `${ESC}]9;9;C:\\repo${BEL}${ESC}]133;A${BEL}$ some-command${ESC}]133;B${BEL}`;
    const signals = signalsOf(stream);
    expect(signals.filter((s) => s.kind === 'notification')).toEqual([]);
    expect(signals).toEqual([
      { kind: 'shell-mark', mark: 'A', exitCode: null },
      { kind: 'shell-mark', mark: 'B', exitCode: null },
    ]);
  });
});

describe('TerminalSignalParser — test 6: C0 and Unicode payload handling', () => {
  it('a discarded C0 byte inside the payload does not break it, and is not included', () => {
    expect(signalsOf(`${ESC}]0;a\x01b${BEL}`)).toEqual([{ kind: 'title', title: 'ab' }]);
  });

  it('accented characters and an astral emoji survive a mid-surrogate-pair split intact', () => {
    const title = 'café \u{1F680}'; // café + rocket emoji (outside the BMP: a surrogate pair)
    const stream = `${ESC}]0;${title}${BEL}`;
    // The emoji is the last two UTF-16 code units of `title` (a surrogate
    // pair). Cut the stream right between its high and low surrogate.
    const highSurrogateIndex = stream.indexOf(title) + title.length - 2;
    const cut = highSurrogateIndex + 1;
    const scanner = new SignalScanner();
    const raw = [...scanner.feed(stream.slice(0, cut)), ...scanner.feed(stream.slice(cut))];
    expect(raw).toEqual([{ type: 'osc', id: 0, payload: title }]);
  });
});

describe('TerminalSignalParser — test 7: differential against @xterm/headless', () => {
  // Small, dependency-free, deterministic PRNG (mulberry32) so a failure can
  // be reproduced exactly from the printed seed.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function random(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ALPHABET = [
    ESC,
    ']',
    '\\',
    '[',
    'P',
    '_',
    BEL,
    CAN,
    SUB,
    C1_ST,
    C1_OSC,
    '\u0090',
    ';',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '0',
    '2',
    '9',
    '133',
    '777',
    'A',
    'B',
    'C',
    'D',
    'a',
    'b',
    'c',
    '\x01',
    ' ',
  ];

  function pick<T>(rng: () => number, arr: readonly T[]): T {
    const item = arr[Math.floor(rng() * arr.length)];
    if (item === undefined) {
      throw new Error('unreachable: index within bounds');
    }
    return item;
  }

  function randomStream(rng: () => number): string {
    const tokenCount = 1 + Math.floor(rng() * 30);
    let s = '';
    for (let i = 0; i < tokenCount; i++) {
      s += pick(rng, ALPHABET);
    }
    return s;
  }

  /** Splits `stream` into a random sequence of non-empty chunks that concatenate back to it. */
  function randomChunks(rng: () => number, stream: string): string[] {
    const chunks: string[] = [];
    let pos = 0;
    while (pos < stream.length) {
      const remaining = stream.length - pos;
      const size = 1 + Math.floor(rng() * Math.min(remaining, 4));
      chunks.push(stream.slice(pos, pos + size));
      pos += size;
    }
    return chunks;
  }

  function escapeForDisplay(s: string): string {
    return JSON.stringify(s);
  }

  type Event = { type: 'bell' } | { type: 'osc'; id: number; payload: string };

  async function xtermEvents(stream: string): Promise<Event[]> {
    const events: Event[] = [];
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const trackedIds = [0, 2, 9, 133, 777];
    const disposables = trackedIds.map((id) =>
      terminal.parser.registerOscHandler(id, (data: string) => {
        events.push({ type: 'osc', id, payload: data });
        return false;
      }),
    );
    const bellDisposable = terminal.onBell(() => {
      events.push({ type: 'bell' });
    });
    await new Promise<void>((resolve) => {
      terminal.write(stream, resolve);
    });
    for (const d of disposables) {
      d.dispose();
    }
    bellDisposable.dispose();
    terminal.dispose();
    return events;
  }

  function scannerEvents(stream: string, chunks: string[]): Event[] {
    const scanner = new SignalScanner();
    const trackedIds = new Set([0, 2, 9, 133, 777]);
    const events: Event[] = [];
    for (const chunk of chunks) {
      for (const raw of scanner.feed(chunk)) {
        if (raw.type === 'bell') {
          events.push({ type: 'bell' });
        } else if (trackedIds.has(raw.id)) {
          events.push({ type: 'osc', id: raw.id, payload: raw.payload });
        }
      }
    }
    return events;
  }

  const SEED = 0xc0ffee;
  const CASE_COUNT = 2000;

  it(`agrees with @xterm/headless on ${CASE_COUNT} random streams (seed 0x${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    let executed = 0;

    for (let i = 0; i < CASE_COUNT; i++) {
      const stream = randomStream(rng);
      const chunks = randomChunks(rng, stream);

      const [expected, actual] = await Promise.all([
        xtermEvents(stream),
        Promise.resolve(scannerEvents(stream, chunks)),
      ]);

      expect(
        actual,
        `mismatch on case ${i} (seed 0x${SEED.toString(16)}), stream = ${escapeForDisplay(stream)}, chunks = ${JSON.stringify(chunks.map(escapeForDisplay))}`,
      ).toEqual(expected);
      executed++;
    }

    expect(executed).toBe(CASE_COUNT);
    console.log(`test 7: ${executed} differential cases executed, seed 0x${SEED.toString(16)}`);
  }, 60_000);
});

describe('TerminalSignalParser — test 8: cost', () => {
  it('processes 10 MB with an OSC every 4 KB, in 16 KB chunks, in under 2 seconds', () => {
    const totalSize = 10 * 1024 * 1024;
    const oscEvery = 4096;
    const chunkSize = 16 * 1024;
    const filler = 'the quick brown fox jumps over the lazy dog. '.repeat(100); // > 4096 chars

    let full = '';
    while (full.length < totalSize) {
      full += filler.slice(0, oscEvery - `${ESC}]0;progress${BEL}`.length);
      full += `${ESC}]0;progress${BEL}`;
    }
    full = full.slice(0, totalSize);

    const parser = new TerminalSignalParser();
    const start = performance.now();
    for (let i = 0; i < full.length; i += chunkSize) {
      parser.feed(full.slice(i, i + chunkSize));
    }
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
  });
});
