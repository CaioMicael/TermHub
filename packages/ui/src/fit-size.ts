import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { TERMINAL_FONT_OPTIONS, ensureTerminalFontReady } from './terminal-theme.js';

export interface FitSize {
  cols: number;
  rows: number;
}

/**
 * Measures the terminal grid size (cols/rows) that fitting an xterm
 * instance into `container` would produce, without keeping that instance
 * around afterwards. `Terminal.tsx` needs a *live* session to attach to
 * before it ever mounts a real xterm — so the app's provisional boot logic
 * (`packages/app/src/renderer/src`, M2.3's session.create path) calls this
 * first to size a freshly created PTY to the space it will actually render
 * into, before that PTY (or its `Terminal`) exists. `Terminal`'s own
 * mount-time `fit()` against its real, long-lived xterm instance is a
 * separate, later call — this function's whole point is answering "how big
 * would that terminal be" a step earlier, cheaply and disposably.
 *
 * M2.4 addendum (this task): this probe now constructs with
 * `TERMINAL_FONT_OPTIONS`, the exact same font family/size/line-height
 * object `Terminal.tsx` uses (`terminal-theme.ts`), and awaits
 * `ensureTerminalFontReady()` before measuring — both to guard against the
 * same "measured with the fallback font" failure mode `Terminal.tsx` does
 * (see that module's own comment), and, just as importantly, so the two
 * measure the *same* cell size as each other. If they didn't, a freshly
 * created PTY would be sized to a cols/rows this probe computed that the
 * real `Terminal` then disagrees with once it renders — a size mismatch
 * with no resize to correct it until M2.5. `caller` is responsible for
 * giving this function a `container` that resolves to the same usable
 * pixel box `Terminal.tsx` will actually render into (same padding, same
 * ancestor chain shape) — see `App.tsx`'s solo-pane container for how this
 * repo satisfies that today.
 */
export async function measureFitSize(container: HTMLElement): Promise<FitSize> {
  await ensureTerminalFontReady();

  const probe = new XTerm({ cols: 80, rows: 24, ...TERMINAL_FONT_OPTIONS });
  const fitAddon = new FitAddon();
  probe.loadAddon(fitAddon);
  probe.open(container);
  fitAddon.fit();
  const { cols, rows } = probe;
  probe.dispose();
  return { cols, rows };
}
