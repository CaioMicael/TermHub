export { Terminal } from './Terminal.js';
export type { TerminalProps } from './Terminal.js';

export {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
} from './terminal-session.js';
export type {
  AttachedTerminalSession,
  TerminalBridge,
  TerminalBridgeMethod,
  TerminalBridgeRequestParams,
  TerminalSink,
} from './terminal-session.js';

export { measureFitSize } from './fit-size.js';
export type { FitSize } from './fit-size.js';

export { TERMINAL_SOLO_PADDING, terminalTheme, ensureTerminalFontReady } from './terminal-theme.js';

export { attachWebglRenderer } from './terminal-webgl.js';
export type {
  DisposableLike,
  TerminalForWebgl,
  WebglAddonLike,
  WebglFallbackReason,
  WebglRendererHandle,
} from './terminal-webgl.js';
