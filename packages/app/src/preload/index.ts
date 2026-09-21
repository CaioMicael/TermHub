import { contextBridge } from 'electron';

// Minimal, trivial bridge for M0.3 — just proves contextBridge wiring works
// end to end (main -> preload -> renderer) without nodeIntegration. The real
// RPC/PTY-data bridge is task M2.2.
const termhubBridge = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
};

// contextIsolation is always on for this window (see src/main/index.ts),
// so contextBridge is the only path exposed here — no nodeIntegration
// fallback to keep around.
try {
  contextBridge.exposeInMainWorld('termhub', termhubBridge);
} catch (error) {
  console.error('[TermHub] failed to expose preload bridge', error);
}
