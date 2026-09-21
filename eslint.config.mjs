// ESLint flat config (ESLint 10) for the whole monorepo: packages/* and scripts/.
//
// TypeScript is pinned to 6.0.3 specifically so `typescript-eslint` can run
// type-aware rules against it: TypeScript 7's npm package dropped the
// classic compiler API that `typescript-eslint` depends on, and
// `typescript-eslint`'s peer range for `typescript` is `>=4.8.4 <6.1.0`.
// Don't bump `typescript` past 6.0.x without confirming typescript-eslint
// supports it (tracking: https://github.com/typescript-eslint/typescript-eslint/issues/10940).
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Auto-discovers the nearest tsconfig.json for each linted file
        // (packages/*/tsconfig.json). Root-level TS tooling files that
        // aren't part of any package project (currently just
        // vitest.config.ts) fall back to tsconfig.tools.json instead of
        // losing type-aware checking.
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
          defaultProject: 'tsconfig.tools.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  // Must stay last: disables ESLint stylistic rules that would otherwise
  // fight Prettier's formatting.
  eslintConfigPrettier,
);
