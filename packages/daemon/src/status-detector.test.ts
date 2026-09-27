import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionStatus } from '@termhub/shared';

import {
  DEFAULT_QUIET_MS,
  ECHO_WINDOW_MS,
  RESIZE_WINDOW_MS,
  StatusDetector,
} from './status-detector.js';
import type { StatusListener } from './status-detector.js';
import type { TerminalSignal } from './osc-parser.js';

// Pure unit tests for the M5.2 status detector: no PTY, no parser — signals
// are handed in as `TerminalSignal[]` literals directly, exactly as
// `docs/specs/m5.2-status-detector.md` section 5 requires. Vitest's fake
// timers stand in for the global `Date.now`/`setTimeout`/`clearTimeout` the
// detector itself uses (status-detector.ts has no injectable clock, unlike
// graveyard.ts — see that file's own header comment for why a second clock
// seam isn't needed here).

const bell: TerminalSignal = { kind: 'bell' };
const notification: TerminalSignal = {
  kind: 'notification',
  source: 'osc9',
  title: null,
  body: 'done',
};
const title: TerminalSignal = { kind: 'title', title: 'working…' };
function mark(m: 'A' | 'B' | 'C' | 'D'): TerminalSignal {
  return { kind: 'shell-mark', mark: m, exitCode: m === 'D' ? 0 : null };
}

/** Records every `onChange` transition as `[status, since]`, for assertions that need the full sequence rather than just the final status. */
function recordChanges(detector: StatusDetector): Array<[SessionStatus, number]> {
  const changes: Array<[SessionStatus, number]> = [];
  detector.onChange((status, since) => {
    changes.push([status, since]);
  });
  return changes;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatusDetector — each edge (test 1)', () => {
  it('freshly constructed, no calls: leaves running at quietMs', () => {
    const detector = new StatusDetector({ agent: true });
    const changes = recordChanges(detector);

    vi.advanceTimersByTime(DEFAULT_QUIET_MS - 1);
    expect(changes).toEqual([]);
    expect(detector.status).toBe('running');

    vi.advanceTimersByTime(1);
    expect(changes).toEqual([['awaiting-input', DEFAULT_QUIET_MS]]);
  });

  it('running -> awaiting-input by silence, agent: true, exactly at quietMs', () => {
    const detector = new StatusDetector({ agent: true, quietMs: 1_000 });
    const changes = recordChanges(detector);

    vi.advanceTimersByTime(999);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([['awaiting-input', 1_000]]);
  });

  it('running -> idle by silence, agent: false', () => {
    const detector = new StatusDetector({ agent: false, quietMs: 1_000 });
    const changes = recordChanges(detector);

    vi.advanceTimersByTime(1_000);
    expect(changes).toEqual([['idle', 1_000]]);
  });

  it('running -> awaiting-input, sticky, by bell and by notification', () => {
    const bellDetector = new StatusDetector({ agent: true });
    const bellChanges = recordChanges(bellDetector);
    vi.setSystemTime(100);
    bellDetector.onOutput([bell]);
    expect(bellChanges).toEqual([['awaiting-input', 100]]);

    const notifDetector = new StatusDetector({ agent: true });
    const notifChanges = recordChanges(notifDetector);
    vi.setSystemTime(200);
    notifDetector.onOutput([notification]);
    expect(notifChanges).toEqual([['awaiting-input', 200]]);
  });

  it.each([['A'], ['B'], ['D']] as const)('running -> idle by mark %s', (m) => {
    const detector = new StatusDetector({ agent: true });
    const changes = recordChanges(detector);
    vi.setSystemTime(50);
    detector.onOutput([mark(m)]);
    expect(changes).toEqual([['idle', 50]]);
  });

  it('idle -> running by output', () => {
    const detector = new StatusDetector({ agent: true });
    detector.onOutput([mark('A')]); // -> idle
    const changes = recordChanges(detector);
    vi.setSystemTime(500);
    detector.onOutput([{ kind: 'title', title: 'x' }]);
    expect(changes).toEqual([['running', 500]]);
  });

  it('idle -> awaiting-input by bell', () => {
    const detector = new StatusDetector({ agent: true });
    detector.onOutput([mark('A')]); // -> idle
    const changes = recordChanges(detector);
    vi.setSystemTime(500);
    detector.onOutput([bell]);
    expect(changes).toEqual([['awaiting-input', 500]]);
  });

  it('awaiting-input (by silence) -> running by output', () => {
    const detector = new StatusDetector({ agent: true, quietMs: 1_000 });
    vi.advanceTimersByTime(1_000); // -> awaiting-input, not sticky
    expect(detector.status).toBe('awaiting-input');
    const changes = recordChanges(detector);
    vi.setSystemTime(2_000);
    detector.onOutput([title]);
    expect(changes).toEqual([['running', 2_000]]);
  });

  it('sticky awaiting-input: stays on output; -> running on mark C; -> idle on mark A', () => {
    // Branch 1: stays on plain output.
    const stay = new StatusDetector({ agent: true });
    stay.onOutput([bell]);
    const stayChanges = recordChanges(stay);
    vi.setSystemTime(1_000);
    stay.onOutput([title]);
    expect(stayChanges).toEqual([]);
    expect(stay.status).toBe('awaiting-input');

    // Branch 2: mark C wins over stickiness -> running.
    const toRunning = new StatusDetector({ agent: true });
    toRunning.onOutput([bell]);
    const toRunningChanges = recordChanges(toRunning);
    vi.setSystemTime(1_000);
    toRunning.onOutput([mark('C')]);
    expect(toRunningChanges).toEqual([['running', 1_000]]);

    // Branch 3: mark A wins over stickiness -> idle.
    const toIdle = new StatusDetector({ agent: true });
    toIdle.onOutput([bell]);
    const toIdleChanges = recordChanges(toIdle);
    vi.setSystemTime(1_000);
    toIdle.onOutput([mark('A')]);
    expect(toIdleChanges).toEqual([['idle', 1_000]]);
  });

  it('sticky awaiting-input -> onInput -> stays -> output after the echo window -> running', () => {
    const detector = new StatusDetector({ agent: true });
    detector.onOutput([bell]); // -> awaiting-input, sticky
    const changes = recordChanges(detector);

    vi.setSystemTime(100);
    detector.onInput();
    detector.onOutput([title]); // inside echo window: ignored
    expect(changes).toEqual([]);
    expect(detector.status).toBe('awaiting-input');

    vi.setSystemTime(100 + ECHO_WINDOW_MS);
    detector.onOutput([title]); // exactly at the edge still counts as inside window? verify boundary explicitly below.
    // At now == echoUntil, echo has elapsed (echoUntil = 100 + ECHO_WINDOW_MS,
    // "now < echoUntil" is false), so this output already counts.
    expect(changes).toEqual([['running', 100 + ECHO_WINDOW_MS]]);
  });

  it('any state -> exited, and afterwards no call changes anything or fires onChange', () => {
    const detector = new StatusDetector({ agent: true });
    detector.onOutput([mark('A')]); // -> idle
    const changes = recordChanges(detector);

    vi.setSystemTime(999);
    detector.onExit();
    expect(changes).toEqual([['exited', 999]]);

    vi.setSystemTime(5_000);
    detector.onOutput([bell]);
    detector.onInput();
    detector.onResize();
    detector.onExit();
    vi.advanceTimersByTime(10_000);

    expect(changes).toEqual([['exited', 999]]);
    expect(detector.status).toBe('exited');
    expect(detector.since).toBe(999);
  });
});

describe('StatusDetector — echo does not flicker (test 2)', () => {
  it('twenty onInput+onOutput([]) pairs cause zero transitions; a bell inside the window does not transition; the same bell outside it does', () => {
    const detector = new StatusDetector({ agent: true, quietMs: 1_000 });
    vi.advanceTimersByTime(1_000); // -> awaiting-input by silence (not sticky)
    expect(detector.status).toBe('awaiting-input');

    const changes = recordChanges(detector);
    let now = 1_000;
    for (let i = 0; i < 20; i++) {
      now += 100;
      vi.setSystemTime(now);
      detector.onInput();
      detector.onOutput([]);
    }
    expect(changes).toEqual([]);
    expect(detector.status).toBe('awaiting-input');

    // A bell right after the last input, inside its echo window: ignored.
    now += 10;
    vi.setSystemTime(now);
    detector.onOutput([bell]);
    expect(changes).toEqual([]);
    expect(detector.status).toBe('awaiting-input');

    // The same bell, once the echo window has elapsed, transitions (it is
    // already awaiting-input, so make it observable by going through idle
    // first via a shell mark, then re-arm and test the bell distinctly).
    now += ECHO_WINDOW_MS;
    vi.setSystemTime(now);
    detector.onOutput([mark('A')]); // -> idle, clears echo irrelevant here
    now += ECHO_WINDOW_MS + 1;
    vi.setSystemTime(now);
    detector.onOutput([bell]);
    expect(changes).toEqual([
      ['idle', now - ECHO_WINDOW_MS - 1],
      ['awaiting-input', now],
    ]);
  });
});

describe('StatusDetector — resize does not flicker (test 3)', () => {
  it('onResize + output inside RESIZE_WINDOW_MS stays idle; a bell inside the resize window transitions', () => {
    const detector = new StatusDetector({ agent: true });
    detector.onOutput([mark('A')]); // -> idle
    const changes = recordChanges(detector);

    vi.setSystemTime(100);
    detector.onResize();
    vi.setSystemTime(100 + RESIZE_WINDOW_MS - 1);
    detector.onOutput([title]);
    expect(changes).toEqual([]);
    expect(detector.status).toBe('idle');

    // A bell inside the same resize window still transitions: resize does
    // not ring a bell (spec section 3.2).
    detector.onOutput([bell]);
    expect(changes).toEqual([['awaiting-input', 100 + RESIZE_WINDOW_MS - 1]]);
  });
});

describe('StatusDetector — signal and output in the same chunk (test 4)', () => {
  it('a bell before or after other signals in the same chunk both yield sticky awaiting-input, surviving later plain output', () => {
    const before = new StatusDetector({ agent: true });
    const beforeChanges = recordChanges(before);
    vi.setSystemTime(10);
    before.onOutput([bell, title]);
    expect(beforeChanges).toEqual([['awaiting-input', 10]]);

    const after = new StatusDetector({ agent: true });
    const afterChanges = recordChanges(after);
    vi.setSystemTime(10);
    after.onOutput([title, bell]);
    expect(afterChanges).toEqual([['awaiting-input', 10]]);

    // 10s of ordinary output with no input in between: still awaiting-input.
    for (const detector of [before, after]) {
      for (let i = 1; i <= 10; i++) {
        vi.setSystemTime(10 + i * 1_000);
        detector.onOutput([title]);
      }
      expect(detector.status).toBe('awaiting-input');
    }
  });
});

describe('StatusDetector — long command with no output on a plain shell (test 5)', () => {
  it('agent: false + mark C + long silence stays running; agent: true becomes awaiting-input', () => {
    const shell = new StatusDetector({ agent: false, quietMs: 1_000 });
    const shellChanges = recordChanges(shell);
    shell.onOutput([mark('C')]);
    vi.advanceTimersByTime(100_000);
    expect(shellChanges).toEqual([]);
    expect(shell.status).toBe('running');

    vi.setSystemTime(0);
    const agentDetector = new StatusDetector({ agent: true, quietMs: 1_000 });
    const agentChanges = recordChanges(agentDetector);
    agentDetector.onOutput([mark('C')]);
    vi.advanceTimersByTime(1_000);
    expect(agentChanges).toEqual([['awaiting-input', 1_000]]);
  });
});

describe('StatusDetector — the agent that exited (test 6, documents the limitation)', () => {
  it('agent: true, mark D then A, then silence: idle. With no mark at all, the same silence gives awaiting-input', () => {
    const withMarks = new StatusDetector({ agent: true, quietMs: 1_000 });
    withMarks.onOutput([mark('D')]);
    withMarks.onOutput([mark('A')]);
    const withMarksChanges = recordChanges(withMarks);
    vi.advanceTimersByTime(1_000);
    // Already idle from mark A; silence while in-prompt keeps it idle, no
    // further transition fires.
    expect(withMarksChanges).toEqual([]);
    expect(withMarks.status).toBe('idle');

    const withoutMarks = new StatusDetector({ agent: true, quietMs: 1_000 });
    // No shell-mark at all — the shell that survived the agent's exit never
    // told the detector it reached a prompt (spec section 2's accepted
    // limitation).
    vi.advanceTimersByTime(1_000);
    expect(withoutMarks.status).toBe('awaiting-input');
  });
});

describe('StatusDetector — a single timer (test 7)', () => {
  it('a thousand onOutput([]) calls in running leave exactly one timer; dispose() leaves zero', () => {
    const detector = new StatusDetector({ agent: true });
    expect(vi.getTimerCount()).toBe(1);

    for (let i = 0; i < 1_000; i++) {
      vi.setSystemTime(i + 1);
      detector.onOutput([]);
    }
    expect(vi.getTimerCount()).toBe(1);

    detector.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('StatusDetector — a throwing listener (test 8)', () => {
  it('does not stop the second listener and does not propagate out of onOutput', () => {
    const detector = new StatusDetector({ agent: true });
    const received: SessionStatus[] = [];
    const throwing: StatusListener = () => {
      throw new Error('boom');
    };
    const second: StatusListener = (status) => {
      received.push(status);
    };
    detector.onChange(throwing);
    detector.onChange(second);

    expect(() => {
      detector.onOutput([bell]);
    }).not.toThrow();
    expect(received).toEqual(['awaiting-input']);
  });
});

describe('StatusDetector — since (test 9)', () => {
  it('since reflects the instant of each transition, and a non-transitioning call leaves it unchanged', () => {
    const detector = new StatusDetector({ agent: true, quietMs: 1_000 });
    expect(detector.since).toBe(0);

    vi.setSystemTime(500);
    detector.onOutput([title]); // running -> running: no transition
    expect(detector.since).toBe(0);

    vi.setSystemTime(1_500);
    detector.onOutput([mark('A')]); // -> idle
    expect(detector.since).toBe(1_500);
    expect(detector.status).toBe('idle');

    vi.setSystemTime(2_000);
    detector.onOutput([mark('B')]); // idle -> idle: no transition
    expect(detector.since).toBe(1_500);

    vi.setSystemTime(3_000);
    detector.onExit();
    expect(detector.since).toBe(3_000);
  });
});
