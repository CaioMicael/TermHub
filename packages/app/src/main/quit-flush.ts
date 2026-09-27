// Waits for the state files' write queues before the app quits
// (docs/specs/m4.1-atomic-state.md section 3.7). Takes an `app`-shaped
// object rather than Electron's `app` itself so it is testable without
// Electron.
//
// Killing the process (Task Manager) or a Windows shutdown never emits
// `before-quit`: at most the last debounce window is lost there, and the
// file on disk is still a complete earlier version, because every write is
// atomic.

/** Above the rename retry's 4 s budget (atomic-file.ts), so a write still retrying gets to finish. */
export const QUIT_FLUSH_TIMEOUT_MS = 5000;

export interface QuitEventLike {
  preventDefault(): void;
}

export interface QuitAppLike {
  on(event: 'before-quit', listener: (event: QuitEventLike) => void): unknown;
  quit(): void;
}

export interface QuitFlushOptions {
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  logError?: (message: string, error?: unknown) => void;
}

export function installQuitFlush(
  app: QuitAppLike,
  flushers: ReadonlyArray<() => Promise<void>>,
  options: QuitFlushOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? QUIT_FLUSH_TIMEOUT_MS;
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) => {
      // The handle is always one `schedule` above returned.
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const logError =
    options.logError ??
    ((message, error) => {
      console.error(`[TermHub] ${message}`, error ?? '');
    });

  let state: 'idle' | 'flushing' | 'done' = 'idle';

  const flushAll = async (): Promise<void> => {
    let timer: unknown;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = schedule(() => resolve('timeout'), timeoutMs);
    });
    const settled = Promise.allSettled(flushers.map((flush) => flush()));
    const result = await Promise.race([settled, timedOut]);
    cancel(timer);
    if (result === 'timeout') {
      logError(`state files did not finish writing within ${timeoutMs} ms; quitting anyway`);
      return;
    }
    for (const outcome of result) {
      if (outcome.status === 'rejected') {
        logError('a state file failed to write before quitting', outcome.reason);
      }
    }
  };

  // Synchronous listener: an async function handed straight to `on` would
  // be a misused promise (no-misused-promises).
  app.on('before-quit', (event) => {
    if (state === 'done') {
      return;
    }
    event.preventDefault();
    if (state === 'flushing') {
      return;
    }
    state = 'flushing';
    flushAll()
      .catch((error: unknown) => {
        logError('unexpected error while flushing state files', error);
      })
      .finally(() => {
        state = 'done';
        app.quit();
      });
  });
}
