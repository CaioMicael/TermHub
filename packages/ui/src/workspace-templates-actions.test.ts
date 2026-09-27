import { describe, expect, it } from 'vitest';
import type { SessionId, SessionSummary, WorkspaceTemplate } from '@termhub/shared';

import type {
  SessionActionsBridge,
  SessionActionsMethod,
  SessionActionsRequestParams,
  SessionActionsRequestResult,
} from './store/session-actions.js';
import type { StoreState, Workspace } from './store/workspace.js';
import {
  openWorkspaceFromTemplate,
  saveCurrentWorkspaceAsTemplate,
} from './workspace-templates-actions.js';

function session(overrides: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    name: 'agent',
    cwd: 'C:\\repo',
    shell: 'pwsh.exe',
    createdAt: 1_000,
    cols: 80,
    rows: 24,
    status: 'running',
    ...overrides,
  };
}

interface FakeStore {
  getState(): StoreState;
  upsertSession(session: SessionSummary): void;
  addWorkspace(workspace: Workspace, opts?: { activate?: boolean }): void;
  split: never;
  closePane: never;
  addWorkspaceCalls: Array<{ workspace: Workspace; opts: { activate?: boolean } | undefined }>;
  upsertedSessions: SessionSummary[];
}

function makeFakeStore(initial: StoreState): FakeStore {
  let state = initial;
  const addWorkspaceCalls: FakeStore['addWorkspaceCalls'] = [];
  const upsertedSessions: SessionSummary[] = [];
  return {
    getState: () => state,
    upsertSession: (s) => {
      upsertedSessions.push(s);
      state = { ...state, sessions: { ...state.sessions, [s.id]: s } };
    },
    addWorkspace: (workspace, opts) => {
      addWorkspaceCalls.push({ workspace, opts });
      state = { ...state, workspaces: [...state.workspaces, workspace] };
    },
    split: undefined as never,
    closePane: undefined as never,
    addWorkspaceCalls,
    upsertedSessions,
  };
}

function makeFakeBridge(): { bridge: SessionActionsBridge; createCalls: unknown[] } {
  const createCalls: unknown[] = [];
  let nextId = 100;

  function request<M extends SessionActionsMethod>(
    method: M,
    params: SessionActionsRequestParams[M],
  ): Promise<SessionActionsRequestResult[M]> {
    if (method === 'session.create') {
      createCalls.push(params);
      const id = nextId++;
      const createParams = params as SessionActionsRequestParams['session.create'];
      const result: SessionActionsRequestResult['session.create'] = {
        session: session({
          id,
          shell: createParams.shell,
          cwd: createParams.cwd,
          ...(createParams.name !== undefined ? { name: createParams.name } : {}),
          ...(createParams.args !== undefined ? { args: createParams.args } : {}),
          ...(createParams.command !== undefined ? { command: createParams.command } : {}),
        }),
      };
      return Promise.resolve(result) as Promise<SessionActionsRequestResult[M]>;
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  }

  return { bridge: { request }, createCalls };
}

const emptyState: StoreState = { workspaces: [], activeWorkspaceId: undefined, sessions: {} };

describe('openWorkspaceFromTemplate (M4.7): "abrir com um clique"', () => {
  it('creates one session per template session, in order, and lays them out with buildAutoGridTree', async () => {
    const template: WorkspaceTemplate = {
      id: 'tpl-1',
      name: '3 agentes',
      sessions: [
        { name: 'agent-1', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' },
        { name: 'agent-2', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' },
        { name: 'agent-3', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' },
      ],
    };
    const store = makeFakeStore(emptyState);
    const { bridge, createCalls } = makeFakeBridge();

    const workspace = await openWorkspaceFromTemplate(store, bridge, template, {
      cols: 80,
      rows: 24,
    });

    expect(createCalls).toHaveLength(3);
    for (const call of createCalls) {
      expect(call).toMatchObject({ shell: 'pwsh.exe', cwd: 'C:\\repo', command: 'claude' });
    }
    expect(store.upsertedSessions).toHaveLength(3);
    expect(store.addWorkspaceCalls).toHaveLength(1);
    expect(workspace).toBeDefined();
    // 3 sessions -> buildAutoGridTree's own "1 left, 2 stacked right" shape.
    expect(workspace?.root).toEqual({
      kind: 'split',
      id: 'ws-1-1',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 100 },
      b: {
        kind: 'split',
        id: 'ws-1-2',
        dir: 'column',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 101 },
        b: { kind: 'leaf', sessionId: 102 },
      },
    });
    expect(workspace?.focusedSessionId).toBe(100);
    // The tab is named after the template, not the generic "Novo workspace".
    expect(workspace?.name).toBe('3 agentes');
    expect(store.addWorkspaceCalls[0]?.opts).toEqual({ activate: true });
  });

  it('never calls session.create or addWorkspace for an empty template', async () => {
    const template: WorkspaceTemplate = { id: 'tpl-1', name: 'empty', sessions: [] };
    const store = makeFakeStore(emptyState);
    const { bridge, createCalls } = makeFakeBridge();

    const workspace = await openWorkspaceFromTemplate(store, bridge, template, {
      cols: 80,
      rows: 24,
    });

    expect(createCalls).toHaveLength(0);
    expect(store.addWorkspaceCalls).toHaveLength(0);
    expect(workspace).toBeUndefined();
  });

  it('picks a workspace id/name that does not collide with an existing workspace', async () => {
    const template: WorkspaceTemplate = {
      id: 'tpl-1',
      name: 'x',
      sessions: [{ name: 'a', cwd: 'C:\\', shell: 'pwsh.exe' }],
    };
    const existing: Workspace = {
      id: 'ws-1',
      name: 'Novo workspace',
      cwd: 'C:\\',
      root: { kind: 'leaf', sessionId: 1 },
      focusedSessionId: 1,
      maximizedSessionId: undefined,
    };
    const store = makeFakeStore({
      workspaces: [existing],
      activeWorkspaceId: 'ws-1',
      sessions: { 1: session({ id: 1 }) },
    });
    const { bridge } = makeFakeBridge();

    const workspace = await openWorkspaceFromTemplate(store, bridge, template, {
      cols: 80,
      rows: 24,
    });

    expect(workspace?.id).not.toBe('ws-1');
  });
});

describe('saveCurrentWorkspaceAsTemplate (M4.7): "salvar workspace atual como modelo"', () => {
  it('builds a template from the workspace and saves it, naming it after the workspace and deduping the id/name', () => {
    const workspace: Workspace = {
      id: 'ws-a',
      name: 'api-gateway',
      cwd: 'C:\\dev\\api-gateway',
      root: {
        kind: 'split',
        id: 'n1',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 1 },
        b: { kind: 'leaf', sessionId: 2 },
      },
      focusedSessionId: 1,
      maximizedSessionId: undefined,
    };
    const sessions: Record<SessionId, SessionSummary> = {
      1: session({ id: 1, name: 'claude', command: 'claude' }),
      2: session({ id: 2, name: 'pwsh' }),
    };
    const saved: WorkspaceTemplate[] = [];
    const templatesStore = { saveTemplate: (t: WorkspaceTemplate) => saved.push(t) };

    const template = saveCurrentWorkspaceAsTemplate(
      templatesStore,
      workspace,
      sessions,
      ['tpl-1'], // an existing template id — the new one must not collide
      ['api-gateway'], // an existing template name — the new one must not collide
    );

    expect(saved).toEqual([template]);
    expect(template.id).not.toBe('tpl-1');
    expect(template.name).toBe('api-gateway 2');
    expect(template.sessions).toEqual([
      { name: 'claude', cwd: 'C:\\repo', shell: 'pwsh.exe', command: 'claude' },
      { name: 'pwsh', cwd: 'C:\\repo', shell: 'pwsh.exe' },
    ]);
  });
});
