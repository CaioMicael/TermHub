import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasStandaloneLine, runDiagnostic } from './cli.js';
import { resolvePipeAddress } from './transport-address.js';

// Required test 8 (docs/specs/m1.8-single-instance.md section 5) — "o gate
// do M1 inteiro": create a session, send "echo hi" as a binary frame,
// disconnect, reconnect, re-attach, and the buffer received on reattach
// must contain "hi". This is the one test in this package's M1.8 suite
// that spawns a real shell (same pattern session.test.ts and
// service.test.ts use: a real PTY, a generous timeout, and a `finally`-style
// guarantee nothing is left running), because the gate is specifically
// about proving this works end to end through the real M1.8 entrypoint
// (`runDaemon`/`startDaemon`), not just through service.ts's own internal
// wiring, which M1.7's suite already covers.

function uniqueAddress(): string {
  return resolvePipeAddress({ suffix: `cli-gate-test-${randomUUID()}` });
}

describe('cli.ts: the M1 gate, end to end', () => {
  it(
    'create session -> echo hi via binary frame -> disconnect -> reconnect -> session.attach -> ' +
      'the reattach buffer contains "hi"',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'termhub-cli-gate-test-'));
      try {
        const address = uniqueAddress();
        const daemonJsonPath = join(tempDir, 'daemon.json');

        const result = await runDiagnostic({ address, daemonJsonPath, timeoutMs: 20_000 });

        // The M1 gate itself: after disconnecting and reconnecting, the
        // buffer this diagnostic received on re-attach contains "hi" as its
        // own standalone line (not just the echoed "echo hi" command text —
        // hasStandaloneLine is the same check cli.ts's own wait loop uses,
        // so this assertion and the tool's own success condition can never
        // silently diverge).
        expect(hasStandaloneLine(result.reattachBuffer, 'hi')).toBe(true);

        // Also true on the very first connection, before any disconnect —
        // the intermediate step the gate's own buffer check subsumes, kept
        // here as an explicit, separately-readable assertion.
        expect(hasStandaloneLine(result.firstConnectionOutput, 'hi')).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
