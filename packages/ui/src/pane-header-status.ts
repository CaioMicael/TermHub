// Pure state->visual mapping behind `PaneHeader.tsx`'s status badge and dot
// (M3.4's prompt, section "Mapeamento de estado"). Kept in its own `.ts` file
// so the mapping is testable in a plain `node` Vitest environment, no DOM,
// no React — the same reasoning `tab-bar-actions.ts` and `session-actions.ts`
// already give for splitting pure logic out of a component/store module.

import type { SessionStatus } from '@termhub/shared';

/**
 * One badge/dot appearance. `label` is the Portuguese text the prototype's
 * own `statusLabel` map shows (`termhub-prototipo.html`, `const
 * statusLabel = {run:'rodando', wait:'esperando você', idle:'ocioso',
 * err:'saiu com erro'}`); `modifier` is the CSS modifier class applied to
 * both `.dot` and `.state` (`''` for the neutral/idle look, which needs no
 * modifier beyond the base rule — see `pane-header.css`).
 */
export interface PaneStatusVisual {
  label: string;
  modifier: '' | 'run' | 'wait' | 'err';
}

/**
 * Maps a session's `status`/`exitCode` to the badge/dot the prototype
 * defines. Four of the five outcomes come straight from the prototype's
 * `statusLabel` + `.dot`/`.state` modifier classes (`running`,
 * `awaiting-input`, `idle`, `exited` with a non-zero `exitCode`).
 *
 * The fifth — `exited` with `exitCode === 0` — has **no prototype
 * equivalent**: every `exited` pane in `termhub-prototipo.html`'s sample
 * data is the error case (`T.claudeRunning`/etc. never model a clean exit
 * in the mock dataset), so the prototype's `statusLabel.err` string
 * ("saiu com erro") would be actively wrong here. This function's decision,
 * documented per M3.4's prompt: label it "encerrado" (distinct from both
 * "ocioso" and "saiu com erro" — a dead-but-clean process is neither still
 * alive nor a failure) and give it idle's neutral gray (`modifier: ''`)
 * rather than invent a new color the prototype never specified. M5.4 owns
 * any future revisit of this exact color/label (docs/milestones.md).
 */
export function paneStatusVisual(
  status: SessionStatus,
  exitCode: number | undefined,
): PaneStatusVisual {
  switch (status) {
    case 'running':
      return { label: 'rodando', modifier: 'run' };
    case 'awaiting-input':
      return { label: 'esperando você', modifier: 'wait' };
    case 'idle':
      return { label: 'ocioso', modifier: '' };
    case 'exited':
      return exitCode !== undefined && exitCode !== 0
        ? { label: 'saiu com erro', modifier: 'err' }
        : { label: 'encerrado', modifier: '' };
  }
}
