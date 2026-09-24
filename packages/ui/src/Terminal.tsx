import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
  type TerminalBridge,
} from './terminal-session.js';
import { TERMINAL_FONT_OPTIONS, ensureTerminalFontReady, terminalTheme } from './terminal-theme.js';
import { attachWebglRenderer, type WebglRendererHandle } from './terminal-webgl.js';

export interface TerminalProps {
  /** The daemon session this terminal attaches to. Assumed to already exist — creating one is the app's job (see `packages/app/src/renderer/src`'s provisional boot policy), not this component's. */
  sessionId: number;
  /** Pass a stable reference (e.g. `window.termhub` itself) — a new object identity every render would tear down and re-attach the effect below for no reason. */
  bridge: TerminalBridge;
}

/**
 * Mounts one full-pane xterm terminal, attached to `sessionId`. Solo-pane
 * layout only (docs/plan.md section 2, the prototype's `.pane.solo .term`):
 * no frame, no divider — `SplitTree`/multi-pane layout is M3's job.
 *
 * Scope notes for later milestones (see this task's final report for the
 * full writeup):
 * - `ResizeObserver` → `fit()` → `session.resize` and clipboard handling
 *   are M2.5. This component calls `fit()` exactly once, at mount.
 * - Multi-session reattach-on-boot and detach-on-window-close policy are
 *   M2.6; this component itself is reattach-agnostic — it just attaches to
 *   whatever `sessionId` it's given, whenever it's given one.
 * - WebGL is attached unconditionally on mount (this milestone renders
 *   exactly one, always-visible terminal). Deciding whether to attach WebGL
 *   based on pane visibility, and juggling the ~16-context Chromium budget
 *   across many simultaneously-mounted panes, is M3.5's job
 *   (`terminal-webgl.ts`'s header comment) — not this component's.
 */
export function Terminal({ sessionId, bridge }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    // `allowProposedApi: true` is required by `Unicode11Addon`/`term.unicode`
    // below — xterm.js still marks the whole Unicode-version-handling API as
    // "proposed" (same category as `@xterm/headless`'s `buffer` accessor,
    // per `packages/daemon/src/buffer.test.ts`'s header comment); without
    // this flag, setting `term.unicode.activeVersion` throws at runtime
    // ("You must set the allowProposedApi option to true to use proposed
    // API") — found via this task's Electron proof run (section 4.B).
    const term = new XTerm({
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme,
      ...TERMINAL_FONT_OPTIONS,
    });
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(new WebLinksAddon());
    term.unicode.activeVersion = '11';

    // Guards `write`/`open`/WebGL-attach against firing after this effect's
    // cleanup has run. React.StrictMode mounts, cleans up, and remounts
    // this effect in dev; `session.detach()` below is synchronous and
    // reference-counted (see `terminal-session.ts`'s header comment), so
    // the *attachment* survives that dance intact, but this xterm
    // *instance* is still torn down on cleanup regardless.
    let disposed = false;
    let webglHandle: WebglRendererHandle | undefined;

    const onDataDisposable = term.onData((data) => {
      bridge.sendData(sessionId, encodeTerminalTextInput(data));
    });
    const onBinaryDisposable = term.onBinary((data) => {
      bridge.sendData(sessionId, encodeTerminalBinaryInput(data));
    });

    // Subscribed before `term.open()` on purpose: `write` below works
    // against xterm's internal buffer whether or not the terminal is
    // attached to the DOM yet — the same mechanism `@xterm/headless` (never
    // opened at all) relies on — so there's no need to gate this on the
    // font wait just below. Keeping this synchronous, un-gated, is also
    // what preserves the attach-ownership timing this component depended on
    // before this task (`terminal-session.ts`'s header comment on why
    // `onData` must be installed before `session.attach`, and why acquiring
    // the attachment synchronously at mount is what makes StrictMode's
    // mount→cleanup→remount collapse into a single `session.attach`).
    const session = attachTerminalSession(bridge, sessionId, {
      write: (data) => {
        if (!disposed) {
          term.write(data);
        }
      },
    });
    session.ready.catch((err: unknown) => {
      // session.attach can legitimately fail (e.g. a stale sessionId) —
      // surfacing a full "session missing" UI is out of this task's
      // scope (that's the M2.6 boot/reattach policy), so this component
      // just logs instead of leaving an unhandled rejection.
      console.error('[Terminal] attach failed', sessionId, err);
    });

    // Armadilha 1 (this task's prompt): xterm measures its cell size when
    // it opens. Opening before the configured font has actually resolved
    // measures against whatever fallback font is active at that instant,
    // and cols/rows (and glyph alignment) come out wrong — permanently,
    // since xterm never re-measures on its own once open. `open()`/`fit()`/
    // the WebGL attach (which itself requires a live, open terminal) all
    // wait on this. See `ensureTerminalFontReady`'s doc comment
    // (terminal-theme.ts) for why this wait is needed even for a
    // system-installed font.
    //
    // This `.then()` firing after `disposed` has already flipped to `true`
    // is exactly what happens for React.StrictMode's first (discarded)
    // mount: `ensureTerminalFontReady()` always resolves asynchronously
    // (native Promises never settle synchronously), while StrictMode's
    // mount→cleanup→remount happens synchronously in one commit — so by
    // the time this callback can run, the *second* mount's effect has
    // already replaced this closure's `disposed` with `true` for the first
    // one. The guard below means the discarded first mount never calls
    // `open()`, never `fit()`s, and never loads a WebGL context — only the
    // surviving mount does, which is what keeps StrictMode from doubling up
    // WebGL contexts (Armadilha 3).
    ensureTerminalFontReady()
      .catch((err: unknown) => {
        console.error(
          '[Terminal] ensureTerminalFontReady failed, opening with whatever font is currently resolved',
          err,
        );
      })
      .then(() => {
        if (disposed) {
          return;
        }
        term.open(container);
        // One fit at mount, per this task's scope — reacting to window/pane
        // resize is M2.5's `ResizeObserver` wiring, not this component's.
        fitAddon.fit();

        // Loaded after `open()` (WebGL needs a live canvas/DOM element),
        // with an automatic, non-throwing fallback to xterm's default
        // renderer on construction failure, `loadAddon` failure, or a later
        // lost context — see `terminal-webgl.ts`'s header comment for the
        // full rationale, including why the fallback is xterm's own
        // default (DOM) renderer rather than `@xterm/addon-canvas`.
        webglHandle = attachWebglRenderer(term, () => new WebglAddon());
      })
      .catch((err: unknown) => {
        // `open()`/`fit()`/`attachWebglRenderer` itself isn't expected to
        // throw (the latter never does, by design — see `terminal-webgl.ts`),
        // but this chain must never produce an unhandled rejection either
        // way.
        console.error('[Terminal] failed to open terminal after font wait', err);
      });

    return () => {
      disposed = true;
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      // Synchronous, reference-counted release — safe to call immediately,
      // whether or not `session.ready` has settled yet (that's the whole
      // point: see `terminal-session.ts`'s header comment on ownership).
      session.detach();
      // No-op if `open()`/the WebGL attach never got to run (the discarded
      // StrictMode mount above) — `webglHandle` stays `undefined` in that
      // case.
      webglHandle?.detach();
      // Disposes every loaded addon, including a still-loaded WebGL one —
      // verified directly against xterm's installed source rather than
      // assumed; see `terminal-webgl.ts`'s header comment. Safe to call on
      // a `term` that was never `open()`ed.
      term.dispose();
    };
  }, [sessionId, bridge]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
