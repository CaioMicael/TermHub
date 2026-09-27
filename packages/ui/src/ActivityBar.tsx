import type { ReactElement } from 'react';

import './activity-bar.css';
import { totalPlacedSessionCount } from './sidebar-model.js';
import { useTermhubStore } from './store/store.js';

/**
 * The four views the sidebar can show, plus the always-empty-for-now
 * settings button (M4.2's prompt, section 2 — settings itself is M7.1's
 * job; the prototype's own settings `.act-btn` has no `data-view` and no
 * click handler either, so it never becomes "active"). `'search'` (M6) and
 * `'profiles'` (M4.6) render only their title in this task — see
 * `Sidebar.tsx`'s own doc comment for why.
 */
export type SidebarView = 'terminals' | 'search' | 'workspaces' | 'profiles';

export interface ActivityBarProps {
  view: SidebarView;
  onSelectView: (view: SidebarView) => void;
}

const VIEWS: ReadonlyArray<{ id: SidebarView; title: string }> = [
  { id: 'terminals', title: 'Terminais (Ctrl+Shift+E)' },
  { id: 'search', title: 'Busca global (Ctrl+Shift+F)' },
  { id: 'workspaces', title: 'Workspaces' },
  { id: 'profiles', title: 'Perfis de shell' },
];

function TerminalsIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15h4" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" strokeLinecap="round" />
    </svg>
  );
}

function WorkspacesIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M3 7a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProfilesIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
      <circle cx="9" cy="7" r="2" fill="#333" />
      <circle cx="15" cy="12" r="2" fill="#333" />
      <circle cx="7" cy="17" r="2" fill="#333" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4L5.6 5.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ICONS: Record<SidebarView, () => ReactElement> = {
  terminals: TerminalsIcon,
  search: SearchIcon,
  workspaces: WorkspacesIcon,
  profiles: ProfilesIcon,
};

/**
 * M4.2's real `ActivityBar.tsx` — the 48px strip left of the sidebar,
 * matching `termhub-prototipo.html`'s `.activity`/`.act-btn` exactly
 * (colors/spacing in `activity-bar.css`).
 *
 * Reads `useTermhubStore` directly for the "Terminais" badge count — the
 * same "package's own singleton, not a foreign dependency" reasoning
 * `TabBar.tsx`'s doc comment already gives for doing the same with its own
 * per-tab status/count selectors.
 */
export function ActivityBar({ view, onSelectView }: ActivityBarProps) {
  const workspaces = useTermhubStore((s) => s.workspaces);
  const sessions = useTermhubStore((s) => s.sessions);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const terminalCount = totalPlacedSessionCount({ workspaces, sessions, activeWorkspaceId });

  return (
    <div className="th-activity">
      {VIEWS.map(({ id, title }) => {
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            className={id === view ? 'th-act-btn th-act-btn-active' : 'th-act-btn'}
            title={title}
            onClick={() => {
              onSelectView(id);
            }}
          >
            <Icon />
            {id === 'terminals' && <span className="th-act-badge">{terminalCount}</span>}
          </button>
        );
      })}
      <div className="th-act-spacer" />
      <button type="button" className="th-act-btn" title="Configurações">
        <SettingsIcon />
      </button>
    </div>
  );
}
