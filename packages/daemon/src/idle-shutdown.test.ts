import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startIdleShutdown } from './idle-shutdown.js';
import type { IdleShutdownController } from './idle-shutdown.js';

// Required test 6 (docs/specs/m1.8-single-instance.md section 5): a live
// session keeps the daemon up even with zero clients connected — that's the
// entire premise of the product (closing every window must never kill the
// user's agents) — while zero clients AND zero sessions together must lead
// to shutdown after the configured idle timeout. Driven entirely with fake
// timers, per the task's own instruction, so the timeout boundary is
// asserted exactly rather than approximated with a real sleep.

let controllers: IdleShutdownController[];

beforeEach(() => {
  vi.useFakeTimers();
  controllers = [];
});

afterEach(() => {
  for (const controller of controllers) {
    controller.dispose();
  }
  vi.useRealTimers();
});

function track(controller: IdleShutdownController): IdleShutdownController {
  controllers.push(controller);
  return controller;
}

describe('startIdleShutdown', () => {
  it('never fires while a session is alive, even with zero clients, no matter how long — the exact scenario the whole daemon exists to protect', () => {
    let idleFired = 0;

    track(
      startIdleShutdown({
        hasClients: () => false,
        hasLiveSessions: () => true, // a session is alive; nobody is connected to it
        onIdleTimeout: () => {
          idleFired += 1;
        },
        idleTimeoutMs: 10_000,
        checkIntervalMs: 500,
      }),
    );

    // Advance well past several multiples of the idle timeout — a live
    // session must hold the daemon up indefinitely, not just past one
    // timeout window.
    vi.advanceTimersByTime(10_000 * 5);
    expect(idleFired).toBe(0);
  });

  it('fires after idleTimeoutMs once both zero clients and zero live sessions hold true', () => {
    let idleFired = 0;

    track(
      startIdleShutdown({
        hasClients: () => false,
        hasLiveSessions: () => false,
        onIdleTimeout: () => {
          idleFired += 1;
        },
        idleTimeoutMs: 10_000,
        checkIntervalMs: 500,
      }),
    );

    // Not yet — only just under the timeout has elapsed.
    vi.advanceTimersByTime(9_000);
    expect(idleFired).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(idleFired).toBe(1);

    // Never fires a second time on its own.
    vi.advanceTimersByTime(60_000);
    expect(idleFired).toBe(1);
  });

  it('a session going from alive to exited starts the countdown from that point, not from construction', () => {
    let hasLiveSessions = true;
    let idleFired = 0;

    track(
      startIdleShutdown({
        hasClients: () => false,
        hasLiveSessions: () => hasLiveSessions,
        onIdleTimeout: () => {
          idleFired += 1;
        },
        idleTimeoutMs: 10_000,
        checkIntervalMs: 500,
      }),
    );

    // Sits idle-except-for-the-session for a long time first.
    vi.advanceTimersByTime(60_000);
    expect(idleFired).toBe(0);

    // The session exits.
    hasLiveSessions = false;
    // Not yet fired immediately — the poller only notices on its next
    // check, and the full idleTimeoutMs must elapse from there.
    vi.advanceTimersByTime(500); // one poll tick: notices idle, arms the timer
    expect(idleFired).toBe(0);
    vi.advanceTimersByTime(9_000);
    expect(idleFired).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(idleFired).toBe(1);
  });

  it('a client connecting cancels an already-armed timer, and disconnecting re-arms it from zero', () => {
    let hasClients = false;
    let idleFired = 0;

    track(
      startIdleShutdown({
        hasClients: () => hasClients,
        hasLiveSessions: () => false,
        onIdleTimeout: () => {
          idleFired += 1;
        },
        idleTimeoutMs: 10_000,
        checkIntervalMs: 500,
      }),
    );

    // Idle timer arms immediately (zero clients, zero sessions from the
    // start). Let it run most of the way down...
    vi.advanceTimersByTime(9_000);
    expect(idleFired).toBe(0);

    // ...then a client connects, canceling it.
    hasClients = true;
    vi.advanceTimersByTime(500); // one poll tick to notice
    // Even after well past what would have been the original deadline, it
    // must not fire: the timer was canceled, not merely paused.
    vi.advanceTimersByTime(60_000);
    expect(idleFired).toBe(0);

    // The client disconnects — the countdown must restart from zero, not
    // resume from where it left off.
    hasClients = false;
    vi.advanceTimersByTime(9_500); // one tick short of a fresh 10s from here
    expect(idleFired).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(idleFired).toBe(1);
  });

  it('dispose() stops the poller and cancels a pending timer — onIdleTimeout is never called after', () => {
    let idleFired = 0;
    const controller = startIdleShutdown({
      hasClients: () => false,
      hasLiveSessions: () => false,
      onIdleTimeout: () => {
        idleFired += 1;
      },
      idleTimeoutMs: 10_000,
      checkIntervalMs: 500,
    });

    vi.advanceTimersByTime(5_000);
    controller.dispose();
    vi.advanceTimersByTime(60_000);
    expect(idleFired).toBe(0);

    // Idempotent.
    expect(() => controller.dispose()).not.toThrow();
  });
});
