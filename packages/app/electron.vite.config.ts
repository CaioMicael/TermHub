import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);

// Build output goes to dist/{main,preload,renderer} instead of electron-vite's
// default out/ so it lands inside a directory name already treated as build
// output everywhere else in the repo: .gitignore (`dist/`), eslint.config.mjs
// (`**/dist/**`), .prettierignore (`dist`) and vitest.config.ts (`**/dist/**`)
// all already exclude it — no extra config to add or maintain in those files.
//
// ## The "daemon" input — docs/specs/m2.1-daemon-client.md section 3
//
// The daemon's own entrypoint (packages/daemon/src/index.ts) is TypeScript,
// and `electron.exe` run as plain Node (`ELECTRON_RUN_AS_NODE=1`, the way
// daemon-client.ts spawns it) cannot execute TypeScript. This adds it as a
// *second* Rollup input on the same "main" build target that already
// produces dist/main/index.js — not a separate package build, not a
// dev-only tsx path — so `electron-vite dev` and `electron-vite build` both
// produce dist/main/daemon.js the exact same way, every time, right next to
// index.js. daemon-paths.ts's `resolveDaemonScriptPath()` then finds it with
// nothing more than `join(__dirname, 'daemon.js')` — no separate lookup
// rule for dev vs. packaged, and nothing extra for M7.5 to wire up: whatever
// packaging step already ships dist/main (for index.js/preload.js to run at
// all) ships daemon.js along with it for free.
//
// This *is* a real bundle, not a copy: Rollup inlines packages/daemon's own
// source and its `@termhub/shared` dependency directly into daemon.js,
// which is what lets a plain TypeScript daemon package (no build step of
// its own that produces anything runnable without further tooling — see
// this task's final report for why packages/daemon's *own* `tsc --build`
// output doesn't solve this on its own) become one self-contained runnable
// JS file. The one thing that must stay external is `node-pty`: it ships a
// prebuilt native `.node` binary Rollup cannot bundle, so it's kept as a
// real `require('node-pty')` resolved via node_modules at runtime — see
// this task's final report for what that means for M7.5 (asarUnpack, and
// making sure node-pty's own node_modules entry actually ships).
const daemonEntry = resolve(__dirname, '../daemon/src/index.ts');
const mainEntry = resolve(__dirname, 'src/main/index.ts');

// `@xterm/headless@6.0.0` (a real daemon dependency, pulled in transitively
// through packages/daemon/src/buffer.ts) ships a `"module"` field in its
// own package.json ("lib/xterm.mjs") that points at a file which simply
// doesn't exist in the published package — only its `"main"` entry
// ("lib-headless/xterm-headless.js") is real. electron-vite's main-process
// preset sets `resolve.mainFields: ['module', 'jsnext:main', 'jsnext']`
// (deliberately *excluding* plain `"main"`), so without this alias Rollup
// tries that broken "module" path first and the "daemon" build above fails
// outright ("Failed to resolve entry for package"). `require.resolve` below
// uses Node's own CommonJS resolution — which only ever looks at `"main"`/
// `"exports"`, never `"module"` — so it always lands on the one entry file
// that's actually there, regardless of node_modules hoisting layout.
const xtermHeadlessEntry = require.resolve('@xterm/headless');

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: mainEntry,
          daemon: daemonEntry,
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
    resolve: {
      alias: {
        '@xterm/headless': xtermHeadlessEntry,
      },
    },
    // `include: ['node-pty']` forces it external even though it isn't (and
    // must not become) a declared dependency of @termhub/app's own
    // package.json — see this file's header comment above.
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })],
  },
  preload: {
    build: {
      outDir: 'dist/preload',
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'dist/renderer',
    },
    plugins: [react()],
  },
});
