// Pure signal extraction from a session's PTY output stream: bell, title,
// notification, progress and shell-integration marks. This module has two
// layers (`SignalScanner`, `TerminalSignalParser`) that together reproduce
// the tokenizing half of xterm.js's `EscapeSequenceParser` — the exact
// state machine that decides where a control string (OSC/DCS/SOS/PM/APC)
// starts and ends, since that is what the ConPTY-mangled stream this daemon
// receives actually looks like on the wire (see `docs/specs/m5.1-osc-parser.md`
// section 1 for the measured facts, section 3.2 for the state table this
// class implements).
//
// This module only observes: `feed()` never returns bytes, and there is no
// "strip" or "filter" option. The raw stream keeps flowing untouched to the
// headless buffer (./buffer.ts) and to attached clients; wiring an instance
// of `TerminalSignalParser` to `Session#onData` is M5.3's job, not this
// one's.

/**
 * Maximum OSC payload kept, in UTF-16 code units, while a control string is
 * being accumulated. Longer OSCs are not indefinitely buffered — accumulation
 * stops at the cap, the scanner stays in the OSC state until the terminator
 * arrives, and dispatch emits nothing for that OSC. Without this, a program
 * that writes `ESC ]` and never terminates (or streams binary garbage) would
 * grow this daemon's memory without bound for as long as the session lives
 * (spec section 2.3).
 */
export const MAX_OSC_PAYLOAD = 4096;

/** Low-level output of the scanner: exactly what a terminal would dispatch. */
export type RawSignal = { type: 'bell' } | { type: 'osc'; id: number; payload: string };

type ScannerState = 'ground' | 'escape' | 'escapeIntermediate' | 'oscString' | 'ignoredString';

/**
 * Stateful tokenizer that copies the parts of xterm.js's
 * `EscapeSequenceParser` (`node_modules/@xterm/xterm/src/common/parser/EscapeSequenceParser.ts`)
 * that decide where control strings begin and end. It does not interpret
 * CSI or DCS payloads, does not track SGR state, and does not render
 * anything — it only recognizes bells and dispatches finished OSCs.
 *
 * One instance per session; never shared. There is no `reset()` or
 * `dispose()` — the instance is cheap enough that it simply dies with the
 * session that owns it (spec section 3.1).
 */
export class SignalScanner {
  private state: ScannerState = 'ground';
  /** Raw "id;payload" accumulated so far for the OSC currently in progress. */
  private oscRaw = '';
  /** Set once `oscRaw` hit `MAX_OSC_PAYLOAD`; suppresses the eventual dispatch. */
  private oscOverflowed = false;

  /** Length of the OSC payload currently being accumulated (0 outside an OSC). For tests. */
  get pendingPayloadLength(): number {
    return this.state === 'oscString' ? this.oscRaw.length : 0;
  }

  /**
   * Scans one chunk. Synchronous, never throws, returns signals in stream
   * order. Malformed input never produces an exception — at worst it
   * produces no event, or aborts a control string silently, exactly like a
   * real terminal would (spec section 2.1–2.3).
   *
   * Single pass over `chunk` with `charCodeAt`; no regex over the whole
   * chunk. In `ground` (plain text, the overwhelming majority of a chunk)
   * nothing is copied. The OSC payload is the only thing ever copied, and
   * it is copied in contiguous slices, not character by character.
   */
  feed(chunk: string): RawSignal[] {
    const signals: RawSignal[] = [];
    const len = chunk.length;
    let i = 0;

    while (i < len) {
      const code = chunk.charCodeAt(i);

      // "Anywhere" transitions: xterm's global rules, which fire regardless
      // of the current state (spec section 3.2, "regras que valem em
      // qualquer estado"). Checked first so state-specific handling below
      // never has to consider these code points again.
      if (code === 0x1b) {
        // ESC. A control string in progress dispatches successfully before
        // the state change — this is why a plain ST (`ESC \`) terminates an
        // OSC: the ESC alone already dispatched it, and the following `\`
        // is just consumed harmlessly back in `escape`.
        if (this.state === 'oscString') {
          this.dispatchOsc(signals);
        } else {
          this.abortOsc();
        }
        this.state = 'escape';
        i++;
        continue;
      }
      if (code === 0x18 || code === 0x1a) {
        // CAN / SUB: abort any control string in progress, no event.
        this.abortOsc();
        this.state = 'ground';
        i++;
        continue;
      }
      if (code >= 0x80 && code <= 0x9f) {
        // C1 control codes.
        if (code === 0x9d) {
          // OSC start (C1 form).
          this.startOsc();
        } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          // DCS / SOS / PM / APC start (C1 form).
          this.abortOsc();
          this.state = 'ignoredString';
        } else if (code === 0x9c) {
          // ST (C1 form): dispatches an OSC in progress, otherwise a no-op.
          if (this.state === 'oscString') {
            this.dispatchOsc(signals);
          } else {
            this.abortOsc();
          }
          this.state = 'ground';
        } else {
          // U+009B (CSI) and the remaining C1 codes: abort silently.
          this.abortOsc();
          this.state = 'ground';
        }
        i++;
        continue;
      }

      switch (this.state) {
        case 'ground':
          if (code === 0x07) {
            signals.push({ type: 'bell' });
          }
          i++;
          break;

        case 'escape':
          i = this.stepEscape(code, i, signals);
          break;

        case 'escapeIntermediate':
          i = this.stepEscapeIntermediate(code, i, signals);
          break;

        case 'ignoredString':
          // Everything is ignored here; only an "anywhere" transition
          // (handled above) can leave this state.
          i++;
          break;

        case 'oscString':
          i = this.stepOscString(chunk, i, len, signals);
          break;
      }
    }

    return signals;
  }

  private stepEscape(code: number, i: number, signals: RawSignal[]): number {
    if (code === 0x5d) {
      // ']' -> OSC.
      this.startOsc();
    } else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
      // 'P' (DCS), 'X' (SOS), '^' (PM), '_' (APC).
      this.abortOsc();
      this.state = 'ignoredString';
    } else if (code >= 0x20 && code <= 0x2f) {
      this.state = 'escapeIntermediate';
    } else if (code === 0x07) {
      // BEL is executed (and stays in `escape`) rather than starting/ending
      // anything here — this is a real bell, unlike inside an OSC.
      signals.push({ type: 'bell' });
      this.state = 'escape';
    } else if (code === 0x7f || code < 0x20) {
      // DEL and the remaining C0 controls: ignored, stay in `escape`.
      this.state = 'escape';
    } else if (code >= 0x30 && code <= 0x7e) {
      // Any other final byte, including CSI's '[': dispatches whatever
      // single-char escape sequence this is (not our concern) and returns
      // to ground, same as plain text would.
      this.state = 'ground';
    } else {
      // Anything else (e.g. non-ASCII printable) falls back to ground,
      // mirroring the parser's default transition.
      this.state = 'ground';
    }
    return i + 1;
  }

  private stepEscapeIntermediate(code: number, i: number, signals: RawSignal[]): number {
    if (code === 0x07) {
      signals.push({ type: 'bell' });
      this.state = 'escapeIntermediate';
    } else if (code >= 0x20 && code <= 0x2f) {
      this.state = 'escapeIntermediate';
    } else if (code === 0x7f || code < 0x20) {
      this.state = 'escapeIntermediate';
    } else {
      // 0x30-0x7e and anything else: back to ground.
      this.state = 'ground';
    }
    return i + 1;
  }

  /** Advances through `oscString`, accumulating a run of payload characters at once. */
  private stepOscString(chunk: string, i: number, len: number, signals: RawSignal[]): number {
    const code = chunk.charCodeAt(i);

    if (code === 0x07) {
      // BEL as OSC terminator dispatches — it is not a bell (spec 2.1).
      this.dispatchOsc(signals);
      this.state = 'ground';
      return i + 1;
    }
    if (code < 0x20) {
      // Other C0 controls are discarded from the payload but do not
      // terminate the OSC (matches xterm's OSC_STRING ignore rule).
      return i + 1;
    }

    // Bulk-consume a contiguous run of payload characters: 0x20-0x7f and
    // U+00A0+. C1 codes 0x80-0x9f were already handled as "anywhere" rules
    // above, so they can't appear in this run.
    let j = i;
    while (j < len) {
      const c = chunk.charCodeAt(j);
      if (c < 0x20 || (c >= 0x80 && c <= 0x9f)) {
        break;
      }
      j++;
    }
    this.appendOscRaw(chunk, i, j);
    return j;
  }

  private startOsc(): void {
    this.oscRaw = '';
    this.oscOverflowed = false;
    this.state = 'oscString';
  }

  private abortOsc(): void {
    this.oscRaw = '';
    this.oscOverflowed = false;
  }

  private appendOscRaw(chunk: string, start: number, end: number): void {
    if (this.oscOverflowed || end <= start) {
      return;
    }
    const remaining = MAX_OSC_PAYLOAD - this.oscRaw.length;
    if (end - start <= remaining) {
      this.oscRaw += chunk.slice(start, end);
    } else {
      this.oscRaw += chunk.slice(start, start + remaining);
      this.oscOverflowed = true;
    }
  }

  private dispatchOsc(signals: RawSignal[]): void {
    if (!this.oscOverflowed) {
      const parsed = parseOscRaw(this.oscRaw);
      if (parsed !== null) {
        signals.push({ type: 'osc', id: parsed.id, payload: parsed.payload });
      }
    }
    this.abortOsc();
  }
}

/**
 * Splits a raw accumulated OSC body ("id;payload") the way xterm does: the
 * digits before the first `;` are the id, and everything after it is the
 * payload verbatim (may itself contain `;`). No `;` at all means an empty
 * payload. Anything else before the first `;` — a non-digit, or no digits —
 * aborts: there is no id to dispatch to, so this returns `null`.
 */
function parseOscRaw(raw: string): { id: number; payload: string } | null {
  const separator = raw.indexOf(';');
  const idPart = separator === -1 ? raw : raw.slice(0, separator);
  if (idPart.length === 0) {
    return null;
  }
  for (let i = 0; i < idPart.length; i++) {
    const code = idPart.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      return null;
    }
  }
  const payload = separator === -1 ? '' : raw.slice(separator + 1);
  return { id: Number(idPart), payload };
}

/** Interpreted, high-level signal the status detector (M5.2) will consume. */
export type TerminalSignal =
  | { kind: 'bell' }
  | { kind: 'title'; title: string }
  | { kind: 'notification'; source: 'osc9' | 'osc777'; title: string | null; body: string }
  | { kind: 'progress'; state: 0 | 1 | 2 | 3 | 4; value: number | null }
  | { kind: 'shell-mark'; mark: 'A' | 'B' | 'C' | 'D'; exitCode: number | null };

/** A ConEmu/Windows Terminal `9;N;...` command: `^\d+(;|$)`, checked without a whole-payload regex on the hot path (this runs once per dispatched OSC, not per byte of the stream). */
function isConEmuCommand(payload: string): boolean {
  let i = 0;
  const len = payload.length;
  while (i < len) {
    const code = payload.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      break;
    }
    i++;
  }
  if (i === 0) {
    return false;
  }
  return i === len || payload.charCodeAt(i) === 0x3b; // ';'
}

/** Parses a decimal integer field from `parts[index]`, or `null` if absent, empty, or not an integer. */
function parseIntField(parts: string[], index: number): number | null {
  const raw = parts[index];
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function interpretOsc9(payload: string): TerminalSignal | null {
  if (payload.length === 0) {
    return null;
  }
  if (!isConEmuCommand(payload)) {
    return { kind: 'notification', source: 'osc9', title: null, body: payload };
  }
  // ConEmu command: only `9;4;state[;value]` (progress) is interpreted.
  const parts = payload.split(';');
  if (parts[0] !== '4') {
    return null;
  }
  const state = parseIntField(parts, 1);
  if (state === null || state < 0 || state > 4) {
    return null;
  }
  let value = parseIntField(parts, 2);
  if (value !== null && (value < 0 || value > 100)) {
    value = null;
  }
  // `state` was just checked to be an integer in [0, 4] above; TypeScript
  // can't narrow a `number` to this literal union on its own.
  const progressState = state as 0 | 1 | 2 | 3 | 4;
  return { kind: 'progress', state: progressState, value };
}

function interpretOsc777(payload: string): TerminalSignal | null {
  const firstSemi = payload.indexOf(';');
  const command = firstSemi === -1 ? payload : payload.slice(0, firstSemi);
  if (command !== 'notify') {
    return null;
  }
  const rest = firstSemi === -1 ? '' : payload.slice(firstSemi + 1);
  const secondSemi = rest.indexOf(';');
  const title = secondSemi === -1 ? rest : rest.slice(0, secondSemi);
  const body = secondSemi === -1 ? '' : rest.slice(secondSemi + 1);
  return { kind: 'notification', source: 'osc777', title, body };
}

function isShellMark(c: string): c is 'A' | 'B' | 'C' | 'D' {
  return c === 'A' || c === 'B' || c === 'C' || c === 'D';
}

function interpretOsc133(payload: string): TerminalSignal | null {
  const markChar = payload.charAt(0);
  if (!isShellMark(markChar)) {
    return null;
  }
  let exitCode: number | null = null;
  if (markChar === 'D') {
    // `payload` looks like "D" or "D;<code>;<...ignored>". `payload.slice(1)`
    // starts with the ';' before the exit code (or is empty), so splitting
    // it puts the code at index 1.
    const parts = payload.slice(1).split(';');
    exitCode = parseIntField(parts, 1);
  }
  return { kind: 'shell-mark', mark: markChar, exitCode };
}

/**
 * Pure. Maps one dispatched OSC to a signal, or `null` when it is not one we
 * use (spec section 3.3). Never throws.
 */
export function interpretOsc(id: number, payload: string): TerminalSignal | null {
  switch (id) {
    case 0:
    case 2:
      return { kind: 'title', title: payload };
    case 9:
      return interpretOsc9(payload);
    case 133:
      return interpretOsc133(payload);
    case 777:
      return interpretOsc777(payload);
    default:
      return null;
  }
}

/**
 * Scanner + interpretation. This is what M5.3 wires to `Session.onData`
 * (see `docs/specs/m5.1-osc-parser.md`, out of scope for this module).
 */
export class TerminalSignalParser {
  private readonly scanner = new SignalScanner();

  /** Feeds one chunk and returns the interpreted signals it produced, in order. */
  feed(chunk: string): TerminalSignal[] {
    const raw = this.scanner.feed(chunk);
    const result: TerminalSignal[] = [];
    for (const signal of raw) {
      if (signal.type === 'bell') {
        result.push({ kind: 'bell' });
        continue;
      }
      const interpreted = interpretOsc(signal.id, signal.payload);
      if (interpreted !== null) {
        result.push(interpreted);
      }
    }
    return result;
  }
}
