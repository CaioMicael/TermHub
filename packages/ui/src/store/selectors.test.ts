import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@termhub/shared';

import { makeLeaf, type PaneNode } from './tree.js';
import {
  selectAggregatedWorkspaceStatus,
  selectSessionCount,
  selectWorkspaceLeaves,
} from './selectors.js';
import type { StoreState, Workspace } from './workspace.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    name: 'powershell.exe',
    cwd: 'C:\\',
    shell: 'powershell.exe',
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    status: 'idle',
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'ws1',
    cwd: 'C:\\',
    root: null,
    focusedSessionId: undefined,
    maximizedSessionId: undefined,
    ...overrides,
  };
}

describe('selectWorkspaceLeaves / selectSessionCount', () => {
  it('returns leaves in left-to-right order', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'r',
      dir: 'row',
      ratio: 0.5,
      a: makeLeaf(2),
      b: makeLeaf(1),
    };
    const state: StoreState = {
      workspaces: [workspace({ root })],
      activeWorkspaceId: 'ws1',
      sessions: {},
    };
    expect(selectWorkspaceLeaves(state, 'ws1')).toEqual([2, 1]);
    expect(selectSessionCount(state, 'ws1')).toBe(2);
  });

  it('empty for an unknown workspace or an empty tree', () => {
    const state: StoreState = { workspaces: [workspace()], activeWorkspaceId: 'ws1', sessions: {} };
    expect(selectWorkspaceLeaves(state, 'unknown')).toEqual([]);
    expect(selectSessionCount(state, 'ws1')).toBe(0);
  });
});

describe('selectAggregatedWorkspaceStatus', () => {
  function stateWithStatuses(statuses: SessionSummary['status'][]): StoreState {
    let root: PaneNode | null = null;
    const sessions: Record<number, SessionSummary> = {};
    statuses.forEach((status, i) => {
      const id = i + 1;
      sessions[id] = session({ id, status });
      root =
        root === null
          ? makeLeaf(id)
          : { kind: 'split', id: `n${i}`, dir: 'row', ratio: 0.5, a: root, b: makeLeaf(id) };
    });
    return { workspaces: [workspace({ root })], activeWorkspaceId: 'ws1', sessions };
  }

  it('awaiting-input beats running and idle', () => {
    expect(
      selectAggregatedWorkspaceStatus(
        stateWithStatuses(['idle', 'running', 'awaiting-input']),
        'ws1',
      ),
    ).toBe('awaiting-input');
  });

  it('running beats idle', () => {
    expect(selectAggregatedWorkspaceStatus(stateWithStatuses(['idle', 'running']), 'ws1')).toBe(
      'running',
    );
  });

  it('all idle -> idle', () => {
    expect(selectAggregatedWorkspaceStatus(stateWithStatuses(['idle', 'idle']), 'ws1')).toBe(
      'idle',
    );
  });

  it('exited is reported on its own, not folded into idle, when every pane has exited', () => {
    expect(selectAggregatedWorkspaceStatus(stateWithStatuses(['exited', 'exited']), 'ws1')).toBe(
      'exited',
    );
  });

  it('a mix of exited and running is running (exited does not win, does not hide)', () => {
    expect(selectAggregatedWorkspaceStatus(stateWithStatuses(['exited', 'running']), 'ws1')).toBe(
      'running',
    );
  });

  it('an empty workspace is "empty"', () => {
    const state: StoreState = { workspaces: [workspace()], activeWorkspaceId: 'ws1', sessions: {} };
    expect(selectAggregatedWorkspaceStatus(state, 'ws1')).toBe('empty');
  });
});
