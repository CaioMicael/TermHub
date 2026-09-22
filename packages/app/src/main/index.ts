import { join } from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';

import { connectToDaemon } from './daemon-client.js';

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
 * Kicks off docs/specs/m2.1-daemon-client.md's find-or-spawn-or-reconnect
 * flow at startup and logs the outcome. Deliberately not awaited by
 * `main()` below — the daemon connection and the window showing up are
 * independent concerns, and a slow/backed-off daemon connection must never
 * delay the window from appearing. M2.1's own scope stops at producing a
 * `DaemonConnection` and surfacing it here; wiring `'blocked'`/`'failed'`
 * into a visible warning banner, and `'connected'`'s client into an IPC
 * bridge the renderer can actually use, is M2.2/M2.3.
 */
async function startDaemonConnection(): Promise<void> {
  const result = await connectToDaemon();

  switch (result.outcome) {
    case 'connected':
      console.log('[TermHub] connected to daemon', {
        pid: result.info.pid,
        pipe: result.info.pipe,
        startedAt: result.info.startedAt,
      });
      return;
    case 'blocked':
      // Section 2: never auto-resolved. M2.2/M2.3 turn this into the
      // visible warning banner the spec requires; this module's job stops
      // at surfacing it clearly here.
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

async function main(): Promise<void> {
  await app.whenReady();

  startDaemonConnection().catch((error: unknown) => {
    console.error('[TermHub] unexpected error while connecting to the daemon', error);
  });

  const mainWindow = createWindow();
  await loadRenderer(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return;
    }

    const nextWindow = createWindow();
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
