import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionCreateParams, SessionId, SessionSummary } from '@termhub/shared';

import { Session } from './session.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExit,
  SessionExitListener,
  SessionOptions,
} from './session.js';

// Owns the lifecycle and metadata of the daemon's live sessions: create,
// look up, list, close. It does not touch the transport/RPC layer
// (packages/daemon/transport.ts, M1.2/M1.5), does not buffer PTY output for
// replay (M1.6), and does not detect "running"/"awaiting-input"/"idle"
// (M5's status-detector) — as far as this module is concerned a session is
// only ever "running" or "exited". It also does not implement a
// close-with-TTL graveyard (M4.4): `close()` removes the session outright,
// see that method's doc comment for why that's still safe to build on top
// of later.

/**
 * The subset of `Session`'s (./session.ts, M1.3) public surface the registry
 * actually needs. Deliberately a structural interface rather than typing the
 * factory as `(options: SessionOptions) => Session` directly: `Session` has
 * private fields, so TypeScript treats it *nominally* — a plain fake object
 * that implements every public member would still be rejected where a
 * `Session` is required. Keeping the registry's dependency on this narrower,
 * structural type is what lets tests inject a fake session (see
 * registry.test.ts) instead of spawning real shells through node-pty, which
 * is exactly the slow/flaky "testing the wrong thing" trap M1.3's own test
 * suite already exists to cover.
 */
export interface SessionLike {
  readonly pid: number;
  readonly isAlive: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: SessionDataListener): Disposable;
  onExit(listener: SessionExitListener): Disposable;
}

/**
 * Creates the underlying session for a given `SessionCreateParams`. Injected
 * as a `Registry` constructor dependency (default: a real `Session`) so the
 * registry's tests are fast and deterministic instead of spawning dozens of
 * `pwsh.exe` processes.
 */
export type SessionFactory = (options: SessionOptions) => SessionLike;

function defaultSessionFactory(options: SessionOptions): SessionLike {
  return new Session(options);
}

/**
 * `Registry#get`'s result: the metadata snapshot plus the live handle, in
 * one lookup. Nothing in M1.4 needs the handle — the RPC layer wiring
 * `session.write`/`session.resize` to an actual PTY is M1.5 — but `get` is
 * the only per-session lookup this module exposes, and there is no reason
 * to make that future caller re-derive a second map just to reach the
 * session it already asked for by id.
 */
export interface RegisteredSession {
  readonly summary: SessionSummary;
  readonly session: SessionLike;
  /**
   * Present once the session has exited, `undefined` while still alive.
   * Mirrors `Session#onExit`'s payload; kept out of `summary` because
   * `SessionSummary` (packages/shared/src/protocol.ts) — the wire shape
   * used by `session.create`/`session.list` — has no slot for it. See this
   * task's final report for why that looks like a gap worth a follow-up in
   * M1.1's types.
   */
  readonly exit?: SessionExit;
}

/** uint32 max — the ceiling `SessionId` (packages/shared/src/protocol.ts) is allowed to reach, since the same id is encoded as a `uint32` in a binary data frame. */
const MAX_SESSION_ID = 0xffffffff;

export interface RegistryOptions {
  /** Defaults to spawning a real `Session`. Override in tests with a fake — see `SessionFactory`'s doc comment. */
  sessionFactory?: SessionFactory;
  /**
   * The id `create()` hands out first; each subsequent call increments by
   * one. Defaults to 1 (0 is left unused as a harmless "no session" sentinel
   * value for callers, not because the protocol requires it). Exposed
   * mainly so tests can drive the registry right up against
   * `MAX_SESSION_ID` without first creating a few billion sessions.
   */
  startId?: SessionId;
}

interface InternalRecord {
  session: SessionLike;
  summary: SessionSummary;
  exit?: SessionExit;
}

/**
 * Registers and tracks the daemon's live sessions. One `Registry` instance
 * is meant to live for the daemon process's whole lifetime (see M1.8).
 */
export class Registry {
  private readonly sessionFactory: SessionFactory;
  private readonly sessions = new Map<SessionId, InternalRecord>();
  private nextId: SessionId;

  constructor(options: RegistryOptions = {}) {
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.nextId = options.startId ?? 1;
  }

  /**
   * Spawns a new session through the injected factory, registers it, and
   * returns its summary.
   *
   * Throws `ProtocolError(INTERNAL_ERROR)` — without calling the factory, so
   * nothing is spawned — if handing out the next id would exceed
   * `MAX_SESSION_ID`. The id counter is monotonic and never reused
   * (`close()` never gives its id back), so this is a real, if distant,
   * failure mode rather than dead code: silently wrapping back to a
   * previously-issued id would let a new session collide with a stale
   * reference to an old one on the wire, which is worse than a loud error.
   */
  create(params: SessionCreateParams): SessionSummary {
    if (this.nextId > MAX_SESSION_ID) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODE.INTERNAL_ERROR,
        `session id space exhausted: next id would exceed the uint32 range (max ${MAX_SESSION_ID})`,
      );
    }
    const id = this.nextId;
    this.nextId += 1;

    const sessionOptions: SessionOptions = {
      shell: params.shell,
      cwd: params.cwd,
      cols: params.cols,
      rows: params.rows,
      // Conditionally-spread so we never assign an explicit `undefined` to
      // an optional field typed without `| undefined` (exactOptionalPropertyTypes).
      ...(params.args !== undefined ? { args: params.args } : {}),
      ...(params.env !== undefined ? { env: params.env } : {}),
    };
    const session = this.sessionFactory(sessionOptions);

    const summary: SessionSummary = {
      id,
      name: params.name ?? params.shell,
      cwd: params.cwd,
      shell: params.shell,
      createdAt: Date.now(),
      cols: params.cols,
      rows: params.rows,
      status: 'running',
      ...(params.tag !== undefined ? { tag: params.tag } : {}),
      ...(params.command !== undefined ? { command: params.command } : {}),
    };

    const record: InternalRecord = { session, summary };
    this.sessions.set(id, record);

    // The registry marks a session exited on its own — nobody needs to poll
    // the OS to find out a shell died. This stays registered (not removed)
    // so a caller who never asked for `close()` can still observe that it
    // died and how; only an explicit `close()` call removes the record.
    session.onExit((exit) => {
      record.exit = exit;
      record.summary = { ...record.summary, status: 'exited' };
    });

    return summary;
  }

  /** Looks up a session by id. Returns `undefined` if it was never created, or was `close()`d. */
  get(id: SessionId): RegisteredSession | undefined {
    const record = this.sessions.get(id);
    if (record === undefined) {
      return undefined;
    }
    return {
      summary: record.summary,
      session: record.session,
      ...(record.exit !== undefined ? { exit: record.exit } : {}),
    };
  }

  /** Summaries of every currently-registered session (alive or exited-but-not-yet-closed), in creation order. */
  list(): SessionSummary[] {
    return Array.from(this.sessions.values(), (record) => record.summary);
  }

  /**
   * Closes a session: kills the process if it's still alive (a no-op if it
   * already exited on its own — `Session#kill` already guarantees that,
   * see session.ts) and removes it from the registry.
   *
   * Idempotent: closing an id that's unknown — never created, or already
   * `close()`d — is a no-op, not an error. That covers both "call it twice"
   * and "the session died on its own and we're closing it anyway" without
   * the caller needing to check first.
   *
   * Removing the record outright (rather than flipping a flag and keeping
   * it around) is a deliberate M1.4-scoped choice, not a constraint for
   * later: `session.close`'s future graveyard/TTL behavior (M4.4) can be
   * layered in front of this by moving the record to a separate store
   * before it would otherwise be deleted, without this method's contract
   * (idempotent, id never reused) having to change.
   */
  close(id: SessionId): void {
    const record = this.sessions.get(id);
    if (record === undefined) {
      return;
    }
    record.session.kill();
    this.sessions.delete(id);
  }
}
