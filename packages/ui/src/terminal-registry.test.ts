import { beforeEach, describe, expect, it } from 'vitest';

import { createTerminalRegistry, type TerminalDom } from './terminal-registry.js';
import type { TerminalHost, TerminalHostOptions } from './terminal-host.js';
import type { TerminalBridge } from './terminal-session.js';
import { initialStoreState, useTermhubStore } from './store/store.js';
import type { SessionSummary } from '@termhub/shared';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Counts `session.attach`/`session.detach` calls per session — this file's whole point (tests 1 and 4). Every other RPC/method this file doesn't exercise is stubbed just enough to satisfy `TerminalBridge`. */
function createFakeBridge(): {
  bridge: TerminalBridge;
  calls: Array<{ method: string; sessionId: number }>;
} {
  const calls: Array<{ method: string; sessionId: number }> = [];
  const bridge: TerminalBridge = {
    request: (method, params) => {
      calls.push({ method, sessionId: params.sessionId });
      return Promise.resolve({});
    },
    sendData: () => {},
    onData: () => () => {},
    readClipboardText: () => Promise.resolve(''),
    writeClipboardText: () => Promise.resolve(),
    openContextMenu: () => Promise.resolve(undefined),
  };
  return { bridge, calls };
}

/**
 * An in-memory `TerminalDom`: parent/child relationships tracked in a plain
 * `Map`, never touching a real DOM API — what section 5 of docs/specs/
 * m3.5-terminal-lifecycle.md calls out by name as what makes the registry
 * testable in plain Node, no jsdom. "Elements" here are just distinguishable
 * plain objects (`makeElement`, below), cast to `HTMLElement` only to
 * satisfy the (compile-time-only, under this test's `node` environment)
 * type — the registry itself never calls a real DOM method on them, only
 * ever routes through this `TerminalDom`.
 */
function createFakeDom(): {
  dom: TerminalDom;
  parentOf: (el: HTMLElement) => HTMLElement | undefined;
} {
  const parents = new Map<HTMLElement, HTMLElement>();
  const bodyMarker = makeElement('body');
  const dom: TerminalDom = {
    createHostElement: () => makeElement('host'),
    createParkElement: () => makeElement('park'),
    parkingParent: () => bodyMarker,
    appendChild: (parent, child) => {
      parents.set(child, parent);
    },
    isChildOf: (child, parent) => parents.get(child) === parent,
    measure: () => ({ width: 100, height: 40 }),
  };
  return { dom, parentOf: (el) => parents.get(el) };
}

let elementCounter = 0;
function makeElement(kind: string): HTMLElement {
  return { __kind: kind, __id: ++elementCounter } as unknown as HTMLElement;
}

/** A slot is just another opaque marker, from the test's point of view — standing in for the real `div` `TerminalSlot.tsx` would render. */
function makeSlot(): HTMLElement {
  return makeElement('slot');
}

interface FakeHostRecord {
  element: HTMLElement;
  disposed: boolean;
  usingWebgl: boolean;
  attachWebglCalls: number;
  detachWebglCalls: number;
  isOpen: boolean;
}

/**
 * A `createTerminalHost` stand-in that never touches xterm or a real DOM —
 * `terminal-host.ts`'s own defaults reach for a real `ResizeObserver` at
 * construction time (a global plain Node has no polyfill for), so the
 * registry's own tests need a lighter substitute (this file's final report
 * entry on why `CreateTerminalRegistryOptions.createHost` exists at all).
 * Still routes `session.attach`/`session.detach` through the *same* fake
 * bridge the test itself passed to `createTerminalRegistry` — so this
 * file's assertions about attach/detach counts exercise the registry's own
 * host-lifecycle bookkeeping, not a fake's.
 */
function createFakeHostFactory(startsOpen: boolean = true): {
  createHost: (options: TerminalHostOptions) => TerminalHost;
  records: Map<number, FakeHostRecord>;
} {
  const records = new Map<number, FakeHostRecord>();
  const createHost = (options: TerminalHostOptions): TerminalHost => {
    const record: FakeHostRecord = {
      element: options.element,
      disposed: false,
      usingWebgl: false,
      attachWebglCalls: 0,
      detachWebglCalls: 0,
      isOpen: startsOpen,
    };
    records.set(options.sessionId, record);
    options.bridge.request('session.attach', { sessionId: options.sessionId }).catch(() => {});
    return {
      sessionId: options.sessionId,
      element: options.element,
      get isOpen() {
        return record.isOpen;
      },
      get usingWebgl() {
        return record.usingWebgl;
      },
      attachWebgl(): void {
        record.attachWebglCalls += 1;
        record.usingWebgl = true;
      },
      detachWebgl(): void {
        record.detachWebglCalls += 1;
        record.usingWebgl = false;
      },
      dispose(): void {
        if (record.disposed) {
          return;
        }
        record.disposed = true;
        options.bridge.request('session.detach', { sessionId: options.sessionId }).catch(() => {});
      },
    };
  };
  return { createHost, records };
}

function makeSession(id: number): SessionSummary {
  return {
    id,
    name: `session-${id}`,
    shell: 'powershell.exe',
    cwd: 'C:\\',
    cols: 80,
    rows: 24,
    status: 'running',
    createdAt: 0,
  } as unknown as SessionSummary;
}

function attachCountFor(
  calls: Array<{ method: string; sessionId: number }>,
  sessionId: number,
): number {
  return calls.filter((c) => c.method === 'session.attach' && c.sessionId === sessionId).length;
}
function detachCountFor(
  calls: Array<{ method: string; sessionId: number }>,
  sessionId: number,
): number {
  return calls.filter((c) => c.method === 'session.detach' && c.sessionId === sessionId).length;
}

beforeEach(() => {
  useTermhubStore.getState().hydrate(initialStoreState);
});

// ---------------------------------------------------------------------------
// Test 1 — split/collapse/maximize/restore never recreate an existing host
// ---------------------------------------------------------------------------

describe('terminal-registry — test 1: layout reshaping never recreates an existing host', () => {
  it('split: A keeps its host (no extra session.attach, no dispose) while B gets a fresh one', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces: [
        {
          id: 'ws1',
          name: 'ws1',
          cwd: 'C:\\',
          root: { kind: 'leaf', sessionId: 1 },
          focusedSessionId: 1,
          maximizedSessionId: undefined,
        },
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession(1) },
    });

    const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });

    const slotA1 = makeSlot();
    registry.place(1, slotA1);
    expect(attachCountFor(calls, 1)).toBe(1);

    // Split: B enters the tree. Per M3.2 (`3e8c165`), the tree reshaping
    // remounts A's own slot too (a new `Group`/`Panel` wraps it) — simulate
    // that: A's old slot unmounts (`unplace`) and a new one mounts
    // (`place`), same session id, different DOM node.
    useTermhubStore.getState().upsertSession(makeSession(2));
    useTermhubStore.getState().split('ws1', 1, 2, 'row', 'split-1');

    registry.unplace(1, slotA1);
    const slotA2 = makeSlot();
    registry.place(1, slotA2);
    const slotB = makeSlot();
    registry.place(2, slotB);

    expect(attachCountFor(calls, 1)).toBe(1); // still just the original attach
    expect(records.get(1)?.disposed).toBe(false);
    expect(attachCountFor(calls, 2)).toBe(1); // B's own, brand-new host
  });

  it('closing the pane that collapses the parent leaves the surviving pane untouched', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces: [
        {
          id: 'ws1',
          name: 'ws1',
          cwd: 'C:\\',
          root: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            a: { kind: 'leaf', sessionId: 1 },
            b: { kind: 'leaf', sessionId: 2 },
          },
          focusedSessionId: 1,
          maximizedSessionId: undefined,
        },
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession(1), 2: makeSession(2) },
    });

    const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });
    const slotA = makeSlot();
    const slotB = makeSlot();
    registry.place(1, slotA);
    registry.place(2, slotB);
    expect(attachCountFor(calls, 1)).toBe(1);
    expect(attachCountFor(calls, 2)).toBe(1);

    // Close B: the split node collapses, A rises to replace it — simulate
    // the resulting remount of A's slot (same session, new DOM node), and
    // B's slot unmounting for good.
    useTermhubStore.getState().closePane('ws1', 2);
    registry.unplace(2, slotB);
    registry.unplace(1, slotA);
    const slotANew = makeSlot();
    registry.place(1, slotANew);

    expect(attachCountFor(calls, 1)).toBe(1);
    expect(records.get(1)?.disposed).toBe(false);
    expect(records.get(2)?.disposed).toBe(true);
    expect(detachCountFor(calls, 2)).toBe(1);
  });

  it('maximize then restore never re-attaches or disposes any pane', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces: [
        {
          id: 'ws1',
          name: 'ws1',
          cwd: 'C:\\',
          root: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            a: { kind: 'leaf', sessionId: 1 },
            b: { kind: 'leaf', sessionId: 2 },
          },
          focusedSessionId: 1,
          maximizedSessionId: undefined,
        },
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession(1), 2: makeSession(2) },
    });

    const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });
    let slotA = makeSlot();
    let slotB = makeSlot();
    registry.place(1, slotA);
    registry.place(2, slotB);

    // Maximize A: `SplitTree` renders only A's leaf now (a different render
    // branch entirely) — B's slot unmounts for good (until restore), A's
    // slot remounts into the solo/maximized branch.
    useTermhubStore.getState().toggleMaximize('ws1', 1);
    registry.unplace(2, slotB);
    registry.unplace(1, slotA);
    slotA = makeSlot();
    registry.place(1, slotA);

    expect(attachCountFor(calls, 1)).toBe(1);
    expect(attachCountFor(calls, 2)).toBe(1);
    expect(records.get(2)?.disposed).toBe(false); // parked, not closed

    // Restore: back to the split branch, both slots remount.
    useTermhubStore.getState().toggleMaximize('ws1', 1);
    registry.unplace(1, slotA);
    slotA = makeSlot();
    slotB = makeSlot();
    registry.place(1, slotA);
    registry.place(2, slotB);

    expect(attachCountFor(calls, 1)).toBe(1);
    expect(attachCountFor(calls, 2)).toBe(1);
    expect(records.get(1)?.disposed).toBe(false);
    expect(records.get(2)?.disposed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — place/unplace ordering never matters
// ---------------------------------------------------------------------------

describe('terminal-registry — test 2: place/unplace ordering independence', () => {
  it('ends up in the new slot whether place(new) runs before or after unplace(old)', () => {
    for (const placeFirst of [true, false]) {
      const { bridge } = createFakeBridge();
      const { dom, parentOf } = createFakeDom();
      const { createHost, records } = createFakeHostFactory();

      useTermhubStore.getState().hydrate({
        ...initialStoreState,
        workspaces: [
          {
            id: 'ws1',
            name: 'ws1',
            cwd: 'C:\\',
            root: { kind: 'leaf', sessionId: 1 },
            focusedSessionId: 1,
            maximizedSessionId: undefined,
          },
        ],
        activeWorkspaceId: 'ws1',
        sessions: { 1: makeSession(1) },
      });

      const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });
      const oldSlot = makeSlot();
      registry.place(1, oldSlot);
      const newSlot = makeSlot();

      if (placeFirst) {
        registry.place(1, newSlot);
        registry.unplace(1, oldSlot);
      } else {
        registry.unplace(1, oldSlot);
        registry.place(1, newSlot);
      }

      // The host element must end up parented by `newSlot` either way, and
      // `unplace(oldSlot)` — whichever order it ran in — must never have
      // disposed anything (section 4.2: "unplace... nunca descarta nada").
      const hostElement = records.get(1)?.element;
      expect(hostElement).toBeDefined();
      expect(parentOf(hostElement as HTMLElement)).toBe(newSlot);
      expect(records.get(1)?.disposed).toBe(false);

      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — 3 workspaces × 10 tab switches
// ---------------------------------------------------------------------------

describe('terminal-registry — test 3: 3 workspaces × 10 tab switches', () => {
  it('never re-attaches on a tab switch, and keeps WebGL within the cap and within what is visible', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    const workspaces = [1, 2, 3].map((n) => ({
      id: `ws${n}`,
      name: `ws${n}`,
      cwd: 'C:\\',
      root: {
        kind: 'split' as const,
        id: `split-${n}`,
        dir: 'row' as const,
        ratio: 0.5,
        a: { kind: 'leaf' as const, sessionId: n * 2 - 1 },
        b: { kind: 'leaf' as const, sessionId: n * 2 },
      },
      focusedSessionId: n * 2 - 1,
      maximizedSessionId: undefined,
    }));
    const sessions: Record<number, SessionSummary> = {};
    for (let id = 1; id <= 6; id++) {
      sessions[id] = makeSession(id);
    }

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces,
      activeWorkspaceId: 'ws1',
      sessions,
    });

    // maxWebglContexts: 1 deliberately stresses the cap even though only
    // 2 panes are ever visible at once — with a generous cap (the real
    // default, 8), 2-visible-at-a-time would never actually exercise it.
    const registry = createTerminalRegistry({
      bridge,
      store: useTermhubStore,
      dom,
      createHost,
      maxWebglContexts: 1,
    });

    // Boot: every pane's slot mounts exactly once. Every workspace stays
    // mounted forever after, switched only by a CSS `display` toggle further
    // up the tree (`App.tsx`'s own doc comment) — so switching tabs below
    // never calls `place`/`unplace` again, only `setActiveWorkspace`.
    for (let id = 1; id <= 6; id++) {
      registry.place(id, makeSlot());
    }

    const visibleIdsByWorkspace: Record<string, number[]> = {
      ws1: [1, 2],
      ws2: [3, 4],
      ws3: [5, 6],
    };
    const order = ['ws1', 'ws2', 'ws3'];
    for (let i = 0; i < 10; i++) {
      const wsId = order[i % order.length] as string;
      useTermhubStore.getState().setActiveWorkspace(wsId);

      for (let id = 1; id <= 6; id++) {
        expect(attachCountFor(calls, id)).toBe(1);
      }

      const usingWebglIds = [...records.entries()]
        .filter(([, r]) => r.usingWebgl)
        .map(([id]) => id);
      expect(usingWebglIds.length).toBeLessThanOrEqual(1); // the cap
      const visibleIds = visibleIdsByWorkspace[wsId] as number[];
      for (const id of usingWebglIds) {
        expect(visibleIds).toContain(id); // never a hidden workspace's pane
      }
    }

    expect(calls.filter((c) => c.method === 'session.attach')).toHaveLength(6);
    registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — closePane disposes the host; a move-only change does not
// ---------------------------------------------------------------------------

describe('terminal-registry — test 4: dispose only when a session leaves every tree', () => {
  it('closePane disposes the host (detach sent, host torn down)', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces: [
        {
          id: 'ws1',
          name: 'ws1',
          cwd: 'C:\\',
          root: { kind: 'leaf', sessionId: 1 },
          focusedSessionId: 1,
          maximizedSessionId: undefined,
        },
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession(1) },
    });

    const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });
    registry.place(1, makeSlot());
    expect(records.get(1)?.disposed).toBe(false);

    useTermhubStore.getState().closePane('ws1', 1);

    expect(records.get(1)?.disposed).toBe(true);
    expect(detachCountFor(calls, 1)).toBe(1);
    registry.dispose();
  });

  it('a pane that only moves (movePane) keeps its host alive', () => {
    const { bridge, calls } = createFakeBridge();
    const { dom } = createFakeDom();
    const { createHost, records } = createFakeHostFactory();

    useTermhubStore.getState().hydrate({
      ...initialStoreState,
      workspaces: [
        {
          id: 'ws1',
          name: 'ws1',
          cwd: 'C:\\',
          root: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            a: { kind: 'leaf', sessionId: 1 },
            b: { kind: 'leaf', sessionId: 2 },
          },
          focusedSessionId: 1,
          maximizedSessionId: undefined,
        },
      ],
      activeWorkspaceId: 'ws1',
      sessions: { 1: makeSession(1), 2: makeSession(2) },
    });

    const registry = createTerminalRegistry({ bridge, store: useTermhubStore, dom, createHost });
    registry.place(1, makeSlot());
    registry.place(2, makeSlot());

    useTermhubStore.getState().movePane('ws1', 1, 2, 'right', 'split-2');

    expect(records.get(1)?.disposed).toBe(false);
    expect(records.get(2)?.disposed).toBe(false);
    expect(attachCountFor(calls, 1)).toBe(1);
    expect(attachCountFor(calls, 2)).toBe(1);
    registry.dispose();
  });
});
