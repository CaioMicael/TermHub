import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachTerminalSession,
  encodeTerminalBinaryInput,
  encodeTerminalTextInput,
  type TerminalBridge,
} from './terminal-session.js';

/**
 * A fake `TerminalBridge` that can emit a "snapshot" chunk *synchronously,
 * from inside* the `session.attach` request call — this is what actually
 * happens on the real wire (docs/specs/m1.7-attach-detach.md section 3.4):
 * the snapshot frame is a separate message that can be dispatched to
 * `onData` listeners before the RPC promise the caller is `await`ing even
 * settles. Only a listener installed *before* calling `request` can ever
 * observe it. `request` resolves synchronously (`Promise.resolve`) — fine
 * for tests that don't care about attach/detach ordering races, which is
 * what `createDaemonLikeFakeBridge` below is for.
 */
function createFakeBridge(): {
  bridge: TerminalBridge;
  requests: Array<{ method: string; sessionId: number }>;
  emitDuringAttach: (sessionId: number, data: Uint8Array) => void;
  emit: (sessionId: number, data: Uint8Array) => void;
  listenerCount: () => number;
  sentInput: Array<{ sessionId: number; data: Uint8Array }>;
} {
  const listeners = new Set<(sessionId: number, data: Uint8Array) => void>();
  const requests: Array<{ method: string; sessionId: number }> = [];
  const sentInput: Array<{ sessionId: number; data: Uint8Array }> = [];
  let attachEmission: { sessionId: number; data: Uint8Array } | undefined;

  const bridge: TerminalBridge = {
    request: (method, params) => {
      requests.push({ method, sessionId: params.sessionId });
      if (method === 'session.attach' && attachEmission !== undefined) {
        const { sessionId, data } = attachEmission;
        for (const listener of listeners) {
          listener(sessionId, data);
        }
      }
      return Promise.resolve({});
    },
    sendData: (sessionId, data) => {
      sentInput.push({ sessionId, data });
    },
    onData: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    bridge,
    requests,
    emitDuringAttach: (sessionId, data) => {
      attachEmission = { sessionId, data };
    },
    emit: (sessionId, data) => {
      for (const listener of listeners) {
        listener(sessionId, data);
      }
    },
    listenerCount: () => listeners.size,
    sentInput,
  };
}

/**
 * A fake `TerminalBridge` modeling the real daemon's actual attach/detach
 * semantics (`packages/daemon/src/service.ts`), not just a generic mock:
 * - `session.attach` is idempotent while already attached (M1.7 section 4:
 *   attaching twice is a no-op success, never a second snapshot).
 * - `session.detach` is a plain, unconditional removal ("delete"), not
 *   reference-counted — the daemon has no idea two `Terminal`s share one
 *   `clientId` (`docs/specs/m1.7-attach-detach.md` section 3.7).
 * - Every response settles on the next macrotask (`setTimeout(..., 0)`),
 *   like a real IPC/wire round trip and *unlike* `createFakeBridge`'s
 *   `Promise.resolve` — this is what makes it possible to reproduce a
 *   React.StrictMode-shaped race (acquire while a prior attach is still
 *   in flight) instead of everything settling before the next line runs.
 */
function createDaemonLikeFakeBridge(): {
  bridge: TerminalBridge;
  requests: Array<{ method: string }>;
  isAttached: () => boolean;
  emit: (sessionId: number, data: Uint8Array) => void;
} {
  const listeners = new Set<(sessionId: number, data: Uint8Array) => void>();
  const requests: Array<{ method: string }> = [];
  let attached = false;

  const bridge: TerminalBridge = {
    request: (method) => {
      requests.push({ method });
      attached = method === 'session.attach';
      return new Promise((resolve) => {
        setTimeout(() => resolve({}), 0);
      });
    },
    sendData: () => {},
    onData: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    bridge,
    requests,
    isAttached: () => attached,
    emit: (sessionId, data) => {
      for (const listener of listeners) {
        listener(sessionId, data);
      }
    },
  };
}

describe('attachTerminalSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('installs onData before requesting session.attach, so a chunk emitted synchronously during the request reaches the sink', () => {
    const fake = createFakeBridge();
    const snapshot = new TextEncoder().encode('snapshot line\r\n');
    fake.emitDuringAttach(7, snapshot);

    const written: Uint8Array[] = [];
    attachTerminalSession(fake.bridge, 7, { write: (data) => written.push(data) });

    expect(written).toEqual([snapshot]);
  });

  it('filters out chunks for a different sessionId', () => {
    const fake = createFakeBridge();
    const written: Uint8Array[] = [];
    attachTerminalSession(fake.bridge, 7, { write: (data) => written.push(data) });

    fake.emit(7, new TextEncoder().encode('mine'));
    fake.emit(8, new TextEncoder().encode('someone elses'));

    expect(written).toEqual([new TextEncoder().encode('mine')]);
  });

  it('stops writing and unsubscribes synchronously on detach(); the real session.detach is deferred', async () => {
    const fake = createFakeBridge();
    const written: Uint8Array[] = [];
    const session = attachTerminalSession(fake.bridge, 7, { write: (data) => written.push(data) });
    await session.ready;

    expect(fake.listenerCount()).toBe(1);

    session.detach();

    // Synchronous: no listener left, no write reaches the discarded sink,
    // even before the deferred session.detach has had a chance to fire.
    expect(fake.listenerCount()).toBe(0);
    fake.emit(7, new TextEncoder().encode('late'));
    expect(written).toEqual([]);
    expect(fake.requests.some((r) => r.method === 'session.detach')).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requests).toContainEqual({ method: 'session.detach', sessionId: 7 });
  });

  it('detach is idempotent: calling it twice still sends session.detach once', async () => {
    const fake = createFakeBridge();
    const session = attachTerminalSession(fake.bridge, 7, { write: () => {} });
    await session.ready;

    session.detach();
    session.detach();
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.requests.filter((r) => r.method === 'session.detach')).toHaveLength(1);
  });

  describe('ownership: StrictMode-shaped acquire -> synchronous release -> acquire', () => {
    it('sends exactly one session.attach, zero session.detach, and ends attached', async () => {
      const fake = createDaemonLikeFakeBridge();

      const session1 = attachTerminalSession(fake.bridge, 1, { write: () => {} });
      session1.detach(); // synchronous StrictMode cleanup — attach1 may still be in flight
      const session2 = attachTerminalSession(fake.bridge, 1, { write: () => {} });

      await vi.runAllTimersAsync();
      await session2.ready;

      expect(fake.requests.map((r) => r.method)).toEqual(['session.attach']);
      expect(fake.isAttached()).toBe(true);
    });

    it('a genuine release with no reacquire sends exactly one session.detach and ends detached', async () => {
      const fake = createDaemonLikeFakeBridge();

      const session = attachTerminalSession(fake.bridge, 1, { write: () => {} });
      await vi.advanceTimersByTimeAsync(0);
      await session.ready;

      session.detach();
      await vi.advanceTimersByTimeAsync(0);

      expect(fake.requests.map((r) => r.method)).toEqual(['session.attach', 'session.detach']);
      expect(fake.isAttached()).toBe(false);
    });

    it('the surviving (second) Terminal keeps receiving data; the discarded (first) one does not', async () => {
      const fake = createDaemonLikeFakeBridge();
      const written1: Uint8Array[] = [];
      const written2: Uint8Array[] = [];

      const session1 = attachTerminalSession(fake.bridge, 1, { write: (d) => written1.push(d) });
      session1.detach(); // unsubscribes session1's own listener synchronously
      const session2 = attachTerminalSession(fake.bridge, 1, { write: (d) => written2.push(d) });
      await vi.runAllTimersAsync();
      await session2.ready;

      const chunk = new TextEncoder().encode('live output');
      fake.emit(1, chunk);

      expect(written1).toEqual([]);
      expect(written2).toEqual([chunk]);
    });
  });
});

describe('encodeTerminalTextInput', () => {
  it('encodes accented text as UTF-8', () => {
    const bytes = encodeTerminalTextInput('ação');
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode('ação')));
    // 'ação' has 2 multi-byte chars (ã, ç) -> 4 chars, 6 bytes in UTF-8.
    expect(bytes.length).toBe(6);
  });
});

describe('encodeTerminalBinaryInput', () => {
  it('maps each char code to exactly one byte, unlike UTF-8 encoding', () => {
    const data = '\x80\xff';
    const bytes = encodeTerminalBinaryInput(data);
    expect(Array.from(bytes)).toEqual([0x80, 0xff]);
    expect(bytes.length).toBe(2);

    // Contrast: TextEncoder would turn these two chars into 4 bytes
    // (each code point > 0x7F becomes a 2-byte UTF-8 sequence), which is
    // exactly the corruption onBinary's byte-per-char contract requires
    // avoiding.
    expect(new TextEncoder().encode(data).length).toBe(4);
  });
});
