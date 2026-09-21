import { defineConfig } from 'vitest/config';

// Runs every workspace package's tests from a single root config: `npm run
// test` covers packages/shared today and will pick up packages/app,
// packages/daemon and packages/ui automatically as those tasks add tests
// next to their code (see CLAUDE.md's test-colocation rule) — no per-package
// Vitest config needed for that. `dist/**` is excluded on top of Vitest's own
// defaults because composite packages (`tsc --build`, outDir "dist") compile
// `*.test.ts` alongside regular sources, and without this exclusion Vitest's
// default include glob picks up both the `src/**/*.test.ts` source and its
// compiled `dist/**/*.test.js` copy, running every test twice.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    environment: 'node',
  },
});
