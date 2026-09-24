// The Zustand store: a thin wrapper that owns no logic of its own besides
// calling `workspace.ts`'s pure reducers and handing Zustand the result
// (M3.1's prompt, section 3.2). Every method here is `state => reducer(state,
// ...args)` — if a bug shows up in *what* a mutation does, it's in
// `workspace.ts`/`tree.ts`, not here.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { SessionId, SessionSummary } from '@termhub/shared';

import type { MoveEdge, SplitDirection } from './tree.js';
import * as reducers from './workspace.js';
import type { StoreState, Workspace } from './workspace.js';

export type { StoreState, Workspace } from './workspace.js';

export const initialStoreState: StoreState = {
  workspaces: [],
  activeWorkspaceId: undefined,
  sessions: {},
};

// Every action below is typed with property (arrow-function) syntax,
// `name: (args) => void`, not TypeScript's shorthand method syntax
// `name(args): void`. The two are otherwise equivalent, but method syntax
// makes `@typescript-eslint/unbound-method` (typescript-rules.md's
// non-negotiable list doesn't include it, but the project's flat config
// still enables it) flag every consumer that reads `useTermhubStore(s =>
// s.setActiveWorkspace)` — a plain property read, never a `this`-using
// call — as a potential unbound-`this` footgun. Property syntax sidesteps
// the false positive instead of sprinkling `eslint-disable` at every call
// site (typescript-rules.md: disabling a rule to unblock a task is
// forbidden regardless of which file the disable would live in).
export interface TermhubStoreActions {
  split: (
    workspaceId: string,
    targetSessionId: SessionId,
    newSessionId: SessionId,
    dir: SplitDirection,
    newNodeId: string,
  ) => void;
  closePane: (workspaceId: string, sessionId: SessionId) => void;
  movePane: (
    workspaceId: string,
    sourceSessionId: SessionId,
    targetSessionId: SessionId,
    edge: MoveEdge,
    newNodeId: string,
  ) => void;
  setRatio: (workspaceId: string, nodeId: string, ratio: number) => void;
  focusPane: (workspaceId: string, sessionId: SessionId) => void;
  toggleMaximize: (workspaceId: string, sessionId: SessionId) => void;
  addWorkspace: (workspace: Workspace, opts?: { activate?: boolean }) => void;
  closeWorkspace: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string) => void;
  reorderWorkspaces: (workspaceIds: readonly string[]) => void;
  renameWorkspace: (workspaceId: string, name: string) => void;
  upsertSession: (session: SessionSummary) => void;
  removeSession: (sessionId: SessionId) => void;
  /**
   * Replaces the entire store state at once. The one exception to "every
   * method just calls a `workspace.ts` reducer": `session-boot.ts`'s
   * multi-session reconciled boot (M3.1's prompt, section 3.4) builds a
   * whole workspace (via `treeFromSessions`) plus every session's metadata
   * in one pass, and applying that as a single `set` avoids the store
   * briefly rendering an intermediate state with an empty `sessions` map for
   * a workspace whose tree already references them.
   */
  hydrate: (state: StoreState) => void;
}

export type TermhubStore = StoreState & TermhubStoreActions;

export const useTermhubStore: UseBoundStore<StoreApi<TermhubStore>> = create<TermhubStore>(
  (set) => ({
    ...initialStoreState,
    split: (workspaceId, targetSessionId, newSessionId, dir, newNodeId) => {
      set((state) =>
        reducers.splitInWorkspace(
          state,
          workspaceId,
          targetSessionId,
          newSessionId,
          dir,
          newNodeId,
        ),
      );
    },
    closePane: (workspaceId, sessionId) => {
      set((state) => reducers.closePaneInWorkspace(state, workspaceId, sessionId));
    },
    movePane: (workspaceId, sourceSessionId, targetSessionId, edge, newNodeId) => {
      set((state) =>
        reducers.movePaneInWorkspace(
          state,
          workspaceId,
          sourceSessionId,
          targetSessionId,
          edge,
          newNodeId,
        ),
      );
    },
    setRatio: (workspaceId, nodeId, ratio) => {
      set((state) => reducers.setRatioInWorkspace(state, workspaceId, nodeId, ratio));
    },
    focusPane: (workspaceId, sessionId) => {
      set((state) => reducers.focusPane(state, workspaceId, sessionId));
    },
    toggleMaximize: (workspaceId, sessionId) => {
      set((state) => reducers.toggleMaximize(state, workspaceId, sessionId));
    },
    addWorkspace: (workspace, opts) => {
      set((state) => reducers.addWorkspace(state, workspace, opts));
    },
    closeWorkspace: (workspaceId) => {
      set((state) => reducers.closeWorkspace(state, workspaceId));
    },
    setActiveWorkspace: (workspaceId) => {
      set((state) => reducers.setActiveWorkspace(state, workspaceId));
    },
    reorderWorkspaces: (workspaceIds) => {
      set((state) => reducers.reorderWorkspaces(state, workspaceIds));
    },
    renameWorkspace: (workspaceId, name) => {
      set((state) => reducers.renameWorkspace(state, workspaceId, name));
    },
    upsertSession: (session) => {
      set((state) => reducers.upsertSession(state, session));
    },
    removeSession: (sessionId) => {
      set((state) => reducers.removeSession(state, sessionId));
    },
    hydrate: (next) => {
      set(() => next);
    },
  }),
);
