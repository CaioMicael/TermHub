import type { SessionSummary } from '@termhub/shared';

import { PaneHeader } from './PaneHeader.js';
import type { PaneNode } from './store/tree.js';
import { Terminal } from './Terminal.js';
import type { TerminalBridge } from './terminal-session.js';
import { TERMINAL_SOLO_PADDING } from './terminal-theme.js';

export interface SplitTreeProps {
  root: PaneNode | null;
  sessions: Record<number, SessionSummary>;
  focusedSessionId: number | undefined;
  /** When set, only this pane renders, full-size — "tela cheia" (docs/plan.md section 2, the prototype's `.pane.solo`). Also covers the "one pane total" case: a single-leaf `root` renders the exact same way whether or not it happens to equal `maximizedSessionId`. */
  maximizedSessionId: number | undefined;
  bridge: TerminalBridge;
  onFocusPane: (sessionId: number) => void;
}

/**
 * M3.1 placeholder — replaced by M3.2's real `SplitTree.tsx` (draggable
 * dividers via `react-resizable-panels`, the prototype's `.divider`
 * styling). This version renders the same tree shape with plain nested
 * flexbox and a **fixed** ratio read straight off each split node — no
 * drag, `setRatio` is never called from here — just enough for M3.1's own
 * Electron proof (4 sessions in a 2×2 grid, docs/plan.md's prototype
 * `.grid`) to have something to screenshot. `PaneHeader`/`TabBar` are the
 * other two M3.1 placeholders this component composes with.
 *
 * A single pane (`root` is a leaf, or `maximizedSessionId` is set) renders
 * with `TERMINAL_SOLO_PADDING` — the same "tela cheia" padding
 * `App.tsx` used pre-M3.1 for its one-and-only terminal — so the M3 solo
 * case keeps looking like M2's did.
 */
export function SplitTree({
  root,
  sessions,
  focusedSessionId,
  maximizedSessionId,
  bridge,
  onFocusPane,
}: SplitTreeProps) {
  if (root === null) {
    return null;
  }
  if (maximizedSessionId !== undefined) {
    return (
      <PaneLeafView
        sessionId={maximizedSessionId}
        sessions={sessions}
        focused
        solo
        bridge={bridge}
        onFocusPane={onFocusPane}
      />
    );
  }
  const solo = root.kind === 'leaf';
  return (
    <PaneNodeView
      node={root}
      sessions={sessions}
      focusedSessionId={focusedSessionId}
      bridge={bridge}
      onFocusPane={onFocusPane}
      solo={solo}
    />
  );
}

function PaneNodeView({
  node,
  sessions,
  focusedSessionId,
  bridge,
  onFocusPane,
  solo,
}: {
  node: PaneNode;
  sessions: Record<number, SessionSummary>;
  focusedSessionId: number | undefined;
  bridge: TerminalBridge;
  onFocusPane: (sessionId: number) => void;
  solo: boolean;
}) {
  if (node.kind === 'leaf') {
    return (
      <PaneLeafView
        sessionId={node.sessionId}
        sessions={sessions}
        focused={node.sessionId === focusedSessionId}
        solo={solo}
        bridge={bridge}
        onFocusPane={onFocusPane}
      />
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: node.dir === 'row' ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        background: '#2b2b2b',
        gap: 1,
      }}
    >
      <div style={{ flex: `${node.ratio} 1 0%`, minWidth: 0, minHeight: 0 }}>
        <PaneNodeView
          node={node.a}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          bridge={bridge}
          onFocusPane={onFocusPane}
          solo={false}
        />
      </div>
      <div style={{ flex: `${1 - node.ratio} 1 0%`, minWidth: 0, minHeight: 0 }}>
        <PaneNodeView
          node={node.b}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          bridge={bridge}
          onFocusPane={onFocusPane}
          solo={false}
        />
      </div>
    </div>
  );
}

function PaneLeafView({
  sessionId,
  sessions,
  focused,
  solo,
  bridge,
  onFocusPane,
}: {
  sessionId: number;
  sessions: Record<number, SessionSummary>;
  focused: boolean;
  solo: boolean;
  bridge: TerminalBridge;
  onFocusPane: (sessionId: number) => void;
}) {
  const session = sessions[sessionId];
  return (
    <div
      onClick={() => onFocusPane(sessionId)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        background: '#1e1e1e',
        outline: !solo && focused ? '1px solid #007acc' : 'none',
        outlineOffset: -1,
      }}
    >
      {!solo && <PaneHeader session={session} focused={focused} />}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          boxSizing: 'border-box',
          padding: solo
            ? `${TERMINAL_SOLO_PADDING.top}px ${TERMINAL_SOLO_PADDING.right}px ${TERMINAL_SOLO_PADDING.bottom}px ${TERMINAL_SOLO_PADDING.left}px`
            : 0,
        }}
      >
        {session !== undefined && (
          <Terminal sessionId={sessionId} cols={session.cols} rows={session.rows} bridge={bridge} />
        )}
      </div>
    </div>
  );
}
