import { describe, expect, it } from 'vitest';

import {
  decodeTabDragPayload,
  encodeTabDragPayload,
  reorderWorkspaceIds,
  tabInsertionIndex,
  TAB_DRAG_MIME,
  type TabRect,
} from './tab-drag.js';

const TABS: TabRect[] = [
  { id: 'a', left: 0, width: 100 },
  { id: 'b', left: 100, width: 100 },
  { id: 'c', left: 200, width: 100 },
];

describe('tabInsertionIndex', () => {
  it('returns 0 when the pointer sits over the first remaining tab, left half', () => {
    expect(tabInsertionIndex(TABS, 'c', 20)).toBe(0);
  });

  it('returns the middle index when the pointer sits over the middle tab', () => {
    expect(tabInsertionIndex(TABS, 'c', 120)).toBe(1);
  });

  it('returns the end index when the pointer is past every remaining tab', () => {
    expect(tabInsertionIndex(TABS, 'c', 500)).toBe(2);
  });

  it('excludes the dragged tab itself from the candidate slots', () => {
    // Dragging 'b': remaining tabs are a (0-100), c (200-300). A pointer at
    // 150 (b's own old midpoint) is past a's midpoint (50) but before c's
    // midpoint (250) — insertion index 1, between a and c.
    expect(tabInsertionIndex(TABS, 'b', 150)).toBe(1);
  });
});

describe('reorderWorkspaceIds', () => {
  it('moves a tab from the end to the front', () => {
    expect(reorderWorkspaceIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('moves a tab from the front to the middle', () => {
    expect(reorderWorkspaceIds(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when the insertion index matches the current position', () => {
    expect(reorderWorkspaceIds(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
  });

  it('clamps an out-of-range insertion index instead of throwing', () => {
    expect(reorderWorkspaceIds(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(reorderWorkspaceIds(['a', 'b', 'c'], 'a', -5)).toEqual(['a', 'b', 'c']);
  });
});

describe('encode/decodeTabDragPayload', () => {
  function fakeDataTransfer(types: readonly string[], data: Record<string, string>) {
    return {
      types,
      getData: (type: string) => data[type] ?? '',
    };
  }

  it('round-trips a workspace id through the custom MIME type', () => {
    const payload = encodeTabDragPayload('ws-2');
    const dt = fakeDataTransfer([TAB_DRAG_MIME], { [TAB_DRAG_MIME]: payload });
    expect(decodeTabDragPayload(dt)).toBe('ws-2');
  });

  it('ignores a dataTransfer with a different MIME type (a pane drag, not a tab drag)', () => {
    const dt = fakeDataTransfer(['application/x-termhub-pane'], {
      'application/x-termhub-pane': '{"sessionId":1}',
    });
    expect(decodeTabDragPayload(dt)).toBeNull();
  });

  it('ignores malformed JSON under the right MIME type', () => {
    const dt = fakeDataTransfer([TAB_DRAG_MIME], { [TAB_DRAG_MIME]: 'not json' });
    expect(decodeTabDragPayload(dt)).toBeNull();
  });
});
