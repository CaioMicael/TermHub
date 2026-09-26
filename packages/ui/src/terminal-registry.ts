// The imperative registry that owns every terminal's whole lifecycle outside
// the React tree (docs/specs/m3.5-terminal-lifecycle.md section 4.1). This
// is the fix for the bug `3e8c165` (M3.2) wrote up and this task's techspec
// exists to close: a `Terminal` that lived inside the layout tree got
// remounted every time the tree changed shape (split, collapse, maximize,
// restore), and the remount raced `terminal-session.ts`'s reference-counted
// attach into showing up as a second holder of an already-attached session —
// no snapshot, a blank pane, the agent's visible history gone even though
// the daemon still had it.
//
// The fix: birth and death of a terminal host track the *store*, not React
// mounts. A session enters this registry's world when it's placed in *any*
// workspace's tree (`split`, `addWorkspace`, boot's `hydrate`) and leaves it
// only when it's removed from every tree (`closePane`, `closeWorkspace`) or
// its session metadata itself is dropped (`removeSession`). Split, collapse,
// maximize, restore and switching tabs never touch that set, so they never
// create or destroy anything here — `TerminalSlot.tsx` only ever *moves* an
// already-alive host's DOM element between a slot and the parking
// container (section 4.2), which is why the elements move rather than being
// recreated: moving a live DOM node preserves the xterm buffer, scrollback
// and selection untouched, and costs nothing.
//
// Every DOM operation this module performs — creating the host and parking
// elements, moving them, reading a slot's size — goes through the injectable
// `TerminalDom` below (never a bare `document`/`Element` call), which is
// exactly what lets `terminal-registry.test.ts` drive this module in the
// repo's plain `node` Vitest environment, with no jsdom: a test's fake
// `TerminalDom` tracks parent/child relationships in a plain `Map`, never
// touching a real DOM API, while `createTerminalHost` (`terminal-host.ts`)
// itself is safe to construct for real under Node too (that module's own
// header comment) — so a registry test can assert real `session.attach`
// counts and real host disposal without a browser at all.

import type { StoreApi } from 'zustand';
import type { SessionId } from '@termhub/shared';

import { createTerminalHost, type TerminalHost } from './terminal-host.js';
import { selectWebglSessions } from './terminal-webgl-policy.js';
import type { TerminalBridge } from './terminal-session.js';
import { collectSessionIds, treeLeaves } from './store/tree.js';
import type { TermhubStore } from './store/store.js';
import type { Workspace } from './store/workspace.js';

/**
 * Every DOM operation the registry needs, injectable so this module has no
 * hard dependency on a real `document` (this file's header comment). The
 * production default (`createBrowserTerminalDom`) is the only implementation
 * that ever touches a real DOM API.
 */
export interface TerminalDom {
  /** A fresh, detached container for a new host — never yet appended anywhere. `terminal-host.ts` opens the xterm into this. */
  createHostElement(): HTMLElement;
  /** A fresh, detached container for the shared parking area — created once, lazily, the first time a host needs to be parked. */
  createParkElement(): HTMLElement;
  /** Where the parking container itself gets appended — `document.body` in production. */
  parkingParent(): HTMLElement;
  /** Moves `child` into `parent`, reparenting it if it was already somewhere else — the same semantics as a real `Node.appendChild`. */
  appendChild(parent: HTMLElement, child: HTMLElement): void;
  /** True only if `child`'s *current* parent is exactly `parent` (reference equality) — what `unplace` checks before moving anything (section 4.2: the ordering-independence guarantee). */
  isChildOf(child: HTMLElement, parent: HTMLElement): boolean;
  /** The pixel size used to gate `term.open()` (section 4.3) — `{ width: 0, height: 0 }` for a hidden/unmeasured element. */
  measure(element: HTMLElement): { width: number; height: number };
}

function createBrowserTerminalDom(): TerminalDom {
  return {
    createHostElement: () => {
      const el = document.createElement('div');
      // Fills whatever slot it's placed into — without this, a bare
      // `<div>` reports its *content* box (zero, until xterm's own DOM
      // gets appended by `term.open()`), never the slot's actual size, so
      // the observer this host relies on to trigger `open()` in the first
      // place (`terminal-host.ts`'s header comment, section 4.3) would
      // never see a non-zero report at all — found running this task's
      // Electron proof: the pane rendered with a correctly-sized slot but
      // an empty, zero-height host `<div>` inside it, and the terminal
      // never opened.
      el.style.width = '100%';
      el.style.height = '100%';
      return el;
    },
    createParkElement: () => {
      const el = document.createElement('div');
      // Out of layout flow and never painted — but not `display:none`,
      // which would report the exact same `{0,0}` a genuinely hidden
      // workspace tab does, and this container isn't that: it's parked
      // hosts, not a hidden pane waiting to become visible again.
      // `visibility:hidden` plus offscreen positioning keeps it inert
      // without conflating the two.
      el.style.position = 'fixed';
      el.style.top = '-10000px';
      el.style.left = '-10000px';
      el.style.width = '0';
      el.style.height = '0';
      el.style.overflow = 'hidden';
      el.style.visibility = 'hidden';
      return el;
    },
    parkingParent: () => document.body,
    appendChild: (parent, child) => {
      parent.appendChild(child);
    },
    isChildOf: (child, parent) => child.parentElement === parent,
    measure: (element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    },
  };
}

export interface TerminalRegistry {
  /** Idempotent. Moves the host element for `sessionId` into `slot`. No-op if the session has no host (not placed in any tree). */
  place(sessionId: SessionId, slot: HTMLElement): void;
  /** Parks the host element only if it is still inside `slot`. Never disposes. */
  unplace(sessionId: SessionId, slot: HTMLElement): void;
  /** Disposes every host and unsubscribes from the store. */
  dispose(): void;
}

export interface CreateTerminalRegistryOptions {
  bridge: TerminalBridge;
  store: StoreApi<TermhubStore>;
  dom?: TerminalDom;
  /** Default 8 (docs/specs/m3.5-terminal-lifecycle.md section 4.4 — deliberately half of Chromium's real ~16-context budget, section 3). */
  maxWebglContexts?: number;
  /**
   * Defaults to the real `createTerminalHost` (`terminal-host.ts`). This
   * field is this task's one addition beyond the techspec's section 5
   * signature — flagged here and in this task's final report rather than
   * added silently: `terminal-host.ts`'s *own* default DI (`createXterm`,
   * `observeElement`, `ensureFontReady`) is exactly what keeps *that*
   * module constructible under plain Node, but `terminal-host.ts`'s
   * defaults still reach for a real `ResizeObserver` at construction time —
   * a global plain Node has no polyfill for. Section 5's own claim ("é
   * isso que permite testar o registro no ambiente node, sem jsdom",
   * about `TerminalDom` alone) doesn't hold with the registry hard-wired to
   * the production host factory: `terminal-registry.test.ts` needs a way
   * to substitute a lightweight fake host so tests 1-4 can assert on
   * `session.attach` counts and dispose calls without ever touching a real
   * `ResizeObserver`/`document.fonts`. This is an *additive* field only —
   * every field the spec does list (`bridge`, `store`, `dom`,
   * `maxWebglContexts`) keeps exactly the behavior/defaults section 5
   * describes.
   */
  createHost?: typeof createTerminalHost;
}

interface HostRecord {
  host: TerminalHost;
  /** Registry's own edge-tracking of what it last told this host about WebGL — see `reconcileWebgl`'s header comment on why this is an edge trigger, not a level one. */
  webglDesired: boolean;
}

/** Every `sessionId` currently a leaf in *any* workspace's tree — section 4.1's "colocada em alguma árvore, em qualquer workspace". */
function computePlacedSessionIds(state: TermhubStore): Set<SessionId> {
  const placed = new Set<SessionId>();
  for (const workspace of state.workspaces) {
    for (const id of collectSessionIds(workspace.root)) {
      placed.add(id);
    }
  }
  return placed;
}

/**
 * The active workspace's currently-visible leaves, in order, plus its
 * focused pane — section 4.4's own definition: "a sessão está na árvore do
 * workspace ativo e esse workspace não tem painel maximizado, ou tem e é
 * ela". A maximized workspace reports only the maximized pane: `SplitTree`
 * itself only renders that one leaf's `TerminalSlot` in that case (its own
 * doc comment), so every other leaf's slot has already unmounted and parked
 * its host by the time this matters — this function doesn't need to special-
 * case that, it just never lists them.
 */
function computeVisible(state: TermhubStore): {
  visibleOrder: SessionId[];
  focusedSessionId: SessionId | undefined;
} {
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (workspace === undefined) {
    return { visibleOrder: [], focusedSessionId: undefined };
  }
  if (workspace.maximizedSessionId !== undefined) {
    return {
      visibleOrder: [workspace.maximizedSessionId],
      focusedSessionId: workspace.maximizedSessionId,
    };
  }
  return {
    visibleOrder: treeLeaves(workspace.root).map((leaf) => leaf.sessionId),
    focusedSessionId: workspace.focusedSessionId,
  };
}

/**
 * Builds the registry. Subscribes to `options.store` immediately and runs
 * one reconciliation pass synchronously before returning, so any session
 * already placed at construction time (e.g. boot's `hydrate`, if it ran
 * before this call) gets a host right away instead of waiting for the next
 * store change.
 */
export function createTerminalRegistry(options: CreateTerminalRegistryOptions): TerminalRegistry {
  const dom = options.dom ?? createBrowserTerminalDom();
  const maxWebglContexts = options.maxWebglContexts ?? 8;
  const buildHost = options.createHost ?? createTerminalHost;
  const hosts = new Map<SessionId, HostRecord>();
  let parkElement: HTMLElement | undefined;
  let disposed = false;

  function parkContainer(): HTMLElement {
    if (parkElement === undefined) {
      parkElement = dom.createParkElement();
      dom.appendChild(dom.parkingParent(), parkElement);
    }
    return parkElement;
  }

  /**
   * Section 4.4's assignment, recomputed fresh every time — but *applied* as
   * an edge trigger, not re-sent every tick: a host already holding WebGL
   * that's still in the desired set is left completely alone (no
   * detach+reattach churn on every store change), and a host whose context
   * was lost independently (`terminal-webgl.ts`'s own fallback, section
   * 4.4's last bullet) is *not* retried just because this function reruns
   * with the same "should have WebGL" answer — only a fresh transition from
   * "not desired" to "desired" calls `attachWebgl()` again. That transition
   * naturally happens the next time the host goes invisible and visible
   * again (its entry leaves `visibleOrder`, `webglDesired` flips to `false`,
   * and later returns), which is exactly the "não em loop" requirement.
   */
  function reconcileWebgl(): void {
    const state = options.store.getState();
    const { visibleOrder, focusedSessionId } = computeVisible(state);
    const visibleOpenSessionIds = visibleOrder.filter((id) => hosts.get(id)?.host.isOpen === true);
    const desired = selectWebglSessions({
      visibleOpenSessionIds,
      focusedSessionId,
      maxContexts: maxWebglContexts,
    });
    for (const [sessionId, record] of hosts) {
      const shouldHave = desired.has(sessionId);
      if (shouldHave && !record.webglDesired) {
        record.host.attachWebgl();
        record.webglDesired = true;
      } else if (!shouldHave && record.webglDesired) {
        record.host.detachWebgl();
        record.webglDesired = false;
      }
    }
  }

  function reconcile(): void {
    if (disposed) {
      return;
    }
    const state = options.store.getState();
    const placed = computePlacedSessionIds(state);

    for (const sessionId of placed) {
      if (hosts.has(sessionId)) {
        continue;
      }
      const session = state.sessions[sessionId];
      const element = dom.createHostElement();
      const host = buildHost({
        sessionId,
        cols: session?.cols ?? 80,
        rows: session?.rows ?? 24,
        bridge: options.bridge,
        element,
        onOpened: reconcileWebgl,
      });
      // Born parked — the corresponding `TerminalSlot` (mounted by the same
      // React re-render this store change triggers) calls `place()` into
      // its own slot right after, moving it out of parking. Starting parked
      // rather than detached-from-everything keeps `unplace`'s "still a
      // child of the given slot" check meaningful even for a host that's
      // never been placed yet.
      dom.appendChild(parkContainer(), element);
      hosts.set(sessionId, { host, webglDesired: false });
    }

    for (const [sessionId, record] of [...hosts]) {
      if (placed.has(sessionId)) {
        continue;
      }
      record.host.dispose();
      hosts.delete(sessionId);
    }

    reconcileWebgl();
  }

  const unsubscribe = options.store.subscribe(reconcile);
  reconcile();

  return {
    place(sessionId, slot) {
      const record = hosts.get(sessionId);
      if (record === undefined) {
        return;
      }
      dom.appendChild(slot, record.host.element);
      // A host that's already open may become visible in a *different*
      // sense right here (e.g. a maximize just made it the sole visible
      // pane) — recompute eagerly rather than waiting for the next store
      // tick, which may not come at all if nothing else changed.
      reconcileWebgl();
    },
    unplace(sessionId, slot) {
      const record = hosts.get(sessionId);
      if (record === undefined) {
        return;
      }
      // Section 4.2's ordering guarantee: only park if the element is
      // *still* inside `slot` — if a newer `place()` (into a different
      // slot) already ran first within the same commit, this is a no-op.
      if (!dom.isChildOf(record.host.element, slot)) {
        return;
      }
      dom.appendChild(parkContainer(), record.host.element);
      reconcileWebgl();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const [, record] of hosts) {
        record.host.dispose();
      }
      hosts.clear();
    },
  };
}

// Re-exported only for `terminal-registry.test.ts`'s fake — production code
// (`App.tsx`) never needs to name this type; it always uses the real
// `Workspace`/`TermhubStore` shapes.
export type { Workspace };
