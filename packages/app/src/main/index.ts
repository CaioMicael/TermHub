import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron';
import type { IpcMainEvent } from 'electron';

import { BridgeGateway, wireWebContentsLifecycle } from './bridge-gateway.js';
import { connectToDaemon } from './daemon-client.js';
import type { DaemonConnection } from './daemon-client.js';
import { IPC_CHANNEL } from './ipc-contract.js';
import type { RelayInboundMessage, RelayOutboundMessage } from './ipc-contract.js';
import { installQuitFlush } from './quit-flush.js';
import { SessionAttachments } from './session-attachments.js';
import { openAppStateFiles } from './store-files.js';

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
 * M2.5, section 2.3: builds and pops the native OS context menu ("Copiar"/
 * "Colar") at the current cursor position (`Menu.popup({ window })` with no
 * explicit `x`/`y` uses the cursor's position — Electron's own documented
 * default), and resolves with the user's choice.
 *
 * `Menu.popup`'s own `callback` option fires once the menu closes, whether
 * or not an item was clicked (Electron's docs: "Called when menu is
 * closed") — including *after* a clicked item's own `click` handler has
 * already run, not instead of it. `settle`'s `settled` guard is what turns
 * that into "resolve with the clicked choice, or with `undefined` if the
 * menu closed with no item chosen" instead of every popup resolving twice.
 */
function openContextMenu(
  window: BrowserWindow,
  hasSelection: boolean,
): Promise<'copy' | 'paste' | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (choice: 'copy' | 'paste' | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(choice);
    };

    const menu = Menu.buildFromTemplate([
      {
        label: 'Copiar',
        accelerator: 'Ctrl+Shift+C',
        enabled: hasSelection,
        click: () => {
          settle('copy');
        },
      },
      {
        label: 'Colar',
        accelerator: 'Ctrl+Shift+V',
        click: () => {
          settle('paste');
        },
      },
    ]);
    menu.popup({
      window,
      callback: () => {
        settle(undefined);
      },
    });
  });
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
  sessionAttachments: Promise<SessionAttachments | undefined>,
): { dispose: () => void } {
  const sendToRenderer = (message: RelayOutboundMessage): void => {
    if (window.isDestroyed()) {
      return;
    }
    window.webContents.send(IPC_CHANNEL.TO_RENDERER, message);
  };

  const gateway = new BridgeGateway({
    sendToRenderer,
    connectionPromise,
    sessionAttachments,
    // M2.5, section 2.4: clipboard access lives in the main process — never
    // `navigator.clipboard` in the sandboxed renderer (see
    // `@termhub/ui`'s `TerminalBridge.readClipboardText` doc comment).
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
    openContextMenu: (hasSelection) => openContextMenu(window, hasSelection),
  });

  const onFromRenderer = (event: IpcMainEvent, message: RelayInboundMessage): void => {
    if (event.sender !== window.webContents) {
      return; // Not this window's bridge — ipcMain listeners are process-global.
    }
    gateway.handleRendererMessage(message);
  };
  ipcMain.on(IPC_CHANNEL.FROM_RENDERER, onFromRenderer);

  // docs/specs/m2.6-boot-reattach.md section 3.3: a crashed/gone renderer
  // process releases whatever the current instance held, without tearing
  // this bridge down — the window (and its webContents) can still recover
  // with a fresh `hello`. `'closed'` (wired by this function's caller, on
  // the *window*, not `webContents`) is what fully disposes the gateway.
  wireWebContentsLifecycle(window.webContents, gateway);

  // Optional early release (section 3.3: "Você pode também chamar
  // releaseAll em did-start-navigation do frame principal, para soltar o
  // daemon mais cedo, mas a correção não pode depender disso") — a full
  // page navigation (dev HMR's occasional full reload, or a real
  // `webContents.reload()`) is about to tear down this instance's JS
  // context well before its own `hello` fires from the new one, so this
  // just frees the daemon-side attachment sooner. Ignored for any non-main
  // frame — an iframe navigating (none exist in this app today, but the
  // event fires for any frame) must never release the whole window's
  // instance.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isSameDocument || !details.isMainFrame) {
      return;
    }
    gateway.releaseCurrentInstance();
  });

  return {
    dispose(): void {
      ipcMain.removeListener(IPC_CHANNEL.FROM_RENDERER, onFromRenderer);
      gateway.dispose();
    },
  };
}

async function main(): Promise<void> {
  // docs/specs/m4.1-atomic-state.md section 3.1: one main process per user.
  // A second one would be a second writer of workspaces.json, each
  // overwriting the other's layout. Taken before anything else, so a
  // process that loses never connects to the daemon or reads state files.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  // Loaded once, at boot, from the daemon's state directory (section 3.2).
  // M4.3 threads this into the renderer's layout; until then the load
  // still runs for real, so a bad file is backed up by the real app.
  const stateFilesPromise = openAppStateFiles();
  stateFilesPromise.catch((error: unknown) => {
    console.error('[TermHub] unexpected error while loading state files', error);
  });
  // Section 3.7: before-quit waits for every state file's write queue.
  installQuitFlush(app, [
    () => stateFilesPromise.then((files) => files.config.flush()),
    () => stateFilesPromise.then((files) => files.workspaces.flush()),
  ]);

  // One `connectToDaemon()` call for the whole app start, shared by the
  // logger above and every window's bridge — never one call per window.
  const connectionPromise = connectToDaemon();
  logDaemonConnectionOutcome(connectionPromise).catch((error: unknown) => {
    console.error('[TermHub] unexpected error while connecting to the daemon', error);
  });

  // docs/specs/m2.6-boot-reattach.md section 3.2: one `SessionAttachments`
  // for the whole app, derived from the *same* `connectionPromise` every
  // window's `BridgeGateway` already shares — never one per window.
  // `.then()` on a single promise memoizes its result, so every gateway
  // that awaits `sessionAttachmentsPromise` observes the identical
  // instance. `undefined` when the daemon connection itself never reached
  // `'connected'` (blocked/failed) — there is no `TransportClient` to hand
  // it in that case, and `BridgeGateway`/`handleAttachmentRequest` already
  // handle an absent book by rejecting `session.attach`/`session.detach`
  // the same way every other method fails without a connection.
  const sessionAttachmentsPromise: Promise<SessionAttachments | undefined> = connectionPromise.then(
    (result) =>
      result.outcome === 'connected' ? new SessionAttachments(result.client) : undefined,
  );

  const openWindow = (): BrowserWindow => {
    const window = createWindow();
    const windowBridge = attachDaemonBridge(window, connectionPromise, sessionAttachmentsPromise);
    window.on('closed', () => {
      windowBridge.dispose();
    });
    return window;
  };

  const mainWindow = openWindow();
  await loadRenderer(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return;
    }
    loadRenderer(openWindow()).catch((error: unknown) => {
      console.error('[TermHub] failed to load renderer after activate', error);
    });
  });

  // Someone launched TermHub again: that process quit on the lock above,
  // and this one surfaces its existing window instead (section 3.1).
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) {
      loadRenderer(openWindow()).catch((error: unknown) => {
        console.error('[TermHub] failed to load renderer for a second launch', error);
      });
      return;
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
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
