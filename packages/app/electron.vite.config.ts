import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Build output goes to dist/{main,preload,renderer} instead of electron-vite's
// default out/ so it lands inside a directory name already treated as build
// output everywhere else in the repo: .gitignore (`dist/`), eslint.config.mjs
// (`**/dist/**`), .prettierignore (`dist`) and vitest.config.ts (`**/dist/**`)
// all already exclude it — no extra config to add or maintain in those files.
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
    },
    plugins: [externalizeDepsPlugin()],
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
