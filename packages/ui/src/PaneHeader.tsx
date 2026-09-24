import type { SessionSummary } from '@termhub/shared';

export interface PaneHeaderProps {
  session: SessionSummary | undefined;
  focused: boolean;
}

/**
 * M3.1 placeholder — replaced by M3.4's real `PaneHeader.tsx` (name, tag,
 * cwd, status badge, maximizar/dividir/fechar buttons, matching the
 * prototype's `.pane-head`). This version only shows the session's name, so
 * the M3.1 Electron proof has *something* to distinguish panes by in a
 * screenshot. Deliberately has no buttons: wiring maximize/split/close here
 * would just be dead weight M3.4 has to delete.
 */
export function PaneHeader({ session, focused }: PaneHeaderProps) {
  return (
    <div
      style={{
        height: 26,
        flex: '0 0 26px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 9px',
        background: focused ? '#232a31' : '#212121',
        color: focused ? '#dcdcdc' : '#a9a9a9',
        fontSize: '11.5px',
        borderBottom: '1px solid #2b2b2b',
        userSelect: 'none',
      }}
    >
      {session === undefined ? '…' : session.name}
    </div>
  );
}
