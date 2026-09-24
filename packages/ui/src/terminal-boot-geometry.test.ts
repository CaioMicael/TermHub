import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal as XTerm } from '@xterm/xterm';

import { createTerminalResizeController, type FitSize } from './terminal-resize.js';

// docs/specs/m2.6-boot-reattach.md section 3.5, required test 9: "Terminal:
// cria o xterm com os cols/rows da sessão no construtor, e nenhum
// fit()/session.resize acontece antes de ready."
//
// `Terminal.tsx` itself is a React component this repo has no DOM-testing
// infrastructure for (`vitest.config.ts`'s root config runs everything under
// `environment: 'node'`, and there's no jsdom/testing-library dependency —
// adding one is a toolchain decision out of this task's scope, per
// .claude/rules/typescript-rules.md's "don't fix by relaxing/adding tooling"
// rule generalized to test infra; see this task's final report for the gap
// this leaves).
//
// What *is* testable here, without any DOM: `@xterm/xterm`'s own `Terminal`
// class can be constructed and written to entirely headless — confirmed
// directly (see this task's final report) — so this file exercises the real
// `@xterm/xterm` `Terminal` and the real `createTerminalResizeController`
// wired together exactly the way `Terminal.tsx` wires them (same option
// shape, same `fit`/`resize` callbacks reading/acting on the real xterm
// instance), just without React or a container `<div>`. That covers both
// halves of section 3.5's contract:
// 1. the xterm instance is constructed with the session's own `cols`/`rows`
//    (not xterm's 80x24 default), and stays there until a real resize;
// 2. neither `fit()` nor `session.resize` fires before `ready` settles, and
//    a fit that lands back on the session's own geometry sends nothing.
describe('Terminal.tsx boot geometry contract (M2.6 required test 9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs the xterm at the session geometry, and term.cols/rows stay there until ready + a real resize', async () => {
    const sessionCols = 137;
    const sessionRows = 41;

    // Same constructor shape Terminal.tsx uses (theme/font omitted — not
    // relevant to geometry), built and written to *before* any `open()` —
    // the exact ordering Terminal.tsx relies on (its own header comment: a
    // snapshot can arrive, and gets written, before the DOM element exists).
    const term = new XTerm({ cols: sessionCols, rows: sessionRows, allowProposedApi: true });
    expect(term.cols).toBe(sessionCols);
    expect(term.rows).toBe(sessionRows);

    // A "snapshot" write against the still-unopened terminal must not throw,
    // and must not itself change the geometry — this is what lets
    // `attachTerminalSession`'s `sink.write` (terminal-session.ts) run ahead
    // of `term.open()` safely.
    term.write('some snapshot bytes, unopened');
    expect(term.cols).toBe(sessionCols);
    expect(term.rows).toBe(sessionRows);

    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const resize = vi.fn<(size: FitSize) => void>();
    // `fit` reads the *real* xterm instance, exactly like `Terminal.tsx`'s
    // `fit: () => { fitAddon.fit(); return { cols: term.cols, rows: term.rows }; }`
    // — here there's no `FitAddon` (it needs a live DOM to measure against),
    // so this fake stands in for "the container happens to still match the
    // session's own geometry", which is the common case section 3.5's
    // `initialSize` dedup exists for.
    const fit = vi.fn<() => FitSize>(() => ({ cols: term.cols, rows: term.rows }));

    const controller = createTerminalResizeController({
      ready,
      initialSize: { cols: sessionCols, rows: sessionRows },
      fit,
      resize,
    });

    // A resize notification arrives (e.g. the ResizeObserver's first fire)
    // well before `ready` ever settles — nothing must happen yet.
    controller.notifySize(1000, 800);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(term.cols).toBe(sessionCols);
    expect(term.rows).toBe(sessionRows);

    // Now the attach settles. The pending notifySize schedules a fit, which
    // lands back on exactly the session's own geometry (initialSize) — so
    // no `session.resize` is sent at all, even though a fit did happen.
    readyResolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();
    expect(term.cols).toBe(sessionCols);
    expect(term.rows).toBe(sessionRows);

    term.dispose();
  });

  it('a real geometry change after ready DOES send exactly one session.resize, with the new size', async () => {
    const term = new XTerm({ cols: 80, rows: 24, allowProposedApi: true });
    const resize = vi.fn<(size: FitSize) => void>();
    // Simulates the pane actually being a different size than the session's
    // geometry once the container is real — `fit` reports 100x30 regardless
    // of `term`'s own current cols/rows (a real FitAddon would also change
    // `term.cols`/`rows` as a side effect of `fit()`; that's irrelevant to
    // what this test is asserting: that the controller reports it exactly
    // once and only after ready).
    const fit = vi.fn<() => FitSize>(() => ({ cols: 100, rows: 30 }));

    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      initialSize: { cols: 80, rows: 24 },
      fit,
      resize,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.notifySize(900, 700);
    await vi.advanceTimersByTimeAsync(50);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 });

    term.dispose();
  });
});
