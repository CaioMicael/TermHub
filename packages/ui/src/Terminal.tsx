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
import { createClipboardKeyHandler, dispatchContextMenuChoice } from './terminal-clipboard.js';
import { createTerminalResizeController } from './terminal-resize.js';
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
 * - M2.5 (this task): `ResizeObserver` → `fit()` → `session.resize`
 *   (`terminal-resize.ts`'s `createTerminalResizeController`, gated on the
 *   attach's `ready` per docs/specs/m2.6-boot-reattach.md section 3.5 —
 *   see the resize wiring below) and Ctrl+Shift+C/V + native context menu
 *   clipboard handling (`terminal-clipboard.ts`).
 * - Multi-session reattach-on-boot and detach-on-window-close policy are
 *   M2.6; this component itself is reattach-agnostic — it just attaches to
 *   whatever `sessionId` it's given, whenever it's given one. M2.6 part B
 *   (after this task) makes this component receive the session's own
 *   initial `cols`/`rows` instead of always starting from `fit()`'s guess
 *   — see this task's final report for what that changes about the resize
 *   wiring below.
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

    // M2.5, section 2.2: the clipboard action deps shared by the keyboard
    // shortcut handler and the context menu's dispatch below — both must
    // agree on what "copy"/"paste" actually does (`terminal-clipboard.ts`'s
    // header comment on why paste always goes through `term.paste`, never
    // `sendData`).
    const clipboardDeps = {
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      paste: (text: string) => {
        term.paste(text);
      },
      writeClipboardText: (text: string) => bridge.writeClipboardText(text),
      readClipboardText: () => bridge.readClipboardText(),
      isDisposed: () => disposed,
    };

    // Ctrl+Shift+C/V are intercepted here (returning `false` keeps xterm
    // from forwarding them to the PTY) — plain Ctrl+C/Ctrl+V fall through
    // untouched (`createClipboardKeyHandler`'s own doc comment).
    term.attachCustomKeyEventHandler(createClipboardKeyHandler(clipboardDeps));

    // Native context menu (section 2.3) — the prototype has none of its
    // own (docs/plan.md's UI reference for this task), so this replaces the
    // browser's default with the OS one instead of suppressing it outright.
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      bridge
        .openContextMenu(term.hasSelection())
        .then((choice) => {
          if (!disposed) {
            dispatchContextMenuChoice(choice, clipboardDeps);
          }
        })
        .catch((err: unknown) => {
          console.error('[Terminal] context menu failed', sessionId, err);
        });
    };
    container.addEventListener('contextmenu', onContextMenu);

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

    // M2.5's resize flow is allowed to start only once *both* of these have
    // happened: `term.open()` (a `fit()` before that throws — there is no
    // live DOM measurement yet) and the attach's own `ready`
    // (docs/specs/m2.6-boot-reattach.md section 3.5: resizing ahead of the
    // snapshot write races the session's geometry against bytes already
    // serialized at the old one). `openedResolve` fires from inside the
    // font-wait `.then()` below, but only for the mount that actually
    // reaches `term.open()` — the discarded StrictMode mount never resolves
    // it, so its `resizeController` (constructed unconditionally below,
    // like `onDataDisposable`) simply never fits/resizes before its own
    // cleanup disposes it.
    //
    // A rejected `ready` (a failed attach) still lets resizing start —
    // `terminal-resize.ts`'s own doc comment on why: there is no snapshot
    // left to protect once the attach itself has failed.
    let openedResolve: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      openedResolve = resolve;
    });
    const resizeReady = Promise.all([opened, session.ready.catch(() => undefined)]).then(
      () => undefined,
    );
    const resizeController = createTerminalResizeController({
      ready: resizeReady,
      fit: () => {
        fitAddon.fit();
        return { cols: term.cols, rows: term.rows };
      },
      resize: ({ cols, rows }) => {
        bridge.request('session.resize', { sessionId, cols, rows }).catch((err: unknown) => {
          console.error('[Terminal] session.resize failed', sessionId, err);
        });
      },
    });
    // `ResizeObserver` on `container` itself — the same element `fitAddon`
    // measures against (it becomes `.xterm`'s parent once `term.open`
    // appends it): armadilha 2 (this task's prompt) is exactly about
    // observing/measuring a *different* box than the one `fit()` actually
    // reads, which would desync `cols`/`rows` between what this component
    // renders and what `fit-size.ts`'s `measureFitSize` probe agreed on.
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) {
        return;
      }
      resizeController.notifySize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(container);

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
        // One eager fit right at open, so the terminal isn't left at
        // xterm's 80x24 construction default until the first `ResizeObserver`
        // callback fires — M2.5's debounced fit/resize flow (`resizeController`
        // above) takes over from here for every size change after this.
        fitAddon.fit();
        // Only now does `resizeController` above become allowed to run
        // (still also gated on `session.ready` — see its own comment).
        openedResolve();

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
      container.removeEventListener('contextmenu', onContextMenu);
      // Disconnects the observer and cancels any debounced fit/resize still
      // pending — a resize of an already-torn-down `Terminal` must never
      // reach the daemon (this task's prompt, section 2.1).
      resizeObserver.disconnect();
      resizeController.dispose();
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
