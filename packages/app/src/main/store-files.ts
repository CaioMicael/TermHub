import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { tempFilePrefix, writeFileAtomic } from '@termhub/daemon/src/atomic-file.js';
import { defaultAppDataDir } from '@termhub/daemon/src/daemon.js';
import {
  ConfigSchema,
  CONFIG_VERSION,
  defaultConfig,
  defaultWorkspacesFile,
  WorkspacesFileSchema,
  WORKSPACES_VERSION,
  type ConfigFile,
  type WorkspacesFile,
} from '@termhub/shared';
import type { ZodType } from 'zod';

// The app's state files on disk — config.json and workspaces.json in the
// same directory as daemon.json (docs/specs/m4.1-atomic-state.md). One
// `StateFile` per file: loaded once at boot, tolerant of a bad file
// (section 3.5), and written through a single per-file queue with a
// debounce (section 3.6). There is deliberately no synchronous write path:
// a sync write at quit could land *before* an async write already in
// flight, letting an older value win (section 2.3). The quit path waits on
// `flush()` instead (quit-flush.ts).

export const STATE_WRITE_DEBOUNCE_MS = 500;
/** How many `<name>.corrupt-*` backups are kept per file; the oldest beyond this are deleted. */
export const MAX_CORRUPT_BACKUPS = 3;

export interface StateFile<T> {
  /** Current in-memory value: what the load produced, or the last value accepted by `save()`. */
  get(): T;
  /** Validates `value`. Invalid → returns false, writes nothing, keeps the previous value. Valid → schedules a debounced write and returns true. */
  save(value: T): boolean;
  /** Writes the pending value now, if any, after any write already in flight. Resolves once the file on disk holds the last accepted value; rejects if that write failed (the value stays pending). */
  flush(): Promise<void>;
}

export type LoadOutcome =
  | { kind: 'loaded' }
  | { kind: 'missing' }
  | { kind: 'discarded'; reason: 'corrupt' | 'invalid' | 'newer'; backupPath: string }
  /** The bad file could not be moved aside. Writes to this file are disabled for this run, so the original is never overwritten. */
  | { kind: 'discarded-unmovable'; reason: 'corrupt' | 'invalid' | 'newer'; error: unknown }
  | { kind: 'unreadable'; error: unknown };

export interface StateFileIo {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export interface StateFileTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StateFileLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface StateFileSpec<T> {
  path: string;
  /** Highest format version this build supports. A file with a greater `version` is moved aside, never overwritten. */
  version: number;
  schema: ZodType<T>;
  defaults: () => T;
}

export interface StateFileDeps {
  io?: StateFileIo;
  timers?: StateFileTimers;
  logger?: StateFileLogger;
  /** Used for backup file names. */
  now?: () => Date;
  debounceMs?: number;
}

const realIo: StateFileIo = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFileAtomic: (path, contents) => writeFileAtomic(path, contents),
  rename: (from, to) => rename(from, to),
  readdir: (dir) => readdir(dir),
  unlink: (path) => unlink(path),
};

const realTimers: StateFileTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    // The handle is always one this object's own setTimeout returned.
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const consoleLogger: StateFileLogger = {
  info: (message) => {
    console.log(`[TermHub] ${message}`);
  },
  warn: (message, error) => {
    console.warn(`[TermHub] ${message}`, error ?? '');
  },
};

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

/** `2026-09-26T19-54-45-123Z`: sortable, and without the `:` Windows forbids in file names. */
function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function removeOrphanTempFiles(
  path: string,
  io: StateFileIo,
  logger: StateFileLogger,
): Promise<void> {
  const dir = dirname(path);
  // Only this file's own temporaries: `.workspaces.json.*.tmp`, never
  // `.daemon.json.*.tmp`, which belongs to the daemon, a separate process
  // that may be writing right now (section 3.5).
  const prefix = tempFilePrefix(path);
  let names: string[];
  try {
    names = await io.readdir(dir);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') {
      logger.warn(`could not list ${dir} to clean up temporary files`, err);
    }
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
      continue;
    }
    try {
      await io.unlink(join(dir, name));
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        logger.warn(`could not remove orphan temporary file ${name}`, err);
      }
    }
  }
}

async function pruneCorruptBackups(
  path: string,
  io: StateFileIo,
  logger: StateFileLogger,
): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  let names: string[];
  try {
    names = await io.readdir(dir);
  } catch (err) {
    logger.warn(`could not list ${dir} to prune old backups`, err);
    return;
  }
  // The timestamp format sorts lexicographically in time order.
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - MAX_CORRUPT_BACKUPS))) {
    try {
      await io.unlink(join(dir, name));
    } catch (err) {
      logger.warn(`could not remove old backup ${name}`, err);
    }
  }
}

type ReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'bad'; reason: 'corrupt' | 'invalid' | 'newer' };

async function readStateFile<T>(spec: StateFileSpec<T>, io: StateFileIo): Promise<ReadResult<T>> {
  let raw: string;
  try {
    raw = await io.readFile(spec.path);
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: err };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'bad', reason: 'corrupt' };
  }
  if (
    typeof json === 'object' &&
    json !== null &&
    'version' in json &&
    typeof json.version === 'number' &&
    json.version > spec.version
  ) {
    return { kind: 'bad', reason: 'newer' };
  }
  const parsed = spec.schema.safeParse(json);
  return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'bad', reason: 'invalid' };
}

/**
 * Loads `spec.path` once, handling every case in section 3.5 without
 * throwing, and returns the `StateFile` that owns all later writes to it.
 * A bad file is renamed aside *before* anything can write, so the first
 * `save()` never destroys a layout that might still be recoverable by hand.
 */
export async function loadStateFile<T>(
  spec: StateFileSpec<T>,
  deps: StateFileDeps = {},
): Promise<{ file: StateFile<T>; outcome: LoadOutcome }> {
  const io = deps.io ?? realIo;
  const timers = deps.timers ?? realTimers;
  const logger = deps.logger ?? consoleLogger;
  const now = deps.now ?? (() => new Date());
  const debounceMs = deps.debounceMs ?? STATE_WRITE_DEBOUNCE_MS;

  await removeOrphanTempFiles(spec.path, io, logger);

  const read = await readStateFile(spec, io);
  let initial: T;
  let outcome: LoadOutcome;
  let writesEnabled = true;
  switch (read.kind) {
    case 'ok':
      initial = read.value;
      outcome = { kind: 'loaded' };
      break;
    case 'missing':
      initial = spec.defaults();
      outcome = { kind: 'missing' };
      break;
    case 'unreadable':
      initial = spec.defaults();
      outcome = { kind: 'unreadable', error: read.error };
      logger.warn(`could not read ${spec.path}; using defaults`, read.error);
      break;
    case 'bad': {
      initial = spec.defaults();
      const tag = read.reason === 'newer' ? 'newer' : 'corrupt';
      const backupPath = `${spec.path}.${tag}-${fileTimestamp(now())}`;
      try {
        await io.rename(spec.path, backupPath);
        outcome = { kind: 'discarded', reason: read.reason, backupPath };
        logger.warn(
          `${spec.path} was ${read.reason}; moved it to ${backupPath} and using defaults`,
        );
        if (tag === 'corrupt') {
          await pruneCorruptBackups(spec.path, io, logger);
        }
      } catch (error) {
        writesEnabled = false;
        outcome = { kind: 'discarded-unmovable', reason: read.reason, error };
        logger.warn(
          `${spec.path} was ${read.reason} and could not be moved aside; using defaults and not writing it this run`,
          error,
        );
      }
      break;
    }
  }

  return {
    file: createStateFile(spec, initial, writesEnabled, { io, timers, logger, debounceMs }),
    outcome,
  };
}

interface WriteResult {
  error?: unknown;
}

function createStateFile<T>(
  spec: StateFileSpec<T>,
  initial: T,
  writesEnabled: boolean,
  deps: { io: StateFileIo; timers: StateFileTimers; logger: StateFileLogger; debounceMs: number },
): StateFile<T> {
  const { io, timers, logger, debounceMs } = deps;
  let current = initial;
  /** `current` has not reached the disk yet. */
  let dirty = false;
  /** A `save()` arrived while a write was in flight; that write's value is already stale. */
  let savedDuringFlight = false;
  let inFlight: Promise<WriteResult> | undefined;
  let timer: unknown;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  // The only place a write starts. Never called while one is in flight, so
  // at most one rename of this file is ever running.
  const startWrite = (): Promise<WriteResult> => {
    const value = current;
    dirty = false;
    savedDuringFlight = false;
    const write = writesEnabled
      ? io.writeFileAtomic(spec.path, JSON.stringify(value, null, 2))
      : Promise.resolve();
    const run = write.then(
      (): WriteResult => ({}),
      (error: unknown): WriteResult => {
        // Keep the value pending: the next save() or flush() retries it.
        dirty = true;
        logger.warn(`could not write ${spec.path}`, error);
        return { error };
      },
    );
    inFlight = run.then((result) => {
      inFlight = undefined;
      // A newer value arrived during this write: write it now rather than
      // leaving it stranded. A failure with no newer value does not retry
      // on its own, so a persistent error never becomes a tight loop.
      if (savedDuringFlight && dirty) {
        void startWrite();
      }
      return result;
    });
    return inFlight;
  };

  const onDebounce = (): void => {
    timer = undefined;
    if (inFlight === undefined && dirty) {
      void startWrite();
    }
    // Otherwise the write in flight picks the pending value up when it ends.
  };

  return {
    get: () => current,
    save: (value) => {
      const parsed = spec.schema.safeParse(value);
      if (!parsed.success) {
        logger.warn(`refused to save an invalid value to ${spec.path}`, parsed.error);
        return false;
      }
      current = parsed.data;
      dirty = true;
      if (inFlight !== undefined) {
        savedDuringFlight = true;
      }
      clearTimer();
      timer = timers.setTimeout(onDebounce, debounceMs);
      return true;
    },
    flush: async () => {
      clearTimer();
      for (;;) {
        if (inFlight !== undefined) {
          await inFlight;
          continue;
        }
        if (!dirty) {
          return;
        }
        const result = await startWrite();
        if ('error' in result) {
          throw result.error;
        }
      }
    },
  };
}

export interface AppStateFiles {
  config: StateFile<ConfigFile>;
  workspaces: StateFile<WorkspacesFile>;
}

function describeOutcome(path: string, outcome: LoadOutcome): string {
  switch (outcome.kind) {
    case 'loaded':
      return `loaded ${path}`;
    case 'missing':
      return `${path} does not exist yet; using defaults`;
    case 'discarded':
      return `${path} was ${outcome.reason}; backed up to ${outcome.backupPath}`;
    case 'discarded-unmovable':
      return `${path} was ${outcome.reason} and could not be backed up; it will not be written this run`;
    case 'unreadable':
      return `${path} could not be read; using defaults`;
  }
}

/**
 * Opens config.json and workspaces.json in `dir`, which defaults to the
 * daemon's own state directory (`defaultAppDataDir()`: `APPDATA/TermHub`),
 * never Electron's `app.getPath('appData')`. On Windows that one ignores the
 * `APPDATA` variable, so a manual test isolated by `APPDATA` would read and
 * write the owner's real layout (docs/specs/m4.1-atomic-state.md 2.2).
 */
export async function openAppStateFiles(
  dir: string = defaultAppDataDir(),
  deps: StateFileDeps = {},
): Promise<AppStateFiles> {
  const logger = deps.logger ?? consoleLogger;
  const configPath = join(dir, 'config.json');
  const workspacesPath = join(dir, 'workspaces.json');
  const [config, workspaces] = await Promise.all([
    loadStateFile(
      { path: configPath, version: CONFIG_VERSION, schema: ConfigSchema, defaults: defaultConfig },
      deps,
    ),
    loadStateFile(
      {
        path: workspacesPath,
        version: WORKSPACES_VERSION,
        schema: WorkspacesFileSchema,
        defaults: defaultWorkspacesFile,
      },
      deps,
    ),
  ]);
  logger.info(describeOutcome(configPath, config.outcome));
  logger.info(describeOutcome(workspacesPath, workspaces.outcome));
  return { config: config.file, workspaces: workspaces.file };
}
