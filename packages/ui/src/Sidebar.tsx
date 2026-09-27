import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { GraveyardEntry, SessionId } from '@termhub/shared';

import type { SidebarView } from './ActivityBar.js';
import {
  buildGraveyardRows,
  collectSessionLocations,
  mostRecentlyClosedSessionId,
  resolveRestoreWorkspaceId,
  sessionsJustUnplaced,
  sessionsToBury,
  type GraveyardRow,
  type SessionOrigin,
} from './graveyard-model.js';
import { splitPaneFromHeader } from './pane-header-actions.js';
import { paneStatusVisual } from './pane-header-status.js';
import {
  activeFocusedTarget,
  buildSidebarGroups,
  type SidebarGroup,
  type SidebarRow,
} from './sidebar-model.js';
import './sidebar.css';
import {
  buryClosedSession,
  closePaneAction,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
} from './store/session-actions.js';
import { useTermhubStore } from './store/store.js';
import { isRestoreLastClosedShortcut } from './terminal-clipboard.js';
import { WorkspacesView } from './WorkspacesView.js';

export interface SidebarProps {
  view: SidebarView;
  /**
   * The daemon RPC bridge the "dividir"/"novo terminal" actions need for
   * `session.create` (`splitPaneWithNewSession`'s round trip) — injected by
   * the caller (`App.tsx` passes `window.termhub`), the same reasoning
   * `TabBar.tsx`'s own `bridge` prop doc comment gives: `@termhub/ui` never
   * reads a global of the Electron renderer directly.
   */
  bridge: SessionActionsBridge;
}

const VIEW_TITLES: Record<SidebarView, string> = {
  terminals: 'Terminais',
  search: 'Busca global',
  workspaces: 'Workspaces',
  profiles: 'Perfis de shell',
};

// Thin adapters from `useTermhubStore` to `SessionActionsStoreApi` — the
// same pattern `TabBar.tsx`/`PaneHeader.tsx` already establish for the same
// reason (see either's own doc comment on its module-level
// `sessionActionsStore` constant).
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

function ChevIcon() {
  return (
    <svg
      className="th-chev"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function SplitIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

function CollapseAllIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M3 6l3-3 3 3M3 10l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5v6" />
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

/** `termhub-prototipo.html`'s "Restaurar" button icon — a circular counter-clockwise arrow. */
function RestoreIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path
        d="M3 8a5 5 0 105-5 5 5 0 00-3.5 1.5L3 6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 3v3h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The sidebar's "Fechados recentemente" group has no `workspaceId` of its own to key its collapsed-state entry by — this stands in for one, alongside every real workspace id (M4.2's `collapsed` `Set<string>` already just holds opaque strings). */
const GRAVEYARD_GROUP_ID = '__graveyard__';

/** How often the graveyard section re-polls `graveyard.list` on its own, absent a close/restore that already triggers an immediate refresh (M4.5's prompt, section 2: "a cada 15 s, para o tempo restante andar e as expiradas sumirem"). */
const GRAVEYARD_POLL_INTERVAL_MS = 15_000;

/**
 * M4.2's real `Sidebar.tsx` — the 270px tree view of workspace → sessions,
 * matching `termhub-prototipo.html`'s `.sidebar`/`.side-title`/`.group`/
 * `.row` (colors/spacing in `sidebar.css`).
 *
 * `'terminals'` has its own tree, and `'workspaces'` (M4.7) has
 * `WorkspacesView.tsx` — the templates list/editor, "salvar como
 * modelo"/"novo modelo"/"abrir com um clique". `'search'` (M6's job) and
 * `'profiles'` (M4.6's) still render **just the title** — no title-bar
 * actions either for those two, since "Novo terminal"/"Dividir painel"/
 * "Recolher tudo" are all terminals-tree actions with nothing to act on in
 * an empty view.
 *
 * Collapsed-group state is local React state (`collapsed`, a `Set` of
 * workspace ids) — persisting it across a reload is M4.3's job (this task's
 * prompt, section 2: "persistir é da M4.3").
 */
export function Sidebar({ view, bridge }: SidebarProps) {
  const workspaces = useTermhubStore((s) => s.workspaces);
  const sessions = useTermhubStore((s) => s.sessions);
  const activeWorkspaceId = useTermhubStore((s) => s.activeWorkspaceId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // ─── M4.5: the graveyard ("Fechados recentemente") ──────────────────────
  //
  // `graveyardEntries` mirrors the daemon's own `graveyard.list` — refreshed
  // on a timer, and immediately after this component detects a bury or
  // performs a restore, per this task's prompt (section 2: "atualização:
  // depois de cada fechar e restaurar, e a cada 15 s"). `originsRef` is the
  // renderer-only "which workspace was this closed from" bookkeeping the
  // daemon has no notion of (`graveyard-model.ts`'s own header comment) —
  // a `useRef`, not `useState`, because writing it must never itself be
  // what triggers a re-render (it changes inside the store-subscription
  // callback below, which already re-renders this component indirectly by
  // calling `setGraveyardEntries`).
  const [graveyardEntries, setGraveyardEntries] = useState<GraveyardEntry[]>([]);
  const originsRef = useRef<Map<SessionId, SessionOrigin>>(new Map());
  const refreshGraveyardRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      bridge
        .request('graveyard.list', {})
        .then((result) => {
          if (cancelled) {
            return undefined;
          }
          setGraveyardEntries(result.entries);
          // Forget the origin of anything no longer buried at all — restored
          // (by this session or, in principle, another client) or reaped
          // past its TTL by the daemon. Without this, a `sessionId` the
          // daemon later reuses could show a stale "· workspace" label.
          const stillBuried = new Set(result.entries.map((e) => e.session.id));
          for (const sessionId of [...originsRef.current.keys()]) {
            if (!stillBuried.has(sessionId)) {
              originsRef.current.delete(sessionId);
            }
          }
          return undefined;
        })
        .catch((err: unknown) => {
          console.error('Sidebar: falha ao listar o cemitério', err);
        });
    };
    refreshGraveyardRef.current = refresh;
    refresh();
    const interval = setInterval(refresh, GRAVEYARD_POLL_INTERVAL_MS);

    // "Fechar enterra" (this task's prompt, section 2): every close button
    // in this app — the pane header's, this sidebar's own row button, and a
    // whole tab closing via `tab-bar-actions.ts`'s `closeWorkspaceTab` —
    // already goes through `store.closePane`/`store.closeWorkspace`
    // (`session-actions.ts`'s `closePaneAction` doc comment explains why
    // *those* two never call the bridge themselves: `PaneHeader.tsx` is a
    // forbidden file whose close button passes `handleCloseClick` no
    // bridge at all). This subscription is what actually buries a session
    // in the daemon, for *every* one of those entry points at once: it
    // diffs the store's own tree shape on every change
    // (`graveyard-model.ts`'s `sessionsJustUnplaced`), so it doesn't matter
    // which button removed a pane — only that one now has zero panes it
    // didn't have before.
    let placedLocations = collectSessionLocations(useTermhubStore.getState());
    const reconcileBurials = () => {
      const state = useTermhubStore.getState();
      const nextLocations = collectSessionLocations(state);
      const candidates = sessionsJustUnplaced(placedLocations, nextLocations);
      // Updated *before* the side effects below run, so the `removeSession`
      // calls' own store notification (this same `subscribe` callback,
      // re-entered synchronously) sees no further diff and returns early —
      // otherwise this would recurse forever.
      placedLocations = nextLocations;
      if (candidates.length === 0) {
        return;
      }
      // M4.8: a daemon-resync's own `hydrate` can also make sessions "just
      // unplaced" in bulk — never a real close. `sessionsToBury` (`
      // graveyard-model.ts`'s own doc comment) is what tells the two apart,
      // by id+createdAt against this same `state.sessions` — never send
      // `session.close` for a candidate it filters out.
      const justUnplaced = sessionsToBury(candidates, state.sessions);
      if (justUnplaced.length === 0) {
        return;
      }
      for (const { sessionId, origin } of justUnplaced) {
        originsRef.current.set(sessionId, origin);
        buryClosedSession(bridge, sessionId);
      }
      for (const { sessionId } of justUnplaced) {
        useTermhubStore.getState().removeSession(sessionId);
      }
      refresh();
    };
    const unsubscribe = useTermhubStore.subscribe(reconcileBurials);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [bridge]);

  /**
   * `session.restore` + placing the session back in its origin workspace
   * (`graveyard-model.ts`'s `resolveRestoreWorkspaceId`) — the click
   * target for a graveyard row/its "Restaurar" button, and for
   * `Ctrl+Shift+T` below. `session_not_found` (the entry expired, or was
   * killed, between the last `graveyard.list` and this click — this task's
   * prompt names the race by name) is handled the same as any other
   * failure: logged, and the list refreshed so the now-stale row simply
   * disappears — no dialog, nothing thrown into the UI.
   */
  const restoreSession = useCallback(
    (sessionId: SessionId) => {
      bridge
        .request('session.restore', { sessionId })
        .then((result) => {
          const origin = originsRef.current.get(sessionId);
          originsRef.current.delete(sessionId);
          const state = useTermhubStore.getState();
          const workspaceId = resolveRestoreWorkspaceId(state, origin);
          if (workspaceId !== undefined) {
            useTermhubStore
              .getState()
              .placeSession(workspaceId, result.session, crypto.randomUUID());
          }
          refreshGraveyardRef.current();
          return undefined;
        })
        .catch((err: unknown) => {
          console.error('Sidebar: falha ao restaurar sessão', sessionId, err);
          refreshGraveyardRef.current();
        });
    },
    [bridge],
  );

  // `Ctrl+Shift+T` (this task's prompt, section 2) — a `window`-level
  // listener, independent of whatever has DOM focus. It still fires with
  // focus inside a terminal: `terminal-clipboard.ts`'s own
  // `createClipboardKeyHandler` (installed by `terminal-host.ts` as xterm's
  // `attachCustomKeyEventHandler`) returns `false` for this same combo, and
  // returning `false` from that handler makes xterm skip its own
  // data-sending pipeline entirely without ever calling
  // `preventDefault`/`stopPropagation` on the native event — see that
  // module's doc comment on `isRestoreLastClosedShortcut` for the verified
  // reasoning. This listener is registered without `capture`, so it always
  // runs after xterm's own (which is bound directly to its hidden
  // textarea), guaranteeing the keys never reach the shell either way.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isRestoreLastClosedShortcut(event)) {
        return;
      }
      event.preventDefault();
      const sessionId = mostRecentlyClosedSessionId(graveyardEntries);
      if (sessionId !== undefined) {
        restoreSession(sessionId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [graveyardEntries, restoreSession]);

  const graveyardRows = buildGraveyardRows(graveyardEntries, originsRef.current, Date.now());

  const groups = buildSidebarGroups({ workspaces, sessions, activeWorkspaceId });

  // "Novo terminal" and "Dividir painel" both trigger this — there is no
  // other session-creation flow inside a workspace today (this task's final
  // report explains the decision). Splits the *active* workspace's *focused*
  // pane, same as `PaneHeader.tsx`'s own "dividir" button does for one
  // specific pane.
  const splitFocusedPane = () => {
    const target = activeFocusedTarget({ workspaces, sessions, activeWorkspaceId });
    if (target === undefined) {
      return;
    }
    void splitPaneFromHeader(sessionActionsStore, bridge, {
      workspaceId: target.workspaceId,
      targetSessionId: target.sessionId,
      dir: 'row',
    });
  };

  const collapseAll = () => {
    setCollapsed(new Set([...groups.map((g) => g.workspaceId), GRAVEYARD_GROUP_ID]));
  };

  const toggleGroup = (workspaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  const canSplit = activeFocusedTarget({ workspaces, sessions, activeWorkspaceId }) !== undefined;

  return (
    <div className="th-sidebar">
      <div className="th-side-title">
        <span>{VIEW_TITLES[view]}</span>
        {view === 'terminals' && (
          <div className="th-side-acts">
            <button
              type="button"
              className="th-icon-btn"
              title="Novo terminal"
              disabled={!canSplit}
              onClick={splitFocusedPane}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="th-icon-btn"
              title="Dividir painel"
              disabled={!canSplit}
              onClick={splitFocusedPane}
            >
              <SplitIcon />
            </button>
            <button
              type="button"
              className="th-icon-btn"
              title="Recolher tudo"
              onClick={collapseAll}
            >
              <CollapseAllIcon />
            </button>
          </div>
        )}
      </div>
      <div className="th-side-body">
        {view === 'terminals' &&
          groups.map((group) => (
            <SidebarGroupView
              key={group.workspaceId}
              group={group}
              collapsed={collapsed.has(group.workspaceId)}
              onToggle={() => {
                toggleGroup(group.workspaceId);
              }}
              bridge={bridge}
            />
          ))}
        {view === 'terminals' && (
          <GraveyardGroupView
            rows={graveyardRows}
            collapsed={collapsed.has(GRAVEYARD_GROUP_ID)}
            onToggle={() => {
              toggleGroup(GRAVEYARD_GROUP_ID);
            }}
            onRestore={restoreSession}
          />
        )}
        {view === 'workspaces' && <WorkspacesView bridge={bridge} />}
      </div>
    </div>
  );
}

function SidebarGroupView({
  group,
  collapsed,
  onToggle,
  bridge,
}: {
  group: SidebarGroup;
  collapsed: boolean;
  onToggle: () => void;
  bridge: SessionActionsBridge;
}) {
  return (
    <div className={collapsed ? 'th-group th-group-collapsed' : 'th-group'}>
      <div className="th-group-head" onClick={onToggle}>
        <ChevIcon />
        <span className="th-group-name">{group.name}</span>
        <span className="th-group-path" title={group.cwd}>
          {group.cwd}
        </span>
        <span className="th-group-count">
          {group.waiting && <span className="th-group-waiting-mark">◆</span>}
          {group.sessionCount}
        </span>
      </div>
      <div className="th-group-items">
        {group.rows.map((row) => (
          <SidebarRowView key={row.sessionId} row={row} bridge={bridge} />
        ))}
      </div>
    </div>
  );
}

function SidebarRowView({ row, bridge }: { row: SidebarRow; bridge: SessionActionsBridge }) {
  const focusThisRow = () => {
    useTermhubStore.getState().focusPane(row.workspaceId, row.sessionId);
  };

  if (row.session === undefined) {
    // Same gap `PaneHeader.tsx`'s own early return covers: a leaf whose
    // session metadata hasn't landed in the store yet. A neutral row, still
    // clickable (focusing a pane that exists in the tree is always valid),
    // no name/status/actions to invent.
    return (
      <div className={row.active ? 'th-row th-row-active' : 'th-row'} onClick={focusThisRow} />
    );
  }

  const visual = paneStatusVisual(row.session.status, row.session.exitCode);
  const dotClassName = [
    'th-row-dot',
    visual.modifier === '' ? '' : `th-row-dot--${visual.modifier}`,
  ]
    .filter((c) => c !== '')
    .join(' ');

  const handleSplit = (event: MouseEvent) => {
    event.stopPropagation();
    void splitPaneFromHeader(sessionActionsStore, bridge, {
      workspaceId: row.workspaceId,
      targetSessionId: row.sessionId,
      dir: 'row',
    });
  };
  const handleClose = (event: MouseEvent) => {
    event.stopPropagation();
    closePaneAction(sessionActionsStore, row.workspaceId, row.sessionId);
  };

  return (
    <div
      className={row.active ? 'th-row th-row-active' : 'th-row'}
      onClick={focusThisRow}
      title={visual.label}
    >
      <span className={dotClassName} />
      <span className="th-row-name">{row.session.name}</span>
      {row.session.tag !== undefined && <span className="th-row-meta">· {row.session.tag}</span>}
      <span className="th-row-acts">
        <button type="button" className="th-icon-btn" title="Dividir" onClick={handleSplit}>
          <SplitIcon size={14} />
        </button>
        <button
          type="button"
          className="th-icon-btn"
          title="Fechar (vai pro cemitério por 10 min)"
          onClick={handleClose}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}

/**
 * M4.5's "Fechados recentemente" group — same `.th-group`/`.th-group-head`
 * shell `SidebarGroupView` uses above, but with no cwd/waiting-mark (a
 * buried session's group has neither) and its own footer
 * (`termhub-prototipo.html`'s own static text below the list, always
 * shown — even with zero rows, matching the rest of this sidebar never
 * hiding an empty group, `sidebar-model.ts`'s own doc comment on
 * `buildSidebarGroups`).
 */
function GraveyardGroupView({
  rows,
  collapsed,
  onToggle,
  onRestore,
}: {
  rows: GraveyardRow[];
  collapsed: boolean;
  onToggle: () => void;
  onRestore: (sessionId: SessionId) => void;
}) {
  return (
    <div
      className={collapsed ? 'th-group th-group-collapsed' : 'th-group'}
      style={{ marginTop: 8 }}
    >
      <div className="th-group-head" onClick={onToggle}>
        <ChevIcon />
        <span className="th-group-name">Fechados recentemente</span>
        <span className="th-group-count">{rows.length}</span>
      </div>
      <div className="th-group-items">
        {rows.map((row) => (
          <GraveyardRowView key={row.sessionId} row={row} onRestore={onRestore} />
        ))}
      </div>
      <div className="th-graveyard-footer">
        Sessões fechadas ficam <b>vivas no daemon</b> por 10 min. <kbd>Ctrl+⇧+T</kbd> traz a última
        de volta.
      </div>
    </div>
  );
}

function GraveyardRowView({
  row,
  onRestore,
}: {
  row: GraveyardRow;
  onRestore: (sessionId: SessionId) => void;
}) {
  const restoreThisRow = () => {
    onRestore(row.sessionId);
  };
  const handleRestoreClick = (event: MouseEvent) => {
    event.stopPropagation();
    onRestore(row.sessionId);
  };

  const dotClassName = row.alive
    ? 'th-row-dot th-row-dot--graveyard-alive'
    : 'th-row-dot th-row-dot--graveyard-dead';
  const nameClassName = row.alive ? 'th-row-name' : 'th-row-name th-row-name--dim';
  const title = row.alive
    ? 'PTY ainda vivo no daemon — restaura com o scrollback intacto'
    : 'Encerrado — restaura mesmo assim, com o scrollback que já tinha';
  // "· tag · workspace", or just "· tag" when the origin workspace isn't
  // known (this task's prompt, section 2) — built from whichever of the
  // two segments actually exist, same as `PaneHeader.tsx`'s own `meta`
  // string doesn't invent a leading "·" for a session with no `tag` either.
  const metaSegments = [row.tag, row.workspaceLabel].filter(
    (segment): segment is string => segment !== undefined,
  );
  const meta = metaSegments.length > 0 ? `· ${metaSegments.join(' · ')}` : undefined;

  return (
    <div className="th-row" onClick={restoreThisRow} title={title}>
      <span className={dotClassName} />
      <span className={nameClassName}>{row.name}</span>
      {meta !== undefined && <span className="th-row-meta">{meta}</span>}
      <span className="th-row-ttl">{row.timeText}</span>
      <span className="th-row-acts">
        <button
          type="button"
          className="th-icon-btn"
          title="Restaurar"
          onClick={handleRestoreClick}
        >
          <RestoreIcon />
        </button>
      </span>
    </div>
  );
}
