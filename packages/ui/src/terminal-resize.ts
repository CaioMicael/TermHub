// Pure decision logic behind `Terminal.tsx`'s `ResizeObserver` wiring
// (M2.5), deliberately free of any xterm/React/DOM dependency — same split
// as `terminal-session.ts` (real xterm/bridge plumbing lives in
// `Terminal.tsx`; this module is driven by Vitest with fakes and fake
// timers).
//
// ## Why resize can't start before `ready` (docs/specs/m2.6-boot-reattach.md
// section 3.5)
//
// The snapshot `session.attach` writes into the terminal is serialized at
// the session's *current* geometry (the daemon's last `session.resize`, or
// its creation size). Fitting the xterm instance and sending a
// `session.resize` before that snapshot has actually been written re-wraps
// nothing by itself, but a resize racing *ahead of* the snapshot changes the
// session's geometry mid-write, and everything the PTY's program (`claude`,
// most visibly) draws next assumes the size it was just told about — not
// the one the snapshot bytes still in flight were drawn for. `Terminal.tsx`
// passes this module the *attach* `ready` promise (`attachTerminalSession`'s
// own `AttachedTerminalSession.ready`, `terminal-session.ts`), and this
// module guarantees neither `fit()` nor `resize()` is ever called before
// that promise settles (resolved *or* rejected — see `dispose`'s doc
// comment above `TerminalResizeController` for the rejected case).
//
// ## Why fit+resize share one debounced callback
//
// A `ResizeObserver` firing on every intermediate frame of a window drag
// would otherwise fire a `fit()` (cheap, local) and a `session.resize` RPC
// (a round trip to the daemon, which itself resizes a real PTY) dozens of
// times a second. The trailing debounce below collapses a burst of
// `notifySize` calls into exactly one `fit()`+possible-`resize()` pair,
// `debounceMs` after the *last* one — xterm and the PTY end up agreeing on
// a size at the same instant, not straddling several in-between ones.
//
// ## Why a zero-size container is a no-op, not just a "resize to 0"
//
// M3.5 hides inactive panes with `display:none`, which reports a
// `ResizeObserver` content rect of `{ width: 0, height: 0 }`. Fitting into
// that and forwarding the result would shrink the PTY (and the real
// terminal size the running program believes it has) down to nothing the
// moment a pane is merely hidden, not closed — this module refuses to even
// schedule a fit for a zero-width-or-height notification, and drops any
// fit/resize that was already pending when one arrives.

export interface FitSize {
  cols: number;
  rows: number;
}

export interface TerminalResizeCallbacks {
  /**
   * Performs the real `fitAddon.fit()` against the live xterm instance and
   * returns the resulting grid size. Only ever called from inside the
   * debounced callback, after `ready` has settled and the most recent
   * `notifySize` reported a non-zero size — never before, and never with a
   * stale/superseded size (a later `notifySize` call restarts the debounce
   * timer, so a fit already in the middle of arithmetic before the timer
   * fired is simply never scheduled for that intermediate value).
   */
  fit(): FitSize;
  /** Sends the real `session.resize` for `size`. Only called when `size` differs from the last size this controller actually sent (or from the session's initial size, if `initialSize` was given — see `createTerminalResizeController`'s options). */
  resize(size: FitSize): void;
}

export interface TerminalResizeControllerOptions extends TerminalResizeCallbacks {
  /**
   * Resolves (or rejects) once the flow is allowed to start — the attach's
   * `AttachedTerminalSession.ready` in production. A rejection (a failed
   * `session.attach`, e.g. a stale `sessionId`) still lets resizing begin:
   * there is no snapshot left to protect at that point, and refusing to
   * ever resize a session whose attach failed would leave a legitimately
   * running PTY permanently the wrong size for its pane.
   */
  ready: Promise<unknown>;
  /** Trailing debounce delay, milliseconds. Defaults to 50 (this task's report explains the choice). */
  debounceMs?: number;
  /** Injectable for fake-timer tests — defaults to the real globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * The size already known to be in effect on the daemon side before this
   * controller ever sends anything (the session's `cols`/`rows` at the time
   * the caller acquired it) — when given, the first fit that comes out
   * equal to it is treated as "unchanged" and no `session.resize` is sent
   * for it. Omitted by `Terminal.tsx` today (M2.6 part B, which creates the
   * xterm at the session's own geometry, is what will supply this — see
   * this task's final report); without it, the very first fit after
   * `ready` always sends whatever it measures, once.
   */
  initialSize?: FitSize;
}

export interface TerminalResizeController {
  /** Reports the container's current pixel size, e.g. from a `ResizeObserver` entry's `contentRect`. Safe to call before `ready` settles (the size is remembered, but no fit/resize happens yet) and after `dispose()` (ignored). */
  notifySize(width: number, height: number): void;
  /** Cancels any pending debounced fit and stops reacting to further `notifySize` calls. Idempotent. */
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 50;

/**
 * Builds the resize policy `Terminal.tsx` drives from its `ResizeObserver`
 * callback. See this module's header comment for the three invariants this
 * enforces: nothing before `ready`, one fit+resize per debounced burst, and
 * zero-size containers are inert.
 */
export function createTerminalResizeController(
  options: TerminalResizeControllerOptions,
): TerminalResizeController {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let disposed = false;
  let isReady = false;
  let pendingSize: { width: number; height: number } | undefined;
  let lastSent: FitSize | undefined = options.initialSize;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  }

  function runFitAndMaybeResize(): void {
    timer = undefined;
    if (disposed) {
      return;
    }
    const size = options.fit();
    if (lastSent !== undefined && lastSent.cols === size.cols && lastSent.rows === size.rows) {
      return;
    }
    lastSent = size;
    options.resize(size);
  }

  function scheduleFit(): void {
    clearTimer();
    timer = setTimeoutFn(runFitAndMaybeResize, debounceMs);
  }

  // Settles (either way — see `TerminalResizeControllerOptions.ready`'s doc
  // comment) exactly once. `.catch` here only guards the internal `.then`
  // rejection path from becoming an unhandled rejection; `options.ready`
  // itself is the caller's promise to observe/log, not this module's.
  options.ready.then(
    () => {
      if (disposed) {
        return;
      }
      isReady = true;
      if (pendingSize !== undefined) {
        scheduleFit();
      }
    },
    () => {
      if (disposed) {
        return;
      }
      isReady = true;
      if (pendingSize !== undefined) {
        scheduleFit();
      }
    },
  );

  return {
    notifySize(width, height) {
      if (disposed) {
        return;
      }
      if (width === 0 || height === 0) {
        // Hidden/collapsed container (M3.5's `display:none` panes, or a
        // transient layout pass) — never fit into this, and drop whatever
        // was pending: it described a size that is no longer current.
        pendingSize = undefined;
        clearTimer();
        return;
      }
      pendingSize = { width, height };
      if (!isReady) {
        return; // Remembered, but the flow hasn't been allowed to start yet.
      }
      scheduleFit();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
