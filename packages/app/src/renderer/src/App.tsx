import { useEffect, useRef, useState } from 'react';
import { measureFitSize, SplitTree, TabBar, useTermhubStore } from '@termhub/ui';

import { resolveBootWorkspace } from './session-boot.js';

// M3.1's casca: a tab strip (one workspace = one tab, docs/plan.md section
// 2) over a grid of panes for the active workspace, everything read from
// `useTermhubStore` (`@termhub/ui`'s store). `TabBar`/`SplitTree` are M3.1's
// own minimal placeholders — see their doc comments for what M3.2/M3.3/M3.4
// replace and why this file only wires them together instead of styling
// anything itself.
//
// Boot still measures a probe container before ever touching the store
// (`measureFitSize`, unchanged from M2.3/M2.6): `resolveBootWorkspace`'s
// fresh-session path needs a `cols`/`rows` guess for a PTY that doesn't
// exist yet, the same reasoning `session-boot.ts`'s header comment already
// covers. Once boot resolves, this component never goes back to the
// measuring/status screen — the store is hydrated once
// (`useTermhubStore.getState().hydrate`) and every render after that reads
// live store state.
//
// Every workspace's `SplitTree` stays mounted, all the time, switched only
// via `display: none` (M3.1's prompt, section 3.5) — so switching tabs
// never re-attaches a session or drops xterm's scrollback. `Terminal.tsx`'s
// own `ResizeObserver`-driven resize guard (M2.5) already no-ops for a
// zero-size (hidden) container, so a hidden pane never sends a spurious
// `session.resize`. Freeing/reattaching each hidden pane's WebGL context
// (the ~16-context Chromium budget, docs/plan.md section 5) is M3.5's job,
// not this component's — every mounted `Terminal` here keeps whatever
// renderer it attached with.

type BootState = { phase: 'measuring' } | { phase: 'ready' } | { phase: 'error'; message: string };

const shellStyle = {
  width: '100vw',
  height: '100vh',
  backgroundColor: '#1e1e1e',
  color: '#cccccc',
  fontFamily: '"Segoe UI", system-ui, sans-serif',
  fontSize: '13px',
  display: 'flex',
  flexDirection: 'column',
} as const;

const statusStyle = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

const gridAreaStyle = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
} as const;

/** Renders whatever `window.termhub`'s current connection state warrants when it isn't `'connected'`, or `null` once it is (the caller then proceeds to session boot). */
function ConnectionStatus({
  state,
}: {
  state: ReturnType<(typeof window)['termhub']['getConnectionState']>;
}) {
  switch (state.state) {
    case 'connecting':
      return <div style={statusStyle}>Conectando ao daemon…</div>;
    case 'connected':
      return null;
    case 'blocked':
      return (
        <div style={statusStyle}>Daemon bloqueado{state.reason ? `: ${state.reason}` : ''}</div>
      );
    case 'failed':
      return (
        <div style={statusStyle}>
          Falha ao conectar ao daemon{state.reason ? `: ${state.reason}` : ''}
        </div>
      );
    case 'disconnected':
      return <div style={statusStyle}>Desconectado do daemon</div>;
  }
}

export function App() {
  const [connection, setConnection] = useState(() => window.termhub.getConnectionState());
  const [bootState, setBootState] = useState<BootState>({ phase: 'measuring' });
  const probeRef = useRef<HTMLDivElement | null>(null);

  const workspaces = useTermhubStore((s) => s.workspaces);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const sessions = useTermhubStore((s) => s.sessions);
  const setActiveWorkspace = useTermhubStore((s) => s.setActiveWorkspace);
  const focusPaneAction = useTermhubStore((s) => s.focusPane);
  const setRatioAction = useTermhubStore((s) => s.setRatio);

  useEffect(() => window.termhub.onConnectionStateChange(setConnection), []);

  useEffect(() => {
    if (connection.state !== 'connected') {
      return;
    }
    if (bootState.phase !== 'measuring') {
      // Boot already resolved (or failed) in an earlier pass over this
      // effect — `resolveBootWorkspace`'s own singleton would no-op a
      // second call anyway, but this also skips re-measuring a probe
      // container that no longer renders once boot is `'ready'`.
      return;
    }
    const probe = probeRef.current;
    if (probe === null) {
      return;
    }
    let cancelled = false;
    measureFitSize(probe)
      .then(({ cols, rows }) => resolveBootWorkspace(window.termhub, { cols, rows }))
      .then((result) => {
        if (cancelled) {
          return undefined;
        }
        const current = useTermhubStore.getState();
        const nextSessions = { ...current.sessions };
        for (const session of result.sessions) {
          nextSessions[session.id] = session;
        }
        // One `hydrate` call instead of an `upsertSession` per session plus
        // an `addWorkspace` — so a subscriber never observes an
        // intermediate render where the workspace's tree already
        // references a session that isn't in `sessions` yet.
        useTermhubStore.getState().hydrate({
          workspaces: [...current.workspaces, result.workspace],
          activeWorkspaceId: result.workspace.id,
          sessions: nextSessions,
        });
        setBootState({ phase: 'ready' });
        return undefined;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBootState({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.state, bootState.phase]);

  if (connection.state !== 'connected') {
    return (
      <div style={shellStyle}>
        <ConnectionStatus state={connection} />
      </div>
    );
  }

  if (bootState.phase !== 'ready') {
    return (
      <div style={shellStyle}>
        <div ref={probeRef} style={{ width: '100%', height: '100%' }}>
          {bootState.phase === 'measuring' && <div style={statusStyle}>Preparando sessão…</div>}
          {bootState.phase === 'error' && (
            <div style={statusStyle}>Não foi possível abrir uma sessão: {bootState.message}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <TabBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelect={(workspaceId) => {
          setActiveWorkspace(workspaceId);
        }}
        bridge={window.termhub}
      />
      <div style={gridAreaStyle}>
        {workspaces.map((workspace) => (
          <div
            key={workspace.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: workspace.id === activeWorkspaceId ? 'block' : 'none',
            }}
          >
            <SplitTree
              workspaceId={workspace.id}
              root={workspace.root}
              sessions={sessions}
              focusedSessionId={workspace.focusedSessionId}
              maximizedSessionId={workspace.maximizedSessionId}
              bridge={window.termhub}
              onFocusPane={(sessionId) => {
                focusPaneAction(workspace.id, sessionId);
              }}
              onSetRatio={(nodeId, ratio) => {
                setRatioAction(workspace.id, nodeId, ratio);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
