import { useState, type MouseEvent } from 'react';

import type { SidebarView } from './ActivityBar.js';
import { splitPaneFromHeader } from './pane-header-actions.js';
import { paneStatusVisual } from './pane-header-status.js';
import {
  activeFocusedTarget,
  buildSidebarGroups,
  type SidebarGroup,
  type SidebarRow,
} from './sidebar-model.js';
import './sidebar.css';
import {
  closePaneAction,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
} from './store/session-actions.js';
import { useTermhubStore } from './store/store.js';

export interface SidebarProps {
  view: SidebarView;
  /**
   * The daemon RPC bridge the "dividir"/"novo terminal" actions need for
   * `session.create` (`splitPaneWithNewSession`'s round trip) — injected by
   * the caller (`App.tsx` passes `window.termhub`), the same reasoning
   * `TabBar.tsx`'s own `bridge` prop doc comment gives: `@termhub/ui` never
   * reads a global of the Electron renderer directly.
   */
  bridge: SessionActionsBridge;
}

const VIEW_TITLES: Record<SidebarView, string> = {
  terminals: 'Terminais',
  search: 'Busca global',
  workspaces: 'Workspaces',
  profiles: 'Perfis de shell',
};

// Thin adapters from `useTermhubStore` to `SessionActionsStoreApi` — the
// same pattern `TabBar.tsx`/`PaneHeader.tsx` already establish for the same
// reason (see either's own doc comment on its module-level
// `sessionActionsStore` constant).
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

function ChevIcon() {
  return (
    <svg
      className="th-chev"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
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
  );
}

function SplitIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

function CollapseAllIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M3 6l3-3 3 3M3 10l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5v6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * M4.2's real `Sidebar.tsx` — the 270px tree view of workspace → sessions,
 * matching `termhub-prototipo.html`'s `.sidebar`/`.side-title`/`.group`/
 * `.row` (colors/spacing in `sidebar.css`).
 *
 * Only the `'terminals'` view has real content — `'search'` is M6's job,
 * `'profiles'` is M4.6's, and `'workspaces'` has no task assigned to it yet
 * in docs/milestones.md; all three render **just the title**, per this
 * task's prompt (section 2: "as vistas que não são Terminais ficam vazias,
 * só com o título" — no fabricated content for them, and no title-bar
 * actions either, since "Novo terminal"/"Dividir painel"/"Recolher tudo" are
 * all terminals-tree actions with nothing to act on in an empty view).
 *
 * Collapsed-group state is local React state (`collapsed`, a `Set` of
 * workspace ids) — persisting it across a reload is M4.3's job (this task's
 * prompt, section 2: "persistir é da M4.3").
 */
export function Sidebar({ view, bridge }: SidebarProps) {
  const workspaces = useTermhubStore((s) => s.workspaces);
  const sessions = useTermhubStore((s) => s.sessions);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const groups = buildSidebarGroups({ workspaces, sessions, activeWorkspaceId });

  // "Novo terminal" and "Dividir painel" both trigger this — there is no
  // other session-creation flow inside a workspace today (this task's final
  // report explains the decision). Splits the *active* workspace's *focused*
  // pane, same as `PaneHeader.tsx`'s own "dividir" button does for one
  // specific pane.
  const splitFocusedPane = () => {
    const target = activeFocusedTarget({ workspaces, sessions, activeWorkspaceId });
    if (target === undefined) {
      return;
    }
    void splitPaneFromHeader(sessionActionsStore, bridge, {
      workspaceId: target.workspaceId,
      targetSessionId: target.sessionId,
      dir: 'row',
    });
  };

  const collapseAll = () => {
    setCollapsed(new Set(groups.map((g) => g.workspaceId)));
  };

  const toggleGroup = (workspaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  const canSplit = activeFocusedTarget({ workspaces, sessions, activeWorkspaceId }) !== undefined;

  return (
    <div className="th-sidebar">
      <div className="th-side-title">
        <span>{VIEW_TITLES[view]}</span>
        {view === 'terminals' && (
          <div className="th-side-acts">
            <button
              type="button"
              className="th-icon-btn"
              title="Novo terminal"
              disabled={!canSplit}
              onClick={splitFocusedPane}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="th-icon-btn"
              title="Dividir painel"
              disabled={!canSplit}
              onClick={splitFocusedPane}
            >
              <SplitIcon />
            </button>
            <button
              type="button"
              className="th-icon-btn"
              title="Recolher tudo"
              onClick={collapseAll}
            >
              <CollapseAllIcon />
            </button>
          </div>
        )}
      </div>
      <div className="th-side-body">
        {view === 'terminals' &&
          groups.map((group) => (
            <SidebarGroupView
              key={group.workspaceId}
              group={group}
              collapsed={collapsed.has(group.workspaceId)}
              onToggle={() => {
                toggleGroup(group.workspaceId);
              }}
              bridge={bridge}
            />
          ))}
      </div>
    </div>
  );
}

function SidebarGroupView({
  group,
  collapsed,
  onToggle,
  bridge,
}: {
  group: SidebarGroup;
  collapsed: boolean;
  onToggle: () => void;
  bridge: SessionActionsBridge;
}) {
  return (
    <div className={collapsed ? 'th-group th-group-collapsed' : 'th-group'}>
      <div className="th-group-head" onClick={onToggle}>
        <ChevIcon />
        <span className="th-group-name">{group.name}</span>
        <span className="th-group-path" title={group.cwd}>
          {group.cwd}
        </span>
        <span className="th-group-count">
          {group.waiting && <span className="th-group-waiting-mark">◆</span>}
          {group.sessionCount}
        </span>
      </div>
      <div className="th-group-items">
        {group.rows.map((row) => (
          <SidebarRowView key={row.sessionId} row={row} bridge={bridge} />
        ))}
      </div>
    </div>
  );
}

function SidebarRowView({ row, bridge }: { row: SidebarRow; bridge: SessionActionsBridge }) {
  const focusThisRow = () => {
    useTermhubStore.getState().focusPane(row.workspaceId, row.sessionId);
  };

  if (row.session === undefined) {
    // Same gap `PaneHeader.tsx`'s own early return covers: a leaf whose
    // session metadata hasn't landed in the store yet. A neutral row, still
    // clickable (focusing a pane that exists in the tree is always valid),
    // no name/status/actions to invent.
    return (
      <div className={row.active ? 'th-row th-row-active' : 'th-row'} onClick={focusThisRow} />
    );
  }

  const visual = paneStatusVisual(row.session.status, row.session.exitCode);
  const dotClassName = [
    'th-row-dot',
    visual.modifier === '' ? '' : `th-row-dot--${visual.modifier}`,
  ]
    .filter((c) => c !== '')
    .join(' ');

  const handleSplit = (event: MouseEvent) => {
    event.stopPropagation();
    void splitPaneFromHeader(sessionActionsStore, bridge, {
      workspaceId: row.workspaceId,
      targetSessionId: row.sessionId,
      dir: 'row',
    });
  };
  const handleClose = (event: MouseEvent) => {
    event.stopPropagation();
    closePaneAction(sessionActionsStore, row.workspaceId, row.sessionId);
  };

  return (
    <div
      className={row.active ? 'th-row th-row-active' : 'th-row'}
      onClick={focusThisRow}
      title={visual.label}
    >
      <span className={dotClassName} />
      <span className="th-row-name">{row.session.name}</span>
      {row.session.tag !== undefined && <span className="th-row-meta">· {row.session.tag}</span>}
      <span className="th-row-acts">
        <button type="button" className="th-icon-btn" title="Dividir" onClick={handleSplit}>
          <SplitIcon size={14} />
        </button>
        <button
          type="button"
          className="th-icon-btn"
          title="Fechar (vai pro cemitério por 10 min)"
          onClick={handleClose}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}
