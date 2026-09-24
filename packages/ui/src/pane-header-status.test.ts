import { describe, expect, it } from 'vitest';

import { paneStatusVisual } from './pane-header-status.js';

describe('paneStatusVisual', () => {
  it('maps running to "rodando" / run', () => {
    expect(paneStatusVisual('running', undefined)).toEqual({ label: 'rodando', modifier: 'run' });
  });

  it('maps awaiting-input to "esperando você" / wait', () => {
    expect(paneStatusVisual('awaiting-input', undefined)).toEqual({
      label: 'esperando você',
      modifier: 'wait',
    });
  });

  it('maps idle to "ocioso" / neutral', () => {
    expect(paneStatusVisual('idle', undefined)).toEqual({ label: 'ocioso', modifier: '' });
  });

  it('maps exited with a non-zero exitCode to "saiu com erro" / err', () => {
    expect(paneStatusVisual('exited', 1)).toEqual({ label: 'saiu com erro', modifier: 'err' });
    expect(paneStatusVisual('exited', -1)).toEqual({ label: 'saiu com erro', modifier: 'err' });
  });

  it('maps exited with exitCode 0 to "encerrado" / neutral (no prototype equivalent — this task\'s own documented decision)', () => {
    expect(paneStatusVisual('exited', 0)).toEqual({ label: 'encerrado', modifier: '' });
  });

  it('treats exited with an undefined exitCode as the clean-exit case, not the error case', () => {
    // `SessionSummary.exitCode` is only guaranteed present once `status` is
    // `'exited'` (protocol.ts's own doc comment) — this asserts the
    // function doesn't crash or misclassify a session whose store entry
    // hasn't caught up yet.
    expect(paneStatusVisual('exited', undefined)).toEqual({ label: 'encerrado', modifier: '' });
  });
});
