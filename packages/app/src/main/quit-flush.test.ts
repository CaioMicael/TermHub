import { describe, expect, it } from 'vitest';

import { installQuitFlush, type QuitAppLike, type QuitEventLike } from './quit-flush.js';

/** A fake `app` whose `quit()` re-emits `before-quit`, the way Electron's does. */
function makeFakeApp(): QuitAppLike & {
  emitBeforeQuit: () => { prevented: boolean };
  quitCalls: () => number;
  exited: () => boolean;
} {
  let listener: ((event: QuitEventLike) => void) | undefined;
  let quitCalls = 0;
  let exited = false;
  const emitBeforeQuit = (): { prevented: boolean } => {
    let prevented = false;
    listener?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      exited = true;
    }
    return { prevented };
  };
  return {
    on: (_event, callback) => {
      listener = callback;
    },
    quit: () => {
      quitCalls += 1;
      emitBeforeQuit();
    },
    emitBeforeQuit,
    quitCalls: () => quitCalls,
    exited: () => exited,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

const quiet = { logError: () => undefined };

describe('installQuitFlush', () => {
  it('holds the quit until every state file has flushed, then quits once', async () => {
    const app = makeFakeApp();
    const workspaces = deferred();
    const config = deferred();
    let flushCalls = 0;
    installQuitFlush(
      app,
      [
        () => {
          flushCalls += 1;
          return workspaces.promise;
        },
        () => {
          flushCalls += 1;
          return config.promise;
        },
      ],
      quiet,
    );

    expect(app.emitBeforeQuit().prevented).toBe(true);
    await settle();
    expect(app.exited()).toBe(false);

    workspaces.resolve();
    await settle();
    expect(app.exited()).toBe(false); // config still writing

    config.resolve();
    await settle();
    expect(app.exited()).toBe(true);
    expect(app.quitCalls()).toBe(1);
    expect(flushCalls).toBe(2);
  });

  it('a second before-quit while flushing does not flush twice', async () => {
    const app = makeFakeApp();
    const write = deferred();
    let flushCalls = 0;
    installQuitFlush(
      app,
      [
        () => {
          flushCalls += 1;
          return write.promise;
        },
      ],
      quiet,
    );

    app.emitBeforeQuit();
    expect(app.emitBeforeQuit().prevented).toBe(true);
    write.resolve();
    await settle();

    expect(flushCalls).toBe(1);
    expect(app.quitCalls()).toBe(1);
    expect(app.exited()).toBe(true);
  });

  it('quits anyway when a flush rejects', async () => {
    const app = makeFakeApp();
    const write = deferred();
    const errors: unknown[] = [];
    installQuitFlush(app, [() => write.promise], {
      logError: (_message, error) => errors.push(error),
    });

    app.emitBeforeQuit();
    const boom = new Error('EPERM');
    write.reject(boom);
    await settle();

    expect(app.exited()).toBe(true);
    expect(errors).toContain(boom);
  });

  it('quits after the timeout when a flush never settles', async () => {
    const app = makeFakeApp();
    let fireTimeout: (() => void) | undefined;
    let timeoutMs: number | undefined;
    const messages: string[] = [];
    installQuitFlush(app, [() => new Promise<void>(() => undefined)], {
      logError: (message) => messages.push(message),
      timeoutMs: 5000,
      setTimeout: (callback, ms) => {
        fireTimeout = callback;
        timeoutMs = ms;
        return 1;
      },
      clearTimeout: () => undefined,
    });

    app.emitBeforeQuit();
    await settle();
    expect(app.exited()).toBe(false);
    expect(timeoutMs).toBe(5000);

    fireTimeout?.();
    await settle();
    expect(app.exited()).toBe(true);
    expect(messages).toEqual([
      'state files did not finish writing within 5000 ms; quitting anyway',
    ]);
  });

  it('with nothing pending, still quits right after the (instant) flush', async () => {
    const app = makeFakeApp();
    installQuitFlush(app, [() => Promise.resolve()], quiet);

    expect(app.emitBeforeQuit().prevented).toBe(true);
    await settle();

    expect(app.exited()).toBe(true);
  });
});
