export interface TermHubBridge {
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
