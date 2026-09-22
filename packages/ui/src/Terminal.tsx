import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
  type TerminalBridge,
} from './terminal-session.js';

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
 * - WebGL rendering and the ANSI/Cascadia theme are M2.4 — this component
 *   uses xterm's default (canvas) renderer and default theme on purpose.
 * - `ResizeObserver` → `fit()` → `session.resize` and clipboard handling
 *   are M2.5. This component calls `fit()` exactly once, at mount.
 * - Multi-session reattach-on-boot and detach-on-window-close policy are
 *   M2.6; this component itself is reattach-agnostic — it just attaches to
 *   whatever `sessionId` it's given, whenever it's given one.
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
    const term = new XTerm({ cursorBlink: true, allowProposedApi: true });
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(new WebLinksAddon());
    term.unicode.activeVersion = '11';

    term.open(container);
    // One fit at mount, per this task's scope — reacting to window/pane
    // resize is M2.5's `ResizeObserver` wiring, not this component's.
    fitAddon.fit();

    // Guards `write` against firing after this effect's cleanup has run.
    // React.StrictMode mounts, cleans up, and remounts this effect in dev;
    // `session.detach()` below is synchronous and reference-counted
    // (see `terminal-session.ts`'s header comment), so the *attachment*
    // survives that dance intact, but this xterm *instance* is still
    // torn down on cleanup regardless — this flag stops a disposed
    // instance from ever receiving a `write` call.
    let disposed = false;

    const onDataDisposable = term.onData((data) => {
      bridge.sendData(sessionId, encodeTerminalTextInput(data));
    });
    const onBinaryDisposable = term.onBinary((data) => {
      bridge.sendData(sessionId, encodeTerminalBinaryInput(data));
    });

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

    return () => {
      disposed = true;
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      // Synchronous, reference-counted release — safe to call immediately,
      // whether or not `session.ready` has settled yet (that's the whole
      // point: see `terminal-session.ts`'s header comment on ownership).
      session.detach();
      term.dispose();
    };
  }, [sessionId, bridge]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
