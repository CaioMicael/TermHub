// Ambient module declaration for CSS side-effect imports (`terminal-host.ts`
// imports `@xterm/xterm/css/xterm.css` — `Terminal.tsx`'s job before M3.5
// moved the logic here). electron-vite's renderer build (Vite) resolves and
// bundles the actual CSS at dev/build time — this declaration only satisfies
// `tsc --build`'s typecheck, which has no built-in notion of a CSS import
// and doesn't automatically pick up Vite's own `vite/client` ambient types
// unless a project references them (the way `packages/app/src/renderer/src/
// env.d.ts` does for `@termhub/app`'s own program). `@termhub/ui`'s program
// has no such reference, so it needs its own minimal declaration instead of
// pulling in the rest of `vite/client` (`import.meta.env`, asset URL
// imports, ...) that this package never uses.
declare module '*.css';

// Same reasoning, for Vite/Vitest's `?raw` import suffix — used by
// `terminal-host.test.ts`'s regression test for the CSS import above (it
// reads `terminal-host.ts`'s own source as plain text, to catch this exact
// import ever being silently dropped again).
declare module '*?raw' {
  const content: string;
  export default content;
}
