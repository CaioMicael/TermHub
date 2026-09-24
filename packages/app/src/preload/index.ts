import { contextBridge, ipcRenderer } from 'electron';

import { createBridge } from './bridge.js';
import type { PreloadBridge } from './bridge.js';

// Real Electron wiring only — the actual bridge logic (RPC correlation,
// coalesced-data/event fan-out, connection-state tracking) lives in
// `bridge.ts`'s `createBridge`, which never imports `electron` and is
// exercised directly by Vitest (`bridge.test.ts`,
// `daemon-relay.integration.test.ts`). This file's only job is handing that
// factory the real `ipcRenderer` and exposing the result, plus the
// `versions` field the M0.3 placeholder already depends on.
//
// Not annotated as `./index.d.ts`'s `TermHubBridge` here: that declaration
// file exists purely to `declare global` the shape of `window.termhub` for
// renderer code (merged in automatically once it's part of this program via
// tsconfig.node.json's include — no import needed for that to take effect),
// and a `.ts` module self-importing its own sibling `.d.ts` is an
// unnecessary, ambiguous circularity to introduce just to re-derive a type
// `PreloadBridge & { versions: ... }` already expresses directly.
const termhubBridge: PreloadBridge & {
  versions: { node: string; chrome: string; electron: string };
} = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  ...createBridge(ipcRenderer),
};

// contextIsolation is always on for this window (see src/main/index.ts),
// so contextBridge is the only path exposed here — no nodeIntegration
// fallback to keep around.
try {
  contextBridge.exposeInMainWorld('termhub', termhubBridge);
} catch (error) {
  console.error('[TermHub] failed to expose preload bridge', error);
}
