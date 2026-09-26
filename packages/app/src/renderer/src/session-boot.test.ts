import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@termhub/shared';
import { collectSessionIds, treeLeaves, type PaneNode } from '@termhub/ui';

import {
  DEFAULT_CWD,
  DEFAULT_SHELL,
  DEFAULT_WORKSPACE_ID,
  resetSessionBootForTests,
  resolveBootWorkspace,
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
      // inside the branch — see `session-boot.ts`'s own doc comment on the
      // identical pattern in `packages/app/src/preload/bridge.ts`.
      return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
    }
    createCalls.push(params);
    const result: SessionBootRequestResult['session.create'] = { session: createdSession };
    return Promise.resolve(result) as Promise<SessionBootRequestResult[M]>;
  }

  return { bridge: { request }, listCalls, createCalls };
}

describe('resolveBootWorkspace', () => {
  beforeEach(() => {
    resetSessionBootForTests();
  });

  it('with no live session: creates one and returns a single-leaf workspace focused on it', async () => {
    const created = summary({ id: 6, status: 'running' });
    const { bridge, createCalls } = createFakeBridge([], created);

    const result = await resolveBootWorkspace(bridge, { cols: 120, rows: 40 });

    expect(result.workspace.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(result.workspace.root).toEqual({ kind: 'leaf', sessionId: 6 });
    expect(result.workspace.focusedSessionId).toBe(6);
    expect(result.sessions).toEqual([created]);
    expect(createCalls).toEqual([{ shell: DEFAULT_SHELL, cwd: DEFAULT_CWD, cols: 120, rows: 40 }]);
  });

  it('with exited sessions only: still creates a fresh one, ignoring the exited ones for the tree', async () => {
    const exited = summary({ id: 5, status: 'exited', exitCode: 0, createdAt: 9_999 });
    const created = summary({ id: 6, status: 'running' });
    const { bridge, createCalls } = createFakeBridge([exited], created);

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(result.workspace.root).toEqual({ kind: 'leaf', sessionId: 6 });
    expect(createCalls).toHaveLength(1);
    // The exited session's metadata is still handed back for the store.
    expect(result.sessions).toEqual([exited, created]);
  });

  it('with N live sessions: builds treeFromSessions over all of them, no session.create', async () => {
    const s1 = summary({ id: 1, createdAt: 1_000 });
    const s2 = summary({ id: 2, createdAt: 2_000 });
    const s3 = summary({ id: 3, createdAt: 3_000 });
    const s4 = summary({ id: 4, createdAt: 4_000 });
    const { bridge, createCalls } = createFakeBridge([s1, s2, s3, s4], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(createCalls).toHaveLength(0);
    expect(collectSessionIds(result.workspace.root).size).toBe(4);
    expect(
      treeLeaves(result.workspace.root)
        .map((l) => l.sessionId)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
    // 2x2: root is a split of two column splits, per treeFromSessions.
    const root = result.workspace.root as Extract<PaneNode, { kind: 'split' }>;
    expect(root.a.kind).toBe('split');
    expect(root.b.kind).toBe('split');
  });

  it('focuses the live session with the highest createdAt, regardless of session.list order', async () => {
    const older = summary({ id: 5, createdAt: 1_000 });
    const newest = summary({ id: 7, createdAt: 3_000 });
    const middle = summary({ id: 6, createdAt: 2_000 });
    const { bridge } = createFakeBridge([older, newest, middle], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(result.workspace.focusedSessionId).toBe(7);
  });

  it('ignores exited sessions even when their createdAt is the highest, both for the tree and for focus', async () => {
    const live = summary({ id: 5, status: 'idle', createdAt: 1_000 });
    const exitedButNewer = summary({ id: 6, status: 'exited', exitCode: 0, createdAt: 5_000 });
    const { bridge, createCalls } = createFakeBridge([live, exitedButNewer], summary({ id: 99 }));

    const result = await resolveBootWorkspace(bridge, { cols: 80, rows: 24 });

    expect(result.workspace.root).toEqual({ kind: 'leaf', sessionId: 5 });
    expect(result.workspace.focusedSessionId).toBe(5);
    expect(createCalls).toHaveLength(0);
  });

  it('StrictMode-shaped double call: two synchronous calls before the first settles result in exactly one session.create', async () => {
    const { bridge, createCalls, listCalls } = createFakeBridge([], summary());

    const first = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const second = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(createCalls).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
  });

  it('StrictMode-shaped double call with already-live sessions: no session.create at all', async () => {
    const alive = summary({ id: 9, status: 'awaiting-input' });
    const { bridge, createCalls } = createFakeBridge([alive], summary({ id: 99 }));

    const first = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    const second = resolveBootWorkspace(bridge, { cols: 80, rows: 24 });
    await Promise.all([first, second]);

    expect(createCalls).toHaveLength(0);
  });
});
