export { TabBar } from './TabBar.js';
export type { TabBarProps } from './TabBar.js';

export { ActivityBar } from './ActivityBar.js';
export type { ActivityBarProps, SidebarView } from './ActivityBar.js';

export { Sidebar } from './Sidebar.js';
export type { SidebarProps } from './Sidebar.js';

export { ConnectionBanner } from './ConnectionBanner.js';
export type { ConnectionBannerKind, ConnectionBannerProps } from './ConnectionBanner.js';

export {
  activeFocusedTarget,
  buildSidebarGroups,
  totalPlacedSessionCount,
} from './sidebar-model.js';
export type { SidebarGroup, SidebarRow } from './sidebar-model.js';

export {
  canCloseWorkspace,
  closeWorkspaceTab,
  createWorkspaceTab,
  generateWorkspaceId,
  nextWorkspaceName,
  NEW_WORKSPACE_CWD_FALLBACK,
  NEW_WORKSPACE_NAME_BASE,
  NEW_WORKSPACE_SIZE,
} from './tab-bar-actions.js';
export type { CloseWorkspaceStoreApi } from './tab-bar-actions.js';

export { SplitTree } from './SplitTree.js';
export type { SplitTreeProps } from './SplitTree.js';

export { PaneHeader } from './PaneHeader.js';
export type { PaneHeaderProps } from './PaneHeader.js';

// ─── M3.6: drag-and-drop (pane move + tab reorder) pure logic ─────────────

export {
  computePaneDrop,
  decodePaneDragPayload,
  edgeForPoint,
  encodePaneDragPayload,
  isPaneDragDisabled,
  PaneDragContext,
  EDGE_DEAD_ZONE_FRACTION,
  PANE_DRAG_MIME,
} from './pane-drag.js';
export type {
  DragPoint,
  DragRect,
  PaneDragApi,
  PaneDragState,
  PaneDropResult,
  PaneDropTarget,
} from './pane-drag.js';

export {
  decodeTabDragPayload,
  encodeTabDragPayload,
  reorderWorkspaceIds,
  tabInsertionIndex,
  TAB_DRAG_MIME,
} from './tab-drag.js';
export type { TabRect } from './tab-drag.js';

export {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
  forgetSessionOwnership,
} from './terminal-session.js';
export type {
  AttachedTerminalSession,
  TerminalBridge,
  TerminalBridgeMethod,
  TerminalBridgeRequestParams,
  TerminalSink,
} from './terminal-session.js';

export { measureFitSize } from './fit-size.js';
export type { FitSize } from './fit-size.js';

export { TERMINAL_SOLO_PADDING, terminalTheme, ensureTerminalFontReady } from './terminal-theme.js';

export { attachWebglRenderer } from './terminal-webgl.js';
export type {
  DisposableLike,
  TerminalForWebgl,
  WebglAddonLike,
  WebglFallbackReason,
  WebglRendererHandle,
} from './terminal-webgl.js';

export { selectWebglSessions } from './terminal-webgl-policy.js';
export type { SelectWebglSessionsParams } from './terminal-webgl-policy.js';

// ─── M3.5: the imperative terminal registry/host, and their React "slot" ──

export { createTerminalHost } from './terminal-host.js';
export type {
  ElementObserverHandle,
  HostDisposable,
  TerminalHost,
  TerminalHostOptions,
  XTermLike,
} from './terminal-host.js';

export { createTerminalRegistry } from './terminal-registry.js';
export type {
  CreateTerminalRegistryOptions,
  TerminalDom,
  TerminalRegistry,
} from './terminal-registry.js';

export { TerminalSlot } from './TerminalSlot.js';
export type { TerminalSlotProps } from './TerminalSlot.js';

// ─── Store (M3.1): workspace/pane-tree model, reducers, selectors ─────────

export {
  clampRatio,
  collectSessionIds,
  closePane,
  makeLeaf,
  movePane,
  setRatio,
  splitPane,
  treeFromSessions,
  treeLeaves,
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
} from './store/tree.js';
export type {
  CloseOutcome,
  MoveEdge,
  MoveOutcome,
  PaneLeaf,
  PaneNode,
  PaneSplitNode,
  SetRatioOutcome,
  SplitDirection,
  SplitOutcome,
} from './store/tree.js';

export {
  addWorkspace,
  applySessionStatus,
  closePaneInWorkspace,
  closeWorkspace,
  focusPane,
  movePaneInWorkspace,
  placeSessionInWorkspace,
  removeSession,
  renameWorkspace,
  reorderWorkspaces,
  setActiveWorkspace,
  setRatioInWorkspace,
  splitInWorkspace,
  toggleMaximize,
  upsertSession,
} from './store/workspace.js';
export type { StoreState, Workspace } from './store/workspace.js';

// ─── M5.3: mirrors daemon session.status/session.exit events into the store ─

export { startSessionStatusSync } from './session-status-sync.js';
export type { StatusSyncBridge, StatusSyncStore } from './session-status-sync.js';

export {
  selectAggregatedWorkspaceStatus,
  selectSessionCount,
  selectWorkspaceLeaves,
} from './store/selectors.js';

export { initialStoreState, useTermhubStore } from './store/store.js';
export type { TermhubStore, TermhubStoreActions } from './store/store.js';

// ─── M4.3: pure store <-> WorkspacesFile projection/reconciliation ────────

export {
  applyRelaunchedSession,
  reconcileLayout,
  toPersistedLayout,
  RECOVERED_WORKSPACE_CWD_FALLBACK,
  RECOVERED_WORKSPACE_ID,
  RECOVERED_WORKSPACE_NAME,
} from './layout-persistence.js';
export type { PendingRelaunch, ReconcileOutcome, ReconcileRestored } from './layout-persistence.js';

export {
  buryClosedSession,
  closePaneAction,
  createWorkspaceWithNewSession,
  estimateSplitSize,
  splitPaneWithNewSession,
  NEW_SESSION_SHELL,
} from './store/session-actions.js';
export type {
  SessionActionsBridge,
  SessionActionsMethod,
  SessionActionsRequestParams,
  SessionActionsRequestResult,
  SessionActionsStoreApi,
  Size,
} from './store/session-actions.js';

// ─── M4.5: the graveyard ("Fechados recentemente") pure model, and the
// terminal-clipboard shortcut it shares with `Ctrl+Shift+T` ──────────────

export {
  buildGraveyardRows,
  collectSessionLocations,
  formatAliveRemaining,
  formatClosedAgo,
  mostRecentlyClosedSessionId,
  resolveRestoreWorkspaceId,
  resolveSplitTarget,
  sessionsJustUnplaced,
  sessionsToBury,
  sortGraveyardEntries,
} from './graveyard-model.js';
export type { GraveyardRow, JustUnplacedSession, SessionOrigin } from './graveyard-model.js';

// ─── M4.7: workspace launch specs and templates ("Workspaces" sidebar view) ─

export {
  buildAutoGridTree,
  nextTemplateId,
  nextTemplateName,
  templateFromWorkspace,
} from './workspace-templates.js';

export {
  openWorkspaceFromTemplate,
  saveCurrentWorkspaceAsTemplate,
} from './workspace-templates-actions.js';

export { removeTemplate, upsertTemplate, useTemplatesStore } from './store/templates.js';
export type { TemplatesActions, TemplatesState, TemplatesStore } from './store/templates.js';

export { WorkspacesView } from './WorkspacesView.js';
export type { WorkspacesViewProps } from './WorkspacesView.js';
