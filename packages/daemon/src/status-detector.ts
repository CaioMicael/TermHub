// M5.2: turns the M5.1 signal stream (plus input/resize/exit events) into a
// `SessionStatus`, without ever touching a PTY, the registry, or the wire
// protocol — everything this module needs is the narrow `TerminalSignal[]`
// the M5.1 parser already produces, and three notifications
// (`onInput`/`onResize`/`onExit`) a caller (M5.3) will drive from
// `Session#onData`/`writeSessionInput`/`session.resize`/`Session#onExit`.
//
// Two decisions this module hard-codes, both from
// `docs/specs/m5.2-status-detector.md` and not reversible by "simplifying"
// the code:
//
// 1. Stopped output alone does not mean "waiting for input". The `claude`
//    CLI sends no BEL/OSC signal to an unrecognized terminal by default
//    (spec section 1), so silence is judged by the session's *origin*
//    instead: a session launched with a `command` (M4.7) treats silence as
//    `awaiting-input`; a plain shell treats it as `idle` (spec section 2).
// 2. A signal that shares a chunk with ordinary output always wins, and the
//    resulting `awaiting-input` is *sticky* — later output cannot clear it,
//    only `onInput`, an OSC 133 mark, or exit can (spec section 3.3). This
//    exists because ConPTY delivers BEL/OSC 9/OSC 777 out of order relative
//    to the text of the same frame (`docs/specs/m5.1-osc-parser.md` section
//    1): if "signal → awaiting-input" could be immediately overwritten by
//    "text from the same chunk → running", the signal would be lost every
//    time.

import type { SessionStatus } from '@termhub/shared';

import type { TerminalSignal } from './osc-parser.js';

/** Default silence threshold before leaving `running`, absent an explicit `quietMs`. Per-profile overrides (`config.json`) are out of scope here — see spec section 6, wired in M7.1. */
export const DEFAULT_QUIET_MS = 3_000;

/** How long after `onInput` that output (or a bell) is ignored as keystroke echo — the shell's own echo, or a TUI redrawing its input field (spec section 3.1). Each new input extends the window. */
export const ECHO_WINDOW_MS = 250;

/** How long after `onResize` that output is ignored as a repaint — ConPTY redraws the whole screen on resize, which is not work (spec section 3.2). Unlike the echo window, a bell inside this window still counts: resizing does not ring a bell. */
export const RESIZE_WINDOW_MS = 500;

export interface StatusDetectorOptions {
  /** True when the session was created with a `command` (M4.7). Decides what silence means (spec section 2). */
  agent: boolean;
  /** Silence needed before leaving `running`. Any value that isn't a positive integer falls back to `DEFAULT_QUIET_MS`. */
  quietMs?: number;
}

export type StatusListener = (status: SessionStatus, since: number) => void;

/** The last OSC 133 shell-integration mark seen, or `null` if none yet. "In prompt" means `A`, `B`, or `D` (spec section 4.2). */
type ShellMark = 'A' | 'B' | 'C' | 'D' | null;

function resolveQuietMs(quietMs: number | undefined): number {
  if (quietMs === undefined || !Number.isInteger(quietMs) || quietMs <= 0) {
    return DEFAULT_QUIET_MS;
  }
  return quietMs;
}

/**
 * Pure(-ish) status state machine for one session. Synchronous and
 * exception-free on every method — every method here runs straight inside
 * `Session#onData`, the input handler, or the resize handler (M5.3), and a
 * throwing listener must never break that delivery path (spec section 4.1).
 *
 * Time comes from the global `Date.now`/`setTimeout`/`clearTimeout`,
 * deliberately not from an injected clock: the only tests that exist for
 * this module drive Vitest's fake timers, which replace those globals
 * directly (spec section 4.1). Unlike `graveyard.ts`'s `GraveyardClock`,
 * there's no second caller here needing a *real* clock alongside a faked
 * one, so the extra seam would be unused indirection.
 */
export class StatusDetector {
  private readonly agent: boolean;
  private readonly quietMs: number;

  private currentStatus: SessionStatus = 'running';
  private currentSince: number;

  /** True while the current `awaiting-input` came from an explicit signal (spec section 3.3) — later plain output must not clear it. */
  private sticky = false;
  private lastMark: ShellMark = null;
  private echoUntil = 0;
  private resizeUntil = 0;

  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private listeners: StatusListener[] = [];

  constructor(options: StatusDetectorOptions) {
    this.agent = options.agent;
    this.quietMs = resolveQuietMs(options.quietMs);
    this.currentSince = Date.now();
    // The constructor arms the timer itself: a session that never writes
    // anything must not stay `running` forever (spec section 4.1).
    this.armSilenceTimer();
  }

  get status(): SessionStatus {
    return this.currentStatus;
  }

  get since(): number {
    return this.currentSince;
  }

  /** One output chunk arrived, with the signals the M5.1 parser found in it. Applies the rules of spec section 4.3, in order. */
  onOutput(signals: readonly TerminalSignal[]): void {
    if (this.currentStatus === 'exited' || this.disposed) {
      return;
    }
    const now = Date.now();

    // Step 2: the last shell-mark in the chunk (if any) is the one in
    // effect — marks arrive in stream order (M5.1 section 1).
    for (const signal of signals) {
      if (signal.kind === 'shell-mark') {
        this.lastMark = signal.mark;
      }
    }

    // Step 3: a notification always counts; a bell only outside the echo
    // window. Either wins over everything else in this chunk, including a
    // shell-mark that arrived in the very same chunk (spec section 3.3).
    const hasWinningSignal = signals.some(
      (signal) =>
        signal.kind === 'notification' || (signal.kind === 'bell' && now >= this.echoUntil),
    );
    if (hasWinningSignal) {
      this.sticky = true;
      this.clearSilenceTimer();
      this.setStatus('awaiting-input', now);
      return;
    }

    // Step 4: an in-chunk shell-mark decides the state outright, regardless
    // of any other output in the same chunk.
    if (this.hasShellMark(signals)) {
      if (this.lastMark === 'A' || this.lastMark === 'B' || this.lastMark === 'D') {
        this.sticky = false;
        this.clearSilenceTimer();
        this.setStatus('idle', now);
        return;
      }
      // this.lastMark === 'C'
      this.sticky = false;
      this.setStatus('running', now);
      this.armSilenceTimer();
      return;
    }

    // Step 5: a sticky awaiting-input survives any plain output.
    if (this.sticky) {
      return;
    }

    // Step 6: echo or resize repaint — ignored.
    if (now < this.echoUntil || now < this.resizeUntil) {
      return;
    }

    // Step 7: output that counts.
    this.setStatus('running', now);
    this.armSilenceTimer();
  }

  /** The user sent input (keystrokes or paste) to the session. Opens the echo window and clears stickiness, but never changes the status by itself (spec section 4.3). */
  onInput(): void {
    if (this.currentStatus === 'exited' || this.disposed) {
      return;
    }
    this.echoUntil = Date.now() + ECHO_WINDOW_MS;
    this.sticky = false;
  }

  /** A client resized the session. Opens the resize window. The status does not change. */
  onResize(): void {
    if (this.currentStatus === 'exited' || this.disposed) {
      return;
    }
    this.resizeUntil = Date.now() + RESIZE_WINDOW_MS;
  }

  /** The process exited. Terminal: every later call on this instance is a no-op. */
  onExit(): void {
    if (this.currentStatus === 'exited' || this.disposed) {
      return;
    }
    this.clearSilenceTimer();
    this.setStatus('exited', Date.now());
  }

  /** Called synchronously on every actual transition, never for a repeat. A throwing listener does not stop the others and never propagates out of this class. Returns an unsubscribe function. */
  onChange(listener: StatusListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Cancels the silence timer. Every later call is a no-op. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearSilenceTimer();
  }

  private hasShellMark(signals: readonly TerminalSignal[]): boolean {
    return signals.some((signal) => signal.kind === 'shell-mark');
  }

  private setStatus(status: SessionStatus, now: number): void {
    if (status === this.currentStatus) {
      return;
    }
    this.currentStatus = status;
    this.currentSince = now;
    for (const listener of this.listeners) {
      try {
        listener(status, now);
      } catch {
        // A listener's exception must never break delivery to the other
        // listeners, nor escape into onOutput/onInput/onResize/onExit's own
        // caller (spec section 4.1).
      }
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }

  /** Arms the single silence timer this instance ever holds, replacing any previous one (spec section 4.1: "um timer só", rearmed on every output that counts). */
  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.onSilence();
    }, this.quietMs);
  }

  private onSilence(): void {
    this.silenceTimer = undefined;
    if (this.currentStatus === 'exited' || this.disposed) {
      return;
    }
    const now = Date.now();
    const inPrompt = this.lastMark === 'A' || this.lastMark === 'B' || this.lastMark === 'D';
    if (inPrompt) {
      this.setStatus('idle', now);
      return;
    }
    if (this.lastMark === 'C' && !this.agent) {
      // The shell says a command is still running; a plain shell has no
      // other basis to call this "waiting" (spec section 2, 4.3). Do not
      // rearm — the next bit of output rearms it.
      return;
    }
    if (this.agent) {
      this.setStatus('awaiting-input', now);
    } else {
      this.setStatus('idle', now);
    }
  }
}
