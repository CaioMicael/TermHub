import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

// Example test, colocated with the code it covers (see CLAUDE.md). Not meant
// to be deep — it exists to establish the convention new packages should
// follow, and to give `npm run test` something real to run.
describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('is pinned to 1 for this milestone', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
