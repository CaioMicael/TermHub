import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Where the daemon's own runnable JS lives once electron-vite has built it,
// and how the app's main process finds it — docs/specs/
// m2.1-daemon-client.md section 3.
//
// The daemon's entrypoint (packages/daemon/src/index.ts) is TypeScript, and
// `electron.exe` run as plain Node via `ELECTRON_RUN_AS_NODE=1` cannot
// execute TypeScript. This project's answer (see electron.vite.config.ts's
// "daemon" entry, next to its own "index" entry on the exact same "main"
// build target) is to give it a second Rollup entry point on that same
// target, so it is bundled to plain, self-contained JS and written out to
// `dist/main/daemon.js` — right next to `dist/main/index.js`, the file this
// module (part of that same "index" bundle) is itself running from. One
// build, one artifact, one rule: `electron-vite dev` and `electron-vite
// build` both produce it the same way, so there is no separate "dev uses
// tsx, packaged uses a bundle" split to keep in sync — and nothing for
// M7.5's packaging config to add, since whatever already ships `dist/main`
// (for index.js/preload to work at all) ships daemon.js along with it.
//
// Resolved relative to *this file's own compiled location* (`__dirname`),
// never `process.cwd()` and never through the monorepo's `node_modules` —
// both are meaningless once this app is packaged (section 3, requirement
// 2). `__dirname` is available here for the same reason src/main/index.ts's
// own header comment gives: packages/app's package.json has no `"type":
// "module"`, so electron-vite's main build compiles to CommonJS.

/** Filename the daemon's bundled entrypoint is written to, alongside `index.js`, by the "daemon" Rollup input in electron.vite.config.ts. */
export const DAEMON_SCRIPT_FILENAME = 'daemon.js';

export interface ResolveDaemonScriptPathOptions {
  /** Overrides the directory `daemon.js` is expected next to. Defaults to `__dirname` (this file's own compiled directory) — tests override this to point at a fixture directory instead of depending on a real build. */
  baseDir?: string;
  /** Overrides the existence check. Defaults to `existsSync`, purely so tests can force the "missing artifact" branch without touching the real filesystem. */
  exists?: (path: string) => boolean;
}

/**
 * Resolves the daemon's bundled JS entrypoint and confirms it actually
 * exists before anything tries to spawn it. Throws — with the exact path it
 * looked for — rather than returning a path that will only fail once handed
 * to `child_process.spawn`: docs/specs/m2.1-daemon-client.md section 3,
 * requirement 3 is explicit that "não consegui conectar" without the
 * attempted path is the worst possible error message here, so this is the
 * one place that path gets produced and it is not allowed to swallow it.
 */
export function resolveDaemonScriptPath(options: ResolveDaemonScriptPathOptions = {}): string {
  const baseDir = options.baseDir ?? __dirname;
  const exists = options.exists ?? existsSync;
  const scriptPath = join(baseDir, DAEMON_SCRIPT_FILENAME);
  if (!exists(scriptPath)) {
    throw new Error(
      `daemon script not found at "${scriptPath}" — expected electron-vite's "daemon" build entry ` +
        '(electron.vite.config.ts) to have placed it next to this file',
    );
  }
  return scriptPath;
}
