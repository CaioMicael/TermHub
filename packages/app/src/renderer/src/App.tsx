import { useEffect, useRef, useState } from 'react';
import {
  ActivityBar,
  ConnectionBanner,
  createTerminalRegistry,
  measureFitSize,
  Sidebar,
  SplitTree,
  startSessionStatusSync,
  TabBar,
  useTemplatesStore,
  useTermhubStore,
  type ConnectionBannerKind,
  type SidebarView,
  type StoreState,
  type TerminalRegistry,
} from '@termhub/ui';

import { runDaemonResync } from './daemon-resync.js';
import {
  resolveBootWorkspace,
  startLayoutPersistence,
  startTemplatesPersistence,
} from './session-boot.js';

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
// never re-attaches a session or drops xterm's scrollback. As of M3.5, the
// terminal instances themselves aren't even in this tree any more: `App`
// creates one `TerminalRegistry` (`@termhub/ui`'s `terminal-registry.ts`)
// for the page's whole lifetime, and every `SplitTree` below only renders
// `TerminalSlot`s that ask the registry to place/park its already-alive
// host — see docs/specs/m3.5-terminal-lifecycle.md section 4.1 for why
// birth/death now tracks the store (`split`/`closePane`/`closeWorkspace`/
// `removeSession`), not React mounts, and section 4.5 for why this
// component is the one that creates and disposes it.

type BootState = { phase: 'measuring' } | { phase: 'ready' } | { phase: 'error'; message: string };

/**
 * M4.8: adapts `useTermhubStore` (a Zustand hook, not a plain `{getState,
 * hydrate}` object) to the store surface `daemon-resync.ts`'s
 * `runDaemonResync` needs — `hydrate` is one of the store's own *actions*
 * (`useTermhubStore.getState().hydrate(...)`), never a method on the hook
 * itself. Module-level, not per-render: `useTermhubStore` is already a
 * process-wide singleton (`store/store.ts`), so this adapter needs no
 * lifecycle of its own.
 */
const daemonResyncStore = {
  getState: () => useTermhubStore.getState(),
  hydrate: (next: StoreState) => {
    useTermhubStore.getState().hydrate(next);
  },
};

type BannerState = { kind: ConnectionBannerKind; reason?: string } | undefined;

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

// M4.2: activity bar (48px) + sidebar (270px) sit left of the existing
// tab-bar-over-grid column (docs/plan.md section 2's shell layout — the
// title bar itself is out of this task's scope). `shellBodyStyle` is the
// row the three live in; `mainColumnStyle` is what used to be `shellStyle`'s
// own direct children (`TabBar` + the grid area), now nested one level
// deeper so it can sit next to the sidebar instead of filling the whole
// window.
const shellBodyStyle = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
} as const;

const mainColumnStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
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
  const [sidebarView, setSidebarView] = useState<SidebarView>('terminals');
  const probeRef = useRef<HTMLDivElement | null>(null);

  const workspaces = useTermhubStore((s) => s.workspaces);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const sessions = useTermhubStore((s) => s.sessions);
  const setActiveWorkspace = useTermhubStore((s) => s.setActiveWorkspace);
  const focusPaneAction = useTermhubStore((s) => s.focusPane);
  const setRatioAction = useTermhubStore((s) => s.setRatio);

  // Created once, for the whole life of this page — never recreated on a
  // re-render (docs/specs/m3.5-terminal-lifecycle.md section 4.5). `useState`'s
  // lazy initializer runs exactly once, on the very first render; the
  // registry itself subscribes to `useTermhubStore` immediately (it doesn't
  // need to wait for boot to hydrate the store — an empty store simply has
  // nothing placed yet). Disposed on this component's own unmount, i.e. the
  // end of the page's life, not on every render.
  const [registry] = useState<TerminalRegistry>(() =>
    createTerminalRegistry({ bridge: window.termhub, store: useTermhubStore }),
  );
  useEffect(() => () => registry.dispose(), [registry]);

  useEffect(() => window.termhub.onConnectionStateChange(setConnection), []);

  // M5.3: starts mirroring session.status/session.exit into the store right
  // away — a top-level effect, not gated on `bootState`, and running before
  // this component's boot effect below ever calls `hydrate()`. That ordering
  // is the whole point (docs/specs/m5.3-status-propagation.md section 2.1):
  // an event that arrives while boot is still measuring/resolving has to be
  // remembered by `session-status-sync.ts`'s own `latest` map so it can be
  // replayed once `hydrate()` actually puts the session in the store,
  // instead of `hydrate()` silently overwriting it with a status read before
  // the event happened. `window.termhub` satisfies `StatusSyncBridge`
  // structurally (same `TerminalBridge`-style narrowing `@termhub/ui`
  // already uses elsewhere) and `useTermhubStore` satisfies `StatusSyncStore`
  // as-is (Zustand's `UseBoundStore` already exposes `getState`/`subscribe`)
  // — no cast needed at this call site.
  useEffect(() => startSessionStatusSync(window.termhub, useTermhubStore), []);

  // M4.8: the faixa (banner) above the tab bar, and the resync it triggers.
  // `lastSeenEpochRef` is the generation this window last resynced against
  // — captured once boot's own connection settles, so a reload/reconnect
  // that never actually changes the daemon connection (this page's very
  // first `'connected'`) never itself counts as "the daemon changed
  // underneath us".
  const [banner, setBanner] = useState<BannerState>(undefined);
  const lastSeenEpochRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (bootState.phase === 'ready' && lastSeenEpochRef.current === undefined) {
      lastSeenEpochRef.current = connection.epoch;
    }
    // Deliberately keyed only on `bootState.phase`: this captures the
    // baseline exactly once, the instant boot finishes — reading
    // `connection.epoch` from the closure at that point, not on every
    // change to it (the resync effect below is what reacts to later
    // changes).
  }, [bootState.phase]);

  // Section 3.3: once boot has finished, 'disconnected'/'blocked' never
  // unmounts the UI again — they only ever set the banner. 'connected' is
  // handled by the resync effect below, which clears the banner only once
  // resync itself has actually finished reconciling the grid.
  useEffect(() => {
    if (bootState.phase !== 'ready') {
      return;
    }
    if (connection.state === 'disconnected') {
      setBanner({ kind: 'reconnecting' });
    } else if (connection.state === 'blocked') {
      setBanner({
        kind: 'blocked',
        ...(connection.reason !== undefined ? { reason: connection.reason } : {}),
      });
    }
  }, [bootState.phase, connection.state, connection.reason]);

  // Section 3.4: resync whenever the connection comes back 'connected' with
  // a generation different from the last one this window resynced against.
  useEffect(() => {
    if (bootState.phase !== 'ready') {
      return;
    }
    if (connection.state !== 'connected' || connection.epoch === undefined) {
      return;
    }
    if (lastSeenEpochRef.current === connection.epoch) {
      return;
    }
    lastSeenEpochRef.current = connection.epoch;
    let cancelled = false;
    runDaemonResync(window.termhub, daemonResyncStore, registry)
      .then((result) => {
        if (cancelled) {
          return undefined;
        }
        if (result.daemonRestarted) {
          // Section 3.4's last paragraph: shown for a few seconds, then
          // cleared — never a permanent state.
          setBanner({ kind: 'restarted' });
          setTimeout(() => {
            if (!cancelled) {
              setBanner(undefined);
            }
          }, 5000);
        } else {
          setBanner(undefined);
        }
        return undefined;
      })
      .catch((err: unknown) => {
        console.error('[TermHub] daemon resync failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [bootState.phase, connection.state, connection.epoch, registry]);

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
          workspaces: [...current.workspaces, ...result.workspaces],
          activeWorkspaceId: result.activeWorkspaceId,
          sessions: nextSessions,
        });
        // M4.7: seeds the templates store with whatever `workspaces.json`
        // itself carried — same one-shot-at-boot posture as the layout's
        // own `hydrate` just above, and for the same reason: nothing has
        // subscribed to save yet (`startTemplatesPersistence` below only
        // starts once `bootState` reaches `'ready'`), so this can never be
        // read back as a "the user just cleared their templates" change.
        useTemplatesStore.getState().setTemplates(result.templates);
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

  // M4.3: starts saving the layout on every `workspaces`/`activeWorkspaceId`
  // change — but only once boot's own `hydrate()` above has already run.
  // `bootState.phase` reaches `'ready'` synchronously right after that
  // `hydrate()` call, so `startLayoutPersistence` is never called any
  // earlier — see its own doc comment (`session-boot.ts`) for why
  // subscribing any earlier is exactly the premature-save bug this task's
  // prompt warns about by name.
  useEffect(() => {
    if (bootState.phase !== 'ready') {
      return;
    }
    return startLayoutPersistence(useTermhubStore, window.termhub, useTemplatesStore);
  }, [bootState.phase]);

  // M4.7: the other half — a templates-only change (saved/edited/deleted in
  // `WorkspacesView.tsx`) also has to reach disk, gated the exact same way
  // (only once boot's own hydrate/seed above has already run).
  useEffect(() => {
    if (bootState.phase !== 'ready') {
      return;
    }
    return startTemplatesPersistence(useTemplatesStore, useTermhubStore, window.termhub);
  }, [bootState.phase]);

  // docs/specs/m4.8-daemon-resilience.md section 3.3: "Antes de o boot
  // terminar, o comportamento de hoje não muda" — this full-screen status
  // (and the measuring/error screen right below it) only ever apply while
  // boot hasn't succeeded yet. Once `bootState.phase === 'ready'`, this
  // component never returns to either of these again for the rest of the
  // page's life, no matter what `connection.state` does later — see the
  // banner below instead.
  if (bootState.phase !== 'ready') {
    if (connection.state !== 'connected') {
      return (
        <div style={shellStyle}>
          <ConnectionStatus state={connection} />
        </div>
      );
    }
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
      {banner !== undefined && (
        <ConnectionBanner
          kind={banner.kind}
          {...(banner.reason !== undefined ? { reason: banner.reason } : {})}
        />
      )}
      <div style={shellBodyStyle}>
        <ActivityBar view={sidebarView} onSelectView={setSidebarView} />
        <Sidebar view={sidebarView} bridge={window.termhub} />
        <div style={mainColumnStyle}>
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
                  registry={registry}
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
      </div>
    </div>
  );
}
