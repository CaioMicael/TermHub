import { z } from 'zod';

// Schemas for the app's two state files in `%APPDATA%/TermHub`:
// `config.json` and `workspaces.json` (docs/specs/m4.1-atomic-state.md
// section 3.4). The main process validates with these on load and before
// every write (`packages/app/src/main/store-files.ts`).
//
// This package is consumed as *source* by the renderer, so nothing here may
// touch Node: no `node:*` imports, no `Buffer`, no `process`. M3.1 broke the
// renderer's typecheck in CI with exactly that (commit 9680378).

/** Highest `config.json` format this build reads and writes. */
export const CONFIG_VERSION = 1;
/** Highest `workspaces.json` format this build reads and writes. */
export const WORKSPACES_VERSION = 1;

/** Same bounds as `MIN_RATIO`/`MAX_RATIO` in packages/ui/src/store/tree.ts. A persisted ratio outside them is rejected, not clamped: it only gets there by hand-editing or corruption. */
export const PERSISTED_MIN_RATIO = 0.1;
export const PERSISTED_MAX_RATIO = 0.9;

export const DEFAULT_GRAVEYARD_TTL_MINUTES = 10;

/**
 * `config.json`. Settings are independent of each other, so every field
 * falls back to its own default on a bad value (`.catch`), keeping the valid
 * ones — one broken setting never resets the rest. Fields added later must
 * come with a default too, so an older file without them stays valid.
 */
export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).catch(CONFIG_VERSION),
  graveyardTtlMinutes: z.number().int().min(1).max(1440).catch(DEFAULT_GRAVEYARD_TTL_MINUTES),
});

export type ConfigFile = z.infer<typeof ConfigSchema>;

export function defaultConfig(): ConfigFile {
  return { version: CONFIG_VERSION, graveyardTtlMinutes: DEFAULT_GRAVEYARD_TTL_MINUTES };
}

/**
 * M4.7: what it takes to relaunch a session from scratch — a `session.create`
 * call's own shape, minus `cols`/`rows` (the caller's job to supply, from
 * whatever size the pane actually is at relaunch time). Shared by a
 * persisted leaf's own `launch` (below) and by a workspace template's
 * per-session spec (`WorkspaceTemplate.sessions`) — both are "how do I spawn
 * this session again", just reached from a different place (one leaf,
 * one template row).
 */
export const LaunchSpecSchema = z.object({
  name: z.string().optional(),
  cwd: z.string(),
  shell: z.string(),
  args: z.array(z.string()).optional(),
  command: z.string().optional(),
});
export type LaunchSpec = z.infer<typeof LaunchSpecSchema>;

/**
 * Persisted form of `PaneNode` (packages/ui/src/store/tree.ts). The leaf
 * carries `sessionCreatedAt` on top of the live `PaneNode`'s `sessionId`
 * (M4.3, docs/milestones.md): the daemon renumbers session ids from 1 on
 * every restart, so a leaf that matched "session 3" before a restart could
 * silently match an unrelated new "session 3" afterwards if only the id
 * were compared. A persisted leaf only matches a live session when **both**
 * `sessionId` and `sessionCreatedAt` agree (`packages/ui/src/
 * layout-persistence.ts`'s `reconcileLayout`).
 *
 * `launch` (M4.7) is optional and filled in by `toPersistedLayout` from the
 * session's own `SessionSummary` at save time — a `workspaces.json` written
 * before this task, or a leaf whose session metadata wasn't known at save
 * time, simply has no `launch`, and stays perfectly valid: a dead leaf with
 * no `launch` is dropped on reconciliation exactly as before this task, only
 * a dead leaf *with* one is a candidate for `reconcileLayout`'s relaunch.
 */
export type PersistedPaneNode =
  | { kind: 'leaf'; sessionId: number; sessionCreatedAt: number; launch?: LaunchSpec | undefined }
  | {
      kind: 'split';
      id: string;
      dir: 'row' | 'column';
      ratio: number;
      a: PersistedPaneNode;
      b: PersistedPaneNode;
    };

const PaneNodeSchema: z.ZodType<PersistedPaneNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('leaf'),
      sessionId: z.number().int(),
      sessionCreatedAt: z.number().int(),
      launch: LaunchSpecSchema.optional(),
    }),
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1),
      dir: z.enum(['row', 'column']),
      ratio: z.number().finite().min(PERSISTED_MIN_RATIO).max(PERSISTED_MAX_RATIO),
      a: PaneNodeSchema,
      b: PaneNodeSchema,
    }),
  ]),
);

const PersistedWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  cwd: z.string(),
  root: PaneNodeSchema.nullable(),
  focusedSessionId: z.number().int().optional(),
});

export type PersistedWorkspace = z.infer<typeof PersistedWorkspaceSchema>;

function collectLeafSessionIds(node: PersistedPaneNode | null, into: number[]): void {
  if (node === null) {
    return;
  }
  if (node.kind === 'leaf') {
    into.push(node.sessionId);
    return;
  }
  collectLeafSessionIds(node.a, into);
  collectLeafSessionIds(node.b, into);
}

/**
 * M4.7: one row of a workspace template's per-session spec — the same
 * shape as a persisted leaf's `LaunchSpec`, `name` included since a
 * template session (unlike a leaf, which always has a live/former
 * `SessionSummary` to fall back to) has nothing else to name it by.
 */
export const WorkspaceTemplateSessionSchema = z.object({
  name: z.string(),
  cwd: z.string(),
  shell: z.string(),
  args: z.array(z.string()).optional(),
  command: z.string().optional(),
});
export type WorkspaceTemplateSession = z.infer<typeof WorkspaceTemplateSessionSchema>;

/**
 * M4.7: "define 3 agentes num workspace e abra tudo com um clique" —
 * `templates` (below) is an array of these, persisted alongside the layout
 * itself (same `workspaces.json`, same `layoutSave` path) since both are
 * just different views of "what sessions a workspace should have".
 */
export const WorkspaceTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  sessions: z.array(WorkspaceTemplateSessionSchema),
});
export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplateSchema>;

/**
 * `workspaces.json`. Validated as a whole, unlike `config.json`: the layout
 * has invariants that cross workspaces, and accepting part of a layout could
 * break them. The content of the layout belongs to M4.3, which may change
 * this schema without a migration until the first release that writes it.
 */
export const WorkspacesFileSchema = z
  .object({
    version: z.literal(WORKSPACES_VERSION),
    activeWorkspaceId: z.string().optional(),
    workspaces: z.array(PersistedWorkspaceSchema),
    /** M4.7. Optional so a `workspaces.json` written before this task — or one nobody has ever saved a template into — stays valid with no migration. */
    templates: z.array(WorkspaceTemplateSchema).optional(),
  })
  .superRefine((file, ctx) => {
    const workspaceIds = new Set<string>();
    for (const workspace of file.workspaces) {
      if (workspaceIds.has(workspace.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate workspace id "${workspace.id}"` });
      }
      workspaceIds.add(workspace.id);
    }

    const templateIds = new Set<string>();
    for (const template of file.templates ?? []) {
      if (templateIds.has(template.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate template id "${template.id}"` });
      }
      templateIds.add(template.id);
    }

    // One session per leaf, across every workspace (M3.1's invariant).
    const sessionIds: number[] = [];
    for (const workspace of file.workspaces) {
      collectLeafSessionIds(workspace.root, sessionIds);
    }
    const seen = new Set<number>();
    for (const sessionId of sessionIds) {
      if (seen.has(sessionId)) {
        ctx.addIssue({
          code: 'custom',
          message: `session ${sessionId} appears in more than one leaf`,
        });
      }
      seen.add(sessionId);
    }

    if (file.activeWorkspaceId !== undefined && !workspaceIds.has(file.activeWorkspaceId)) {
      ctx.addIssue({
        code: 'custom',
        message: `activeWorkspaceId "${file.activeWorkspaceId}" is not a workspace in this file`,
      });
    }
  });

export type WorkspacesFile = z.infer<typeof WorkspacesFileSchema>;

export function defaultWorkspacesFile(): WorkspacesFile {
  return { version: WORKSPACES_VERSION, workspaces: [] };
}
