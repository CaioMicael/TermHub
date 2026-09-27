// M4.7: pure logic behind the sidebar's "Workspaces" view — building a
// template from an existing workspace, and laying out a brand-new
// workspace's grid once every one of a template's sessions has been
// created. No React, no Zustand, no daemon/bridge access — same posture
// `layout-persistence.ts`'s own header comment gives, and for the same
// reason: `workspace-templates.test.ts` drives every function here with
// plain values, no DOM.
//
// `workspace-templates-actions.ts` is the impure layer on top of this one —
// it's what actually calls `session.create` for each of a template's
// sessions and applies the resulting tree to the store. This module only
// ever answers "what should the tree look like" and "what does this
// workspace's current shape look like as a template", never "make it so".

import type { SessionId, SessionSummary, WorkspaceTemplate } from '@termhub/shared';

import { DEFAULT_RATIO, makeLeaf, treeLeaves, type PaneNode } from './store/tree.js';
import type { Workspace } from './store/workspace.js';

// ---------------------------------------------------------------------------
// buildAutoGridTree — "abrir com um clique" lays out N sessions automatically
// ---------------------------------------------------------------------------

/**
 * Builds the automatic grid this task's prompt specifies (section 3): 1
 * session alone, 2 side by side, 3 with one on the left and two stacked on
 * the right, 4 in a 2x2, and more than that in balanced rows — each row an
 * even split of its own sessions, rows themselves stacked evenly top to
 * bottom. Node ids are minted from a counter local to this call
 * (`${nodeIdPrefix}-${n}`), the same determinism `tree.ts`'s own
 * `treeFromSessions` already relies on for the same reason: two calls in
 * the same "open" must pass different prefixes to avoid colliding split
 * node ids across workspaces.
 *
 * `dir: 'row'` means side by side, `dir: 'column'` means stacked — the same
 * convention every other tree-building function in this codebase uses
 * (`estimateSplitSize`'s own doc comment, `store/session-actions.ts`).
 *
 * Empty input yields `null` (an empty workspace) — defensive; a template
 * this function is ever called for always has at least one session
 * (`WorkspaceTemplateSchema`'s own `sessions` array is never required to be
 * non-empty by the schema, but the editor UI never lets one be saved with
 * zero, so this is a "never observed in practice" guard, not a real path).
 */
export function buildAutoGridTree(
  sessionIds: readonly SessionId[],
  nodeIdPrefix = 'grid',
): PaneNode | null {
  const n = sessionIds.length;
  if (n === 0) {
    return null;
  }

  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `${nodeIdPrefix}-${counter}`;
  };

  /** A balanced binary split of `ids`, all along `dir` — used both for one grid row's own sessions (`dir: 'row'`) and for stacking rows on top of each other (`dir: 'column'`). */
  function balanced(nodes: readonly PaneNode[], dir: 'row' | 'column'): PaneNode {
    if (nodes.length === 1) {
      // `nodes` is never empty when this is called (every caller below
      // only ever passes a non-empty slice), so `nodes[0]` is always
      // defined — asserted rather than re-guarded, to keep this small
      // helper's own signature simple.
      return nodes[0] as PaneNode;
    }
    const mid = Math.ceil(nodes.length / 2);
    return {
      kind: 'split',
      id: nextId(),
      dir,
      ratio: DEFAULT_RATIO,
      a: balanced(nodes.slice(0, mid), dir),
      b: balanced(nodes.slice(mid), dir),
    };
  }

  function rowOf(ids: readonly SessionId[]): PaneNode {
    return balanced(
      ids.map((id) => makeLeaf(id)),
      'row',
    );
  }

  if (n === 1) {
    return makeLeaf(sessionIds[0] as SessionId);
  }
  if (n === 2) {
    return rowOf(sessionIds); // side by side
  }
  if (n === 3) {
    // One alone on the left, two stacked on the right.
    return {
      kind: 'split',
      id: nextId(),
      dir: 'row',
      ratio: DEFAULT_RATIO,
      a: makeLeaf(sessionIds[0] as SessionId),
      b: balanced(
        [makeLeaf(sessionIds[1] as SessionId), makeLeaf(sessionIds[2] as SessionId)],
        'column',
      ),
    };
  }
  if (n === 4) {
    // 2x2: two rows of two, stacked.
    return balanced([rowOf(sessionIds.slice(0, 2)), rowOf(sessionIds.slice(2, 4))], 'column');
  }

  // More than 4: balanced rows, as square-ish as possible. `rows` sessions
  // laid out top to bottom, each one an even split of up to `perRow`
  // sessions side by side.
  const rows = Math.ceil(Math.sqrt(n));
  const perRow = Math.ceil(n / rows);
  const rowGroups: SessionId[][] = [];
  for (let i = 0; i < n; i += perRow) {
    rowGroups.push(sessionIds.slice(i, i + perRow));
  }
  return balanced(
    rowGroups.map((group) => rowOf(group)),
    'column',
  );
}

// ---------------------------------------------------------------------------
// templateFromWorkspace — "salvar workspace atual como modelo"
// ---------------------------------------------------------------------------

/**
 * Builds a `WorkspaceTemplate` from `workspace`'s current panes, one
 * template session per leaf, in `treeLeaves` order (left to right, top to
 * bottom — the same order the workspace itself reads). A leaf whose session
 * metadata isn't in `sessions` (shouldn't happen for a workspace actually on
 * screen, since every placed leaf always has an `upsertSession` behind it —
 * defensive, not expected) is simply skipped rather than guessed at.
 *
 * `id`/`name` are the caller's to mint (`workspace-templates-actions.ts`
 * generates the id; `name` defaults to the workspace's own `name` there) —
 * kept out of this function so it stays deterministic and free of
 * `crypto.randomUUID()`, same reasoning `tab-bar-actions.ts`'s own
 * `generateWorkspaceId`/`createWorkspaceTab` split follows.
 */
export function templateFromWorkspace(
  workspace: Pick<Workspace, 'root'>,
  sessions: Readonly<Record<SessionId, SessionSummary>>,
  id: string,
  name: string,
): WorkspaceTemplate {
  const templateSessions = treeLeaves(workspace.root)
    .map((leaf) => sessions[leaf.sessionId])
    .filter((session): session is SessionSummary => session !== undefined)
    .map((session) => ({
      name: session.name,
      cwd: session.cwd,
      shell: session.shell,
      ...(session.args !== undefined ? { args: session.args } : {}),
      ...(session.command !== undefined ? { command: session.command } : {}),
    }));
  return { id, name, sessions: templateSessions };
}

// ---------------------------------------------------------------------------
// Naming helpers — same "pick something that doesn't collide" convention
// `tab-bar-actions.ts`'s own `generateWorkspaceId`/`nextWorkspaceName` use
// ---------------------------------------------------------------------------

/** Picks a template id that doesn't collide with any id in `existingIds`. */
export function nextTemplateId(existingIds: readonly string[]): string {
  const existing = new Set(existingIds);
  let n = existing.size + 1;
  let candidate = `tpl-${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `tpl-${n}`;
  }
  return candidate;
}

/** Picks a display name that doesn't collide with any name in `existingNames` — `base`, then `base 2`, `base 3`, ... */
export function nextTemplateName(base: string, existingNames: readonly string[]): string {
  const existing = new Set(existingNames);
  if (!existing.has(base)) {
    return base;
  }
  let n = 2;
  let candidate = `${base} ${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${base} ${n}`;
  }
  return candidate;
}
