import type { SessionId, SessionSummary } from '@termhub/shared';

/**
 * Prop contract fixed by M3.2 (`SplitTree.tsx`'s doc comment on why it
 * always renders this component, even for the solo pane) — M3.4 implements
 * the real visual against this exact interface. `workspaceId`/`sessionId`
 * are the addressing pair M3.4's maximizar/dividir/fechar buttons need to
 * call the store (`toggleMaximize`, `split`, `closePane`, all keyed by
 * `(workspaceId, sessionId)` — see `store/workspace.ts`); `solo`/`maximized`
 * distinguish the prototype's `.pane.solo`/`.grid.maximized>.pane.is-max`
 * styling from an ordinary focused pane.
 */
export interface PaneHeaderProps {
  workspaceId: string;
  sessionId: SessionId;
  session: SessionSummary | undefined;
  focused: boolean;
  maximized: boolean;
  solo: boolean;
}

/**
 * M3.1/M3.2 placeholder — replaced by M3.4's real `PaneHeader.tsx` (name,
 * tag, cwd, status badge, maximizar/dividir/fechar buttons, matching the
 * prototype's `.pane-head`). This version only shows the session's name, so
 * the M3.1/M3.2 Electron proofs have *something* to distinguish panes by in
 * a screenshot. Deliberately has no buttons: wiring maximize/split/close
 * here would just be dead weight M3.4 has to delete. `workspaceId`,
 * `sessionId`, `maximized` and `solo` are accepted per the prop contract
 * above but not yet drawn — M3.2's own prompt is explicit that only the
 * *interface and signature* are this task's to fix, not the visual.
 */
// Only `session`/`focused` are destructured — `workspaceId`, `sessionId`,
// `maximized` and `solo` are part of the fixed prop contract above (for
// M3.4's callers to rely on) but this placeholder's render doesn't use
// them yet, so they're left on `props` rather than bound to unused
// variables.
export function PaneHeader(props: PaneHeaderProps) {
  const { session, focused } = props;
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
