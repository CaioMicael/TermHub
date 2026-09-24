import type { Workspace } from './store/workspace.js';

export interface TabBarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | undefined;
  onSelect: (workspaceId: string) => void;
}

/**
 * M3.1 placeholder — replaced by M3.4... wait, by M3.3's real `TabBar.tsx`
 * (status dot, session counter, close button, `+`, matching the prototype's
 * `.tabbar`/`.tab`). This version is just a row of plain buttons that call
 * `onSelect` — one workspace = one tab (docs/plan.md section 2), no
 * separate tab entity. Kept intentionally dumb: `App.tsx` owns wiring this
 * to `useTermhubStore().setActiveWorkspace`.
 */
export function TabBar({ workspaces, activeWorkspaceId, onSelect }: TabBarProps) {
  return (
    <div
      style={{
        height: 35,
        flex: '0 0 35px',
        display: 'flex',
        alignItems: 'stretch',
        background: '#252526',
        userSelect: 'none',
      }}
    >
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          onClick={() => onSelect(workspace.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 12px',
            background: workspace.id === activeWorkspaceId ? '#1e1e1e' : '#2d2d2d',
            color: workspace.id === activeWorkspaceId ? '#fff' : '#9d9d9d',
            border: 'none',
            borderRight: '1px solid #252526',
            fontFamily: 'inherit',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {workspace.name}
        </button>
      ))}
    </div>
  );
}
