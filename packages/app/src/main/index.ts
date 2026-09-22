import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import type { IpcMainEvent } from 'electron';

import { BridgeGateway } from './bridge-gateway.js';
import { connectToDaemon } from './daemon-client.js';
import type { DaemonConnection } from './daemon-client.js';
import { IPC_CHANNEL } from './ipc-contract.js';
import type { RelayInboundMessage, RelayOutboundMessage } from './ipc-contract.js';

// packages/app has its own package.json without "type": "module" (unlike
// the repo root), so main and preload build as CommonJS and __dirname is
// available here. This is deliberate, not an oversight of the root's ESM
// setting: sandboxed preload scripts (sandbox: true below) don't reliably
// support ESM in Electron, so main/preload stay CJS while the renderer is
// bundled by Vite regardless of either package.json's "type".
function createWindow(): BrowserWindow {
  // No native menu (frameless-feeling shell, matches prototype.html — the
  // window chrome is drawn by the renderer, not by Electron/OS menu bars).
  Menu.setApplicationMenu(null);

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    // Same dark tone as the editor pane in prototype.html, set at the
    // BrowserWindow level (not just in renderer CSS) so there is no white
    // flash while the renderer bundle loads and paints.
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // Proof-of-boot log for M0.3 acceptance: real window bounds, background
    // color and confirmation that no native application menu is installed.
    console.log('[TermHub] ready-to-show', {
      bounds: mainWindow.getBounds(),
      backgroundColor: mainWindow.getBackgroundColor(),
      applicationMenu: Menu.getApplicationMenu(),
    });
    mainWindow.show();
  });

  return mainWindow;
}

async function loadRenderer(mainWindow: BrowserWindow): Promise<void> {
  // electron-vite sets ELECTRON_RENDERER_URL during `electron-vite dev` so
  // the window loads from the Vite dev server (HMR); in a built app there is
  // no dev server and we load the bundled renderer/index.html from disk.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Logs the outcome of docs/specs/m2.1-daemon-client.md's
 * find-or-spawn-or-reconnect flow. Deliberately not awaited by `main()`
 * below — the daemon connection and the window showing up are independent
 * concerns, and a slow/backed-off daemon connection must never delay the
 * window from appearing. Takes the same `connectionPromise` handed to
 * `attachDaemonBridge` (a single `connectToDaemon()` call per app start,
 * not one per window) so this is purely an observer of it, never a second
 * connection attempt.
 */
async function logDaemonConnectionOutcome(
  connectionPromise: Promise<DaemonConnection>,
): Promise<void> {
  const result = await connectionPromise;

  switch (result.outcome) {
    case 'connected':
      console.log('[TermHub] connected to daemon', {
        pid: result.info.pid,
        pipe: result.info.pipe,
        startedAt: result.info.startedAt,
      });
      return;
    case 'blocked':
      // Section 2: never auto-resolved. The M2.2 bridge (below) surfaces
      // this to the renderer as connection state; the visible warning
      // banner itself is M2.3's job.
      console.warn('[TermHub] daemon connection blocked — will not spawn or kill', {
        reason: result.reason,
        pid: result.info.pid,
        startedAt: result.info.startedAt,
      });
      return;
    case 'failed':
      console.error('[TermHub] could not find or start a daemon', {
        attempts: result.attempts,
        daemonPath: result.daemonPath,
        lastError: result.lastError.message,
      });
  }
}

/**
 * Wires one window to the shared daemon connection: a `BridgeGateway`
 * (main/bridge-gateway.ts — connection-state tracking + the `DaemonRelay`
 * once connected) fed by an `ipcMain` listener scoped to exactly this
 * window's `webContents` (so multiple windows, were M2 ever to grow one,
 * would not cross-deliver each other's requests), and a `sendToRenderer`
 * that drops messages once the window is destroyed instead of throwing
 * (armadilha 5 — see `DaemonRelay.dispose`'s doc comment for the other half
 * of that guarantee). Every main -> renderer message, whatever its kind,
 * goes out over the same `webContents.send` channel
 * (`IPC_CHANNEL.TO_RENDERER`) — see `ipc-contract.ts`'s header comment for
 * why (armadilha 2: `invoke`/`handle` is never used for RPC here, precisely
 * because its reply doesn't share an ordering guarantee with `send`).
 */
function attachDaemonBridge(
  window: BrowserWindow,
  connectionPromise: Promise<DaemonConnection>,
): { dispose: () => void } {
  const sendToRenderer = (message: RelayOutboundMessage): void => {
    if (window.isDestroyed()) {
      return;
    }
    window.webContents.send(IPC_CHANNEL.TO_RENDERER, message);
  };

  const gateway = new BridgeGateway({ sendToRenderer, connectionPromise });

  const onFromRenderer = (event: IpcMainEvent, message: RelayInboundMessage): void => {
    if (event.sender !== window.webContents) {
      return; // Not this window's bridge — ipcMain listeners are process-global.
    }
    gateway.handleRendererMessage(message);
  };
  ipcMain.on(IPC_CHANNEL.FROM_RENDERER, onFromRenderer);

  return {
    dispose(): void {
      ipcMain.removeListener(IPC_CHANNEL.FROM_RENDERER, onFromRenderer);
      gateway.dispose();
    },
  };
}

async function main(): Promise<void> {
  await app.whenReady();

  // One `connectToDaemon()` call for the whole app start, shared by the
  // logger above and every window's bridge — never one call per window.
  const connectionPromise = connectToDaemon();
  logDaemonConnectionOutcome(connectionPromise).catch((error: unknown) => {
    console.error('[TermHub] unexpected error while connecting to the daemon', error);
  });

  const mainWindow = createWindow();
  const bridge = attachDaemonBridge(mainWindow, connectionPromise);
  mainWindow.on('closed', () => {
    bridge.dispose();
  });
  await loadRenderer(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return;
    }

    const nextWindow = createWindow();
    const nextBridge = attachDaemonBridge(nextWindow, connectionPromise);
    nextWindow.on('closed', () => {
      nextBridge.dispose();
    });
    loadRenderer(nextWindow).catch((error: unknown) => {
      console.error('[TermHub] failed to load renderer after activate', error);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Entry point bootstrap: nothing in this process awaits main(), so the
// rejection is handled explicitly here (logged, then exit with a non-zero
// code) rather than left as an unhandled rejection. This satisfies
// no-floating-promises without `void` because a single-argument `.catch()`
// counts as the promise being handled.
main().catch((error: unknown) => {
  console.error('[TermHub] fatal error during startup', error);
  app.exit(1);
});
