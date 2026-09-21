// ESLint flat config (ESLint 10) for the whole monorepo: packages/* and scripts/.
//
// TypeScript note: this repo pins `typescript@^7.0.2`, the new Go-based native
// compiler. Its npm package no longer exports the classic TS Compiler API
// (`require('typescript')` only returns `{ version, versionMajorMinor }` now —
// there is no `createProgram`, `createSourceFile`, `SyntaxKind`, etc.).
// `typescript-eslint` (parser and plugin, tested at 8.70.0) depends on that
// classic API and refuses to load at all against TS 7, even for syntax-only
// parsing with no type-aware rules:
//
//   Error: typescript-eslint does not support TS 7.0.
//     at .../@typescript-eslint/parser/dist/index.js:49:11
//
// See https://github.com/typescript-eslint/typescript-eslint/issues/10940
// (tracking bug) and https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
// (workaround: install a second, TS 6.x copy of `typescript` just for
// linting). Neither downgrading the repo's TypeScript nor adding that
// side-by-side install is this task's call to make, so until upstream ships
// TS 7 support, ESLint here only covers JavaScript tooling files (this file,
// `scripts/**`, `*.config.mjs`, ...). TypeScript sources are still type-checked
// by `npm run typecheck` (tsc --build); the `any` ban from CLAUDE.md is
// enforced there by `strict` plus code review in the meantime.
import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // TypeScript sources: not linted by ESLint yet, see note above.
      '**/*.ts',
      '**/*.tsx',
    ],
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
  // Must stay last: disables ESLint stylistic rules that would otherwise
  // fight Prettier's formatting.
  eslintConfigPrettier,
];
