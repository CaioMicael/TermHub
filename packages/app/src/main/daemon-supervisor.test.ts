import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '@termhub/shared';

import type { DaemonInfo } from '@termhub/daemon/src/daemon.js';
import type { TransportClient } from '@termhub/daemon/src/transport-client.js';

import { createDaemonSupervisor } from './daemon-supervisor.js';
import type { DaemonConnection } from './daemon-client.js';
import type { DaemonSupervisor, DaemonSupervisorState } from './daemon-supervisor.js';

// docs/specs/m4.8-daemon-resilience.md section 4, required test 1. Every
// scenario here injects a fake `connect` — never a real daemon/process — so
// the retry/backoff/epoch state machine is exercised deterministically with
// fake timers, exactly the seam `CreateDaemonSupervisorOptions.connect`
// exists for.

function fakeInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 12345,
    pipe: 'fake-pipe',
    token: 'fake-token',
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Only the slice of `TransportClient` `daemon-supervisor.ts` actually touches — narrower than depending on the concrete class, same reasoning `session-attachments.ts`'s own `AttachmentTransportClient` gives. */
type FakeTransportClient = Pick<TransportClient, 'onClose'>;

/** A minimal, controllable stand-in for `TransportClient` — only `onClose` is ever touched by `daemon-supervisor.ts`. */
function fakeClient(): {
  client: FakeTransportClient;
  fireClose: () => void;
} {
  const listeners = new Set<() => void>();
  return {
    client: {
      onClose: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    fireClose: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function connectedResult(
  client: FakeTransportClient,
  info: DaemonInfo = fakeInfo(),
): DaemonConnection {
  return {
    outcome: 'connected',
    // `FakeTransportClient` is structurally what this module reads from a
    // real `TransportClient` (only `onClose`) — the real type has dozens of
    // other members this fake deliberately never implements, so the cast
    // must go through `unknown`.
    client: client as unknown as TransportClient,
    info,
  };
}

function blockedResult(reason: 'zombie' | 'version-mismatch' | 'token-rejected'): DaemonConnection {
  return { outcome: 'blocked', reason, info: fakeInfo() };
}

function failedResult(message = 'no daemon found'): DaemonConnection {
  return {
    outcome: 'failed',
    attempts: 5,
    lastError: new Error(message),
    daemonPath: '/fake/daemon.json',
  };
}

let supervisors: DaemonSupervisor[];

beforeEach(() => {
  vi.useFakeTimers();
  supervisors = [];
});

afterEach(() => {
  for (const supervisor of supervisors) {
    supervisor.dispose();
  }
  vi.useRealTimers();
});

function collectStates(supervisor: DaemonSupervisor): DaemonSupervisorState[] {
  const seen: DaemonSupervisorState[] = [];
  supervisor.onChange((state) => {
    seen.push(state);
  });
  return seen;
}

describe('createDaemonSupervisor (docs/specs/m4.8-daemon-resilience.md section 4, required test 1)', () => {
  it('a drop leads to disconnected, the retry respects backoff, and the next connection arrives with epoch + 1', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const first = fakeClient();
    const second = fakeClient();
    const connect = vi
      .fn<() => Promise<DaemonConnection>>()
      .mockResolvedValueOnce(connectedResult(first.client))
      .mockResolvedValueOnce(failedResult())
      .mockResolvedValueOnce(connectedResult(second.client));

    const supervisor = createDaemonSupervisor({
      connect,
      initialBackoffMs: 250,
      maxBackoffMs: 5000,
    });
    supervisors.push(supervisor);

    const result1 = await supervisor.firstConnection;
    expect(result1.outcome).toBe('connected');
    expect(supervisor.current()).toMatchObject({ state: 'connected', epoch: 1 });

    const states = collectStates(supervisor);

    first.fireClose();
    expect(supervisor.current()).toEqual({ state: 'disconnected' });
    expect(states).toEqual([{ state: 'disconnected' }]);
    // Only the drop has been observed so far — `connect` has not been
    // called again yet (the retry loop awaits the backoff first).
    expect(connect).toHaveBeenCalledTimes(1);

    // Advancing less than the backoff must not trigger a retry yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(1);

    // The rest of the first backoff window (250ms total) elapses: the retry
    // fires, resolves 'failed', and (because of the doubled backoff) waits
    // up to 500ms before trying again.
    await vi.advanceTimersByTimeAsync(200);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.current()).toEqual({ state: 'disconnected' }); // 'failed' doesn't push a new state

    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(3);

    expect(supervisor.current()).toMatchObject({ state: 'connected', epoch: 2 });
    expect(states.at(-1)).toMatchObject({ state: 'connected', epoch: 2 });

    // The section 2 guarantee this whole module exists to uphold: nothing
    // here ever calls process.kill, on a zombie, a version mismatch, a
    // rejected token, or a plain drop-and-reconnect.
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it("'blocked' stops the retry loop for good — no further connect() calls, even after a long wait", async () => {
    const first = fakeClient();
    const connect = vi
      .fn<() => Promise<DaemonConnection>>()
      .mockResolvedValueOnce(connectedResult(first.client))
      .mockResolvedValueOnce(blockedResult('zombie'));

    const supervisor = createDaemonSupervisor({
      connect,
      initialBackoffMs: 250,
      maxBackoffMs: 5000,
    });
    supervisors.push(supervisor);
    await supervisor.firstConnection;

    first.fireClose();
    await vi.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.current()).toEqual({
      state: 'blocked',
      reason: 'zombie',
      info: expect.anything() as unknown,
    });

    // No amount of further waiting resumes retrying once blocked.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('a blocked *first* connection is reported as-is, with no retry of its own (section 3.1: "faz a primeira conexão ... como hoje")', async () => {
    const connect = vi
      .fn<() => Promise<DaemonConnection>>()
      .mockResolvedValue(blockedResult('version-mismatch'));
    const supervisor = createDaemonSupervisor({ connect });
    supervisors.push(supervisor);

    const result = await supervisor.firstConnection;
    expect(result).toEqual(blockedResult('version-mismatch'));
    expect(supervisor.current()).toMatchObject({ state: 'blocked', reason: 'version-mismatch' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('dispose() stops the retry loop from ever calling connect() again', async () => {
    const first = fakeClient();
    const connect = vi
      .fn<() => Promise<DaemonConnection>>()
      .mockResolvedValueOnce(connectedResult(first.client))
      .mockResolvedValue(failedResult());

    const supervisor = createDaemonSupervisor({
      connect,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    });
    supervisors.push(supervisor);
    await supervisor.firstConnection;

    first.fireClose();
    supervisor.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
