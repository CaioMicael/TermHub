export { TabBar } from './TabBar.js';
export type { TabBarProps } from './TabBar.js';

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

export {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
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
  closePaneInWorkspace,
  closeWorkspace,
  focusPane,
  movePaneInWorkspace,
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

export {
  selectAggregatedWorkspaceStatus,
  selectSessionCount,
  selectWorkspaceLeaves,
} from './store/selectors.js';

export { initialStoreState, useTermhubStore } from './store/store.js';
export type { TermhubStore, TermhubStoreActions } from './store/store.js';

export {
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
