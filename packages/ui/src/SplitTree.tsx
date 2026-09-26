import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Group,
  Panel,
  Separator,
  type Layout,
  type LayoutChangedMeta,
} from 'react-resizable-panels';
import type { SessionId, SessionSummary } from '@termhub/shared';

import { PaneHeader } from './PaneHeader.js';
import {
  computePaneDrop,
  decodePaneDragPayload,
  edgeForPoint,
  isPaneDragDisabled,
  PANE_DRAG_MIME,
  PaneDragContext,
  type PaneDragApi,
  type PaneDragState,
  type PaneDropTarget,
} from './pane-drag.js';
import { buildPaneLayout, sizesToRatio, type PaneLayout } from './split-layout.js';
import './split-tree.css';
import { TerminalSlot } from './TerminalSlot.js';
import type { TerminalRegistry } from './terminal-registry.js';
import type { SessionActionsBridge } from './store/session-actions.js';
import type { MoveEdge } from './store/tree.js';
import { useTermhubStore } from './store/store.js';
import { TERMINAL_SOLO_PADDING } from './terminal-theme.js';

export interface SplitTreeProps {
  workspaceId: string;
  root: PaneLayoutInputNode;
  sessions: Record<number, SessionSummary>;
  focusedSessionId: number | undefined;
  /** When set, only this pane renders, full-size — "tela cheia" (docs/plan.md section 2, the prototype's `.pane.solo`). Also covers the "one pane total" case: a single-leaf `root` renders the exact same way whether or not it happens to equal `maximizedSessionId`. */
  maximizedSessionId: number | undefined;
  /**
   * M3.5's terminal registry (`terminal-registry.ts`), created once in
   * `App.tsx` with the real bridge and store (docs/specs/m3.5-terminal-
   * lifecycle.md section 4.5) — `SplitTree` never constructs one itself,
   * only threads it down to each leaf's `TerminalSlot`, which calls
   * `place`/`unplace` on it.
   */
  registry: TerminalRegistry;
  /**
   * Only `PaneHeader`'s "dividir" button needs this (`splitPaneWithNewSession`'s
   * `session.create` round trip) — since the registry above now owns the
   * *terminal's* bridge entirely (constructed once in `App.tsx`, never
   * forwarded through this component), `SplitTree` itself no longer needs
   * `TerminalBridge`'s `sendData`/`onData`/clipboard methods at all. Typed
   * as exactly what `PaneHeader` requires, `SessionActionsBridge`, with no
   * cast: M3.4's `as unknown as SessionActionsBridge` line (`af23679`'s
   * final report) existed only because this prop used to be `TerminalBridge`
   * (a shape `PaneHeader` never needed) forwarded straight through — this
   * task's report explains why that requirement went away instead of
   * needing an intersection type.
   */
  bridge: SessionActionsBridge;
  onFocusPane: (sessionId: number) => void;
  /** Wired straight to the store's `setRatio(workspaceId, nodeId, ratio)` (M3.1). Committed once per completed drag — `react-resizable-panels`' `onLayoutChanged` only fires after pointer release (`meta.isUserInteraction`), not per pointer-move — never on every intermediate layout during the drag itself (this task's prompt, section 2: "não a cada pixel"). */
  onSetRatio: (nodeId: string, ratio: number) => void;
}

// Re-exported so callers don't need to import `PaneNode` from `./store/tree.js`
// just to type a prop — `SplitTree` only ever needs the shape `PaneNode` already is.
type PaneLayoutInputNode = Parameters<typeof buildPaneLayout>[0];

/**
 * M3.2's real `SplitTree.tsx` — recursive render of a workspace's pane tree
 * with `react-resizable-panels` (`Group`/`Panel`/`Separator`, v4's renamed
 * API — see this task's final report for the version and the rename from
 * the older `PanelGroup`/`PanelResizeHandle` naming this task's prompt
 * anticipated). Replaces the M3.1 placeholder's fixed-ratio flexbox.
 *
 * The store is the single source of truth for `ratio` (armadilha 1, this
 * task's prompt): every `Panel`'s `defaultSize` is derived from the tree's
 * `ratio` via `split-layout.ts`'s `ratioToSizes`, and the library's own
 * internal size state is never read back except through `onLayoutChanged`
 * — which this component turns straight into a `setRatio` call, so the
 * store never drifts from what's rendered. Because this component (and
 * every ancestor down to `App.tsx`'s workspace wrapper) stays mounted with
 * `display: none` when its workspace isn't active (M3.1's casca), a `Panel`
 * never gets un-mounted by a tab switch — its `defaultSize` is read once,
 * at the `Panel`'s own mount, and that mount already reflects whatever
 * `ratio` was current when the split was created or last dragged.
 *
 * `maximizedSessionId` renders only that one pane, full-size — the rest of
 * the tree (every other `Terminal`) is **not** unmounted, just not
 * rendered here at all; `App.tsx`'s own "keep the whole tab mounted,
 * hidden" trick does not apply *inside* one workspace's tree, so a
 * maximized-then-restored workspace's other panes have already gone
 * through an unmount/remount of their `Terminal`s by the time this
 * component switches back to rendering the full tree — measured and
 * written up honestly in this task's final report (armadilha 2).
 */
export function SplitTree({
  workspaceId,
  root,
  sessions,
  focusedSessionId,
  maximizedSessionId,
  registry,
  bridge,
  onFocusPane,
  onSetRatio,
}: SplitTreeProps) {
  const layout = buildPaneLayout(root);
  if (layout === null) {
    return null;
  }
  if (maximizedSessionId !== undefined) {
    return (
      <PaneDragProvider workspaceId={workspaceId}>
        <PaneLeafView
          workspaceId={workspaceId}
          sessionId={maximizedSessionId}
          sessions={sessions}
          focused
          solo
          maximized
          registry={registry}
          bridge={bridge}
          onFocusPane={onFocusPane}
        />
      </PaneDragProvider>
    );
  }
  const solo = layout.kind === 'leaf';
  return (
    <PaneDragProvider workspaceId={workspaceId}>
      <PaneLayoutView
        workspaceId={workspaceId}
        layout={layout}
        sessions={sessions}
        focusedSessionId={focusedSessionId}
        registry={registry}
        bridge={bridge}
        onFocusPane={onFocusPane}
        onSetRatio={onSetRatio}
        solo={solo}
      />
    </PaneDragProvider>
  );
}

/**
 * M3.6's drag state, scoped to one workspace's `SplitTree` — every
 * `PaneHeader` inside starts a drag (`beginDrag`), every non-dragged leaf's
 * drop-zone overlay (`PaneLeafView` below) tracks the hovered border
 * (`setDropTarget`) and commits a move on drop (`drop`), all through the
 * same `PaneDragContext` instance so neither has to import the other.
 * `drop` is the only place that ever calls the store's `movePane` — it runs
 * `computePaneDrop` (`pane-drag.ts`) itself, so a drop that lands back on
 * the source pane, off every border, or with nothing being dragged, is a
 * true no-op (section 2's "nada muda" cases), and always clears the drag
 * state first, whether or not a move actually happens.
 */
function PaneDragProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [state, setState] = useState<PaneDragState>({
    draggingSessionId: null,
    dropTarget: null,
  });

  const api = useMemo<PaneDragApi>(
    () => ({
      state,
      beginDrag: (sessionId: SessionId) => {
        setState({ draggingSessionId: sessionId, dropTarget: null });
      },
      endDrag: () => {
        setState({ draggingSessionId: null, dropTarget: null });
      },
      setDropTarget: (target: PaneDropTarget | null) => {
        setState((prev) => ({ ...prev, dropTarget: target }));
      },
      drop: (targetSessionId: SessionId, edge: MoveEdge | null) => {
        const sourceSessionId = state.draggingSessionId;
        setState({ draggingSessionId: null, dropTarget: null });
        const result = computePaneDrop({ sourceSessionId, targetSessionId, edge });
        if (result === null) {
          return;
        }
        useTermhubStore
          .getState()
          .movePane(
            workspaceId,
            result.sourceSessionId,
            result.targetSessionId,
            result.edge,
            crypto.randomUUID(),
          );
      },
    }),
    [state, workspaceId],
  );

  return <PaneDragContext.Provider value={api}>{children}</PaneDragContext.Provider>;
}

function PaneLayoutView({
  workspaceId,
  layout,
  sessions,
  focusedSessionId,
  registry,
  bridge,
  onFocusPane,
  onSetRatio,
  solo,
}: {
  workspaceId: string;
  layout: PaneLayout;
  sessions: Record<number, SessionSummary>;
  focusedSessionId: number | undefined;
  registry: TerminalRegistry;
  bridge: SessionActionsBridge;
  onFocusPane: (sessionId: number) => void;
  onSetRatio: (nodeId: string, ratio: number) => void;
  solo: boolean;
}) {
  if (layout.kind === 'leaf') {
    return (
      <PaneLeafView
        key={layout.key}
        workspaceId={workspaceId}
        sessionId={layout.sessionId}
        sessions={sessions}
        focused={layout.sessionId === focusedSessionId}
        solo={solo}
        maximized={false}
        registry={registry}
        bridge={bridge}
        onFocusPane={onFocusPane}
      />
    );
  }
  return (
    <SplitGroupView
      key={layout.key}
      workspaceId={workspaceId}
      layout={layout}
      sessions={sessions}
      focusedSessionId={focusedSessionId}
      registry={registry}
      bridge={bridge}
      onFocusPane={onFocusPane}
      onSetRatio={onSetRatio}
    />
  );
}

function SplitGroupView({
  workspaceId,
  layout,
  sessions,
  focusedSessionId,
  registry,
  bridge,
  onFocusPane,
  onSetRatio,
}: {
  workspaceId: string;
  layout: Extract<PaneLayout, { kind: 'split' }>;
  sessions: Record<number, SessionSummary>;
  focusedSessionId: number | undefined;
  registry: TerminalRegistry;
  bridge: SessionActionsBridge;
  onFocusPane: (sessionId: number) => void;
  onSetRatio: (nodeId: string, ratio: number) => void;
}) {
  const [aId, bId] = layout.panelIds;
  const [aSize, bSize] = layout.sizes;
  const nodeId = layout.nodeId;

  // Latest sizes seen during the drag, read back only once the drag ends
  // (see `onLayoutChanged` below) — this is what keeps `onSetRatio` (a
  // store write, which triggers a re-render) from firing on every pointer
  // move (this task's prompt, section 2).
  const latestSizesRef = useRef<{ a: number; b: number }>({ a: aSize, b: bSize });

  const handleLayoutChange = useCallback(
    (nextLayout: Layout) => {
      const a = nextLayout[aId];
      const b = nextLayout[bId];
      if (a !== undefined && b !== undefined) {
        latestSizesRef.current = { a, b };
      }
    },
    [aId, bId],
  );

  const handleLayoutChanged = useCallback(
    (_nextLayout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) {
        // Programmatic/constraint-driven layout changes (initial mount,
        // window resize, etc.) aren't a divider drag — never write those
        // back to the store.
        return;
      }
      const { a, b } = latestSizesRef.current;
      onSetRatio(nodeId, sizesToRatio(a, b));
    },
    [nodeId, onSetRatio],
  );

  return (
    <Group
      orientation={layout.dir === 'row' ? 'horizontal' : 'vertical'}
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={handleLayoutChanged}
      style={{ width: '100%', height: '100%' }}
    >
      <Panel id={aId} defaultSize={aSize} minSize={10}>
        <PaneLayoutView
          workspaceId={workspaceId}
          layout={layout.a}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          registry={registry}
          bridge={bridge}
          onFocusPane={onFocusPane}
          onSetRatio={onSetRatio}
          solo={false}
        />
      </Panel>
      <Separator
        className={layout.dir === 'row' ? 'th-divider th-divider-v' : 'th-divider th-divider-h'}
      />
      <Panel id={bId} defaultSize={bSize} minSize={10}>
        <PaneLayoutView
          workspaceId={workspaceId}
          layout={layout.b}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          registry={registry}
          bridge={bridge}
          onFocusPane={onFocusPane}
          onSetRatio={onSetRatio}
          solo={false}
        />
      </Panel>
    </Group>
  );
}

function PaneLeafView({
  workspaceId,
  sessionId,
  sessions,
  focused,
  solo,
  maximized,
  registry,
  bridge,
  onFocusPane,
}: {
  workspaceId: string;
  sessionId: number;
  sessions: Record<number, SessionSummary>;
  focused: boolean;
  solo: boolean;
  maximized: boolean;
  registry: TerminalRegistry;
  bridge: SessionActionsBridge;
  onFocusPane: (sessionId: number) => void;
}) {
  const session = sessions[sessionId];

  // M3.6's drop-zone overlay — armadilha 2 (this task's prompt): it exists
  // in the DOM *only* while a pane drag is in progress and this leaf is a
  // valid target, never otherwise, so it can never intercept a click,
  // text selection or scroll inside the terminal at rest. `dragApi === null`
  // can't happen under a real `SplitTree` (it always renders inside a
  // `PaneDragProvider`, above), only guarded here for the same defensive
  // reason `PaneHeader.tsx`'s own `dragApi === null` check exists.
  const dragApi = useContext(PaneDragContext);
  const dragState = dragApi?.state ?? { draggingSessionId: null, dropTarget: null };
  const showDropZone =
    dragState.draggingSessionId !== null &&
    dragState.draggingSessionId !== sessionId &&
    !isPaneDragDisabled({ solo, maximized });
  const hoveredEdge =
    dragState.dropTarget !== null && dragState.dropTarget.sessionId === sessionId
      ? dragState.dropTarget.edge
      : null;

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
        position: 'relative',
        // `.pane.solo { outline: none !important }` (prototype): the solo
        // pane never gets a focus outline, regardless of `focused`.
        outline: !solo && focused ? '1px solid #007acc' : 'none',
        outlineOffset: -1,
      }}
    >
      <PaneHeader
        key={paneHeaderKeyOf(sessionId)}
        workspaceId={workspaceId}
        sessionId={sessionId}
        session={session}
        focused={focused}
        maximized={maximized}
        solo={solo}
        bridge={bridge}
      />
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
        <TerminalSlot sessionId={sessionId} registry={registry} />
      </div>
      {showDropZone && dragApi !== null && (
        <div
          className="th-pane-dropzone"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(PANE_DRAG_MIME)) {
              return;
            }
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const edge = edgeForPoint(rect, { x: event.clientX, y: event.clientY });
            dragApi.setDropTarget(edge === null ? null : { sessionId, edge });
          }}
          onDragLeave={() => {
            if (dragApi.state.dropTarget?.sessionId === sessionId) {
              dragApi.setDropTarget(null);
            }
          }}
          onDrop={(event) => {
            const sourceSessionId = decodePaneDragPayload(event.dataTransfer);
            if (sourceSessionId === null) {
              return;
            }
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const edge = edgeForPoint(rect, { x: event.clientX, y: event.clientY });
            dragApi.drop(sessionId, edge);
          }}
        >
          {hoveredEdge !== null && (
            <div className={`th-pane-dropzone-hint th-pane-dropzone-hint--${hoveredEdge}`} />
          )}
        </div>
      )}
    </div>
  );
}

function paneHeaderKeyOf(sessionId: number): string {
  return `pane-head-${sessionId}`;
}
