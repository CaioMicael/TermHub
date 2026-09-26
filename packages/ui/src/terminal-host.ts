// One terminal's full imperative lifecycle — the xterm instance, its attach
// to the daemon session, the resize flow, the keyboard/clipboard handling,
// and its WebGL renderer — as a plain object with no React and no ownership
// by the layout tree (docs/specs/m3.5-terminal-lifecycle.md section 4.1/4.5).
// `terminal-registry.ts` is the only caller: it creates exactly one host per
// placed `sessionId`, for the host's entire lifetime, regardless of how many
// times the layout reshapes around it.
//
// This is `Terminal.tsx`'s old effect body, migrated verbatim in spirit (see
// that component's own history, `git log -1 761f825`/`834bb77`/`d7b8ed1` for
// why each piece exists) — not reworked. What's different is *when* the
// xterm's `open()` happens, and *why* this module can be driven by Vitest in
// the repo's plain `node` environment without jsdom:
//
// - `element` is created by the registry (`document.createElement`, section
//   4.2) and handed to this module — this module never creates or moves it.
// - `term.open()` used to run unconditionally once the font was ready
//   (`Terminal.tsx`). Here it also waits for the host's element to actually
//   measure a non-zero size at least once (section 4.3, armadilha 4) — a
//   parked or `display:none`-workspace host must never open with a
//   zero-sized box. The natural signal for "this element just became
//   visible" turns out to be the very `ResizeObserver` the resize flow
//   (M2.5) already needs on this element: a `display:none` ancestor turning
//   `display:block` reports exactly the same kind of resize event as a
//   window drag would, whether the transition happened because a slot moved
//   this host or because a hidden workspace tab became active without any
//   `place`/`unplace` call at all (`App.tsx` only ever toggles a CSS
//   `display` on an ancestor — see `TerminalSlot.tsx`'s doc comment). So
//   `open()` is gated on the observer's *first* non-zero report, not on
//   `place()` being called — reusing the same signal keeps this module free
//   of any dependency on the registry's own bookkeeping.
// - Every DOM/xterm-construction seam a test would otherwise need real
//   browser globals for is injectable, defaulting to the real thing in
//   production (same pattern as `terminal-webgl.ts`'s `createAddon` and
//   `terminal-resize.ts`'s `setTimeoutFn`): `createXterm`, `observeElement`,
//   `ensureFontReady`. A real `@xterm/xterm` `Terminal` is safe to construct
//   and `write()` into under plain Node (verified directly: `new
//   Terminal(...)`, `.write()`, `.dispose()` all succeed with no `document`
//   global at all) — only `.open()` touches the DOM, which is exactly the
//   call this module gates.

import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionId } from '@termhub/shared';
import '@xterm/xterm/css/xterm.css';

import { createClipboardKeyHandler, dispatchContextMenuChoice } from './terminal-clipboard.js';
import { createTerminalResizeController } from './terminal-resize.js';
import { attachTerminalSession, type TerminalBridge } from './terminal-session.js';
import { TERMINAL_FONT_OPTIONS, ensureTerminalFontReady, terminalTheme } from './terminal-theme.js';
import {
  attachWebglRenderer,
  type WebglAddonLike,
  type WebglRendererHandle,
} from './terminal-webgl.js';

/** A disposable subscription — matches `@xterm/xterm`'s own `IDisposable`. */
export interface HostDisposable {
  dispose(): void;
}

/**
 * The minimal slice of `@xterm/xterm`'s `Terminal` this module needs —
 * satisfied structurally by a real instance (default `createXterm` below),
 * and fakeable in tests without any DOM. Mirrors `terminal-webgl.ts`'s
 * `TerminalForWebgl` in spirit, extended with every other method
 * `Terminal.tsx` used to call directly.
 */
export interface XTermLike {
  readonly cols: number;
  readonly rows: number;
  readonly unicode: { activeVersion: string };
  loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }): void;
  onData(listener: (data: string) => void): HostDisposable;
  onBinary(listener: (data: string) => void): HostDisposable;
  attachCustomKeyEventHandler(handler: (event: never) => boolean): void;
  open(element: HTMLElement): void;
  write(data: Uint8Array): void;
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  dispose(): void;
}

export interface ElementObserverHandle {
  disconnect(): void;
}

export interface TerminalHostOptions {
  sessionId: SessionId;
  /** The session's own geometry (`SessionSummary.cols`/`rows`) — same reasoning as `Terminal.tsx`'s own doc comment on why the xterm instance is constructed with these, never xterm's 80x24 default. */
  cols: number;
  rows: number;
  bridge: TerminalBridge;
  /** Created by the registry (`document.createElement`) — this module opens the xterm into it, but never creates, moves or removes it itself (docs/specs/m3.5-terminal-lifecycle.md section 4.2). */
  element: HTMLElement;
  /** Called once, right after `term.open()` actually runs — the registry's cue to recompute the WebGL assignment (`terminal-webgl-policy.ts`), since a host that just opened may now be eligible. */
  onOpened?: () => void;
  /** Defaults to `new XTerm(...)` with this host's font/theme options. Injectable so tests never need a real DOM. */
  createXterm?: (options: { cols: number; rows: number }) => XTermLike;
  /**
   * Defaults to a real `ResizeObserver` on `element`. Injectable so tests can
   * drive "this host just became visible" (or "this host is hidden/zero-
   * sized") without a real DOM — see this module's header comment on why a
   * resize observation is also the open-gating signal (armadilha 4).
   */
  observeElement?: (
    element: HTMLElement,
    onResize: (width: number, height: number) => void,
  ) => ElementObserverHandle;
  /** Defaults to `ensureTerminalFontReady` (terminal-theme.ts). Injectable so tests control timing without waiting on real fonts (armadilha 1). */
  ensureFontReady?: () => Promise<void>;
  /** Defaults to `() => new WebglAddon()`. Injectable so tests never load a real WebGL context. */
  createWebglAddon?: () => WebglAddonLike;
}

export interface TerminalHost {
  readonly sessionId: SessionId;
  readonly element: HTMLElement;
  /** True once `term.open()` has actually run (armadilha 4's gate has been satisfied). Never flips back to `false` — the xterm instance, once opened, stays open for this host's entire life; only WebGL comes and goes. */
  readonly isOpen: boolean;
  readonly usingWebgl: boolean;
  /** No-op if not yet open, or already attached. See `terminal-webgl-policy.ts` for who decides when to call this. */
  attachWebgl(): void;
  /** No-op if not currently attached. Never disposes the xterm itself — only the WebGL addon, falling back to the DOM renderer (`terminal-webgl.ts`). */
  detachWebgl(): void;
  /**
   * Tears down everything: the resize observer/controller, the attach (the
   * real `session.detach` may still be deferred — `terminal-session.ts`'s
   * own ownership rules), the WebGL addon if loaded, and the xterm instance
   * itself. Does **not** remove `element` from the DOM — the registry, which
   * owns knowing where `element` currently lives (a slot, or parked), does
   * that (docs/specs/m3.5-terminal-lifecycle.md section 4.1). Safe to call
   * exactly once; the registry never calls it twice for the same host.
   */
  dispose(): void;
}

function defaultCreateXterm(options: { cols: number; rows: number }): XTermLike {
  // `allowProposedApi: true` is required by `Unicode11Addon`/`term.unicode`
  // below, same as `Terminal.tsx` before this task (`761f825`'s commit
  // message: without it, setting `term.unicode.activeVersion` throws).
  return new XTerm({
    cursorBlink: true,
    allowProposedApi: true,
    theme: terminalTheme,
    cols: options.cols,
    rows: options.rows,
    ...TERMINAL_FONT_OPTIONS,
  }) as unknown as XTermLike;
}

function defaultObserveElement(
  element: HTMLElement,
  onResize: (width: number, height: number) => void,
): ElementObserverHandle {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined) {
      return;
    }
    onResize(entry.contentRect.width, entry.contentRect.height);
  });
  observer.observe(element);
  return { disconnect: () => observer.disconnect() };
}

/**
 * Builds one terminal host: attaches to `options.sessionId` immediately
 * (before this function even returns — same ordering contract as
 * `Terminal.tsx` always relied on, `terminal-session.ts`'s header comment),
 * and opens the underlying xterm the first time `options.element` is
 * observed at a non-zero size, after the configured font is ready.
 */
export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
  const createXterm = options.createXterm ?? defaultCreateXterm;
  const observeElement = options.observeElement ?? defaultObserveElement;
  const ensureFontReady = options.ensureFontReady ?? ensureTerminalFontReady;
  const createWebglAddon = options.createWebglAddon ?? (() => new WebglAddon());

  const term = createXterm({ cols: options.cols, rows: options.rows });
  const fitAddon = new FitAddon();
  const unicode11Addon = new Unicode11Addon();
  term.loadAddon(fitAddon);
  term.loadAddon(unicode11Addon);
  term.loadAddon(new WebLinksAddon());
  term.unicode.activeVersion = '11';

  let disposed = false;
  let isOpen = false;
  let openAttempted = false;
  let webglHandle: WebglRendererHandle | undefined;

  const onDataDisposable = term.onData((data) => {
    options.bridge.sendData(options.sessionId, encodeTextInput(data));
  });
  const onBinaryDisposable = term.onBinary((data) => {
    options.bridge.sendData(options.sessionId, encodeBinaryInput(data));
  });

  const clipboardDeps = {
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    paste: (text: string) => {
      term.paste(text);
    },
    writeClipboardText: (text: string) => options.bridge.writeClipboardText(text),
    readClipboardText: () => options.bridge.readClipboardText(),
    isDisposed: () => disposed,
  };
  term.attachCustomKeyEventHandler(createClipboardKeyHandler(clipboardDeps));

  const onContextMenu = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    options.bridge
      .openContextMenu(term.hasSelection())
      .then((choice) => {
        if (!disposed) {
          dispatchContextMenuChoice(choice, clipboardDeps);
        }
      })
      .catch((err: unknown) => {
        console.error('[terminal-host] context menu failed', options.sessionId, err);
      });
  };
  options.element.addEventListener('contextmenu', onContextMenu as unknown as EventListener);

  // Subscribed before `session.attach` — the ordering contract
  // `terminal-session.ts`'s header comment requires.
  const session = attachTerminalSession(options.bridge, options.sessionId, {
    write: (data) => {
      if (!disposed) {
        term.write(data);
      }
    },
  });
  session.ready.catch((err: unknown) => {
    console.error('[terminal-host] attach failed', options.sessionId, err);
  });

  let openedResolve: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    openedResolve = resolve;
  });
  const resizeReady = Promise.all([opened, session.ready.catch(() => undefined)]).then(
    () => undefined,
  );
  const resizeController = createTerminalResizeController({
    ready: resizeReady,
    initialSize: { cols: options.cols, rows: options.rows },
    fit: () => {
      fitAddon.fit();
      return { cols: term.cols, rows: term.rows };
    },
    resize: ({ cols, rows }) => {
      options.bridge
        .request('session.resize', { sessionId: options.sessionId, cols, rows })
        .catch((err: unknown) => {
          console.error('[terminal-host] session.resize failed', options.sessionId, err);
        });
    },
  });

  function attemptOpen(): void {
    if (openAttempted || disposed) {
      return;
    }
    openAttempted = true;
    ensureFontReady()
      .catch((err: unknown) => {
        console.error(
          '[terminal-host] ensureFontReady failed, opening with whatever font is currently resolved',
          err,
        );
      })
      .then(() => {
        if (disposed) {
          return;
        }
        term.open(options.element);
        isOpen = true;
        openedResolve();
        options.onOpened?.();
      })
      .catch((err: unknown) => {
        console.error('[terminal-host] failed to open terminal after font wait', err);
      });
  }

  const observerHandle = observeElement(options.element, (width, height) => {
    resizeController.notifySize(width, height);
    // Armadilha 4 (docs/specs/m3.5-terminal-lifecycle.md section 4.3): a
    // parked or hidden-workspace host reports `{0, 0}` here — `open()` must
    // never run against that. The very first non-zero report, whenever it
    // arrives (right after `place()`, or later when a hidden workspace tab
    // becomes active with no `place()` call at all), is what's allowed to
    // trigger it.
    if (!openAttempted && width > 0 && height > 0) {
      attemptOpen();
    }
  });

  const hostResult: TerminalHost = {
    sessionId: options.sessionId,
    element: options.element,
    get isOpen() {
      return isOpen;
    },
    get usingWebgl() {
      return webglHandle?.usingWebgl ?? false;
    },
    attachWebgl(): void {
      if (!isOpen || disposed || webglHandle !== undefined) {
        return;
      }
      webglHandle = attachWebglRenderer(term, createWebglAddon);
    },
    detachWebgl(): void {
      webglHandle?.detach();
      webglHandle = undefined;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      options.element.removeEventListener('contextmenu', onContextMenu as unknown as EventListener);
      observerHandle.disconnect();
      resizeController.dispose();
      session.detach();
      webglHandle?.detach();
      webglHandle = undefined;
      term.dispose();
    },
  };
  return hostResult;
}

// ---------------------------------------------------------------------------
// Keyboard input encoding — same contracts as `terminal-session.ts`'s
// `encodeTerminalTextInput`/`encodeTerminalBinaryInput`, duplicated locally
// only to keep this module's own import list self-contained; kept in exact
// sync with that module's own doc comments on *why* each encoding is what it
// is (UTF-8 for `onData`, raw byte-per-char for `onBinary`'s mouse reports).
// ---------------------------------------------------------------------------

function encodeTextInput(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

function encodeBinaryInput(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i) & 0xff;
  }
  return bytes;
}
