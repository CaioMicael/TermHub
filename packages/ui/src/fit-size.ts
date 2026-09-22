import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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
 */
export function measureFitSize(container: HTMLElement): FitSize {
  const probe = new XTerm({ cols: 80, rows: 24 });
  const fitAddon = new FitAddon();
  probe.loadAddon(fitAddon);
  probe.open(container);
  fitAddon.fit();
  const { cols, rows } = probe;
  probe.dispose();
  return { cols, rows };
}
