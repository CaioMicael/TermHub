import type { ITheme } from '@xterm/xterm';

// Single source of truth for the terminal's font (Armadilha 2, this task's
// prompt): both `fit-size.ts`'s `measureFitSize` (a disposable probe xterm
// that decides the PTY's cols/rows *before* the real session exists) and
// `Terminal.tsx` (the long-lived xterm that actually renders it) construct
// their `Terminal` with this exact object. If the two ever measured with a
// different font, size or line-height, the probe's cols/rows would disagree
// with what the real terminal renders at, and the PTY would be born the
// wrong size — with no resize to correct it until M2.5. See this task's
// final report for the side-by-side cols/rows proof.
//
// Values are `termhub-prototipo.html`'s `:root { --mono-font }` and `.term`
// rule (`font-size:12.5px;line-height:1.38`) verbatim. xterm's
// `ITerminalOptions.lineHeight` is documented as a *multiplier* of
// `fontSize`, not a pixel value, so the prototype's unitless `1.38` maps
// directly with no conversion.
export const TERMINAL_FONT_FAMILY =
  '"Cascadia Mono","Cascadia Code",Consolas,"Courier New",monospace';
export const TERMINAL_FONT_SIZE = 12.5;
export const TERMINAL_LINE_HEIGHT = 1.38;

/** Passed as-is to `new Terminal(...)` by both consumers described above. */
export const TERMINAL_FONT_OPTIONS = {
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: TERMINAL_FONT_SIZE,
  lineHeight: TERMINAL_LINE_HEIGHT,
} as const;

// `.pane.solo .term { padding: 8px 14px 14px }` in the prototype (3-value
// CSS shorthand: top, left+right, bottom). `App.tsx` applies this as the
// solo pane's padding, and `measureFitSize`'s caller must size the container
// it measures into the same way, so the probe and the real terminal agree
// on how much space is actually usable (Armadilha 2 again).
export const TERMINAL_SOLO_PADDING = { top: 8, right: 14, bottom: 14, left: 14 } as const;

// Armadilha 1 (this task's prompt): xterm measures its cell size (character
// width/height) synchronously when it opens. If the configured font hasn't
// been resolved by the browser's font-matching yet, that measurement uses
// whatever fallback font is currently active, and cols/rows (plus the glyph
// alignment) come out wrong — including after the font later finishes
// loading, because xterm doesn't re-measure on its own. Cascadia Mono is a
// system-installed font here (not an `@font-face`), but the Font Loading
// API (`document.fonts`) still mediates *system* fonts, not just
// `@font-face` ones: `document.fonts.load()`/`.ready` reflect whether the
// browser's font-matching has actually resolved and cached the face the
// page asked for, which is not guaranteed to have already happened by the
// time this module's caller runs, especially on a freshly started Electron
// renderer process before it's painted anything. `ensureTerminalFontReady`
// is the shared wait both `measureFitSize` and `Terminal.tsx` perform
// before constructing their xterm instance.
export function ensureTerminalFontReady(): Promise<void> {
  const spec = `${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`;
  return document.fonts
    .load(spec)
    .then(() => document.fonts.ready)
    .then(() => undefined);
}

// xterm's `ITheme`, matching the prototype's Dark+ palette
// (`termhub-prototipo.html`'s `:root`) where it defines a color, and VS
// Code's own Dark+ terminal defaults otherwise. Primary source for every
// VS Code value below:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts
// (the `dark` entry of each color in `ansiColorMap`), read directly — not
// from memory — via `curl` in this task (see the final report for the
// fetched excerpt). Cursor colors are VS Code's *fallback* behavior read
// from `terminalColorRegistry.ts`'s neighbor,
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
// (`theme.getColor(TERMINAL_CURSOR_FOREGROUND_COLOR) || foregroundColor`,
// `... TERMINAL_CURSOR_BACKGROUND_COLOR) || backgroundColor`): Dark+ never
// sets `terminalCursor.foreground`/`.background`, so VS Code's own terminal
// cursor is just its foreground/background color — moot here anyway, since
// the prototype *does* define an explicit cursor color (`.cursor { background:
// #d4d4d4 }`), which wins per this task's instructions.
//
// Full color-by-color table (value, source) is in this task's final report.
export const terminalTheme: ITheme = {
  background: '#1e1e1e', // prototype --bg
  foreground: '#cccccc', // prototype --fg
  selectionBackground: '#264f78', // prototype .term::selection
  cursor: '#d4d4d4', // prototype .cursor { background: #d4d4d4 }
  cursorAccent: '#1e1e1e', // VS Code Dark+ terminalCursor.background falls back to terminal.background (unset in Dark+) — see header comment

  black: '#000000', // VS Code Dark+ terminal.ansiBlack
  red: '#cd3131', // VS Code Dark+ terminal.ansiRed
  green: '#0dbc79', // VS Code Dark+ terminal.ansiGreen
  yellow: '#e5e510', // VS Code Dark+ terminal.ansiYellow
  blue: '#2472c8', // VS Code Dark+ terminal.ansiBlue
  magenta: '#bc3fbc', // VS Code Dark+ terminal.ansiMagenta
  cyan: '#11a8cd', // VS Code Dark+ terminal.ansiCyan
  white: '#e5e5e5', // VS Code Dark+ terminal.ansiWhite

  // The 6 bright colors below are the prototype's own 8 named ANSI
  // variables (red/green/yellow/blue/mag/cyan/white — brightBlack/gray is
  // separate, see next line) — they happen to equal VS Code Dark+'s bright
  // variants exactly, confirmed value-by-value against terminalColorRegistry.ts.
  brightBlack: '#808080', // prototype --ansi-gray. VS Code Dark+ uses #666666 here — prototype wins per this task's instructions; divergence flagged in the final report.
  brightRed: '#f14c4c', // prototype --ansi-red (== VS Code Dark+ terminal.ansiBrightRed)
  brightGreen: '#23d18b', // prototype --ansi-green (== VS Code Dark+ terminal.ansiBrightGreen)
  brightYellow: '#f5f543', // prototype --ansi-yellow (== VS Code Dark+ terminal.ansiBrightYellow)
  brightBlue: '#3b8eea', // prototype --ansi-blue (== VS Code Dark+ terminal.ansiBrightBlue)
  brightMagenta: '#d670d6', // prototype --ansi-mag (== VS Code Dark+ terminal.ansiBrightMagenta)
  brightCyan: '#29b8db', // prototype --ansi-cyan (== VS Code Dark+ terminal.ansiBrightCyan)
  brightWhite: '#e5e5e5', // prototype --ansi-white (== VS Code Dark+ terminal.ansiBrightWhite)
};
