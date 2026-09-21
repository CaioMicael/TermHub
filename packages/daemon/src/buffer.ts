import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

// A headless terminal emulator, one per session, that mirrors the exact
// byte stream a `Session` (./session.ts, M1.3) produces from its PTY. It
// exists so the daemon can answer "what does the screen look like right
// now" for a client that isn't attached at the moment — the snapshot half
// of reattach (M1.7). This module does not know about sessions, the
// registry, or the wire protocol; it only turns a VT byte stream into
// "current screen state" and back into a VT byte stream. Wiring one of
// these to a `Session`'s `onData`/`onExit` and to `session.attach` on the
// wire is M1.7's job, not this one's.
//
// It's the same trick VS Code's pty host uses to support reattach: keep a
// real terminal emulator (not just a string buffer) fed the live stream, so
// escape sequences, cursor movement, and screen clears are interpreted
// exactly the way a real terminal would interpret them, and can be
// re-serialized into VT sequences that reproduce the same state in a brand
// new terminal.

/**
 * Default scrollback length, in lines, when `TerminalBufferOptions.scrollback`
 * is omitted.
 *
 * xterm.js itself defaults to 1000, which is tuned for an interactive human
 * scrolling a viewport, not for holding enough history that a client
 * reattaching hours later still finds useful context from an AI agent that
 * can produce thousands of lines of output unattended. 10,000 lines matches
 * the scrollback depth `docs/milestones.md` (M6.3) already assumes buffer
 * search has to cope with, and — at a few hundred bytes per xterm buffer
 * line — stays in the low single-digit megabytes per session, which is
 * cheap enough to keep for every session the daemon tracks, not just the
 * attached one.
 */
export const DEFAULT_SCROLLBACK = 10_000;

export interface TerminalBufferOptions {
  /** Initial terminal width in columns. */
  cols: number;
  /** Initial terminal height in rows. */
  rows: number;
  /**
   * How many lines of scrollback to retain above the viewport. Writing
   * past this limit discards the oldest lines first. Defaults to
   * `DEFAULT_SCROLLBACK`.
   */
  scrollback?: number;
}

/**
 * Headless terminal buffer that mirrors a session's PTY stream and can
 * serialize its current state (screen + scrollback) back into VT sequences.
 *
 * ## Why `write` doesn't return the serialized state, and `serialize` is async
 *
 * `@xterm/headless`'s `Terminal.write()` is asynchronous: it queues data
 * into a parser that drains it later, on a microtask/macrotask schedule
 * internal to xterm, and only calls back once that specific chunk has been
 * fully parsed. Calling `serialize()` right after `write()` without waiting
 * for that callback can observe a *partially parsed* screen — the class of
 * bug that passes with a two-line test and silently corrupts real agent
 * output, which arrives in many chunks in quick succession.
 *
 * This class closes that gap so the caller cannot get it wrong:
 * - `write()` stays synchronous in its own signature (matching
 *   `Session#write`), but internally chains every write onto a private
 *   promise, so the parser processes writes strictly in call order and each
 *   one's completion is tracked.
 * - `serialize()` is `async` and *always* awaits that chain before reading
 *   anything out of the terminal. There is no synchronous "peek" method
 *   that could race ahead of a pending write — `serialize()` is the only
 *   way to read the state back out, and it is race-proof by construction.
 */
export class TerminalBuffer {
  private readonly terminal: Terminal;
  private readonly serializeAddon: SerializeAddon;
  private disposed = false;
  /**
   * Tail of the write chain: resolves once every `write()` call issued so
   * far has been fully parsed by xterm's internal parser, in order.
   */
  private pendingWrites: Promise<void> = Promise.resolve();
  /**
   * Monotonic count of `write()` calls issued so far, incremented
   * synchronously inside `write()` — see `sequence`'s doc comment for why
   * this exists (M1.7's reattach race, `docs/specs/m1.7-attach-detach.md`
   * section 2).
   */
  private writeSeq = 0;

  constructor(options: TerminalBufferOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      // @xterm/addon-serialize reaches into a couple of xterm.js APIs that
      // are still marked "proposed" (e.g. reading rows/cols off a headless
      // terminal to know what it's serializing). Without this, `serialize()`
      // throws "You must set the allowProposedApi option to true to use
      // proposed API" the first time it's called — this isn't optional
      // configuration, it's required for the addon to function headlessly.
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
  }

  /**
   * Feeds data into the emulator, exactly as it arrived from the PTY (e.g.
   * a `Session#onData` payload). Safe to call repeatedly in a tight loop —
   * each call is queued behind the previous one internally, so writes are
   * always parsed in the order they were submitted regardless of how xterm
   * schedules its parser.
   */
  write(data: string): void {
    // Synchronous, unconditional: every call — even one issued while a
    // `serialize()` is in flight — gets the next number, with no gap where a
    // caller could observe an in-between state. `sequence`'s doc comment and
    // `serialize()` below explain what this number is *for*.
    this.writeSeq += 1;
    this.pendingWrites = this.pendingWrites.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
    );
  }

  /**
   * The sequence number of the most recent `write()` call, i.e. how many
   * `write()` calls have been made so far. Read this synchronously, right
   * after calling `write()` (no `await` in between — there must not be one,
   * since another `write()` could land in that gap), to learn the sequence
   * number `write()` call just got — that's the `chunkSeq` M1.7's
   * `docs/specs/m1.7-attach-detach.md` (section 3.2/3.3) needs to decide
   * whether a chunk delivered to a newly-attaching client is already
   * reflected in a `serialize()` snapshot or not.
   */
  get sequence(): number {
    return this.writeSeq;
  }

  /** Resizes the emulator's viewport. Does not affect retained scrollback. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /**
   * Serializes the current screen and scrollback into VT sequences that,
   * written into a fresh terminal of the same size, reproduce this
   * terminal's visible state — including cursor position, in-progress SGR
   * attributes, and (if active) the alternate screen buffer — plus the
   * `write()` sequence number (`seq`) that state reflects.
   *
   * `seq` is captured *synchronously*, at call time, before this method's
   * first `await` — it is exactly `this.writeSeq` at the instant
   * `serialize()` was called, not at the instant it resolves. That
   * distinction is the whole point: `write()` calls made *after*
   * `serialize()` is called but *before* it resolves must not silently leak
   * into `vt`, or a caller relying on `seq` as "the boundary between what's
   * in `vt` and what isn't" (M1.7's reattach) would sometimes get a `vt`
   * containing one write more than `seq` claims.
   *
   * That guarantee doesn't come from hoping microtask ordering works out —
   * it comes from where the read is spliced into the write chain. `read`
   * below is chained onto `pendingWrites` *as captured at this call*, so it
   * runs only after every write issued so far has been parsed. Then
   * `pendingWrites` is reassigned to run *after* `read` — so any `write()`
   * called during this `await` doesn't just get a higher `seq`, its
   * underlying `terminal.write()` is *held back* until after `read`'s
   * `serializeAddon.serialize()` call has already captured the screen. Two
   * independent things point the same way (the sequence number and the
   * actual terminal content), instead of one guarding a promise the other
   * doesn't keep.
   *
   * Still always waits for every write issued *before* this call to be
   * fully parsed first, same as before — the result never reflects a
   * partially processed write (see the class doc comment).
   */
  async serialize(): Promise<{ vt: string; seq: number }> {
    const seq = this.writeSeq;
    const read = this.pendingWrites.then(() => this.serializeAddon.serialize());
    this.pendingWrites = read.then(() => undefined);
    return { vt: await read, seq };
  }

  /**
   * Releases the emulator. Safe to call once the buffer is no longer
   * needed; nothing else in this class is usable afterward.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.serializeAddon.dispose();
    this.terminal.dispose();
  }
}
