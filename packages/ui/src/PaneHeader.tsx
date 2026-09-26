import { useContext } from 'react';
import type { SessionId, SessionSummary } from '@termhub/shared';

import {
  handleCloseClick,
  handleMaximizeClick,
  handleSplitClick,
  type MaximizeStoreApi,
} from './pane-header-actions.js';
import { encodePaneDragPayload, isPaneDragDisabled, PANE_DRAG_MIME, PaneDragContext } from './pane-drag.js';
import './pane-header.css';
import { paneStatusVisual } from './pane-header-status.js';
import type { SessionActionsBridge, SessionActionsStoreApi } from './store/session-actions.js';
import { useTermhubStore } from './store/store.js';

/**
 * Prop contract fixed by M3.2 (`SplitTree.tsx`'s doc comment on why it
 * always renders this component, even for the solo pane) — M3.4 implements
 * the real visual against this exact interface. `workspaceId`/`sessionId`
 * are the addressing pair M3.4's maximizar/dividir/fechar buttons need to
 * call the store (`toggleMaximize`, `split`, `closePane`, all keyed by
 * `(workspaceId, sessionId)` — see `store/workspace.ts`); `solo`/`maximized`
 * distinguish the prototype's `.pane.solo`/`.grid.maximized>.pane.is-max`
 * styling from an ordinary focused pane.
 *
 * `bridge` is this task's one authorized addition to that fixed contract
 * (M3.4's prompt, section 2: "Extensão autorizada do contrato de props") —
 * the "dividir" button needs a way to reach the daemon
 * (`splitPaneWithNewSession`'s `session.create` round trip) and M3.2's
 * contract had no such field. Typed as `SessionActionsBridge`, the minimal
 * shape `splitPaneWithNewSession` already accepts, not the broader
 * `TerminalBridge` `SplitTree.tsx` itself receives as its own `bridge`
 * prop — `window.termhub`'s real `request` is generic over every RPC
 * method (`packages/app/src/preload/bridge.ts`'s `PreloadBridge`), so the
 * same object structurally satisfies both, and `SplitTree.tsx` only needed
 * one changed line to forward it through.
 */
export interface PaneHeaderProps {
  workspaceId: string;
  sessionId: SessionId;
  session: SessionSummary | undefined;
  focused: boolean;
  maximized: boolean;
  solo: boolean;
  bridge: SessionActionsBridge;
}

// Thin adapters from `useTermhubStore` (a Zustand store instance — its
// mutator methods live on `getState()`'s result, not on the store object
// itself) to the small structural interfaces `pane-header-actions.ts`'s
// handlers take. Module-level, not per-render, since `useTermhubStore` is
// `@termhub/ui`'s own singleton (same pattern `TabBar.tsx`'s
// `sessionActionsStore` already uses for the same reason).
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

const maximizeStore: MaximizeStoreApi = {
  toggleMaximize: (workspaceId, sessionId) => {
    useTermhubStore.getState().toggleMaximize(workspaceId, sessionId);
  },
};

function MaximizeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M6 2.5H2.5V6M10 13.5h3.5V10" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" opacity=".45" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg
      width="14"
      height="14"
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
 * M3.4's real `PaneHeader.tsx` — name, tag/cwd, status badge and the
 * maximizar/dividir/fechar buttons, matching `termhub-prototipo.html`'s
 * `.pane-head` (colors/spacing in `pane-header.css`). Replaces the
 * M3.1/M3.2 name-only placeholder.
 *
 * `solo` (the prototype's `.pane.solo .pane-head`: transparent background,
 * "cabeçalho liso") and `focused` (`.pane.focused .pane-head`) are read
 * straight off props into `th-pane-head--solo`/`th-pane-head--focused` —
 * this component never inspects the DOM ancestry the way the prototype's
 * plain CSS selectors do, since `SplitTree.tsx`'s leaf wrapper carries no
 * `.pane`/`.focused`/`.solo` classes of its own (it uses inline styles for
 * the outline — see `SplitTree.tsx`'s `PaneLeafView`).
 */
export function PaneHeader({
  workspaceId,
  sessionId,
  session,
  focused,
  maximized,
  solo,
  bridge,
}: PaneHeaderProps) {
  // M3.6: dragging a pane starts only from this header (armadilha 1 —
  // dragging inside the terminal area itself is xterm text selection, and
  // must stay that way). `PaneDragContext` is `null` when this header
  // somehow renders outside a `SplitTree` (never happens in the app today,
  // but keeps this component from crashing if it ever did) — treated the
  // same as "drag disabled". `isPaneDragDisabled` is the same function
  // `SplitTree.tsx`'s drop-zone overlay uses to decide whether *any* pane
  // in this workspace can be a drop target (section 2's last bullet: solo
  // or maximized means there is no other pane to move to or from).
  const dragApi = useContext(PaneDragContext);
  const dragDisabled = dragApi === null || isPaneDragDisabled({ solo, maximized });

  const headClassName = [
    'th-pane-head',
    focused ? 'th-pane-head--focused' : '',
    solo ? 'th-pane-head--solo' : '',
    !dragDisabled ? 'th-pane-head--draggable' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');

  if (session === undefined) {
    // No `SessionSummary` yet for this pane's session — e.g. a session
    // `splitPaneFromHeader` just created, in the gap between `store.split`
    // placing the leaf and `upsertSession` recording its metadata (the two
    // happen in the same synchronous `set`, so this window is effectively
    // zero, but nothing here assumes it always is). A neutral header, no
    // crash on `session.name`/`session.status`.
    return <div className={headClassName} />;
  }

  const visual = paneStatusVisual(session.status, session.exitCode);
  const dotClassName = ['th-dot', visual.modifier === '' ? '' : `th-dot--${visual.modifier}`]
    .filter((c) => c !== '')
    .join(' ');
  const stateClassName = ['th-state', visual.modifier === '' ? '' : `th-state--${visual.modifier}`]
    .filter((c) => c !== '')
    .join(' ');
  const meta = session.tag !== undefined ? `· ${session.tag} — ${session.cwd}` : `— ${session.cwd}`;

  return (
    <div
      className={headClassName}
      draggable={!dragDisabled}
      onDragStart={(event) => {
        if (dragDisabled || dragApi === null) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(PANE_DRAG_MIME, encodePaneDragPayload(sessionId));
        dragApi.beginDrag(sessionId);
      }}
      onDragEnd={() => {
        dragApi?.endDrag();
      }}
    >
      <span className={dotClassName} />
      <span className="th-pname">{session.name}</span>
      <span className="th-pmeta">{meta}</span>
      <span className={stateClassName}>{visual.label}</span>
      {/* `draggable={false}`: without it, a mousedown-drag gesture starting
          on one of these buttons would still be picked up as a pane drag by
          the header's own `draggable` ancestor above (native HTML5 DnD
          bubbles a drag gesture up to the nearest draggable ancestor when
          the element the gesture started on isn't draggable itself — buttons
          aren't, by default, but that's not enough on its own to stop it). */}
      <span className="th-acts" draggable={false}>
        <button
          type="button"
          className="th-icon-btn"
          title={maximized ? 'Restaurar' : 'Maximizar'}
          onClick={(event) => {
            handleMaximizeClick(event, maximizeStore, workspaceId, sessionId);
          }}
        >
          <MaximizeIcon />
        </button>
        <button
          type="button"
          className="th-icon-btn"
          title="Dividir"
          onClick={(event) => {
            handleSplitClick(event, sessionActionsStore, bridge, workspaceId, sessionId);
          }}
        >
          <SplitIcon />
        </button>
        <button
          type="button"
          className="th-icon-btn"
          title="Fechar"
          onClick={(event) => {
            handleCloseClick(event, sessionActionsStore, workspaceId, sessionId);
          }}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}
