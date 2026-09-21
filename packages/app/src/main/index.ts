import { join } from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';

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

async function main(): Promise<void> {
  await app.whenReady();

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
