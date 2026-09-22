import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SCROLLBACK, TerminalBuffer } from './buffer.js';

// `@xterm/headless`'s `buffer` accessor and a couple of APIs
// `@xterm/addon-serialize` depends on internally are still marked
// "proposed" in xterm.js, so every raw comparison `Terminal` this test file
// creates directly (i.e. not through `TerminalBuffer`, which already sets
// this — see buffer.ts) needs the same flag to read buffer contents back
// out.
const COMPARISON_OPTS = { allowProposedApi: true } as const;

/** Promisifies `Terminal#write`, resolving once the parser has fully processed `data`. */
function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

/** Every line currently in `terminal`'s active buffer (scrollback + viewport), trimmed of trailing whitespace. */
function linesOf(terminal: Terminal): string[] {
  const lines: string[] = [];
  for (let y = 0; y < terminal.buffer.active.length; y++) {
    lines.push(terminal.buffer.active.getLine(y)?.translateToString(true) ?? '');
  }
  return lines;
}

describe('TerminalBuffer', () => {
  it('round-trips a realistic stream: serialize() replayed into a fresh terminal matches the original screen line by line', async () => {
    const cols = 24;
    const rows = 6;

    // A realistic mix of what actually arrives from a PTY in separate
    // chunks: plain text, ANSI SGR colors, an absolute cursor move (CUP),
    // a full screen clear + cursor home, and more text written afterward —
    // exactly the shape M1.7's reattach snapshot has to survive.
    const chunks = [
      'line one\r\n',
      '\x1b[31mred\x1b[39m and \x1b[32mgreen\x1b[39m\r\n',
      'line three\r\n',
      '\x1b[2;5Hmoved-here',
      '\r\n\x1b[2J\x1b[H',
      'after clear, line 1\r\n',
      'after clear, line 2\r\n',
    ];

    const source = new TerminalBuffer({ cols, rows, scrollback: 100 });
    for (const chunk of chunks) {
      source.write(chunk);
    }
    const { vt, seq } = await source.serialize();
    expect(seq).toBe(chunks.length);

    // Ground truth: an independent raw terminal driven with the exact same
    // chunks, with nothing going through TerminalBuffer or serialize() at all.
    const expected = new Terminal({ cols, rows, ...COMPARISON_OPTS });
    for (const chunk of chunks) {
      await writeAndWait(expected, chunk);
    }

    // The terminal under test: brand new and empty, fed only the
    // serialized VT sequences — this is exactly what M1.7 does on reattach.
    const target = new Terminal({ cols, rows, ...COMPARISON_OPTS });
    await writeAndWait(target, vt);

    expect(linesOf(target)).toEqual(linesOf(expected));
    expect(target.buffer.active.cursorX).toBe(expected.buffer.active.cursorX);
    expect(target.buffer.active.cursorY).toBe(expected.buffer.active.cursorY);

    source.dispose();
    expected.dispose();
    target.dispose();
  });

  it('drains every queued write(), in order, before serialize() resolves', async () => {
    const cols = 80;
    const rows = 5;
    const buffer = new TerminalBuffer({ cols, rows });

    // Fire 50 single-character writes back-to-back with nothing awaited in
    // between — the exact shape of agent output arriving in a burst of
    // small PTY chunks. Naive serialize()-right-after-write() (proven above
    // to return "" on an undrained terminal) or any reordering would fail
    // the exact-string check below.
    let expectedText = '';
    for (let i = 0; i < 50; i++) {
      const chunk = String(i % 10);
      buffer.write(chunk);
      expectedText += chunk;
    }

    const { vt, seq } = await buffer.serialize();
    expect(seq).toBe(50);
    const target = new Terminal({ cols, rows, ...COMPARISON_OPTS });
    await writeAndWait(target, vt);

    const firstLine = target.buffer.active.getLine(0)?.translateToString(true) ?? '';
    expect(firstLine).toBe(expectedText);

    buffer.dispose();
    target.dispose();
  });

  it('discards the oldest scrollback lines once the configured limit is exceeded, keeping the most recent ones', async () => {
    const cols = 16;
    const rows = 3;
    const scrollback = 5;
    const buffer = new TerminalBuffer({ cols, rows, scrollback });

    const totalLines = 30;
    for (let i = 0; i < totalLines; i++) {
      buffer.write(`L${i}\r\n`);
    }
    const { vt } = await buffer.serialize();

    const target = new Terminal({ cols, rows, ...COMPARISON_OPTS });
    await writeAndWait(target, vt);
    const text = linesOf(target).join('\n');

    // The earliest lines must be gone...
    expect(text).not.toContain('L0\n');
    expect(text).not.toContain('L1\n');
    expect(text).not.toContain('L10\n');
    // ...while the most recent ones survive.
    expect(text).toContain(`L${totalLines - 1}`);
    expect(text).toContain(`L${totalLines - 2}`);
    // And the replayed buffer never holds more than scrollback + viewport
    // rows worth of lines, proving the cap was enforced on write, not just
    // hidden by the replay.
    expect(target.buffer.active.length).toBeLessThanOrEqual(scrollback + rows);

    buffer.dispose();
    target.dispose();
  });

  it('defaults to DEFAULT_SCROLLBACK and dispose() is safe to call more than once', async () => {
    const buffer = new TerminalBuffer({ cols: 80, rows: 24 });
    expect(DEFAULT_SCROLLBACK).toBeGreaterThan(1000);

    buffer.write('hello\r\n');
    await buffer.serialize();

    buffer.dispose();
    expect(() => buffer.dispose()).not.toThrow();
  });

  it('sequence() matches the number of write() calls, and serialize() excludes a write() issued after it was called — not by timing luck, but because serialize() splices its read into the write chain', async () => {
    const cols = 40;
    const rows = 5;
    const buffer = new TerminalBuffer({ cols, rows });

    expect(buffer.sequence).toBe(0);
    buffer.write('before\r\n');
    expect(buffer.sequence).toBe(1);

    // Call serialize() but don't await it yet, then — still perfectly
    // deterministically, since nothing has yielded to the event loop —
    // issue one more write(). This is exactly the M1.7 danger window
    // (docs/specs/m1.7-attach-detach.md section 2): a write "during"
    // serialize()'s own await.
    const serializePromise = buffer.serialize();
    buffer.write('after\r\n');
    expect(buffer.sequence).toBe(2);

    const { vt, seq } = await serializePromise;
    // The returned seq is frozen at the value serialize() saw when it was
    // *called*, not when it resolves — it must not have observed the
    // second write() even though that write() happened before this await
    // completed.
    expect(seq).toBe(1);

    const target = new Terminal({ cols, rows, ...COMPARISON_OPTS });
    await writeAndWait(target, vt);
    const text = linesOf(target).join('\n');
    expect(text).toContain('before');
    expect(text).not.toContain('after');

    buffer.dispose();
    target.dispose();
  });
});
