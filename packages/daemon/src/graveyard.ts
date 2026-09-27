import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionId, SessionSummary } from '@termhub/shared';

import type { SessionLike } from './registry.js';
import type { Disposable, SessionExit } from './session.js';

// M4.4: what `session.close` moves a session INTO instead of killing it
// outright. A buried session keeps its real PTY (or `SessionLike` fake, in
// tests) and whatever `TerminalBuffer` is already mirroring its output —
// this module owns neither of those, only the bookkeeping of "which ids are
// buried, since when, until when, and what to do once the TTL elapses" (see
// `docs/milestones.md` M4.4 and this task's final report for the full
// division of labor with `service.ts`/`registry.ts`).
//
// Deliberately independent of node-pty, the registry, and the wire protocol
// service (service.ts): everything this module needs from a buried
// session is the same narrow `SessionLike` surface `registry.ts` already
// depends on (`kill()`, `onExit()`), so this whole module is testable with a
// fake session and a fake clock, no PTY, no transport, no registry.
//
// ## Clock and timers are constructor-injected, not global
//
// `startIdleShutdown` (idle-shutdown.ts, M1.8) gets away with plain global
// `setInterval`/`setTimeout` because every one of its own tests drives it
// with `vi.useFakeTimers()`. That doesn't work here: this module's own
// intended real-PTY test (service.test.ts, M4.4) needs a *real* shell
// process's *real*, asynchronous I/O to keep flowing on the real event loop
// while this module's own TTL is made to elapse "instantly" for the test —
// globally faking every timer in the process would also freeze the retry/
// poll timers the transport and `waitFor`-style test helpers depend on.
// `GraveyardClock` below is how a caller gets that independence: production
// gets the real `Date.now`/`setTimeout`/`clearTimeout` (`systemClock`), a
// unit test gets a fully inert fake it steps by hand, and a real-PTY test
// gets a fake clock too but leaves every *other* timer in the process alone.

/** Minimum accepted `ttlMs`: 1 minute. Below this the "cemitério" concept stops meaning anything — a session would die about as fast as an outright `session.kill()`. */
export const MIN_TTL_MS = 60_000;

/** Maximum accepted `ttlMs`: 24 hours. Keeps a forgotten buried session from pinning a real PTY (and its `TerminalBuffer`'s scrollback) alive indefinitely. */
export const MAX_TTL_MS = 86_400_000;

/** Default `ttlMs` when `session.close` omits it: 10 minutes, per `docs/plan.md`. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Validates (and defaults) a `session.close` request's optional `ttlMs`,
 * returning the value to actually use. Throws `ProtocolError(INVALID_PARAMS)`
 * — the same code every other request-parameter validation failure in this
 * daemon uses (protocol.ts's own doc comment on `INVALID_PARAMS`) — for
 * anything that isn't an integer in `[MIN_TTL_MS, MAX_TTL_MS]`. Exported so
 * `service.ts`'s `session.close` handler can validate up front, before ever
 * touching the registry, and so graveyard.test.ts can assert the exact
 * rejection independently of any RPC plumbing.
 */
export function resolveTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) {
    return DEFAULT_TTL_MS;
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODE.INVALID_PARAMS,
      `ttlMs must be an integer in [${MIN_TTL_MS}, ${MAX_TTL_MS}], got ${JSON.stringify(ttlMs)}`,
    );
  }
  return ttlMs;
}

/**
 * The clock/timer primitives `Graveyard` needs, factored out so a caller can
 * substitute a fake one. `setTimeout`/`clearTimeout`'s handle type is
 * deliberately `unknown` on this interface (not `NodeJS.Timeout`): the only
 * contract is "whatever `setTimeout` returns is later handed back to
 * `clearTimeout` verbatim, and nothing else"; a fake implementation is free
 * to return anything it likes (see graveyard.test.ts's own fake clock) —
 * `Graveyard` itself never inspects a handle, only stores and replays it.
 */
export interface GraveyardClock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Schedules `handler` to run after `ms` milliseconds; returns an opaque handle for `clearTimeout`. */
  setTimeout(handler: () => void, ms: number): unknown;
  /** Cancels a timer previously returned by this same clock's `setTimeout`. Safe to call on an already-fired or already-cleared handle (mirrors the global `clearTimeout`'s own tolerance). */
  clearTimeout(handle: unknown): void;
}

const systemClock: GraveyardClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    // `as`: `handle` here is always exactly what this same `setTimeout`
    // returned a moment ago (a real `NodeJS.Timeout`) — `Graveyard` never
    // hands a `systemClock` handle to any other clock's `clearTimeout`, or
    // vice versa.
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** One `graveyard.list()` entry — the exact wire shape `GraveyardListResult.entries` (protocol.ts) promises. */
export interface BuriedSessionEntry {
  session: SessionSummary;
  /** Epoch milliseconds `session.close` buried this session at. */
  closedAt: number;
  /** Epoch milliseconds this session's PTY is killed for good, absent a `session.restore` before then. */
  expiresAt: number;
}

/** A listener registered via `Graveyard#onDeath` — see that method's doc comment. */
export type GraveyardDeathListener = (sessionId: SessionId, summary: SessionSummary) => void;

export interface GraveyardOptions {
  /** Defaults to the real system clock (`Date.now`/`setTimeout`/`clearTimeout`). Override in tests — see this module's header comment. */
  clock?: GraveyardClock;
}

interface InternalEntry {
  session: SessionLike;
  summary: SessionSummary;
  exit?: SessionExit;
  closedAt: number;
  expiresAt: number;
  timer: unknown;
  exitSub: Disposable;
}

/** Merges `entry`'s tracked exit (if the process died while buried) into the summary `graveyard.list()`/`session.restore` hand back — same "merge at the point of serialization" convention `service.ts`'s own `listWithExit` uses for `registry.list()`, kept independent here since this module doesn't depend on `registry.ts`. */
function summaryWithExit(entry: InternalEntry): SessionSummary {
  if (entry.exit === undefined) {
    return entry.summary;
  }
  return {
    ...entry.summary,
    exitCode: entry.exit.exitCode,
    ...(entry.exit.signal !== undefined ? { signal: entry.exit.signal } : {}),
  };
}

/**
 * The M4.4 "cemitério de sessões": sessions `session.close` moved here
 * instead of killing, kept alive and observable until either
 * `session.restore`s them back out or their TTL elapses on its own.
 *
 * Every mutating method here (`bury`/`restore`/`kill`) is synchronous and
 * side-effect-complete before it returns — no `await` anywhere in this
 * class — which is what makes the "restore races the TTL timer" case
 * (docs/milestones.md's own named pitfall for this task) resolve
 * deterministically instead of needing a lock: whichever call a test (or,
 * in production, whichever event the real event loop delivers first)
 * actually invokes first simply wins, because nothing can interleave with a
 * synchronous method body. The loser sees the map entry the winner already
 * removed and returns its own well-defined "not buried" outcome — `restore`
 * returns `undefined`, `kill` returns `false` — never throwing.
 */
export class Graveyard {
  private readonly clock: GraveyardClock;
  private readonly entries = new Map<SessionId, InternalEntry>();
  private deathListeners: GraveyardDeathListener[] = [];

  constructor(options: GraveyardOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  /** Whether `sessionId` is currently buried (not restored, killed, or expired). */
  has(sessionId: SessionId): boolean {
    return this.entries.has(sessionId);
  }

  /** How many sessions are currently buried. `idle-shutdown.ts` (via `service.ts`'s `SessionService.hasBuriedSessions`) reads this to keep the daemon up while it's non-zero. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Buries `session` (already removed from wherever it was live — the
   * registry, in production) under `sessionId`, for `ttlMs` (defaults to
   * `DEFAULT_TTL_MS`, validated the same way `resolveTtlMs` validates a
   * `session.close` request).
   *
   * Idempotent: burying an id that's already buried is a no-op that leaves
   * the existing entry's `closedAt`/`expiresAt`/timer completely untouched —
   * "fechar uma sessão que já está no cemitério não muda o expiresAt dela"
   * (docs/milestones.md M4.4). The caller (service.ts) is expected to check
   * `has()` first if it needs to know whether this call actually did
   * anything (e.g. to decide whether to even call this at all) — `bury`
   * itself doesn't report that back, matching `registry.close()`'s own
   * "idempotent, no signal either way" precedent.
   *
   * Subscribes to `session.onExit` so `list()`/`restore()` keep reporting an
   * accurate `status`/`exitCode` if the process dies on its own while
   * buried (docs/milestones.md: "continua no cemitério até o TTL, com
   * status exited, e ainda pode ser restaurada").
   */
  bury(sessionId: SessionId, session: SessionLike, summary: SessionSummary, ttlMs?: number): void {
    if (this.entries.has(sessionId)) {
      return;
    }
    const resolvedTtl = resolveTtlMs(ttlMs);
    const closedAt = this.clock.now();
    const expiresAt = closedAt + resolvedTtl;

    const exitSub = session.onExit((exit) => {
      const current = this.entries.get(sessionId);
      if (current === undefined) {
        return; // already restored/killed/expired — nothing left to update
      }
      current.exit = exit;
      current.summary = { ...current.summary, status: 'exited' };
    });

    const timer = this.clock.setTimeout(() => {
      this.expire(sessionId);
    }, resolvedTtl);

    this.entries.set(sessionId, { session, summary, closedAt, expiresAt, timer, exitSub });
  }

  /**
   * Removes `sessionId` from the graveyard and hands back its live session
   * handle plus up-to-date summary (reflecting any exit that happened while
   * buried), for the caller (service.ts, via `registry.reinstate`) to make
   * live again. Cancels the pending expiry timer and unsubscribes the exit
   * listener first — this call, not the timer, is now responsible for the
   * session.
   *
   * Returns `undefined` if `sessionId` isn't buried: never was, already
   * restored, already killed, or already expired. `service.ts`'s
   * `session.restore` handler turns that into the `session_not_found`
   * `ProtocolError` the wire protocol promises.
   */
  restore(sessionId: SessionId): { session: SessionLike; summary: SessionSummary } | undefined {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(sessionId);
    this.clock.clearTimeout(entry.timer);
    entry.exitSub.dispose();
    return { session: entry.session, summary: summaryWithExit(entry) };
  }

  /**
   * Kills `sessionId`'s session right now if it's buried: cancels the timer,
   * unsubscribes the exit listener, calls `session.kill()` (a no-op if the
   * process already exited on its own — same `Session#kill` idempotency
   * `registry.close()` already relies on), removes the entry, and notifies
   * `onDeath` listeners. Returns `true` if there was anything to kill,
   * `false` if `sessionId` wasn't buried — the caller (`session.kill`'s
   * handler in service.ts) uses that to decide whether to *also* try
   * `registry.close()` for a still-live (never-buried) session.
   */
  kill(sessionId: SessionId): boolean {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      return false;
    }
    this.remove(sessionId, entry);
    return true;
  }

  /** Every currently buried entry's `graveyard.list()` wire shape, in no particular guaranteed order. */
  list(): BuriedSessionEntry[] {
    return Array.from(this.entries.values(), (entry) => ({
      session: summaryWithExit(entry),
      closedAt: entry.closedAt,
      expiresAt: entry.expiresAt,
    }));
  }

  /**
   * Kills and permanently removes every currently buried session, canceling
   * every pending TTL timer — what the daemon's own shutdown
   * (daemon-runtime.ts) does to this graveyard, mirroring what it already
   * does to every still-live session in the registry. Each removal fires
   * `onDeath` exactly like an individual `kill()`/TTL expiry would, so a
   * caller relying on that (service.ts, to dispose each session's
   * `TerminalBuffer`) doesn't need a separate code path for shutdown.
   */
  disposeAll(): void {
    for (const sessionId of Array.from(this.entries.keys())) {
      this.kill(sessionId);
    }
  }

  /**
   * Registers a listener called once, synchronously, every time a buried
   * session is actually killed and permanently removed — by TTL expiry, an
   * explicit `kill()`, or `disposeAll()` at shutdown. Never called for
   * `restore()`, since the session keeps running there, now owned by
   * whoever called `restore()` (the registry, in production) instead of
   * this graveyard.
   *
   * This is the seam `service.ts` uses to dispose whatever it still owns
   * for that session — the `TerminalBuffer`, the delivery subscription —
   * which this module knows nothing about and must not reach into
   * directly. Kept as a subscribable event (rather than a single
   * constructor-only callback) specifically so a caller can construct a
   * `Graveyard` with a test clock first and wire the real cleanup callback
   * in afterward, instead of having to know it up front.
   */
  onDeath(listener: GraveyardDeathListener): Disposable {
    this.deathListeners.push(listener);
    return {
      dispose: () => {
        this.deathListeners = this.deathListeners.filter((l) => l !== listener);
      },
    };
  }

  private remove(sessionId: SessionId, entry: InternalEntry): void {
    this.entries.delete(sessionId);
    this.clock.clearTimeout(entry.timer);
    entry.exitSub.dispose();
    entry.session.kill();
    const finalSummary = summaryWithExit(entry);
    for (const listener of this.deathListeners) {
      listener(sessionId, finalSummary);
    }
  }

  private expire(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      // Only reachable if something else removed this entry without going
      // through this class's own `clock.clearTimeout` call — i.e. never, in
      // this implementation, since `restore()`/`kill()` always cancel the
      // timer before returning. Guarded anyway rather than assumed, so a
      // stray fake-clock bug in a test fires this harmlessly instead of
      // throwing into `setTimeout`'s own caller.
      return;
    }
    this.remove(sessionId, entry);
  }
}
