#!/usr/bin/env node
// Placeholder used by root npm scripts that don't have an implementation yet.
// Fails loudly and says exactly which milestone task is expected to fill it in,
// instead of silently no-op'ing or being mistaken for a passing script.

const messages = {
  lint: 'lint is not implemented yet — arrives in task M0.4 (ESLint flat config + Prettier).',
  test: 'test is not implemented yet — arrives in task M0.4 (Vitest).',
  build: 'build is not implemented yet — arrives in task M0.3 (electron-vite).',
  dev: 'dev is not implemented yet — arrives in task M0.3 (electron-vite + renderer HMR).',
};

const task = process.argv[2];
const message = messages[task] ?? `"${task}" has no placeholder message configured.`;

console.error(`\n[TermHub] npm run ${task}: ${message}\n`);
process.exit(1);
