import { describe, expect, it } from 'vitest';
import type { WorkspaceTemplate } from '@termhub/shared';

import { removeTemplate, upsertTemplate, useTemplatesStore } from './templates.js';

function template(overrides: Partial<WorkspaceTemplate> & { id: string }): WorkspaceTemplate {
  return { name: 'x', sessions: [], ...overrides };
}

describe('upsertTemplate', () => {
  it('appends a new template when its id is not present', () => {
    const before = [template({ id: 'tpl-1' })];
    const added = template({ id: 'tpl-2' });
    expect(upsertTemplate(before, added)).toEqual([before[0], added]);
  });

  it('replaces the existing template in place, at the same index, when its id already exists', () => {
    const before = [template({ id: 'tpl-1', name: 'old' }), template({ id: 'tpl-2' })];
    const edited = template({ id: 'tpl-1', name: 'new' });
    expect(upsertTemplate(before, edited)).toEqual([edited, before[1]]);
  });
});

describe('removeTemplate', () => {
  it('removes the template with the given id', () => {
    const before = [template({ id: 'tpl-1' }), template({ id: 'tpl-2' })];
    expect(removeTemplate(before, 'tpl-1')).toEqual([before[1]]);
  });

  it('is a no-op (same array reference) for an id that is not there', () => {
    const before = [template({ id: 'tpl-1' })];
    expect(removeTemplate(before, 'nope')).toBe(before);
  });
});

describe('useTemplatesStore', () => {
  it('starts empty, and setTemplates/saveTemplate/deleteTemplate all work through the real Zustand store', () => {
    useTemplatesStore.getState().setTemplates([]);
    expect(useTemplatesStore.getState().templates).toEqual([]);

    useTemplatesStore.getState().saveTemplate(template({ id: 'tpl-1', name: 'A' }));
    expect(useTemplatesStore.getState().templates).toEqual([template({ id: 'tpl-1', name: 'A' })]);

    useTemplatesStore.getState().saveTemplate(template({ id: 'tpl-1', name: 'B' }));
    expect(useTemplatesStore.getState().templates).toEqual([template({ id: 'tpl-1', name: 'B' })]);

    useTemplatesStore.getState().deleteTemplate('tpl-1');
    expect(useTemplatesStore.getState().templates).toEqual([]);
  });
});
