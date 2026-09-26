import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Atomic file writes shared by every state file this project keeps on disk:
// `daemon.json` (the daemon, docs/specs/m1.8-single-instance.md section 3.2)
// and `config.json`/`workspaces.json` (the app's main process,
// docs/specs/m4.1-atomic-state.md). Moved here out of daemon.ts unchanged
// (section 3.3 of the M4.1 spec), so the Windows rename retry below exists
// in exactly one place.

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Windows-specific transient failure this project's own test suite (see
 * daemon.test.ts's atomicity test) surfaced while writing this: unlike a
 * POSIX `rename(2)`, which atomically retargets the directory entry
 * regardless of who else has the old name open, NTFS can refuse to rename a
 * *new* file over a destination another handle currently has open — even
 * just for reading — with `EPERM` (occasionally `EBUSY`/`EACCES`). A reader
 * of `daemon.json` (a client resolving the daemon to connect to) that
 * happens to have the file open at the exact instant a daemon rewrites it
 * can trigger this. It clears on its own once that reader's `readFile`
 * closes the handle, but "once" is not bounded to a few milliseconds in
 * practice: AV/indexer activity on Windows can hold a file open far longer,
 * and this is why the retry below budgets *seconds*, not hundreds of
 * milliseconds, before giving up.
 *
 * The retry is exponential backoff with jitter, not a fixed interval. A
 * fixed interval has a real failure mode this project hit directly: a
 * periodic reader (daemon.test.ts's required-test-5 readers, sampling on a
 * timer) can end up in phase with a fixed-delay writer, so every retry
 * lands while the reader's handle happens to be open — starving the rename
 * outright regardless of how many attempts are budgeted. Randomizing each
 * wait (rather than a phase-locked constant) breaks that resonance;
 * doubling the cap on each attempt means a persistent holder gets
 * increasingly long gaps to actually let go, without spending the whole
 * budget on tiny, ineffective waits up front.
 */
export const RENAME_RETRY_BASE_DELAY_MS = 10;
export const RENAME_RETRY_MAX_DELAY_MS = 320;
/** Total time budget across all retries — seconds, not the previous ~400ms, because Windows AV/indexer hold times can exceed that (see above). */
export const RENAME_RETRY_BUDGET_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRenameError(err: unknown): boolean {
  return (
    isErrnoException(err) && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
  );
}

/**
 * Delay for a given (1-indexed) retry attempt: exponential backoff, capped
 * at `maxDelayMs`, with "equal jitter" (half fixed, half random) rather than
 * full jitter — this keeps the wait strictly growing attempt-over-attempt
 * (in its lower bound) instead of letting randomness occasionally pick a
 * later attempt a shorter wait than an earlier one, which is what
 * daemon.test.ts's unit test on this function asserts.
 */
function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const half = cap / 2;
  return half + Math.random() * half;
}

type RenameFn = (oldPath: string, newPath: string) => Promise<void>;
type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

export interface RenameWithRetryOptions {
  /** Test-only seam: inject a fake `rename` to simulate transient/persistent failures without touching a real filesystem. Defaults to `node:fs/promises`'s `rename`. */
  rename?: RenameFn;
  /** Test-only seam: inject a fake sleep to exercise the retry loop without real wall-clock waits. Defaults to a real `setTimeout`-based sleep. */
  sleep?: SleepFn;
  /** Test-only seam: inject a fake clock so the retry budget can be exercised deterministically. Defaults to `Date.now`. */
  now?: NowFn;
  /**
   * Test-only seam: override the backoff's starting cap, its ceiling, and
   * the total retry budget — all three default to the production constants
   * below. daemon.test.ts's atomicity test (required test 5) uses this to
   * keep the *same* real-timer retry mechanism under real reader contention
   * while scaling the numbers down, so a real-world-realistic but
   * comparatively rare NTFS lock doesn't force that test to run for the
   * production budget's full multi-second ceiling on every contended write.
   */
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
}

export async function renameWithRetry(
  tmpPath: string,
  destPath: string,
  options: RenameWithRetryOptions = {},
): Promise<void> {
  const renameFn = options.rename ?? rename;
  const sleepFn = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const baseDelayMs = options.baseDelayMs ?? RENAME_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? RENAME_RETRY_MAX_DELAY_MS;
  const budgetMs = options.budgetMs ?? RENAME_RETRY_BUDGET_MS;

  const start = now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await renameFn(tmpPath, destPath);
      return;
    } catch (err) {
      if (!isTransientRenameError(err)) {
        throw err;
      }
      if (now() - start >= budgetMs) {
        throw err;
      }
      await sleepFn(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
}

/**
 * Writes `contents` to `path` atomically: a temporary file in the same
 * directory (so `rename` is a same-filesystem, single-syscall operation,
 * not a cross-device copy) written in full, then renamed over the
 * destination with `renameWithRetry`. A reader of `path` sees either the
 * previous complete file or the new complete file, never a truncated one,
 * because it never observes the temporary file at `path`'s name at all.
 *
 * The temporary file is `.<basename>.<pid>.<hex>.tmp`. The basename prefix
 * is what lets a writer clean up its own orphans after a crash without ever
 * touching another writer's (docs/specs/m4.1-atomic-state.md section 3.5).
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  retryOptions?: RenameWithRetryOptions,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(
    dir,
    tempFilePrefix(path) + `${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  await writeFile(tmpPath, contents, 'utf8');
  await renameWithRetry(tmpPath, path, retryOptions);
}

/** The prefix every temporary file `writeFileAtomic` creates for `path` starts with: `.<basename>.` */
export function tempFilePrefix(path: string): string {
  return `.${basename(path)}.`;
}
