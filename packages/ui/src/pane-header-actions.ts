// Pure/testable logic behind `PaneHeader.tsx`'s three buttons (M3.4's
// prompt, section 4.A) — kept out of the component itself for the same
// reason `tab-bar-actions.ts` gives: these can be driven by Vitest in a
// plain `node` environment, no DOM, no React.
//
// Armadilha 1 (M3.4's prompt): a click on any of these three buttons must
// never also trigger the pane's own `onClick={() => onFocusPane(sessionId)}`
// (`SplitTree.tsx`'s `PaneLeafView`) — the prototype's own markup calls
// `event.stopPropagation()` on every `.icon-btn` inside `.pane-head` for
// exactly this reason. Every `handle*Click` below takes the click event
// first and calls `stopPropagation()` on it before doing anything else, so
// there is no code path that mutates the store without also having stopped
// the bubble.
//
// Armadilha 2: `handleCloseClick` reaches the store through
// `closePaneAction` only — the same function `session-actions.ts` already
// guarantees never touches `SessionActionsBridge`/`session.close` (see that
// module's own doc comment). This file adds no second way to close a pane.

import type { SessionId } from '@termhub/shared';

import {
  closePaneAction,
  splitPaneWithNewSession,
  type SessionActionsBridge,
  type SessionActionsStoreApi,
} from './store/session-actions.js';
import type { SplitDirection } from './store/tree.js';

/**
 * The minimal shape of a click event this module needs — just
 * `stopPropagation`. Typed locally instead of importing `React.MouseEvent`
 * so the functions below stay framework-agnostic and trivially fakeable in
 * a `node`-environment test (`{ stopPropagation: () => calls.push('x') }`),
 * the same "small structural interface" approach `SessionActionsBridge`
 * itself already uses for `window.termhub`.
 */
export interface PaneHeaderClickEvent {
  stopPropagation: () => void;
}

/** The slice of `TermhubStore` the maximize button needs. */
export interface MaximizeStoreApi {
  toggleMaximize: (workspaceId: string, sessionId: SessionId) => void;
}

export function handleMaximizeClick(
  event: PaneHeaderClickEvent,
  store: MaximizeStoreApi,
  workspaceId: string,
  sessionId: SessionId,
): void {
  event.stopPropagation();
  store.toggleMaximize(workspaceId, sessionId);
}

export function handleCloseClick(
  event: PaneHeaderClickEvent,
  store: Pick<SessionActionsStoreApi, 'closePane'>,
  workspaceId: string,
  sessionId: SessionId,
): void {
  event.stopPropagation();
  closePaneAction(store, workspaceId, sessionId);
}

/**
 * Default id generator for a pane header's "dividir" button —
 * `crypto.randomUUID()`, same source `tree.ts`'s `splitPane` doc comment
 * names as the store's own way of minting a `newNodeId` (it stays a pure
 * function itself, so the id has to come from its caller). Overridable via
 * `handleSplitClick`'s `opts.newNodeId` so tests get deterministic ids.
 */
function randomNodeId(): string {
  return crypto.randomUUID();
}

/**
 * Runs the actual `session.create` + `store.split` round trip for the
 * "dividir" button and never lets the returned promise reject — armadilha 3
 * (M3.4's prompt): "se a criação falhar ... o erro não pode ficar solto,
 * nada de promise flutuante". `splitPaneWithNewSession` itself already
 * guarantees that a rejected `session.create` never reaches `store.split`
 * (`session-actions.ts`'s own doc comment: no leaf is created unless the
 * daemon accepted the session first) — this wrapper's only job is to catch
 * that rejection here, once, so every caller (`handleSplitClick` below) can
 * fire it with a plain `void` instead of each inventing its own `.catch`.
 */
export async function splitPaneFromHeader(
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  params: { workspaceId: string; targetSessionId: SessionId; dir: SplitDirection },
  opts: { newNodeId?: () => string; onError?: (err: unknown) => void } = {},
): Promise<void> {
  const newNodeId = (opts.newNodeId ?? randomNodeId)();
  try {
    await splitPaneWithNewSession(store, bridge, { ...params, newNodeId });
  } catch (err) {
    const onError =
      opts.onError ??
      ((error: unknown) => {
        // The only surfacing this failure gets today; M4's graveyard/M5's
        // notifications may give it a real UI surface later, but staying
        // silent here would hide a daemon-side session.create failure
        // entirely.
        console.error('PaneHeader: falha ao dividir o painel', error);
      });
    onError(err);
  }
}

/**
 * The "dividir" button's onClick. Always splits `row` (side-by-side), per
 * the prototype's own icon (`termhub-prototipo.html`'s pane-head "Dividir"
 * button: a vertical line inside the square, `path d="M8 2.5v11"` — a
 * *vertical divider*, i.e. two side-by-side panes) and M3.4's prompt.
 * Synchronous by design: `splitPaneFromHeader`'s own promise is never
 * awaited here, only fired with `void` (it cannot reject — see that
 * function's doc comment), so this stays a plain event handler React can
 * wire directly to `onClick` without a `no-misused-promises` complaint
 * about an async handler.
 */
export function handleSplitClick(
  event: PaneHeaderClickEvent,
  store: SessionActionsStoreApi,
  bridge: SessionActionsBridge,
  workspaceId: string,
  targetSessionId: SessionId,
  opts: { newNodeId?: () => string; onError?: (err: unknown) => void } = {},
): void {
  event.stopPropagation();
  void splitPaneFromHeader(store, bridge, { workspaceId, targetSessionId, dir: 'row' }, opts);
}
