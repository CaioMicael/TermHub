import { describe, expect, it } from 'vitest';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionCreateParams } from '@termhub/shared';

import { Registry } from './registry.js';
import type { SessionFactory, SessionLike } from './registry.js';
import type {
  Disposable,
  SessionDataListener,
  SessionExit,
  SessionExitListener,
} from './session.js';

// Registry owns lifecycle/metadata bookkeeping only — it must never touch
// node-pty itself. Every test in this file uses `FakeSession` through an
// injected `SessionFactory` instead of the real `Session` (M1.3), so this
// suite stays fast/deterministic and never spawns `pwsh.exe`/`powershell.exe`.
// `Session` itself (real PTY spawn/write/kill) is already covered by
// session.test.ts — that is the one file allowed to be slow for it.

/** In-memory stand-in for `Session` that implements `SessionLike` without going near node-pty. Exposes small test hooks (`writes`, `resizes`, `killCalls`, `emitExit`) so tests can both drive it and assert on what the registry did to it. */
class FakeSession implements SessionLike {
  private static nextPid = 9000;

  readonly pid = FakeSession.nextPid++;
  private aliveFlag = true;
  private exitListeners: SessionExitListener[] = [];
  private dataListeners: SessionDataListener[] = [];

  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCalls = 0;

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  /** Mirrors `Session#kill`'s contract: safe to call more than once, or after the process already exited on its own. */
  kill(): void {
    this.killCalls += 1;
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: SessionDataListener): Disposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== listener);
      },
    };
  }

  onExit(listener: SessionExitListener): Disposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== listener);
      },
    };
  }

  /** Test-only: simulates the underlying process dying, whether on its own or because `kill()` was called. No-op if already dead, matching `Session#kill`'s idempotency. */
  emitExit(exit: SessionExit): void {
    if (!this.aliveFlag) {
      return;
    }
    this.aliveFlag = false;
    for (const listener of this.exitListeners) {
      listener(exit);
    }
  }
}

function makeFactory(): { factory: SessionFactory; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

function baseParams(overrides: Partial<SessionCreateParams> = {}): SessionCreateParams {
  return {
    cwd: 'C:\\Users\\caiom\\project',
    shell: 'pwsh.exe',
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe('Registry', () => {
  it('creates a session and retrieves it by id', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(
      baseParams({ name: 'claude-1', tag: 'agent', command: 'claude' }),
    );

    expect(summary.id).toBe(1);
    expect(summary.name).toBe('claude-1');
    expect(summary.tag).toBe('agent');
    expect(summary.command).toBe('claude');
    expect(summary.status).toBe('running');

    const registered = registry.get(summary.id);
    expect(registered).toBeDefined();
    expect(registered?.summary).toEqual(summary);
    expect(registered?.exit).toBeUndefined();

    // get() hands back the live session handle too, so a future RPC layer
    // (M1.5) can act on it through the same lookup.
    registered?.session.write('echo hi\r');
    registered?.session.resize(100, 40);
    const fake = registered?.session as FakeSession;
    expect(fake.writes).toEqual(['echo hi\r']);
    expect(fake.resizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  it('defaults name to the shell when none is given', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams({ shell: 'cmd.exe' }));

    expect(summary.name).toBe('cmd.exe');
    expect(summary.tag).toBeUndefined();
    expect(summary.command).toBeUndefined();
  });

  it('get() returns undefined for an id that was never created', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    expect(registry.get(999)).toBeUndefined();
  });

  it('list() reflects creations and closures', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    expect(registry.list()).toEqual([]);

    const a = registry.create(baseParams({ name: 'a' }));
    const b = registry.create(baseParams({ name: 'b' }));

    expect(registry.list().map((s) => s.id)).toEqual([a.id, b.id]);

    registry.close(a.id);

    expect(registry.list().map((s) => s.id)).toEqual([b.id]);

    registry.close(b.id);

    expect(registry.list()).toEqual([]);
  });

  it('never reuses an id after close(), even when a new session is created right after', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const first = registry.create(baseParams());
    registry.close(first.id);
    const second = registry.create(baseParams());

    expect(second.id).not.toBe(first.id);
    expect(second.id).toBeGreaterThan(first.id);
    // The closed id really is gone, not just "shadowed".
    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.get(second.id)).toBeDefined();
  });

  it('close() kills a still-alive session and removes it from the registry', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];
    expect(fake).toBeDefined();

    registry.close(summary.id);

    expect(fake?.killCalls).toBe(1);
    expect(fake?.isAlive).toBe(false);
    expect(registry.get(summary.id)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('close() is idempotent: calling it twice does not throw', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];

    expect(() => {
      registry.close(summary.id);
    }).not.toThrow();
    expect(() => {
      registry.close(summary.id);
    }).not.toThrow();

    // Second close() found nothing left to kill — the fake only saw one
    // kill() call, from the first close().
    expect(fake?.killCalls).toBe(1);
  });

  it('close() on an id that was never created does not throw', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    expect(() => {
      registry.close(12345);
    }).not.toThrow();
  });

  it('a session that dies on its own (not via close()) becomes exited with the right exitCode, without being removed', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];
    expect(fake).toBeDefined();

    fake?.emitExit({ exitCode: 3, signal: 9 });

    const registered = registry.get(summary.id);
    expect(registered).toBeDefined();
    expect(registered?.summary.status).toBe('exited');
    expect(registered?.exit).toEqual({ exitCode: 3, signal: 9 });

    // Still listed — only an explicit close() removes it.
    expect(registry.list().map((s) => s.id)).toEqual([summary.id]);
    expect(registry.list()[0]?.status).toBe('exited');
  });

  it('close() after a self-triggered exit does not throw and removes the (already-exited) session', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];
    fake?.emitExit({ exitCode: 0 });

    expect(() => {
      registry.close(summary.id);
    }).not.toThrow();
    expect(registry.get(summary.id)).toBeUndefined();
    // kill() is still called by close() (Session#kill's own idempotency is
    // what makes that safe against a process that's already gone); the fake
    // mirrors that by no-op'ing emitExit when already dead.
    expect(fake?.killCalls).toBe(1);
  });

  it('throws a clear ProtocolError instead of wrapping around when the uint32 id space is exhausted', () => {
    const { factory } = makeFactory();
    // Drive the counter to one below the uint32 ceiling instead of actually
    // creating ~4 billion sessions.
    const registry = new Registry({ sessionFactory: factory, startId: 0xffffffff });

    const last = registry.create(baseParams());
    expect(last.id).toBe(0xffffffff);

    let thrown: unknown;
    try {
      registry.create(baseParams());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.INTERNAL_ERROR);

    // Never wraps back around to reuse a previously-issued id.
    expect(registry.get(0xffffffff)).toBeDefined();
  });

  it('does not spawn a session at all when the id space is already exhausted', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory, startId: 0xffffffff + 1 });

    expect(() => {
      registry.create(baseParams());
    }).toThrow(ProtocolError);

    // The factory was never even called — no process/resource leaked trying
    // to spawn a session for an id that couldn't be issued.
    expect(sessions).toHaveLength(0);
  });
});
