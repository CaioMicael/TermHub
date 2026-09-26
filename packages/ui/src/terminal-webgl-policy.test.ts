import { describe, expect, it } from 'vitest';

import { selectWebglSessions } from './terminal-webgl-policy.js';

describe('selectWebglSessions', () => {
  it('selects everyone when under budget', () => {
    const result = selectWebglSessions({
      visibleOpenSessionIds: [1, 2, 3],
      focusedSessionId: undefined,
      maxContexts: 8,
    });
    expect(result).toEqual(new Set([1, 2, 3]));
  });

  it('respects the cap, keeping leaf order when nothing is focused', () => {
    const result = selectWebglSessions({
      visibleOpenSessionIds: [1, 2, 3, 4, 5],
      focusedSessionId: undefined,
      maxContexts: 3,
    });
    expect(result).toEqual(new Set([1, 2, 3]));
  });

  it('puts the focused session first, bumping the last leaf out when over budget', () => {
    const result = selectWebglSessions({
      visibleOpenSessionIds: [1, 2, 3, 4, 5],
      focusedSessionId: 5,
      maxContexts: 3,
    });
    // focused (5) always wins a slot, then leaf order (1, 2) fills the rest —
    // 3 and 4 are the ones bumped out, not 5, even though 5 is last in leaf
    // order.
    expect(result).toEqual(new Set([5, 1, 2]));
  });

  it('ignores a focusedSessionId that is not in the visible/open list', () => {
    const result = selectWebglSessions({
      visibleOpenSessionIds: [1, 2, 3],
      focusedSessionId: 999,
      maxContexts: 2,
    });
    expect(result).toEqual(new Set([1, 2]));
  });

  it('is deterministic: same input, same output, called repeatedly', () => {
    const params = {
      visibleOpenSessionIds: [4, 2, 7, 1],
      focusedSessionId: 7,
      maxContexts: 2,
    };
    const first = selectWebglSessions(params);
    const second = selectWebglSessions(params);
    expect([...first]).toEqual([...second]);
    expect([...first]).toEqual([7, 4]);
  });

  it('returns an empty set for a zero or negative budget', () => {
    expect(
      selectWebglSessions({ visibleOpenSessionIds: [1], focusedSessionId: 1, maxContexts: 0 }),
    ).toEqual(new Set());
    expect(
      selectWebglSessions({
        visibleOpenSessionIds: [1],
        focusedSessionId: undefined,
        maxContexts: -3,
      }),
    ).toEqual(new Set());
  });

  it('handles an empty visible list', () => {
    expect(
      selectWebglSessions({ visibleOpenSessionIds: [], focusedSessionId: 1, maxContexts: 8 }),
    ).toEqual(new Set());
  });
});
