import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import {
  DEFAULT_CWD,
  DEFAULT_SHELL,
  resetSessionBootForTests,
  resolveBootSession,
  type SessionBootBridge,
  type SessionBootMethod,
  type SessionBootRequestParams,
  type SessionBootRequestResult,
} from './session-boot.js';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'powershell.exe',
    cwd: DEFAULT_CWD,
    shell: DEFAULT_SHELL,
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

/**
 * A fake `SessionBootBridge`. `request` is implemented as a real generic
 * function (not a plain arrow typed by context) so the two branches can
 * each return their own method's result shape — the same "erase to the
 * union, cast back" pattern `packages/app/src/preload/bridge.ts`'s real
 * `request` implementation uses for the identical reason (a generic method
 * body can't otherwise return a type that depends on the type parameter it
 * closes over per-call).
 */
function createFakeBridge(
  initialSessions: SessionSummary[],
  createdSession: SessionSummary,
): { bridge: SessionBootBridge; listCalls: number[]; createCalls: unknown[] } {
  const listCalls: number[] = [];
  const createCalls: unknown[] = [];

  function request<M extends SessionBootMethod>(
    method: M,
    params: SessionBootRequestParams[M],
  ): Promise<SessionBootRequestResult[M]> {
    if (method === 'session.list') {
      listCalls.push(1);
      const result: SessionBootRequestResult['session.list'] = { sessions: initialSessions };
      // as: this function's return type depends on `M`, which isn't known
      // inside the branch — see this function's own doc comment.
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    createCalls.push(params);
    const result: SessionBootRequestResult['session.create'] = { session: createdSession };
    return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
  }

  return { bridge: { request }, listCalls, createCalls };
}

describe('resolveBootSession', () => {
  beforeEach(() => {
    resetSessionBootForTests();
  });

  it('reuses the first non-exited session instead of creating one', async () => {
    const alive = summary({ id: 5, status: 'idle' });
    const { bridge, listCalls, createCalls } = createFakeBridge([alive], summary({ id: 99 }));

    const result = await resolveBootSession(bridge, { cols: 80, rows: 24 });

    expect(result).toEqual(alive);
    expect(createCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(1);
  });

  // docs/specs/m2.6-boot-reattach.md section 3.4, required test 8: among
  // several live sessions, boot picks the one with the highest `createdAt`
  // — not just "the first one `session.list` happened to return".
  it('reuses the live session with the highest createdAt when several are live', async () => {
    const older = summary({ id: 5, status: 'idle', createdAt: 1_000 });
    const newest = summary({ id: 7, status: 'running', createdAt: 3_000 });
    const middle = summary({ id: 6, status: 'awaiting-input', createdAt: 2_000 });
    // Deliberately out of createdAt order, so a naive `.find()`/"first
    // non-exited" policy would pick `older` instead.
    const { bridge, createCalls } = createFakeBridge([older, newest, middle], summary({ id: 99 }));

    const result = await resolveBootSession(bridge, { cols: 80, rows: 24 });

    expect(result).toEqual(newest);
    expect(createCalls).toHaveLength(0);
  });

  // Exited sessions are left alone (M4's graveyard), never picked over a
  // live one, however new their own createdAt might be.
  it('ignores exited sessions even when their createdAt is the highest', async () => {
    const live = summary({ id: 5, status: 'idle', createdAt: 1_000 });
    const exitedButNewer = summary({
      id: 6,
      status: 'exited',
      exitCode: 0,
      createdAt: 5_000,
    });
    const { bridge, createCalls } = createFakeBridge([live, exitedButNewer], summary({ id: 99 }));

    const result = await resolveBootSession(bridge, { cols: 80, rows: 24 });

    expect(result).toEqual(live);
    expect(createCalls).toHaveLength(0);
  });

  it('does not reuse an exited session — creates a new one instead', async () => {
    const exited = summary({ id: 5, status: 'exited', exitCode: 0 });
    const created = summary({ id: 6, status: 'running' });
    const { bridge, createCalls } = createFakeBridge([exited], created);

    const result = await resolveBootSession(bridge, { cols: 80, rows: 24 });

    expect(result).toEqual(created);
    expect(createCalls).toHaveLength(1);
  });

  it('sizes a freshly created session with the given cols/rows and the default shell/cwd', async () => {
    const { bridge, createCalls } = createFakeBridge([], summary());

    await resolveBootSession(bridge, { cols: 120, rows: 40 });

    expect(createCalls).toEqual([{ shell: DEFAULT_SHELL, cwd: DEFAULT_CWD, cols: 120, rows: 40 }]);
  });

  it('StrictMode-shaped double call: two synchronous calls before the first settles result in exactly one session.create', async () => {
    const { bridge, createCalls, listCalls } = createFakeBridge([], summary());

    const first = resolveBootSession(bridge, { cols: 80, rows: 24 });
    const second = resolveBootSession(bridge, { cols: 80, rows: 24 });
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(createCalls).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
  });

  it('StrictMode-shaped double call with an already-alive session: no session.create at all', async () => {
    const alive = summary({ id: 9, status: 'awaiting-input' });
    const { bridge, createCalls } = createFakeBridge([alive], summary({ id: 99 }));

    const first = resolveBootSession(bridge, { cols: 80, rows: 24 });
    const second = resolveBootSession(bridge, { cols: 80, rows: 24 });
    await Promise.all([first, second]);

    expect(createCalls).toHaveLength(0);
  });
});
