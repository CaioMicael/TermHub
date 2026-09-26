import { describe, expect, it } from 'vitest';

import {
  ConfigSchema,
  defaultConfig,
  defaultWorkspacesFile,
  WorkspacesFileSchema,
  type PersistedPaneNode,
  type WorkspacesFile,
} from './config-schema.js';

const leaf = (sessionId: number): PersistedPaneNode => ({ kind: 'leaf', sessionId });

function validWorkspacesFile(): WorkspacesFile {
  return {
    version: 1,
    activeWorkspaceId: 'ws-a',
    workspaces: [
      {
        id: 'ws-a',
        name: 'grid',
        cwd: 'C:\\w',
        focusedSessionId: 1,
        root: {
          kind: 'split',
          id: 'n1',
          dir: 'column',
          ratio: 0.5,
          a: { kind: 'split', id: 'n2', dir: 'row', ratio: 0.3, a: leaf(1), b: leaf(2) },
          b: leaf(3),
        },
      },
      { id: 'ws-b', name: 'empty', cwd: 'C:\\x', root: null },
    ],
  };
}

describe('ConfigSchema: per-field fallback', () => {
  it('accepts a valid file as is', () => {
    expect(ConfigSchema.parse({ version: 1, graveyardTtlMinutes: 30 })).toEqual({
      version: 1,
      graveyardTtlMinutes: 30,
    });
  });

  it('replaces only the invalid field with its default, keeping the valid ones', () => {
    // version is valid and stays; the TTL is out of range and falls back.
    expect(ConfigSchema.parse({ version: 1, graveyardTtlMinutes: 0 })).toEqual(defaultConfig());
    expect(ConfigSchema.parse({ version: 1, graveyardTtlMinutes: 'ten' }).graveyardTtlMinutes).toBe(
      10,
    );
    expect(ConfigSchema.parse({ version: 1, graveyardTtlMinutes: 2.5 }).graveyardTtlMinutes).toBe(
      10,
    );
  });

  it('fills a field missing from an older file with its default', () => {
    expect(ConfigSchema.parse({ version: 1 })).toEqual(defaultConfig());
  });

  it('keeps a valid field when a sibling is broken', () => {
    expect(ConfigSchema.parse({ version: 'x', graveyardTtlMinutes: 45 })).toEqual({
      version: 1,
      graveyardTtlMinutes: 45,
    });
  });

  it('rejects a value that is not an object at all', () => {
    expect(ConfigSchema.safeParse([1, 2]).success).toBe(false);
    expect(ConfigSchema.safeParse(null).success).toBe(false);
  });
});

describe('WorkspacesFileSchema: whole-file validation', () => {
  it('accepts a valid layout, including an empty workspace', () => {
    expect(WorkspacesFileSchema.parse(validWorkspacesFile())).toEqual(validWorkspacesFile());
  });

  it('accepts the default file', () => {
    expect(WorkspacesFileSchema.safeParse(defaultWorkspacesFile()).success).toBe(true);
  });

  it('rejects a ratio outside [0.1, 0.9] instead of clamping it', () => {
    const file = validWorkspacesFile();
    const [first] = file.workspaces;
    if (first?.root?.kind !== 'split') {
      throw new Error('fixture: first workspace must start with a split');
    }
    first.root = { ...first.root, ratio: 0.95 };
    expect(WorkspacesFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a session id in two leaves of the same workspace', () => {
    const file = validWorkspacesFile();
    file.workspaces[1] = { id: 'ws-b', name: 'dup', cwd: 'C:\\x', root: leaf(9) };
    const [first] = file.workspaces;
    if (first === undefined) {
      throw new Error('fixture: missing first workspace');
    }
    first.root = { kind: 'split', id: 'n9', dir: 'row', ratio: 0.5, a: leaf(4), b: leaf(4) };
    expect(WorkspacesFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a session id repeated across two workspaces', () => {
    const file = validWorkspacesFile();
    file.workspaces[1] = { id: 'ws-b', name: 'dup', cwd: 'C:\\x', root: leaf(2) };
    expect(WorkspacesFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects an activeWorkspaceId that is not in the file', () => {
    expect(
      WorkspacesFileSchema.safeParse({ ...validWorkspacesFile(), activeWorkspaceId: 'nope' })
        .success,
    ).toBe(false);
  });

  it('rejects duplicate workspace ids', () => {
    const file = validWorkspacesFile();
    file.workspaces[1] = { id: 'ws-a', name: 'again', cwd: 'C:\\x', root: null };
    expect(WorkspacesFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a malformed tree node', () => {
    const file = validWorkspacesFile();
    const [first] = file.workspaces;
    if (first === undefined) {
      throw new Error('fixture: missing first workspace');
    }
    // A structurally broken node, as a truncated or hand-edited file would have.
    const broken: unknown = { kind: 'split', id: 'n1', dir: 'diagonal', ratio: 0.5, a: leaf(1) };
    expect(
      WorkspacesFileSchema.safeParse({ ...file, workspaces: [{ ...first, root: broken }] }).success,
    ).toBe(false);
  });

  it('rejects a version other than 1', () => {
    expect(WorkspacesFileSchema.safeParse({ ...validWorkspacesFile(), version: 2 }).success).toBe(
      false,
    );
  });
});
