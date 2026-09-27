// M4.7: "abrir tudo com um clique" — the impure half of the templates
// feature, on top of `workspace-templates.ts`'s pure `buildAutoGridTree`/
// `templateFromWorkspace`. Same split `store/session-actions.ts`/
// `tab-bar-actions.ts` already establish: this module awaits real
// `session.create` round trips before ever touching the store, so it isn't
// pure and doesn't belong in that other file.

import type { SessionSummary } from '@termhub/shared';
import type { WorkspaceTemplate } from '@termhub/shared';

import { generateWorkspaceId, nextWorkspaceName } from './tab-bar-actions.js';
import type {
  SessionActionsBridge,
  SessionActionsStoreApi,
  Size,
} from './store/session-actions.js';
import type { Workspace } from './store/workspace.js';
import {
  buildAutoGridTree,
  nextTemplateId,
  nextTemplateName,
  templateFromWorkspace,
} from './workspace-templates.js';

/**
 * Creates one session per `template.sessions` entry (in order — the array's
 * own order is what `buildAutoGridTree` lays out left to right / top to
 * bottom), then a brand-new workspace whose tree is the automatic grid over
 * all of them, focused on the first. This is the one Playwright is meant to
 * watch fire N `session.create` calls for "definir 3 agentes... abrir tudo
 * com um clique" (this task's required proof 4).
 *
 * Every session is created before the workspace is added to the store —
 * one `addWorkspace` call, not N tree mutations — so nobody ever observes an
 * intermediate grid with only some of the panes in it (same "one hydrate,
 * not several partial mutations" reasoning `App.tsx`'s own boot effect
 * already follows).
 *
 * Sessions are created **sequentially**, not with `Promise.all`: the
 * daemon's `Registry` (`packages/daemon/src/registry.ts`) hands out ids one
 * at a time from a single counter, and creating them one after another
 * keeps this function's own behavior simple and deterministic to test —
 * "3 agentes" opening a beat slower than the theoretical minimum is a cost
 * this task's prompt never asks this function to avoid, unlike a session
 * ending up in the wrong grid position, which sequential creation also
 * rules out by construction (`results[i]` really is session `i`).
 *
 * An empty template (`template.sessions.length === 0`) creates nothing and
 * never calls `addWorkspace` — there would be no pane to seed the tree
 * with.
 */
export async function openWorkspaceFromTemplate(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  template: WorkspaceTemplate,
  size: Size,
): Promise<Workspace | undefined> {
  if (template.sessions.length === 0) {
    return undefined;
  }

  const state = store.getState();
  const workspaceId = generateWorkspaceId(state.workspaces.map((w) => w.id));
  // The tab is named after the template ("3 agentes"), which is what the
  // user picked; the generic "Novo workspace" name is only for a template
  // saved with a blank name.
  const name =
    template.name.trim() !== ''
      ? template.name
      : nextWorkspaceName(state.workspaces.map((w) => w.name));

  const created: SessionSummary[] = [];
  for (const templateSession of template.sessions) {
    const { session } = await bridge.request('session.create', {
      name: templateSession.name,
      shell: templateSession.shell,
      cwd: templateSession.cwd,
      cols: size.cols,
      rows: size.rows,
      ...(templateSession.args !== undefined ? { args: templateSession.args } : {}),
      ...(templateSession.command !== undefined ? { command: templateSession.command } : {}),
    });
    created.push(session);
    store.upsertSession(session);
  }

  const ids = created.map((session) => session.id);
  const root = buildAutoGridTree(ids, workspaceId);
  const firstId = ids[0];
  const workspace: Workspace = {
    id: workspaceId,
    name,
    cwd: created[0]?.cwd ?? template.sessions[0]?.cwd ?? 'C:\\',
    root,
    focusedSessionId: firstId,
    maximizedSessionId: undefined,
  };
  store.addWorkspace(workspace, { activate: true });
  return workspace;
}

/**
 * "Salvar workspace atual como modelo" — builds a template from
 * `workspace`'s current panes (`templateFromWorkspace`) and saves it,
 * naming it after the workspace itself (deduped against `existingNames`,
 * same `nextTemplateName`/`nextTemplateId` policy the templates editor uses
 * to avoid two indistinguishable rows).
 */
export function saveCurrentWorkspaceAsTemplate(
  templatesStore: { saveTemplate: (template: WorkspaceTemplate) => void },
  workspace: Pick<Workspace, 'root' | 'name'>,
  sessions: Readonly<Record<number, SessionSummary>>,
  existingIds: readonly string[],
  existingNames: readonly string[],
): WorkspaceTemplate {
  const id = nextTemplateId(existingIds);
  const name = nextTemplateName(workspace.name, existingNames);
  const template = templateFromWorkspace(workspace, sessions, id, name);
  templatesStore.saveTemplate(template);
  return template;
}
