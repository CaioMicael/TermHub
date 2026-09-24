// Pure decision logic behind `Terminal.tsx`'s clipboard keyboard shortcuts
// and context-menu action dispatch (M2.5, section 2.2/2.3), free of any
// xterm/React/DOM dependency — same split as `terminal-session.ts`/
// `terminal-resize.ts`.
//
// ## Why paste goes through `term.paste()`, never `sendData` directly
//
// xterm.js's `Terminal.paste(data)` (see `@xterm/xterm`'s own `ITerminal`
// typings) writes bracketed-paste markers (`ESC [200~` / `ESC [201~`) around
// `data` before handing it to the terminal's input path, but *only* when the
// PTY's program has actually turned bracketed paste mode on (it's a mode the
// program opts into, e.g. `readline`/Ink-based CLIs like `claude`). Feeding
// the same text through `sendData`/`onData`'s raw path instead skips that
// entirely: a multi-line paste arrives at the shell as if each line had been
// typed and Enter pressed individually, which — for a shell prompt — means
// every line but the last executes as its own command instead of the whole
// blob landing in the input buffer for the user to review before running.
// This is exactly the failure mode this task's prompt calls out by name.
//
// ## Why the shortcuts never reach the PTY
//
// `Terminal.tsx` installs `createClipboardKeyHandler`'s return value as
// xterm's `attachCustomKeyEventHandler` — returning `false` for
// Ctrl+Shift+C/V tells xterm not to process that key event at all (no PTY
// write, no default xterm binding), while `Ctrl+C`/`Ctrl+V` without Shift
// return `true` and reach the PTY exactly as before (`Ctrl+C` interrupts the
// running program, unrelated to clipboard).

/** The subset of a DOM `KeyboardEvent` this module actually inspects — narrow enough to fake in a test without a real `KeyboardEvent`/browser, and structurally satisfied by the real thing as-is. */
export interface ClipboardKeyEvent {
  type: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
}

export type ClipboardShortcutAction = 'copy' | 'paste';

/**
 * Classifies one keyboard event as a clipboard shortcut, or not. Only
 * `keydown` is considered — xterm's `attachCustomKeyEventHandler` also
 * receives `keyup`/`keypress` for some paths, and reacting to more than one
 * event per physical key press would fire the action (copy/paste) twice per
 * shortcut.
 */
export function classifyClipboardShortcut(
  event: ClipboardKeyEvent,
): ClipboardShortcutAction | undefined {
  if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === 'c') {
    return 'copy';
  }
  if (key === 'v') {
    return 'paste';
  }
  return undefined;
}

/** The terminal/bridge operations `performCopy`/`performPaste`/`createClipboardKeyHandler` need — `Terminal.tsx` supplies these backed by a real `@xterm/xterm` instance and `window.termhub`; tests pass plain fakes. */
export interface ClipboardActionDeps {
  hasSelection(): boolean;
  getSelection(): string;
  /** `term.paste(text)` — never a raw PTY write (see this module's header comment). */
  paste(text: string): void;
  writeClipboardText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  /** True once the owning `Terminal` has been torn down — guards the async `readClipboardText().then(...)` continuation from writing into a disposed xterm instance. */
  isDisposed(): boolean;
  /** Reports a failure that has nowhere else to go (both call sites are fire-and-forget by design — there is no request this is a response to). Defaults to `console.error` in production; tests can capture it. */
  onError?: (context: string, err: unknown) => void;
}

function reportError(deps: ClipboardActionDeps, context: string, err: unknown): void {
  (deps.onError ?? ((c, e) => console.error(`[terminal-clipboard] ${c}`, e)))(context, err);
}

/** Writes the current selection to the OS clipboard. A no-op (no clipboard write at all) when there is no selection — matches the context menu's own "Copiar" being disabled in that case (section 2.3). */
export function performCopy(deps: ClipboardActionDeps): void {
  if (!deps.hasSelection()) {
    return;
  }
  deps.writeClipboardText(deps.getSelection()).catch((err: unknown) => {
    reportError(deps, 'copy failed', err);
  });
}

/** Reads the OS clipboard and pastes it into the terminal via `term.paste()`. */
export function performPaste(deps: ClipboardActionDeps): void {
  deps
    .readClipboardText()
    .then((text) => {
      if (!deps.isDisposed()) {
        deps.paste(text);
      }
    })
    .catch((err: unknown) => {
      reportError(deps, 'paste failed', err);
    });
}

/**
 * Builds the function `Terminal.tsx` installs as xterm's
 * `attachCustomKeyEventHandler`. Returns `false` (intercepted, not sent to
 * the PTY) for Ctrl+Shift+C/V, `true` (business as usual, including plain
 * Ctrl+C/Ctrl+V reaching the PTY) for everything else.
 */
export function createClipboardKeyHandler(
  deps: ClipboardActionDeps,
): (event: ClipboardKeyEvent) => boolean {
  return (event) => {
    const action = classifyClipboardShortcut(event);
    if (action === 'copy') {
      performCopy(deps);
      return false;
    }
    if (action === 'paste') {
      performPaste(deps);
      return false;
    }
    return true;
  };
}

/** The main process's answer to `openContextMenu` (section 2.3) — `undefined` if the menu was dismissed without a choice. `Terminal.tsx`'s context-menu handler dispatches this the same way the keyboard shortcuts do (`performCopy`/`performPaste`), so "menu choice" and "keyboard shortcut" always agree on what "copy"/"paste" actually does. */
export function dispatchContextMenuChoice(
  choice: ClipboardShortcutAction | undefined,
  deps: ClipboardActionDeps,
): void {
  if (choice === 'copy') {
    performCopy(deps);
  } else if (choice === 'paste') {
    performPaste(deps);
  }
}
