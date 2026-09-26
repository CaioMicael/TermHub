import { describe, expect, it } from 'vitest';

import { createTerminalHost, type ElementObserverHandle, type XTermLike } from './terminal-host.js';
import { forgetSessionOwnership, type TerminalBridge } from './terminal-session.js';

/** A `TerminalBridge` fake that resolves every request immediately and never emits data — this file only cares about `open()` gating, not attach/data flow (that's `terminal-session.test.ts`'s job). */
function createFakeBridge(): TerminalBridge {
  return {
    request: () => Promise.resolve({}),
    sendData: () => {},
    onData: () => () => {},
    readClipboardText: () => Promise.resolve(''),
    writeClipboardText: () => Promise.resolve(),
    openContextMenu: () => Promise.resolve(undefined),
  };
}

/** A DOM-free stand-in for the host's container element — just enough for `terminal-host.ts`'s own `addEventListener`/`removeEventListener` (contextmenu) calls to be no-ops. */
function createFakeElement(): HTMLElement {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLElement;
}

/** A fake xterm recording whether/how many times `open()` was called — this file's whole point (armadilha 4/1: `open()` must never run against a zero-sized or not-yet-font-ready host). Also records every `write()`/`reset()` call, for M4.8's reattach tests (below). */
function createFakeXterm(): {
  term: XTermLike;
  openCalls: HTMLElement[];
  writes: string[];
  resetCalls: () => number;
} {
  const openCalls: HTMLElement[] = [];
  const writes: string[] = [];
  const state = { resetCalls: 0 };
  const term: XTermLike = {
    cols: 80,
    rows: 24,
    unicode: { activeVersion: '6' },
    loadAddon: () => {},
    onData: () => ({ dispose: () => {} }),
    onBinary: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
    open: (element) => {
      openCalls.push(element);
    },
    write: (data) => {
      writes.push(new TextDecoder().decode(data));
    },
    hasSelection: () => false,
    getSelection: () => '',
    paste: () => {},
    reset: () => {
      state.resetCalls += 1;
    },
    dispose: () => {},
  };
  return {
    term,
    openCalls,
    writes,
    resetCalls: () => state.resetCalls,
  };
}

/**
 * A `TerminalBridge` fake that actually tracks `session.attach`/
 * `session.detach` calls and lets the test emit data for a session — M4.8's
 * reattach tests need both, unlike every other test in this file (which
 * only cares about `open()` gating against `createFakeBridge`'s inert
 * stand-in above).
 */
function createEmittingBridge(): {
  bridge: TerminalBridge;
  requests: Array<{ method: string }>;
  emit: (sessionId: number, text: string) => void;
} {
  const listeners = new Set<(sessionId: number, data: Uint8Array) => void>();
  const requests: Array<{ method: string }> = [];
  const bridge: TerminalBridge = {
    request: (method) => {
      requests.push({ method });
      return Promise.resolve({});
    },
    sendData: () => {},
    onData: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readClipboardText: () => Promise.resolve(''),
    writeClipboardText: () => Promise.resolve(),
    openContextMenu: () => Promise.resolve(undefined),
  };
  return {
    bridge,
    requests,
    emit: (sessionId, text) => {
      const data = new TextEncoder().encode(text);
      for (const listener of listeners) {
        listener(sessionId, data);
      }
    },
  };
}

/** A controllable stand-in for `defaultObserveElement` — the test drives `trigger(width, height)` itself instead of relying on a real `ResizeObserver`. */
function createFakeObserver(): {
  observeElement: (
    element: HTMLElement,
    onResize: (width: number, height: number) => void,
  ) => ElementObserverHandle;
  trigger: (width: number, height: number) => void;
  disconnected: () => boolean;
} {
  let onResize: ((width: number, height: number) => void) | undefined;
  let disconnected = false;
  return {
    observeElement: (_element, cb) => {
      onResize = cb;
      return { disconnect: () => (disconnected = true) };
    },
    trigger: (width, height) => onResize?.(width, height),
    disconnected: () => disconnected,
  };
}

/** A controllable, never-auto-resolving font-ready promise — the test resolves it itself, on its own schedule, to prove `open()` waits for it. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createTerminalHost — open() gating (armadilha 1 e 4)', () => {
  it('never opens while every resize report so far has been zero-sized', () => {
    const { term, openCalls } = createFakeXterm();
    const { observeElement, trigger } = createFakeObserver();
    const font = createDeferred();
    font.resolve(); // font is ready from the start — only size is the gate here

    createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: createFakeBridge(),
      element: createFakeElement(),
      createXterm: () => term,
      observeElement,
      ensureFontReady: () => font.promise,
    });

    trigger(0, 0);
    trigger(0, 40);
    trigger(40, 0);

    expect(openCalls).toEqual([]);
  });

  it('does not open before the font-ready promise resolves, even with a non-zero size already reported', async () => {
    const { term, openCalls } = createFakeXterm();
    const { observeElement, trigger } = createFakeObserver();
    const font = createDeferred();

    createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: createFakeBridge(),
      element: createFakeElement(),
      createXterm: () => term,
      observeElement,
      ensureFontReady: () => font.promise,
    });

    trigger(120, 40);
    // Give any stray microtask a chance to run — there should be none yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(openCalls).toEqual([]);

    font.resolve();
    await font.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(openCalls).toHaveLength(1);
  });

  it('opens exactly once, into the host element, even when several non-zero resizes arrive', async () => {
    const { term, openCalls } = createFakeXterm();
    const { observeElement, trigger } = createFakeObserver();
    const font = createDeferred();
    font.resolve();
    const element = createFakeElement();

    const host = createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: createFakeBridge(),
      element,
      createXterm: () => term,
      observeElement,
      ensureFontReady: () => font.promise,
    });

    trigger(120, 40);
    await Promise.resolve();
    await Promise.resolve();
    trigger(200, 60);
    trigger(80, 24);
    await Promise.resolve();
    await Promise.resolve();

    expect(openCalls).toEqual([element]);
    expect(host.isOpen).toBe(true);
  });

  it('opens once visible even without ever being "placed" again — the resize observer alone is the visibility signal (docs/specs/m3.5-terminal-lifecycle.md section 4.3)', async () => {
    const { term, openCalls } = createFakeXterm();
    const { observeElement, trigger } = createFakeObserver();
    const font = createDeferred();
    font.resolve();

    createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: createFakeBridge(),
      element: createFakeElement(),
      createXterm: () => term,
      observeElement,
      ensureFontReady: () => font.promise,
    });

    // Simulates a hidden workspace's host: parked with zero size for a
    // while (no `place()` call happens on a tab switch — only a CSS
    // `display` toggle further up the tree), then the workspace becomes
    // active and the very same observer reports a real size.
    trigger(0, 0);
    trigger(0, 0);
    trigger(300, 80);
    await Promise.resolve();
    await Promise.resolve();

    expect(openCalls).toHaveLength(1);
  });

  it('dispose() disconnects the observer and never opens afterwards', () => {
    const { term, openCalls } = createFakeXterm();
    const { observeElement, trigger, disconnected } = createFakeObserver();
    const font = createDeferred();

    const host = createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: createFakeBridge(),
      element: createFakeElement(),
      createXterm: () => term,
      observeElement,
      ensureFontReady: () => font.promise,
    });

    host.dispose();
    expect(disconnected()).toBe(true);

    font.resolve();
    trigger(120, 40);
    expect(openCalls).toEqual([]);
  });
});

describe('createTerminalHost.reattach() (docs/specs/m4.8-daemon-resilience.md required test 3)', () => {
  /**
   * Builds a fake xterm and bridge that both append to one shared, ordered
   * `events` timeline (`'attach'` for every `session.attach` the bridge
   * sees, `'reset'` for every `term.reset()` call) — what actually proves
   * "no duplication" is the *order* `reattach()` produces them in: `reset`
   * has to land strictly before the *next* `attach`'s snapshot could
   * possibly write anything, never after.
   */
  function createOrderedFakes(): {
    term: XTermLike;
    bridge: TerminalBridge;
    events: string[];
    emit: (sessionId: number, text: string) => void;
  } {
    const events: string[] = [];
    const listeners = new Set<(sessionId: number, data: Uint8Array) => void>();
    const term: XTermLike = {
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '6' },
      loadAddon: () => {},
      onData: () => ({ dispose: () => {} }),
      onBinary: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: () => {},
      open: () => {},
      write: (data) => {
        events.push(`write:${new TextDecoder().decode(data)}`);
      },
      hasSelection: () => false,
      getSelection: () => '',
      paste: () => {},
      reset: () => {
        events.push('reset');
      },
      dispose: () => {},
    };
    const bridge: TerminalBridge = {
      request: (method) => {
        if (method === 'session.attach') {
          events.push('attach');
        }
        return Promise.resolve({});
      },
      sendData: () => {},
      onData: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      readClipboardText: () => Promise.resolve(''),
      writeClipboardText: () => Promise.resolve(),
      openContextMenu: () => Promise.resolve(undefined),
    };
    return {
      term,
      bridge,
      events,
      emit: (sessionId, text) => {
        const data = new TextEncoder().encode(text);
        for (const listener of listeners) {
          listener(sessionId, data);
        }
      },
    };
  }

  it('⚑ without a reset() call, the old content and the fresh snapshot both land in the xterm, back to back — duplicated, not replaced', () => {
    // Models the defect directly: reattaching by hand (detach then a fresh
    // `attachTerminalSession`) with no `term.reset()` in between — exactly
    // what a `reattach()` without this task's fix would do.
    const fake = createOrderedFakes();
    const host = createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: fake.bridge,
      element: createFakeElement(),
      createXterm: () => fake.term,
      observeElement: () => ({ disconnect: () => {} }),
    });
    fake.emit(1, 'OLD');
    host.dispose(); // releases the attach, but this stand-in never calls reset()
    // The ownership map (`terminal-session.ts`) is forgotten here so this
    // test isolates exactly the one thing it's demonstrating (no reset()
    // between two attaches) — without this, the *second* `attachTerminalSession`
    // below would itself be silently absorbed by React.StrictMode's own
    // deferred-detach mechanism (the *other* trap, closed separately by
    // `forgetSessionOwnership`'s own required tests in
    // terminal-session.test.ts), and this test would never even reach the
    // scenario it's meant to show.
    forgetSessionOwnership(fake.bridge);
    createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: fake.bridge,
      element: createFakeElement(),
      createXterm: () => fake.term,
      observeElement: () => ({ disconnect: () => {} }),
    });
    fake.emit(1, 'NEW');

    expect(fake.events).toEqual(['attach', 'write:OLD', 'attach', 'write:NEW']);
    // No 'reset' anywhere in the timeline — a real xterm's buffer would
    // show 'OLD' immediately followed by 'NEW', not 'NEW' alone.
    expect(fake.events).not.toContain('reset');
  });

  it('reattach() resets the xterm strictly before requesting the fresh attach — no duplication', () => {
    const fake = createOrderedFakes();
    const host = createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: fake.bridge,
      element: createFakeElement(),
      createXterm: () => fake.term,
      observeElement: () => ({ disconnect: () => {} }),
    });
    fake.emit(1, 'OLD');
    expect(fake.events).toEqual(['attach', 'write:OLD']);

    fake.events.length = 0;
    // The real caller contract (`TerminalHost.reattach`'s own doc comment):
    // the whole bridge's ownership map has already been forgotten before
    // this is called (`terminal-registry.ts`'s `reattachAll`, itself called
    // after `daemon-resync.ts`'s own `forgetSessionOwnership`) — without
    // this, the fresh `attachTerminalSession` inside `reattach()` would be
    // absorbed the same way a bare StrictMode remount is, and no second
    // `session.attach` would ever go out.
    forgetSessionOwnership(fake.bridge);
    host.reattach();

    // reset() happens *before* the new session.attach request goes out —
    // the ordering docs/specs/m4.8-daemon-resilience.md section 2.2
    // requires, so any snapshot the daemon sends can never land on top of
    // the old content.
    expect(fake.events).toEqual(['reset', 'attach']);

    fake.events.length = 0;
    fake.emit(1, 'FRESH-SNAPSHOT');
    expect(fake.events).toEqual(['write:FRESH-SNAPSHOT']);
  });

  it('reattach() is a safe no-op once the host is disposed', () => {
    const { term } = createFakeXterm();
    const fake = createEmittingBridge();

    const host = createTerminalHost({
      sessionId: 1,
      cols: 80,
      rows: 24,
      bridge: fake.bridge,
      element: createFakeElement(),
      createXterm: () => term,
      observeElement: () => ({ disconnect: () => {} }),
    });

    host.dispose();
    expect(() => host.reattach()).not.toThrow();
  });
});

describe('createTerminalHost — xterm.css is imported (regression)', () => {
  // The pane rendered structurally correct but every pixel of the WebGL
  // canvas came out fully transparent, in a real Electron proof, with no
  // exception anywhere: `.xterm`, `.xterm-viewport`, `.xterm-screen` and its
  // canvases were all `position: static` instead of `relative`/`absolute`
  // (confirmed by diffing `getComputedStyle` against a pre-M3.5 build that
  // rendered correctly). `Terminal.tsx`'s own `import '@xterm/xterm/css/
  // xterm.css'` — the only thing that ever set those rules — was never
  // carried over to `terminal-host.ts` when the logic migrated (M3.5's
  // prompt didn't call this import out explicitly, and it produces no
  // TypeScript or lint error to drop silently). Losing it doesn't just
  // mis-position a few elements: xterm's own layered-canvas rendering model
  // depends on this stylesheet's absolute positioning to composite the
  // WebGL/link-layer/DOM-fallback layers correctly at all.
  //
  // This can't be exercised by opening a real xterm against jsdom (the repo
  // has none, and `terminal-host.ts`'s own tests deliberately fake the DOM
  // seams instead — see this file's header). What *is* checkable without a
  // browser is the one thing that actually broke: this module's own source
  // no longer contains the import at all once someone deletes it — a plain
  // text check on the file this test lives beside, not a behavioral
  // assertion, but exactly the class of regression this defect was.
  it("this module's source imports @xterm/xterm/css/xterm.css", async () => {
    // Vite/Vitest's `?raw` suffix imports the file as a plain string,
    // instead of executing it — no `node:fs` needed (this package has no
    // `@types/node`, on purpose: it's the browser-facing half of the
    // monorepo, `packages/daemon/tsconfig.json`'s own comment on why that
    // package needs `"types": ["node"]` and this one doesn't).
    const { default: source } = await import('./terminal-host.ts?raw');
    expect(source).toMatch(/import\s+['"]@xterm\/xterm\/css\/xterm\.css['"]/);
  });
});
