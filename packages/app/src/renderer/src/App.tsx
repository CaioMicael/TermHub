import { useEffect, useRef, useState } from 'react';
import { Terminal, measureFitSize } from '@termhub/ui';

import { resolveBootSession } from './session-boot.js';

// Full-window, single-terminal shell for M2.3's milestone gate (docs/
// milestones.md M2, "rodar `claude` dentro do TermHub e conversar com ele").
// Solo-pane layout per the prototype (docs/plan.md section 2, `.pane.solo
// .term`): no sidebar, no tabs, no split tree — those are M3/M4. The amber
// warning strip the prototype shows for daemon trouble is also not this
// task's (a plain status line stands in for it here); see this task's final
// report.

type SessionBootState =
  | { phase: 'measuring' }
  | { phase: 'ready'; sessionId: number }
  | { phase: 'error'; message: string };

const shellStyle = {
  width: '100vw',
  height: '100vh',
  backgroundColor: '#1e1e1e',
  color: '#cccccc',
  fontFamily: '"Segoe UI", system-ui, sans-serif',
  fontSize: '14px',
} as const;

const statusStyle = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
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
  const [sessionState, setSessionState] = useState<SessionBootState>({ phase: 'measuring' });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => window.termhub.onConnectionStateChange(setConnection), []);

  useEffect(() => {
    if (connection.state !== 'connected') {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let cancelled = false;
    // Measured before session.create so a freshly spawned PTY is born the
    // size it will actually render into, instead of a fixed default that
    // `session.resize` would otherwise have to correct on the first real
    // resize (M2.5) — see `measureFitSize`'s own doc comment.
    const { cols, rows } = measureFitSize(container);
    resolveBootSession(window.termhub, { cols, rows })
      .then((session) => {
        if (!cancelled) {
          setSessionState({ phase: 'ready', sessionId: session.id });
        }
        return undefined;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSessionState({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection.state]);

  if (connection.state !== 'connected') {
    return (
      <div style={shellStyle}>
        <ConnectionStatus state={connection} />
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
        {sessionState.phase === 'measuring' && <div style={statusStyle}>Preparando sessão…</div>}
        {sessionState.phase === 'error' && (
          <div style={statusStyle}>Não foi possível abrir uma sessão: {sessionState.message}</div>
        )}
        {sessionState.phase === 'ready' && (
          <Terminal sessionId={sessionState.sessionId} bridge={window.termhub} />
        )}
      </div>
    </div>
  );
}
