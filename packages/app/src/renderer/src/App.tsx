import { useEffect, useRef, useState } from 'react';
import { Terminal, measureFitSize, TERMINAL_SOLO_PADDING } from '@termhub/ui';

import { resolveBootSession } from './session-boot.js';

// Full-window, single-terminal shell for M2.3's milestone gate (docs/
// milestones.md M2, "rodar `claude` dentro do TermHub e conversar com ele").
// Solo-pane layout per the prototype (docs/plan.md section 2, `.pane.solo
// .term`): no sidebar, no tabs, no split tree — those are M3/M4. The amber
// warning strip the prototype shows for daemon trouble is also not this
// task's (a plain status line stands in for it here); see this task's final
// report.
//
// M2.4 addendum (this task): `soloPaneStyle` below applies the prototype's
// `.pane.solo .term { padding: 8px 14px 14px }` — `TERMINAL_SOLO_PADDING`,
// the same constant `@termhub/ui` exports for anything measuring the same
// space. It wraps `containerRef` (the div `measureFitSize` measures and
// `Terminal` mounts into) rather than applying padding directly to
// `containerRef` itself: `@xterm/addon-fit` reads padding off xterm's own
// generated `.xterm` element and reads width/height off *that element's
// parent* — so padding on `containerRef` (which becomes that parent) would
// double-count against `@xterm/addon-fit`'s own arithmetic, while an
// unpadded `containerRef` inset by an *outer* padded wrapper (CSS
// percentage sizing resolves against the parent's content box regardless of
// `box-sizing`) keeps `containerRef`'s measured box identical to the space
// actually available to the terminal, for both `measureFitSize`'s probe and
// the real `Terminal`.

type SessionBootState =
  | { phase: 'measuring' }
  | { phase: 'ready'; sessionId: number; cols: number; rows: number }
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

const soloPaneStyle = {
  width: '100%',
  height: '100%',
  backgroundColor: '#1e1e1e',
  boxSizing: 'border-box',
  padding: `${TERMINAL_SOLO_PADDING.top}px ${TERMINAL_SOLO_PADDING.right}px ${TERMINAL_SOLO_PADDING.bottom}px ${TERMINAL_SOLO_PADDING.left}px`,
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
    // resize (M2.5) — see `measureFitSize`'s own doc comment. `measureFitSize`
    // is async as of M2.4 (it awaits the configured font before measuring —
    // `terminal-theme.ts`'s `ensureTerminalFontReady`), so `resolveBootSession`
    // is chained off it instead of running in parallel.
    measureFitSize(container)
      .then(({ cols, rows }) => resolveBootSession(window.termhub, { cols, rows }))
      .then((session) => {
        if (!cancelled) {
          // `session.cols`/`session.rows` — never the `measureFitSize`
          // result computed just above — are what `Terminal` constructs its
          // xterm with (docs/specs/m2.6-boot-reattach.md section 3.5). For
          // a freshly created session the two happen to be equal (`session-
          // boot.ts` sizes `session.create` with exactly this window's
          // measured fit), but for a *reused* session they're the daemon's
          // real, possibly-different, current geometry (the last
          // `session.resize`) — using the window's fresh measurement there
          // instead would size the xterm to the wrong geometry for a
          // snapshot already serialized at the session's own.
          setSessionState({
            phase: 'ready',
            sessionId: session.id,
            cols: session.cols,
            rows: session.rows,
          });
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
      <div style={soloPaneStyle}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
          {sessionState.phase === 'measuring' && <div style={statusStyle}>Preparando sessão…</div>}
          {sessionState.phase === 'error' && (
            <div style={statusStyle}>Não foi possível abrir uma sessão: {sessionState.message}</div>
          )}
          {sessionState.phase === 'ready' && (
            <Terminal
              sessionId={sessionState.sessionId}
              cols={sessionState.cols}
              rows={sessionState.rows}
              bridge={window.termhub}
            />
          )}
        </div>
      </div>
    </div>
  );
}
