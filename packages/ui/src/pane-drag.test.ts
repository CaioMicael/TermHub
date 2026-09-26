import { describe, expect, it } from 'vitest';

import {
  computePaneDrop,
  decodePaneDragPayload,
  edgeForPoint,
  encodePaneDragPayload,
  isPaneDragDisabled,
  PANE_DRAG_MIME,
} from './pane-drag.js';

const RECT = { left: 0, top: 0, width: 100, height: 200 };

describe('edgeForPoint', () => {
  it('picks the nearest edge for a point close to the top', () => {
    expect(edgeForPoint(RECT, { x: 50, y: 5 })).toBe('top');
  });

  it('picks the nearest edge for a point close to the bottom', () => {
    expect(edgeForPoint(RECT, { x: 50, y: 195 })).toBe('bottom');
  });

  it('picks the nearest edge for a point close to the left', () => {
    expect(edgeForPoint(RECT, { x: 2, y: 100 })).toBe('left');
  });

  it('picks the nearest edge for a point close to the right', () => {
    expect(edgeForPoint(RECT, { x: 98, y: 100 })).toBe('right');
  });

  it('returns null for the dead zone at the center', () => {
    expect(edgeForPoint(RECT, { x: 50, y: 100 })).toBeNull();
  });

  it('resolves the diagonal tie at a corner deterministically (top over left)', () => {
    // (0, 0): normalized distance to top and to left are both 0 — a true
    // tie. The documented priority (top > bottom > left > right) picks top.
    expect(edgeForPoint(RECT, { x: 0, y: 0 })).toBe('top');
  });

  it('splits a square rect along the exact diagonal between top and left', () => {
    const square = { left: 0, top: 0, width: 100, height: 100 };
    // Just above the diagonal (y < x): still top's side per the tie-break,
    // but clearly closer to top than to left once y is well under x.
    expect(edgeForPoint(square, { x: 80, y: 10 })).toBe('top');
    expect(edgeForPoint(square, { x: 10, y: 80 })).toBe('left');
  });

  it('returns null for a degenerate (zero-size) rect', () => {
    expect(edgeForPoint({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('isPaneDragDisabled', () => {
  it('is disabled when the workspace is solo', () => {
    expect(isPaneDragDisabled({ solo: true, maximized: false })).toBe(true);
  });

  it('is disabled when the pane is maximized', () => {
    expect(isPaneDragDisabled({ solo: false, maximized: true })).toBe(true);
  });

  it('is enabled otherwise', () => {
    expect(isPaneDragDisabled({ solo: false, maximized: false })).toBe(false);
  });
});

describe('computePaneDrop', () => {
  it('returns the move when source, target and edge are all valid', () => {
    expect(computePaneDrop({ sourceSessionId: 1, targetSessionId: 2, edge: 'right' })).toEqual({
      sourceSessionId: 1,
      targetSessionId: 2,
      edge: 'right',
    });
  });

  it('rejects a drop with no session being dragged', () => {
    expect(computePaneDrop({ sourceSessionId: null, targetSessionId: 2, edge: 'right' })).toBeNull();
  });

  it('rejects a drop with no border under the pointer', () => {
    expect(computePaneDrop({ sourceSessionId: 1, targetSessionId: 2, edge: null })).toBeNull();
  });

  it('rejects dropping a pane onto itself', () => {
    expect(computePaneDrop({ sourceSessionId: 1, targetSessionId: 1, edge: 'right' })).toBeNull();
  });
});

describe('encode/decodePaneDragPayload', () => {
  function fakeDataTransfer(types: readonly string[], data: Record<string, string>) {
    return {
      types,
      getData: (type: string) => data[type] ?? '',
    };
  }

  it('round-trips a session id through the custom MIME type', () => {
    const payload = encodePaneDragPayload(42);
    const dt = fakeDataTransfer([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: payload });
    expect(decodePaneDragPayload(dt)).toBe(42);
  });

  it('ignores a dataTransfer with a different MIME type (text dragged from outside)', () => {
    const dt = fakeDataTransfer(['text/plain'], { 'text/plain': 'hello' });
    expect(decodePaneDragPayload(dt)).toBeNull();
  });

  it('ignores a dataTransfer with a different MIME type (a file dragged from outside)', () => {
    const dt = fakeDataTransfer(['Files'], {});
    expect(decodePaneDragPayload(dt)).toBeNull();
  });

  it('ignores malformed JSON under the right MIME type', () => {
    const dt = fakeDataTransfer([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'not json' });
    expect(decodePaneDragPayload(dt)).toBeNull();
  });

  it('ignores well-formed JSON missing sessionId', () => {
    const dt = fakeDataTransfer([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: '{"foo":1}' });
    expect(decodePaneDragPayload(dt)).toBeNull();
  });
});
