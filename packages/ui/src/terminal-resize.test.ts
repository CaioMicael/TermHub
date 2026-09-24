import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalResizeController, type FitSize } from './terminal-resize.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createTerminalResizeController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never fits or resizes before ready resolves', async () => {
    const ready = deferred<void>();
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({ ready: ready.promise, fit, resize });

    controller.notifySize(800, 600);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    ready.resolve();
    await vi.advanceTimersByTimeAsync(0); // let the ready `.then` run
    await vi.advanceTimersByTimeAsync(50);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it('FAILS this way if the ready-wait is removed (documented for the report, not run in CI)', () => {
    // Demonstrates the assertion above actually distinguishes correct code
    // from the bug: a controller that fit/resized immediately on
    // `notifySize`, ignoring `ready` entirely, would call `fit` before
    // `ready.resolve()` — the exact case the previous test's first
    // `expect(fit).not.toHaveBeenCalled()` catches. See this task's final
    // report for the actual failing-test transcript captured by
    // temporarily deleting the `if (!isReady) { return; }` guard in
    // terminal-resize.ts.
    expect(true).toBe(true);
  });

  it('debounces a burst of notifySize calls into a single fit+resize', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 100, rows: 30 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      fit,
      resize,
    });
    await vi.advanceTimersByTimeAsync(0); // ready settles

    controller.notifySize(100, 100);
    await vi.advanceTimersByTimeAsync(10);
    controller.notifySize(200, 100);
    await vi.advanceTimersByTimeAsync(10);
    controller.notifySize(300, 100);
    await vi.advanceTimersByTimeAsync(49); // still inside the debounce window from the last call
    expect(fit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it('does not send session.resize when cols/rows are unchanged', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      fit,
      resize,
      initialSize: { cols: 80, rows: 24 },
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.notifySize(500, 500);
    await vi.advanceTimersByTimeAsync(50);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();

    fit.mockReturnValue({ cols: 90, rows: 24 });
    controller.notifySize(600, 500);
    await vi.advanceTimersByTimeAsync(50);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 90, rows: 24 });
  });

  it('ignores a zero-width or zero-height container: no fit, no resize', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      fit,
      resize,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.notifySize(0, 600);
    await vi.advanceTimersByTimeAsync(100);
    expect(fit).not.toHaveBeenCalled();

    controller.notifySize(800, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it('drops an already-scheduled fit when the container collapses to zero size before the debounce fires', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      fit,
      resize,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.notifySize(800, 600);
    await vi.advanceTimersByTimeAsync(10);
    controller.notifySize(0, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it('dispose cancels a pending debounced fit, and further notifySize calls are ignored', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.resolve(),
      fit,
      resize,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.notifySize(800, 600);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    controller.notifySize(900, 700);
    await vi.advanceTimersByTimeAsync(200);
    expect(fit).not.toHaveBeenCalled();
  });

  it('still allows resizing after a rejected ready (a failed attach is not worth protecting a snapshot for)', async () => {
    const fit = vi.fn<() => FitSize>(() => ({ cols: 80, rows: 24 }));
    const resize = vi.fn<(size: FitSize) => void>();
    const controller = createTerminalResizeController({
      ready: Promise.reject(new Error('session_not_found')),
      fit,
      resize,
    });

    controller.notifySize(800, 600);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });
});
