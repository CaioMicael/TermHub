import { describe, expect, it } from 'vitest';

import {
  attachWebglRenderer,
  type DisposableLike,
  type TerminalForWebgl,
  type WebglAddonLike,
  type WebglFallbackReason,
  type WebglRendererHandle,
} from './terminal-webgl.js';

// Plain closures instead of `vi.fn()` spies, matching `terminal-session.test.ts`'s
// fake style — avoids referencing bare method properties from an object
// literal (`@typescript-eslint/unbound-method`) and keeps every fake's
// contract explicit (see each helper's own comment).

/** A fake WebGL addon whose `onContextLoss` listener the test can trigger, and whose `dispose()` call count is observable. */
function makeFakeAddon(): {
  addon: WebglAddonLike;
  triggerContextLoss: () => void;
  disposeCallCount: () => number;
} {
  let contextLossListener: (() => void) | undefined;
  let disposeCalls = 0;
  const addon: WebglAddonLike = {
    activate: () => undefined,
    dispose: () => {
      disposeCalls += 1;
    },
    onContextLoss: (listener: () => void): DisposableLike => {
      contextLossListener = listener;
      return { dispose: () => undefined };
    },
  };
  return {
    addon,
    triggerContextLoss: () => contextLossListener?.(),
    disposeCallCount: () => disposeCalls,
  };
}

/** A fake terminal recording every addon `loadAddon` is called with, optionally throwing instead. */
function makeFakeTerminal(throwOnLoad?: Error): {
  term: TerminalForWebgl;
  loadedAddons: unknown[];
} {
  const loadedAddons: unknown[] = [];
  const term: TerminalForWebgl = {
    loadAddon: (addon) => {
      if (throwOnLoad !== undefined) {
        throw throwOnLoad;
      }
      loadedAddons.push(addon);
    },
  };
  return { term, loadedAddons };
}

describe('attachWebglRenderer', () => {
  it('loads the addon onto the terminal and reports usingWebgl true', () => {
    const { addon, disposeCallCount } = makeFakeAddon();
    const { term, loadedAddons } = makeFakeTerminal();

    const handle = attachWebglRenderer(term, () => addon);

    expect(loadedAddons).toEqual([addon]);
    expect(handle.usingWebgl).toBe(true);
    expect(disposeCallCount()).toBe(0);
  });

  it('falls back without throwing when the addon constructor throws', () => {
    const { term, loadedAddons } = makeFakeTerminal();
    const fallbackReasons: WebglFallbackReason[] = [];

    let handle: WebglRendererHandle | undefined;
    expect(() => {
      handle = attachWebglRenderer(
        term,
        () => {
          throw new Error('no webgl2 context available');
        },
        (reason) => fallbackReasons.push(reason),
      );
    }).not.toThrow();

    expect(handle!.usingWebgl).toBe(false);
    expect(loadedAddons).toEqual([]);
    expect(fallbackReasons).toEqual(['construct-failed']);
    // detach() must remain safe to call even though nothing was ever loaded.
    expect(() => handle!.detach()).not.toThrow();
  });

  it('falls back without throwing when term.loadAddon throws, and disposes the partially-constructed addon', () => {
    const { addon, disposeCallCount } = makeFakeAddon();
    const { term } = makeFakeTerminal(new Error('WebGL context creation failed'));
    const fallbackReasons: WebglFallbackReason[] = [];

    const handle = attachWebglRenderer(
      term,
      () => addon,
      (reason) => fallbackReasons.push(reason),
    );

    expect(handle.usingWebgl).toBe(false);
    expect(disposeCallCount()).toBe(1);
    expect(fallbackReasons).toEqual(['load-failed']);
  });

  it('disposes the addon exactly once and flips usingWebgl to false when onContextLoss fires, without needing the terminal itself torn down', () => {
    const { addon, triggerContextLoss, disposeCallCount } = makeFakeAddon();
    const { term } = makeFakeTerminal();
    const fallbackReasons: WebglFallbackReason[] = [];

    const handle = attachWebglRenderer(
      term,
      () => addon,
      (reason) => fallbackReasons.push(reason),
    );
    expect(handle.usingWebgl).toBe(true);

    triggerContextLoss();

    expect(handle.usingWebgl).toBe(false);
    expect(disposeCallCount()).toBe(1);
    expect(fallbackReasons).toEqual(['context-lost']);

    // A second context-loss event (shouldn't happen from a real WebglAddon,
    // whose own dispose is idempotent, but this module must not assume that
    // and double-dispose regardless) must not call dispose again.
    triggerContextLoss();
    expect(disposeCallCount()).toBe(1);
  });

  it('detach() disposes the addon', () => {
    const { addon, disposeCallCount } = makeFakeAddon();
    const { term } = makeFakeTerminal();

    const handle = attachWebglRenderer(term, () => addon);
    handle.detach();

    expect(disposeCallCount()).toBe(1);
  });

  it('detach() after a context loss does not dispose the addon a second time', () => {
    const { addon, triggerContextLoss, disposeCallCount } = makeFakeAddon();
    const { term } = makeFakeTerminal();

    const handle = attachWebglRenderer(term, () => addon);
    triggerContextLoss();
    expect(disposeCallCount()).toBe(1);

    handle.detach();
    expect(disposeCallCount()).toBe(1);
  });
});
