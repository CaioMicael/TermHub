// Pure logic behind attaching/detaching the `@xterm/addon-webgl` renderer,
// deliberately free of any real xterm/DOM dependency so it can be driven by
// Vitest (`environment: 'node'`, the repo's default) with plain fakes —
// same style as `terminal-session.ts`. `Terminal.tsx` only wires this module
// to a real `@xterm/xterm` instance and a real `WebglAddon`.
//
// Scope: this milestone (M2.4) renders exactly one, always-visible solo
// terminal, so this module's whole job is "load WebGL if it works, fall
// back if it doesn't, never throw, never leak the GL context." Deciding
// *whether* to attach WebGL based on pane visibility, and juggling the
// ~16-context Chromium budget across many panels as panes mount/unmount
// repeatedly, is M3.5's job — `docs/specs/m3.5-webgl-lifecycle.md` (not
// written as of this task). This module is the single-terminal primitive
// that spec builds on, not the multi-panel policy.
//
// ## Fallback target: xterm's own default (DOM) renderer, not
// `@xterm/addon-canvas`
//
// docs/milestones.md's M2.4 line says "fallback para canvas". As of this
// task, `@xterm/addon-canvas` has no release compatible with this repo's
// `@xterm/xterm@6.0.0`: both its `latest` (0.7.0) and its `beta`
// (0.8.0-beta.48) tags declare `peerDependencies: { "@xterm/xterm": "^5.0.0"
// }` (checked with `npm view @xterm/addon-canvas@latest peerDependencies`
// and `npm view @xterm/addon-canvas@0.8.0-beta.48 peerDependencies` against
// this repo's installed `@xterm/xterm` — see this task's final report for
// the raw output). Installing it anyway would be the cross-major hack this
// task's instructions rule out.
//
// This turns out not to matter: `@xterm/addon-webgl`'s own `dispose()`
// already reverts the terminal to its built-in default renderer with no
// `addon-canvas` involved. Reading `node_modules/@xterm/addon-webgl/lib/
// addon-webgl.js` (installed version 0.19.0) directly, `WebglAddon.activate`
// registers a disposable that runs on the addon's own disposal:
//
//   this._register((0, t.toDisposable)(() => {
//     if (this._terminal._core._store._isDisposed) return;
//     const svc = this._terminal._core._renderService;
//     svc.setRenderer(this._terminal._core._createRenderer());
//     svc.handleResize(e.cols, e.rows);
//   }))
//
// i.e. disposing the WebGL addon *is* the fallback to the DOM renderer —
// there is nothing else this module needs to load.
//
// ## Why `dispose()` can be called from two places safely
//
// `onContextLoss` disposes the addon, and this module's own `detach()` also
// disposes it (e.g. on component unmount, whether or not context loss ever
// fired). This is safe because xterm's `AddonManager` (`node_modules/
// @xterm/xterm/lib/xterm.js`, installed version 6.0.0) wraps every loaded
// addon's `dispose` in `_wrappedAddonDispose`, which is guarded by an
// `isDisposed` flag and is a no-op on a second call:
//
//   _wrappedAddonDispose(e){
//     if(e.isDisposed) return;
//     ...
//     e.isDisposed = true; e.dispose.apply(e.instance); this._addons.splice(t,1);
//   }
//
// and separately, `Terminal.dispose()` disposes every *still-loaded* addon
// via that same manager (`this._addonManager = this._register(new
// AddonManager)`, whose own `dispose()` iterates `this._addons` calling
// `instance.dispose()`) — so a `Terminal.dispose()` in `Terminal.tsx`'s
// cleanup can never double-dispose an addon this module already disposed
// itself (it was already spliced out of `_addons`), and never *misses*
// disposing one this module left loaded.

export interface DisposableLike {
  dispose(): void;
}

/** The minimal slice of `@xterm/addon-webgl`'s `WebglAddon` this module needs. A real `WebglAddon` instance satisfies this structurally as-is. */
export interface WebglAddonLike extends DisposableLike {
  activate(terminal: unknown): void;
  onContextLoss(listener: () => void): DisposableLike;
}

/** The minimal slice of `@xterm/xterm`'s `Terminal` this module needs. A real `Terminal` instance satisfies this structurally as-is. */
export interface TerminalForWebgl {
  loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }): void;
}

/** Why WebGL isn't (or is no longer) the active renderer — surfaced for logging/tests, not for `Terminal.tsx` to act on (the fallback itself already happened by the time this fires). */
export type WebglFallbackReason = 'construct-failed' | 'load-failed' | 'context-lost';

export interface WebglRendererHandle {
  /** True once the addon loaded successfully and hasn't since lost its context or been detached. */
  readonly usingWebgl: boolean;
  /**
   * Detaches this helper: stops listening for context loss and disposes the
   * addon if it's still loaded (idempotent either way — see this module's
   * header comment). Safe to call unconditionally from `Terminal.tsx`'s
   * cleanup regardless of whether WebGL ever loaded or already fell back.
   */
  detach(): void;
}

/**
 * Attempts to load `createAddon()`'s addon onto `term`, falling back to
 * `term`'s own default renderer (never throwing) if construction or
 * `loadAddon` fails, and again if the context is later lost. `term` must
 * already be `open()`ed — `@xterm/addon-webgl` requires a live DOM element
 * (this module doesn't enforce that itself; `Terminal.tsx` is responsible
 * for load order).
 */
export function attachWebglRenderer(
  term: TerminalForWebgl,
  createAddon: () => WebglAddonLike,
  onFallback?: (reason: WebglFallbackReason) => void,
): WebglRendererHandle {
  let addon: WebglAddonLike | undefined;

  try {
    addon = createAddon();
  } catch (err) {
    console.error('[terminal-webgl] failed to construct WebglAddon, using default renderer', err);
    onFallback?.('construct-failed');
    return { usingWebgl: false, detach(): void {} };
  }

  try {
    term.loadAddon(addon);
  } catch (err) {
    console.error('[terminal-webgl] failed to load WebglAddon, using default renderer', err);
    disposeAddonSafely(addon);
    onFallback?.('load-failed');
    return { usingWebgl: false, detach(): void {} };
  }

  let usingWebgl = true;
  // Tracked independently of xterm's own idempotent-dispose guard (this
  // module's header comment) — `onContextLoss` and `detach()` can both
  // reach `disposeOnce` below, and this module does not assume anything
  // about how a given `WebglAddonLike` implementation behaves on a second
  // `dispose()` call.
  let disposed = false;
  const disposeOnce = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    disposeAddonSafely(addon);
  };

  const contextLossSubscription = addon.onContextLoss(() => {
    console.error('[terminal-webgl] WebGL context lost, falling back to default renderer');
    usingWebgl = false;
    // Disposing the addon itself is what restores the default renderer —
    // see this module's header comment. No replacement addon to load.
    disposeOnce();
    onFallback?.('context-lost');
  });

  return {
    get usingWebgl() {
      return usingWebgl;
    },
    detach(): void {
      contextLossSubscription.dispose();
      disposeOnce();
    },
  };
}

function disposeAddonSafely(addon: WebglAddonLike | undefined): void {
  if (addon === undefined) {
    return;
  }
  try {
    addon.dispose();
  } catch (err) {
    // Should be unreachable given xterm's own idempotent-dispose guard
    // (this module's header comment), but a `dispose()` throwing must never
    // propagate out of a cleanup path.
    console.error('[terminal-webgl] addon.dispose() threw', err);
  }
}
