import { useState } from 'react';
import type { SessionStatus } from '@termhub/shared';

import { selectAggregatedWorkspaceStatus, selectSessionCount } from './store/selectors.js';
import type { SessionActionsBridge, SessionActionsStoreApi } from './store/session-actions.js';
import { useTermhubStore } from './store/store.js';
import type { Workspace } from './store/workspace.js';
import {
  canCloseWorkspace,
  closeWorkspaceTab,
  createWorkspaceTab,
  type CloseWorkspaceStoreApi,
} from './tab-bar-actions.js';
import './tab-bar.css';

export interface TabBarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | undefined;
  onSelect: (workspaceId: string) => void;
  /**
   * The daemon RPC bridge the `+` button's `createWorkspaceTab` call needs
   * for `session.create`. Injected by the caller (`App.tsx` passes
   * `window.termhub`, the same way it already does for `SplitTree`'s own
   * `bridge` prop) rather than read off `window` in here — `@termhub/ui`
   * never reads a global of the Electron renderer directly (the same rule
   * `Terminal.tsx`/`SplitTree.tsx` already follow); doing so would tie this
   * package to that one runtime and make the dependency invisible to a
   * test. See `session-actions.ts`'s `SessionActionsBridge` for why this is
   * the same minimal structural type rather than the app's full
   * `PreloadBridge`.
   */
  bridge: SessionActionsBridge;
}

/**
 * M3.3's real `TabBar.tsx` — one tab per workspace (docs/plan.md section 2:
 * "aba = workspace"), matching `termhub-prototipo.html`'s `.tabbar`/`.tab`
 * exactly (colors/spacing in `tab-bar.css`). Replaces M3.1's plain-button
 * placeholder.
 *
 * `useTermhubStore` is read directly for `closeWorkspace` and for the
 * per-tab status/count selectors — `store.ts`'s hook is `@termhub/ui`'s own
 * singleton (the same one `App.tsx` already reads), not a foreign
 * dependency, and `SplitTree.tsx` already establishes this as fine. The
 * daemon bridge, by contrast, comes in as a prop (`TabBarProps.bridge`) —
 * see that prop's doc comment for why reading `window.termhub` in here
 * instead was rejected in review.
 */

const STATUS_DOT_COLOR: Record<SessionStatus | 'empty', string> = {
  running: '#89d185', // prototype --st-run
  'awaiting-input': '#ffcc00', // prototype --st-wait
  idle: '#6e7681', // prototype --st-idle
  exited: '#f14c4c', // prototype --st-err
  empty: '#6e7681', // no panes yet — rendered the same as idle (selectors.ts's own doc comment)
};

const sessionActionsStore: SessionActionsStoreApi = {
  getState: () => useTermhubStore.getState(),
  upsertSession: (session) => {
    useTermhubStore.getState().upsertSession(session);
  },
  split: (workspaceId, targetSessionId, newSessionId, dir, newNodeId) => {
    useTermhubStore.getState().split(workspaceId, targetSessionId, newSessionId, dir, newNodeId);
  },
  addWorkspace: (workspace, opts) => {
    useTermhubStore.getState().addWorkspace(workspace, opts);
  },
  closePane: (workspaceId, sessionId) => {
    useTermhubStore.getState().closePane(workspaceId, sessionId);
  },
};

const closeWorkspaceStore: CloseWorkspaceStoreApi = {
  closeWorkspace: (workspaceId) => {
    useTermhubStore.getState().closeWorkspace(workspaceId);
  },
};

export function TabBar({ workspaces, activeWorkspaceId, onSelect, bridge }: TabBarProps) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const handleCreate = () => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    setCreating(true);
    setCreateError(undefined);
    createWorkspaceTab(sessionActionsStore, bridge, active)
      .catch((err: unknown) => {
        setCreateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setCreating(false);
      });
  };

  return (
    <div
      style={{
        height: 35,
        flex: '0 0 35px',
        display: 'flex',
        alignItems: 'stretch',
        background: '#252526', // prototype --bg-side
        userSelect: 'none',
      }}
      title={createError}
    >
      {workspaces.map((workspace) => (
        <Tab
          key={workspace.id}
          workspace={workspace}
          active={workspace.id === activeWorkspaceId}
          workspaceCount={workspaces.length}
          onSelect={onSelect}
        />
      ))}
      <button
        type="button"
        className="th-tab-add"
        title="Novo workspace"
        disabled={creating}
        onClick={handleCreate}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        >
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * One tab. Subscribes to the store itself, scoped to just this workspace's
 * aggregated status and session count (`selectAggregatedWorkspaceStatus`/
 * `selectSessionCount`) — armadilha 2 (M3.3's prompt): calling a store
 * selector inside the parent's `.map` would either violate the rules of
 * hooks (a selector call isn't a hook by itself, but reading the *whole*
 * store in the parent to compute every tab's status would) or re-render
 * every tab whenever any session anywhere changes. A `Tab` component per
 * workspace, each with its own `useTermhubStore(state => selector(state,
 * workspace.id))` call, re-renders only when *that* workspace's own
 * status/count actually changes.
 */
function Tab({
  workspace,
  active,
  workspaceCount,
  onSelect,
}: {
  workspace: Workspace;
  active: boolean;
  workspaceCount: number;
  onSelect: (workspaceId: string) => void;
}) {
  const status = useTermhubStore((state) => selectAggregatedWorkspaceStatus(state, workspace.id));
  const count = useTermhubStore((state) => selectSessionCount(state, workspace.id));
  const closable = canCloseWorkspace(workspaceCount);

  return (
    <div
      className={active ? 'th-tab th-tab-active' : 'th-tab'}
      onClick={() => {
        onSelect(workspace.id);
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: STATUS_DOT_COLOR[status],
        }}
      />
      <span className="th-tab-name">{workspace.name}</span>
      <span className="th-tab-count">{count}</span>
      <button
        type="button"
        className="th-tab-close"
        title={closable ? 'Fechar aba' : 'O último workspace não pode ser fechado'}
        disabled={!closable}
        onClick={(event) => {
          event.stopPropagation();
          closeWorkspaceTab(closeWorkspaceStore, workspace.id, workspaceCount);
        }}
      >
        &#10005;
      </button>
    </div>
  );
}
