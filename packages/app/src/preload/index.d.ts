import type { PreloadBridge } from './bridge.js';

export interface TermHubBridge extends PreloadBridge {
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
}

declare global {
  interface Window {
    termhub: TermHubBridge;
  }
}
