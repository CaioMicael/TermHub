import { describe, expect, it, vi } from 'vitest';

import {
  classifyClipboardShortcut,
  createClipboardKeyHandler,
  dispatchContextMenuChoice,
  performCopy,
  performPaste,
  type ClipboardActionDeps,
} from './terminal-clipboard.js';

// Plain closures instead of `vi.fn()` spies referenced later off an object
// literal — matches `terminal-webgl.test.ts`'s own stated convention
// (avoids `@typescript-eslint/unbound-method`) and keeps each fake's
// contract explicit: every call is captured into a plain array this test
// asserts against directly.
function createDeps(
  overrides: {
    hasSelection?: () => boolean;
    getSelection?: () => string;
    readClipboardText?: () => Promise<string>;
    writeClipboardText?: (text: string) => Promise<void>;
    isDisposed?: () => boolean;
  } = {},
): {
  deps: ClipboardActionDeps;
  pasteCalls: string[];
  writeCalls: string[];
  errorCalls: Array<{ context: string; err: unknown }>;
} {
  const pasteCalls: string[] = [];
  const writeCalls: string[] = [];
  const errorCalls: Array<{ context: string; err: unknown }> = [];

  const deps: ClipboardActionDeps = {
    hasSelection: overrides.hasSelection ?? (() => false),
    getSelection: overrides.getSelection ?? (() => ''),
    paste: (text) => {
      pasteCalls.push(text);
    },
    writeClipboardText:
      overrides.writeClipboardText ??
      ((text) => {
        writeCalls.push(text);
        return Promise.resolve();
      }),
    readClipboardText: overrides.readClipboardText ?? (() => Promise.resolve('')),
    isDisposed: overrides.isDisposed ?? (() => false),
    onError: (context, err) => {
      errorCalls.push({ context, err });
    },
  };

  return { deps, pasteCalls, writeCalls, errorCalls };
}

describe('classifyClipboardShortcut', () => {
  it('recognizes Ctrl+Shift+C as copy', () => {
    expect(
      classifyClipboardShortcut({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'C' }),
    ).toBe('copy');
  });

  it('recognizes Ctrl+Shift+V as paste', () => {
    expect(
      classifyClipboardShortcut({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'v' }),
    ).toBe('paste');
  });

  it('does not intercept plain Ctrl+C (interrupt) or Ctrl+V', () => {
    expect(
      classifyClipboardShortcut({ type: 'keydown', ctrlKey: true, shiftKey: false, key: 'c' }),
    ).toBeUndefined();
    expect(
      classifyClipboardShortcut({ type: 'keydown', ctrlKey: true, shiftKey: false, key: 'v' }),
    ).toBeUndefined();
  });

  it('ignores keyup/keypress even for the right key combo', () => {
    expect(
      classifyClipboardShortcut({ type: 'keyup', ctrlKey: true, shiftKey: true, key: 'c' }),
    ).toBeUndefined();
  });
});

describe('createClipboardKeyHandler', () => {
  it('intercepts Ctrl+Shift+C: returns false and never touches sendData/the PTY path', () => {
    const { deps, pasteCalls, writeCalls } = createDeps({
      hasSelection: () => true,
      getSelection: () => 'hello world',
    });
    const handler = createClipboardKeyHandler(deps);
    const result = handler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'C' });
    expect(result).toBe(false);
    expect(writeCalls).toEqual(['hello world']);
    expect(pasteCalls).toEqual([]);
  });

  it('intercepts Ctrl+Shift+V: returns false and pastes via term.paste, not sendData', async () => {
    const { deps, pasteCalls } = createDeps({
      readClipboardText: () => Promise.resolve('line1\nline2'),
    });
    const handler = createClipboardKeyHandler(deps);
    const result = handler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'V' });
    expect(result).toBe(false);
    await vi.waitFor(() => {
      expect(pasteCalls).toEqual(['line1\nline2']);
    });
  });

  it('lets plain Ctrl+C through to the PTY (interrupt)', () => {
    const { deps, writeCalls } = createDeps();
    const handler = createClipboardKeyHandler(deps);
    const result = handler({ type: 'keydown', ctrlKey: true, shiftKey: false, key: 'c' });
    expect(result).toBe(true);
    expect(writeCalls).toEqual([]);
  });

  it('does not paste into a disposed terminal', async () => {
    const { deps, pasteCalls } = createDeps({
      readClipboardText: () => Promise.resolve('text'),
      isDisposed: () => true,
    });
    const handler = createClipboardKeyHandler(deps);
    handler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'V' });
    await Promise.resolve();
    await Promise.resolve();
    expect(pasteCalls).toEqual([]);
  });
});

describe('performCopy', () => {
  it('does nothing when there is no selection', () => {
    const { deps, writeCalls } = createDeps({ hasSelection: () => false });
    performCopy(deps);
    expect(writeCalls).toEqual([]);
  });

  it('reports a rejected clipboard write instead of throwing', async () => {
    const { deps, errorCalls } = createDeps({
      hasSelection: () => true,
      getSelection: () => 'x',
      writeClipboardText: () => Promise.reject(new Error('nope')),
    });
    performCopy(deps);
    await vi.waitFor(() => {
      expect(errorCalls).toHaveLength(1);
    });
    expect(errorCalls[0]?.context).toBe('copy failed');
    expect(errorCalls[0]?.err).toBeInstanceOf(Error);
  });
});

describe('performPaste', () => {
  it('calls term.paste with the clipboard text', async () => {
    const { deps, pasteCalls } = createDeps({
      readClipboardText: () => Promise.resolve('pasted text'),
    });
    performPaste(deps);
    await vi.waitFor(() => {
      expect(pasteCalls).toEqual(['pasted text']);
    });
  });
});

describe('dispatchContextMenuChoice', () => {
  it('performs copy for a "copy" choice', () => {
    const { deps, writeCalls } = createDeps({
      hasSelection: () => true,
      getSelection: () => 'sel',
    });
    dispatchContextMenuChoice('copy', deps);
    expect(writeCalls).toEqual(['sel']);
  });

  it('performs paste for a "paste" choice', async () => {
    const { deps, pasteCalls } = createDeps({ readClipboardText: () => Promise.resolve('p') });
    dispatchContextMenuChoice('paste', deps);
    await vi.waitFor(() => {
      expect(pasteCalls).toEqual(['p']);
    });
  });

  it('does nothing for an undefined choice (menu dismissed)', () => {
    const { deps, writeCalls, pasteCalls } = createDeps();
    dispatchContextMenuChoice(undefined, deps);
    expect(writeCalls).toEqual([]);
    expect(pasteCalls).toEqual([]);
  });
});
