import { describe, expect, it } from 'vitest';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionId, SessionSummary } from '@termhub/shared';

import { DEFAULT_TTL_MS, Graveyard, MAX_TTL_MS, MIN_TTL_MS, resolveTtlMs } from './graveyard.js';
import type { GraveyardClock } from './graveyard.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExit,
  SessionExitListener,
} from './session.js';
import type { SessionLike } from './registry.js';

// Pure unit tests for the M4.4 graveyard: no PTY, no transport, no registry.
// Every session is a FakeSession (same pattern registry.test.ts/
// service.test.ts already use for the same reason), and the clock is a hand
// -rolled fake — not `vi.useFakeTimers()` — because Graveyard's whole reason
// for taking an injectable `GraveyardClock` (see graveyard.ts's header
// comment) is to let a *different* test file (service.test.ts's real-PTY
// suite) fake only this module's timers while everything else in the
// process keeps running on real ones. Using the same fake clock idiom here
// too keeps both suites' Graveyard-facing behavior verified against the
// exact same clock contract.

class FakeSession implements SessionLike {
  private static nextPid = 51_000;

  readonly pid = FakeSession.nextPid++;
  private aliveFlag = true;
  private exitListeners: SessionExitListener[] = [];
  private dataListeners: SessionDataListener[] = [];

  killCalls = 0;

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  write(): void {
    // unused by these tests
  }

  resize(): void {
    // unused by these tests
  }

  kill(): void {
    this.killCalls += 1;
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: SessionDataListener): Disposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== listener);
      },
    };
  }

  onExit(listener: SessionExitListener): Disposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== listener);
      },
    };
  }

  /** Simulates the process dying on its own — safe to call more than once, mirroring `Session#kill`'s own idempotency (registry.test.ts's `FakeSession` does the same). */
  emitExit(exit: SessionExit): void {
    if (!this.aliveFlag) {
      return;
    }
    this.aliveFlag = false;
    for (const listener of this.exitListeners) {
      listener(exit);
    }
  }
}

interface FakeTimerHandle {
  id: number;
  dueAt: number;
  handler: () => void;
}

/**
 * A fully inert, hand-stepped clock: `now()` only changes when `advance()`
 * is told to change it, and a scheduled timer only fires when `advance()`
 * steps `now()` far enough to reach its deadline — never on its own, never
 * tied to real wall-clock time. This is what makes "restore before the TTL"
 * vs "restore after the TTL" (and the exact-same-tick race between the two)
 * assertable precisely instead of approximately.
 */
function createFakeClock(): {
  clock: GraveyardClock;
  now: () => number;
  advance: (ms: number) => void;
} {
  let currentTime = 0;
  let nextId = 1;
  const timers: FakeTimerHandle[] = [];

  const clock: GraveyardClock = {
    now: () => currentTime,
    setTimeout: (handler, ms) => {
      const handle: FakeTimerHandle = { id: nextId++, dueAt: currentTime + ms, handler };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      // `as`: every handle this fake clock's `clearTimeout` is ever called
      // with is one this same clock's `setTimeout` returned a moment
      // earlier — `Graveyard` never mixes handles across clock instances.
      const idx = timers.indexOf(handle as FakeTimerHandle);
      if (idx !== -1) {
        timers.splice(idx, 1);
      }
    },
  };

  function advance(ms: number): void {
    currentTime += ms;
    // Fire every timer whose deadline is now due, in the order they become
    // due — repeatedly, in case a firing handler itself calls back into
    // this clock (Graveyard's own timer handler doesn't schedule a new one,
    // but this loop stays correct regardless).
    for (;;) {
      const dueIdx = timers.findIndex((t) => t.dueAt <= currentTime);
      if (dueIdx === -1) {
        break;
      }
      const [due] = timers.splice(dueIdx, 1);
      due?.handler();
    }
  }

  return { clock, now: () => currentTime, advance };
}

function baseSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'agent-1',
    cwd: 'C:\\Users\\caiom\\project',
    shell: 'pwsh.exe',
    createdAt: 0,
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

describe('resolveTtlMs', () => {
  it('defaults to DEFAULT_TTL_MS when omitted', () => {
    expect(resolveTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
  });

  it('accepts an integer at the exact boundaries of [MIN_TTL_MS, MAX_TTL_MS]', () => {
    expect(resolveTtlMs(MIN_TTL_MS)).toBe(MIN_TTL_MS);
    expect(resolveTtlMs(MAX_TTL_MS)).toBe(MAX_TTL_MS);
  });

  it.each([
    ['below the minimum', MIN_TTL_MS - 1],
    ['above the maximum', MAX_TTL_MS + 1],
    ['zero', 0],
    ['negative', -1],
    ['not an integer', 60_500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s with INVALID_PARAMS', (_label, ttlMs) => {
    let thrown: unknown;
    try {
      resolveTtlMs(ttlMs);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.INVALID_PARAMS);
  });
});

describe('Graveyard', () => {
  it('bury() + list(): a buried session appears in list() with the right closedAt/expiresAt, and has() reports it', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    advance(5_000); // now() = 5000, so closedAt isn't coincidentally 0
    graveyard.bury(summary.id, session, summary, 120_000);

    expect(graveyard.has(summary.id)).toBe(true);
    expect(graveyard.size).toBe(1);

    const [entry] = graveyard.list();
    expect(entry).toBeDefined();
    expect(entry?.closedAt).toBe(5_000);
    expect(entry?.expiresAt).toBe(5_000 + 120_000);
    expect(entry?.session).toEqual(summary);
  });

  it('restore() before the TTL elapses hands back the live session and summary, and removes it from the graveyard', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    graveyard.bury(summary.id, session, summary, 120_000);
    advance(119_999); // one millisecond short of expiry

    const restored = graveyard.restore(summary.id);
    expect(restored).toBeDefined();
    expect(restored?.session).toBe(session);
    expect(restored?.summary).toEqual(summary);
    expect(session.killCalls).toBe(0); // restored, not killed

    expect(graveyard.has(summary.id)).toBe(false);
    expect(graveyard.list()).toEqual([]);

    // Advancing further does nothing: the timer was canceled by restore(),
    // not merely superseded.
    advance(1_000_000);
    expect(session.killCalls).toBe(0);
  });

  it('after the TTL elapses, kill() has been called on the session, and restore() then fails as session_not_found', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    graveyard.bury(summary.id, session, summary, 60_000);
    advance(60_000); // exactly at the deadline

    expect(session.killCalls).toBe(1);
    expect(graveyard.has(summary.id)).toBe(false);

    const restored = graveyard.restore(summary.id);
    expect(restored).toBeUndefined();
  });

  it('session.kill semantics: kill() on a buried session kills it immediately and returns true; on an unburied/unknown id it returns false without throwing', () => {
    const { clock } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    graveyard.bury(summary.id, session, summary, 120_000);

    expect(graveyard.kill(summary.id)).toBe(true);
    expect(session.killCalls).toBe(1);
    expect(graveyard.has(summary.id)).toBe(false);

    // Idempotent: killing again (or an id that was never buried) is a no-op.
    expect(graveyard.kill(summary.id)).toBe(false);
    expect(graveyard.kill(999_999)).toBe(false);
    expect(session.killCalls).toBe(1);
  });

  it('bury() is idempotent: closing an already-buried id again does not change its expiresAt or arm a second timer', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    graveyard.bury(summary.id, session, summary, 60_000);
    const [firstEntry] = graveyard.list();
    const originalExpiresAt = firstEntry?.expiresAt;

    advance(30_000);
    // Same id, a much longer ttl this time — must be ignored entirely.
    graveyard.bury(summary.id, session, summary, 86_400_000);

    const [secondEntry] = graveyard.list();
    expect(secondEntry?.expiresAt).toBe(originalExpiresAt);

    // The original 60s timer is still the one in effect: 30s already
    // elapsed, 30s more reaches the (unchanged) deadline.
    advance(30_000);
    expect(session.killCalls).toBe(1);
  });

  it('a session that exits on its own while buried is reported as exited (with exitCode) in list() and by restore(), and stays buried until the TTL', () => {
    const { clock } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const session = new FakeSession();
    const summary = baseSummary();

    graveyard.bury(summary.id, session, summary, 120_000);
    session.emitExit({ exitCode: 3, signal: 9 });

    expect(graveyard.has(summary.id)).toBe(true); // still buried, not removed
    const [entry] = graveyard.list();
    expect(entry?.session.status).toBe('exited');
    expect(entry?.session.exitCode).toBe(3);
    expect(entry?.session.signal).toBe(9);

    const restored = graveyard.restore(summary.id);
    expect(restored?.summary.status).toBe('exited');
    expect(restored?.summary.exitCode).toBe(3);
  });

  it('restore() racing the exact same tick as expiry: whichever runs first wins, and the other observes a clean "not buried" outcome without throwing', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const sessionA = new FakeSession();
    const summaryA = baseSummary({ id: 1 });
    const sessionB = new FakeSession();
    const summaryB = baseSummary({ id: 2 });

    graveyard.bury(summaryA.id, sessionA, summaryA, 60_000);
    graveyard.bury(summaryB.id, sessionB, summaryB, 60_000);

    // Case 1: restore() called before the clock ever reaches the deadline
    // (the restore "wins" the race) — expire() then simply finds nothing
    // left to do for this id, and must not throw.
    const restoredA = graveyard.restore(summaryA.id);
    expect(restoredA).toBeDefined();
    expect(() => advance(60_000)).not.toThrow();
    expect(sessionA.killCalls).toBe(0);

    // Case 2: the clock reaches the deadline first (expiry "wins") — a
    // restore attempted right after must fail cleanly, not throw.
    expect(sessionB.killCalls).toBe(1); // already expired by the advance() above
    expect(() => graveyard.restore(summaryB.id)).not.toThrow();
    expect(graveyard.restore(summaryB.id)).toBeUndefined();
  });

  it('onDeath fires exactly once per TTL expiry, once per explicit kill(), and NOT for restore()', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const deaths: SessionId[] = [];
    graveyard.onDeath((sessionId) => deaths.push(sessionId));

    const expiring = new FakeSession();
    const expiringSummary = baseSummary({ id: 1 });
    const killed = new FakeSession();
    const killedSummary = baseSummary({ id: 2 });
    const restored = new FakeSession();
    const restoredSummary = baseSummary({ id: 3 });

    graveyard.bury(expiringSummary.id, expiring, expiringSummary, 60_000);
    graveyard.bury(killedSummary.id, killed, killedSummary, 60_000);
    graveyard.bury(restoredSummary.id, restored, restoredSummary, 60_000);

    graveyard.restore(restoredSummary.id);
    graveyard.kill(killedSummary.id);
    advance(60_000);

    expect(deaths.sort()).toEqual([expiringSummary.id, killedSummary.id].sort());
  });

  it('a disposed onDeath listener stops receiving future deaths', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const deaths: SessionId[] = [];
    const sub = graveyard.onDeath((sessionId) => deaths.push(sessionId));

    const session = new FakeSession();
    const summary = baseSummary();
    graveyard.bury(summary.id, session, summary, 60_000);

    sub.dispose();
    advance(60_000);

    expect(deaths).toEqual([]);
    expect(session.killCalls).toBe(1); // the kill itself still happens — only the notification is unsubscribed
  });

  it('disposeAll() kills and removes every buried session, canceling their timers, and fires onDeath for each', () => {
    const { clock, advance } = createFakeClock();
    const graveyard = new Graveyard({ clock });
    const deaths: SessionId[] = [];
    graveyard.onDeath((sessionId) => deaths.push(sessionId));

    const sessions = [new FakeSession(), new FakeSession(), new FakeSession()];
    sessions.forEach((session, i) => {
      graveyard.bury(i, session, baseSummary({ id: i }), 60_000);
    });

    graveyard.disposeAll();

    expect(graveyard.size).toBe(0);
    expect(sessions.every((s) => s.killCalls === 1)).toBe(true);
    expect(deaths.sort()).toEqual([0, 1, 2]);

    // The canceled timers really were canceled, not just "already fired
    // early" — advancing well past the original deadline kills nothing a
    // second time.
    advance(1_000_000);
    expect(sessions.every((s) => s.killCalls === 1)).toBe(true);
  });
});
