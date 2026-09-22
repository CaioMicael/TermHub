import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROTOCOL_VERSION } from '@termhub/shared';

import { resolvePipeAddress } from './transport-address.js';
import { TransportServer } from './transport-server.js';
import type { TransportServerOptions } from './transport-server.js';

// The daemon's single-instance lock and its `daemon.json` bookkeeping —
// docs/specs/m1.8-single-instance.md, sections 3.1-3.2. This module is
// deliberately narrow: it owns exactly "win or lose the race, and if we
// won, persist what we won" (`startDaemon`), plus the small file-format
// helpers everything else (daemon-runtime.ts, cli.ts, index.ts, tests)
// needs to read/write/clean up that same file. Session lifecycle, the
// registry, and idle-shutdown wiring are `daemon-runtime.ts`'s job, layered
// on top of `startDaemon`'s result — kept separate so the race itself (the
// thing this spec is actually about) is testable as a small, self-contained
// unit, per section 4: "exponha a função de start ... com os defaults
// reais. Testes de corrida vão chamá-la duas vezes em paralelo."
//
// ## The one place this file's code order doesn't literally match section
// ## 3.2's numbered list, and why that's still safe
//
// Section 3.2 lists, in order, what happens *after* `listen()` resolves:
// "1. gerar o token; 2. escrever daemon.json; 3. registrar o serviço...".
// `TransportServerOptions.token` (transport-server.ts) is a required
// constructor parameter, though — there is no way to construct the
// `TransportServer` this function calls `listen()` on without already
// having a token value in hand. So in this implementation, token
// generation necessarily happens *before* `listen()` is even called, not
// after it resolves as step 1's position in the list might suggest.
//
// This does not reopen the failure mode section 2 describes. What matters
// there is that a *losing* process's token/pid never reaches disk — and
// generating an unused, never-persisted, never-advertised random token in
// memory for a server whose `listen()` is about to fail with `EADDRINUSE`
// is harmless: nothing reads it, nothing writes it anywhere, and the
// process exits with it discarded. The actual guarantee ("nada é escrito
// em disco antes de a corrida estar ganha") is enforced exactly as
// written: `writeDaemonJsonAtomic` below is only ever called after
// `server.listen()` has already resolved successfully.

/** Shape of `daemon.json`, written atomically in `%APPDATA%/TermHub/` (docs/specs/m1.8-single-instance.md section 3.2). */
export interface DaemonInfo {
  pid: number;
  pipe: string;
  token: string;
  protocolVersion: number;
  /** ISO-8601 timestamp of when this daemon instance won the lock. */
  startedAt: string;
}

/**
 * The exit code a losing daemon process uses (docs/specs/
 * m1.8-single-instance.md section 3.1): distinct from both success (`0`)
 * and a generic failure (`1`), specifically so a caller spawning this
 * process (M2.1's daemon-client.ts, out of scope here) can tell "another
 * daemon already owns this address, which is fine" apart from "this daemon
 * actually failed to start".
 */
export const ALREADY_RUNNING_EXIT_CODE = 3;

/**
 * Result of one `startDaemon()` call. `'already-running'` means this
 * process lost the race for the pipe — see `startDaemon`'s doc comment.
 * Beyond the `info`/`outcome` shape docs/specs/m1.8-single-instance.md
 * section 4 specifies, the `'started'` branch also carries the live
 * `server` this call just brought up: `daemon-runtime.ts` needs a handle to
 * it to register the session service and wire shutdown, and there is no
 * other way for a caller to get one (this function is the only thing that
 * constructs it). Everything the spec actually mandates about this type —
 * the two outcomes, and what `info` contains — is unchanged; this is an
 * addition, not a narrowing.
 */
export type StartResult =
  | { outcome: 'started'; info: DaemonInfo; server: TransportServer }
  | { outcome: 'already-running' };

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * `%APPDATA%/TermHub` on Windows (docs/plan.md section on state files),
 * matching `process.env.APPDATA` exactly rather than hardcoding
 * `<home>/AppData/Roaming` — same reasoning as `transport-address.ts`
 * leaning on `os.tmpdir()`: let the platform's own environment answer the
 * question instead of this project re-deriving it.
 *
 * Windows is this project's primary target (CLAUDE.md), but this code must
 * not hard-require it: `APPDATA` is only ever set on Windows, so anywhere
 * else (a contributor's Linux/macOS dev machine running this same test
 * suite, per CLAUDE.md's "não deve cravar nada Windows-only") falls back to
 * a dotfile directory under the home directory instead of throwing.
 */
function defaultAppDataDir(): string {
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData.length > 0) {
    return join(appData, 'TermHub');
  }
  return join(homedir(), '.termhub');
}

/** Real default path for `daemon.json` — `defaultAppDataDir()/daemon.json`. */
export function defaultDaemonJsonPath(): string {
  return join(defaultAppDataDir(), 'daemon.json');
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
 * can trigger this. It clears on its own within milliseconds once that
 * reader's `readFile` closes the handle, so a short bounded retry is the
 * right response — not surfacing it as a real write failure, and not
 * retrying forever either.
 */
const RENAME_RETRY_ATTEMPTS = 20;
const RENAME_RETRY_DELAY_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRenameError(err: unknown): boolean {
  return (
    isErrnoException(err) && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
  );
}

async function renameWithRetry(tmpPath: string, destPath: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(tmpPath, destPath);
      return;
    } catch (err) {
      if (attempt === RENAME_RETRY_ATTEMPTS || !isTransientRenameError(err)) {
        throw err;
      }
      await sleep(RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * Writes `info` to `path` atomically: a temporary file in the same
 * directory (so `rename` is a same-filesystem, single-syscall operation,
 * not a cross-device copy) written in full, then renamed over the
 * destination. Docs/specs/m1.8-single-instance.md section 3.2's own words:
 * "arquivo temporário no mesmo diretório e rename, nunca escrita direta no
 * destino" — a reader of `path` (a client resolving the daemon to connect
 * to) either sees the previous complete file or the new complete file,
 * never a truncated or half-written one, because it never observes the
 * temporary file at `path`'s name at all. See `renameWithRetry`'s doc
 * comment for the one Windows-specific wrinkle this needed on top of a
 * plain `rename`.
 */
async function writeDaemonJsonAtomic(path: string, info: DaemonInfo): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.daemon.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, JSON.stringify(info, null, 2), 'utf8');
  await renameWithRetry(tmpPath, path);
}

/**
 * Reads and parses `daemon.json` at `path`. Returns `undefined` for any
 * reason it can't produce a usable `DaemonInfo` — missing file, unreadable,
 * malformed JSON, or JSON that doesn't look like `DaemonInfo` — rather than
 * throwing: an orphaned or corrupted `daemon.json` (section 3.2's "o
 * daemon.json órfão") must never stop a new daemon from starting, and a
 * caller reading it to decide "connect or start" needs exactly this
 * "unusable = treat as absent" signal, not a caught exception at every call
 * site.
 */
export async function readDaemonInfo(path: string): Promise<DaemonInfo | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isDaemonInfo(parsed)) {
    return undefined;
  }
  return parsed;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof DaemonInfo, unknown>>;
  return (
    typeof candidate.pid === 'number' &&
    typeof candidate.pipe === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.protocolVersion === 'number' &&
    typeof candidate.startedAt === 'string'
  );
}

/**
 * Removes `daemon.json` at `path`, but only if it is still this process's —
 * i.e. only if the `pid` it currently contains matches `ownPid` (docs/specs/
 * m1.8-single-instance.md section 3.5's third cleanup step). A mismatch
 * means another daemon already won a later race and overwrote the file
 * (section 3.2), and removing its entry would be deleting a live daemon's
 * only advertised address — so this is a no-op instead. A missing/unusable
 * file (already gone, or never existed) is also a silent no-op: there is
 * nothing to clean up either way, and this runs from shutdown paths where
 * throwing over "it's already gone" would be actively unhelpful.
 */
export async function removeDaemonJsonIfOwnedByPid(path: string, ownPid: number): Promise<void> {
  const current = await readDaemonInfo(path);
  if (current === undefined || current.pid !== ownPid) {
    return;
  }
  try {
    await unlink(path);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}

export interface StartDaemonOptions {
  /** Pipe/socket address to listen on. Defaults to the real per-user `resolvePipeAddress()`. Tests should pass a unique address instead (see transport-address.ts's `suffix` option) — this is the parameter docs/specs/m1.8-single-instance.md section 4 asks this function to expose for that reason. */
  address?: string;
  /** Where to read/write `daemon.json`. Defaults to `defaultDaemonJsonPath()`. Tests should pass a unique path per run, for the same reason as `address`. */
  daemonJsonPath?: string;
  /** Protocol version this daemon speaks. Defaults to `PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Forwarded to `TransportServer`. Defaults to that class's own default. */
  handshakeTimeoutMs?: number;
}

/**
 * Attempts to become *the* daemon for `options.address` (or the real
 * per-user pipe address, by default): implements docs/specs/
 * m1.8-single-instance.md sections 3.1-3.2 exactly.
 *
 * The lock is `server.listen()` itself, not a check against `daemon.json` —
 * creating a named pipe (or, off Windows, a unix socket) with a name
 * already in use is atomic at the OS level, so at most one of any number of
 * concurrent callers targeting the same address can ever have its
 * `listen()` succeed. A caller whose `listen()` rejects with `EADDRINUSE`
 * lost the race: this resolves with `{ outcome: 'already-running' }` having
 * touched neither the filesystem nor anything else observable, exactly the
 * property that keeps a loser's token from ever clobbering a winner's
 * `daemon.json` (section 2's failure mode). Any other `listen()` error is a
 * real failure and propagates — this function only ever treats
 * `EADDRINUSE` specifically as "someone else won", never "listen() threw
 * for some reason, so assume that".
 *
 * On success, `daemon.json` is written atomically (`writeDaemonJsonAtomic`)
 * with a freshly generated token before this resolves — the daemon is not
 * considered "started" from any caller's perspective until that file is in
 * place with this instance's own pid/token/pipe.
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartResult> {
  const address = options.address ?? resolvePipeAddress();
  const daemonJsonPath = options.daemonJsonPath ?? defaultDaemonJsonPath();
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;

  // See this file's header comment for why the token is generated here,
  // before listen() is even attempted, rather than strictly after it
  // resolves: TransportServerOptions.token is required at construction
  // time, and nothing about this value is persisted or exposed unless and
  // until listen() below actually succeeds.
  const token = randomBytes(32).toString('hex');
  const serverOptions: TransportServerOptions = {
    token,
    address,
    protocolVersion,
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  };
  const server = new TransportServer(serverOptions);

  try {
    await server.listen();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EADDRINUSE') {
      return { outcome: 'already-running' };
    }
    throw err;
  }

  const info: DaemonInfo = {
    pid: process.pid,
    pipe: server.pipeAddress,
    token,
    protocolVersion: server.protocolVersion,
    startedAt: new Date().toISOString(),
  };
  await writeDaemonJsonAtomic(daemonJsonPath, info);

  return { outcome: 'started', info, server };
}

// Exported for daemon.test.ts's atomicity test (required test 5), which
// verifies the write goes through a temp-file-then-rename in the same
// directory rather than a direct write to `path` — the property that gives
// writeDaemonJsonAtomic its name.
export { writeDaemonJsonAtomic };
