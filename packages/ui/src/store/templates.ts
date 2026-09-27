// M4.7: the workspace templates' own tiny store — deliberately separate
// from `store.ts`'s `useTermhubStore` (the layout/session store), not a new
// slice of it. Templates are edited far less often than the layout, have
// none of `StoreState`'s cross-workspace invariants (M3.1's "one session
// per leaf", etc.) to protect, and a second, independent Zustand store here
// means every existing `StoreState` object literal in the codebase (there
// are dozens, across this package's and `packages/app`'s own tests) never
// has to grow a `templates` field it doesn't care about. Persistence is
// composed on the other side (`packages/app/src/renderer/src/
// session-boot.ts`'s `startTemplatesPersistence`): it reads both stores and
// writes one `workspaces.json`, same file, same `layoutSave` path.
//
// Same thin-wrapper split `store.ts` itself uses: pure reducers below (unit
// tested directly, no Zustand), a small Zustand shell on top that just
// calls them.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { WorkspaceTemplate } from '@termhub/shared';

/** Replaces `template` in `templates` if its `id` already exists, else appends it — the "create or edit" the templates editor needs in one call. */
export function upsertTemplate(
  templates: readonly WorkspaceTemplate[],
  template: WorkspaceTemplate,
): WorkspaceTemplate[] {
  const index = templates.findIndex((t) => t.id === template.id);
  if (index === -1) {
    return [...templates, template];
  }
  const next = templates.slice();
  next[index] = template;
  return next;
}

/** Removes the template with `templateId`, if any. A no-op (returns `templates` itself, same reference) when it isn't there — same "reject silently, no error to throw" posture `store/workspace.ts`'s reducers already use throughout. */
export function removeTemplate(
  templates: WorkspaceTemplate[],
  templateId: string,
): WorkspaceTemplate[] {
  if (!templates.some((t) => t.id === templateId)) {
    return templates;
  }
  return templates.filter((t) => t.id !== templateId);
}

export interface TemplatesState {
  templates: WorkspaceTemplate[];
}

export interface TemplatesActions {
  /** Replaces the whole list — `session-boot.ts`'s boot seeds the store with the persisted file's own templates this way, once. */
  setTemplates: (templates: WorkspaceTemplate[]) => void;
  /** The templates editor's "save" — create or edit, by `template.id`. */
  saveTemplate: (template: WorkspaceTemplate) => void;
  deleteTemplate: (templateId: string) => void;
}

export type TemplatesStore = TemplatesState & TemplatesActions;

export const useTemplatesStore: UseBoundStore<StoreApi<TemplatesStore>> = create<TemplatesStore>(
  (set) => ({
    templates: [],
    setTemplates: (templates) => {
      set({ templates });
    },
    saveTemplate: (template) => {
      set((state) => ({ templates: upsertTemplate(state.templates, template) }));
    },
    deleteTemplate: (templateId) => {
      set((state) => ({ templates: removeTemplate(state.templates, templateId) }));
    },
  }),
);
