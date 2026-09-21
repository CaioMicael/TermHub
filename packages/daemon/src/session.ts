import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';

// This is the only file in the daemon allowed to know `node-pty` exists.
// Every task that consumes sessions (registry, RPC, headless buffer — M1.4,
// M1.5, M1.6) talks to `Session` and the types below, never to `IPty`, so
// swapping the PTY backend later can never leak past this module.

/** Options to create a new pseudoterminal-backed session. */
export interface SessionOptions {
  /** Executable to launch (e.g. `pwsh.exe`, `cmd.exe`, `wsl.exe`). */
  shell: string;
  /** Arguments passed to `shell`. Defaults to no arguments. */
  args?: string[];
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment variables for the spawned process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Initial terminal width in columns. node-pty defaults to 80 when omitted. */
  cols?: number;
  /** Initial terminal height in rows. node-pty defaults to 24 when omitted. */
  rows?: number;
  /**
   * Force ConPTY on (`true`) or off (`false`) on Windows. Leave unset to let
   * node-pty decide: it enables ConPTY whenever the Windows build number is
   * >= 18309, which is every Windows 10/11 release this project supports.
   * Exposed mainly so tests can force a specific code path; production
   * callers should normally leave this unset. No effect off Windows.
   */
  useConpty?: boolean;
  /**
   * Whether the newly created pseudoconsole should inherit the cursor
   * position of the console it is attached to, instead of starting fresh at
   * (0, 0). Off by default: every session this wrapper creates gets a blank
   * screen rather than whatever happened to be on the parent console when it
   * was spawned. No effect off Windows or when ConPTY is disabled.
   */
  conptyInheritCursor?: boolean;
}

/** Payload delivered when the underlying process exits. */
export interface SessionExit {
  exitCode: number;
  /** POSIX signal number, when the process was terminated by one. Not set on Windows. */
  signal?: number;
}

/** Handle returned by `onData`/`onExit` to stop listening. */
export interface Disposable {
  dispose(): void;
}

export type SessionDataListener = (data: string) => void;
export type SessionExitListener = (exit: SessionExit) => void;

/**
 * A single terminal session backed by a native pseudoterminal.
 *
 * On Windows this spawns through ConPTY (see `SessionOptions.useConpty`).
 * `kill()` is the important part to get right there: closing a ConPTY does
 * not, by itself, guarantee every process attached to its console dies —
 * node-pty's Windows agent walks the console's process list and terminates
 * each PID individually specifically to avoid orphaned processes, which is
 * why this wrapper never bypasses `IPty.kill()` with something more direct.
 */
export class Session {
  private readonly pty: IPty;
  private alive = true;

  constructor(options: SessionOptions) {
    this.pty = spawnPty(options.shell, options.args ?? [], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      conptyInheritCursor: options.conptyInheritCursor ?? false,
      // Conditionally-spread so we never assign an explicit `undefined` to
      // an optional field typed without `| undefined` (exactOptionalPropertyTypes).
      ...(options.cols !== undefined ? { cols: options.cols } : {}),
      ...(options.rows !== undefined ? { rows: options.rows } : {}),
      ...(options.useConpty !== undefined ? { useConpty: options.useConpty } : {}),
    });

    this.pty.onExit(() => {
      this.alive = false;
    });
  }

  /** Process ID of the spawned shell. */
  get pid(): number {
    return this.pty.pid;
  }

  /** Whether the process is still running (false once `exit` has fired). */
  get isAlive(): boolean {
    return this.alive;
  }

  /** Writes data to the session's stdin. */
  write(data: string): void {
    this.pty.write(data);
  }

  /** Resizes the pseudoterminal. No-op-safe to call before the session is fully ready; node-pty queues it. */
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  /**
   * Terminates the session. Safe to call more than once or after the
   * process has already exited on its own — a no-op in that case, so
   * callers (e.g. graveyard TTL expiry in M4.4) don't need to track state
   * themselves before calling it.
   */
  kill(): void {
    if (!this.alive) {
      return;
    }
    this.pty.kill();
  }

  /** Subscribes to output. Returns a `Disposable` to stop listening. */
  onData(listener: SessionDataListener): Disposable {
    return this.pty.onData(listener);
  }

  /** Subscribes to the process exiting. Returns a `Disposable` to stop listening. */
  onExit(listener: SessionExitListener): Disposable {
    return this.pty.onExit(listener);
  }
}
