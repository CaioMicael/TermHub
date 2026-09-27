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
    // M4.7: `create()` itself already wrote `command + '\r'` right after
    // spawning (this params fixture passes `command: 'claude'`) — that
    // write is asserted on its own, below; `echo hi\r` here is on top of it.
    expect(fake.writes).toEqual(['claude\r', 'echo hi\r']);
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

  // M4.6 (second half): a pane split relaunches the split pane's own shell
  // profile by reading `args` off its `SessionSummary` — this is that wire
  // straight through `create()`. Without it a WSL pane's split would spawn
  // `wsl.exe` with no `-d <distro>` and land in the wrong distro (this
  // task's own prompt names this pitfall).
  it('propagates args into the summary, for a future split to reuse (M4.6)', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams({ shell: 'wsl.exe', args: ['-d', 'Ubuntu'] }));

    expect(summary.args).toEqual(['-d', 'Ubuntu']);
  });

  it('omits args from the summary when session.create was not given any', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams({ shell: 'pwsh.exe' }));

    expect(summary.args).toBeUndefined();
  });

  // M4.7: `command` used to be recorded onto the summary and never actually
  // run — a session created with `command: 'claude'` opened a blank
  // interactive shell. `create()` now writes it as a line of input right
  // after spawning, `\r`-terminated (the Enter keystroke), so the shell
  // itself runs it instead of just remembering it happened.
  it('writes command + "\\r" to the freshly spawned session right after creating it', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    registry.create(baseParams({ command: 'claude' }));

    const [session] = sessions;
    expect(session?.writes).toEqual(['claude\r']);
  });

  it('writes nothing at all when session.create has no command (an ordinary interactive shell)', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    registry.create(baseParams());

    const [session] = sessions;
    expect(session?.writes).toEqual([]);
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

  it('create() sets statusSince equal to createdAt (M5.3)', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    expect(summary.statusSince).toBe(summary.createdAt);
  });

  it('a self-triggered exit sets statusSince to the moment of exit, not createdAt (M5.3)', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];
    fake?.emitExit({ exitCode: 0 });

    const registered = registry.get(summary.id);
    expect(registered?.summary.statusSince).toBeGreaterThanOrEqual(summary.createdAt);
    expect(registered?.summary.status).toBe('exited');
  });

  describe('setStatus (M5.3)', () => {
    it('replaces status and statusSince on a live session', () => {
      const { factory } = makeFactory();
      const registry = new Registry({ sessionFactory: factory });
      const summary = registry.create(baseParams());

      registry.setStatus(summary.id, 'awaiting-input', 12_345);

      const registered = registry.get(summary.id);
      expect(registered?.summary.status).toBe('awaiting-input');
      expect(registered?.summary.statusSince).toBe(12_345);
    });

    it('is a no-op for an unknown id', () => {
      const { factory } = makeFactory();
      const registry = new Registry({ sessionFactory: factory });

      expect(() => {
        registry.setStatus(999, 'idle', 1);
      }).not.toThrow();
    });

    it('never overwrites an exited summary — death is terminal, only wireExitTracking writes it', () => {
      const { factory, sessions } = makeFactory();
      const registry = new Registry({ sessionFactory: factory });
      const summary = registry.create(baseParams());
      const fake = sessions[0];
      fake?.emitExit({ exitCode: 0 });
      const exitedSince = registry.get(summary.id)?.summary.statusSince;

      registry.setStatus(summary.id, 'running', 999_999);

      const registered = registry.get(summary.id);
      expect(registered?.summary.status).toBe('exited');
      expect(registered?.summary.statusSince).toBe(exitedSince);
    });

    // NOTE (spec deviation — see this task's final report): the techspec
    // (docs/specs/m5.3-status-propagation.md section 3.2) says "`setStatus`
    // vale para sessão no cemitério também, que continua registrada". Against
    // the real `evict()` above, that premise doesn't hold: `evict()` deletes
    // the id from `this.sessions` outright (the record moves entirely into
    // `Graveyard`'s own separate map, out of `Registry`'s reach) — so a
    // buried session is exactly the "unknown id" no-op path below, not a
    // distinct case. `service.ts`'s handler still emits `session.status` to
    // whoever's attached either way (it doesn't go through the registry for
    // that), but the registry-level `summary.status`/`statusSince` a
    // buried-then-restored session comes back with never reflects any
    // transition that happened while buried.
    it('is a no-op for a buried (evicted) session too — evict() already removed its record', () => {
      const { factory } = makeFactory();
      const registry = new Registry({ sessionFactory: factory });
      const summary = registry.create(baseParams());
      registry.evict(summary.id);

      expect(() => {
        registry.setStatus(summary.id, 'idle', 1);
      }).not.toThrow();
      expect(registry.get(summary.id)).toBeUndefined();
    });
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

  // docs/specs/m2.6-boot-reattach.md section 3.6 / test 9a: before this
  // method existed, session.resize's handler (service.ts) called
  // `registered.session.resize(...)` directly and never touched the
  // registry's own summary, so `session.list`/`session.attach` kept
  // reporting the session's *creation* geometry forever. A boot-time
  // Terminal sizes its xterm construction from that summary (section 3.5),
  // so a stale one there would create the xterm at the wrong geometry and
  // then write a snapshot serialized at the new one — the exact line-wrap
  // corruption section 3.5 exists to avoid.
  it('resize() resizes the session AND updates the summary registry.list()/get() report', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const created = registry.create(baseParams({ cols: 80, rows: 24 }));
    const fake = registry.get(created.id)?.session as FakeSession;

    registry.resize(created.id, 120, 40);

    expect(fake.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(registry.get(created.id)?.summary).toMatchObject({ cols: 120, rows: 40 });
    expect(registry.list().find((s) => s.id === created.id)).toMatchObject({
      cols: 120,
      rows: 40,
    });
  });

  it('resize() on an unknown id throws SESSION_NOT_FOUND, same as the handler used to throw itself', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    let thrown: unknown;
    try {
      registry.resize(999_999, 80, 24);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND);
  });

  // ---------------------------------------------------------------------------
  // M4.4: evict()/reinstate() — the graveyard building blocks close()'s own
  // doc comment predicted. Not exercised through a Graveyard here (that's
  // graveyard.test.ts's job); these tests only prove the registry's own two
  // new methods do exactly what they promise, standing alone.
  // ---------------------------------------------------------------------------

  it('evict() removes the record without killing the session, and it is gone from get()/list()', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams({ name: 'buried-1' }));
    const fake = sessions[0];

    const evicted = registry.evict(summary.id);

    expect(evicted?.summary).toEqual(summary);
    expect(evicted?.session).toBe(fake);
    expect(fake?.killCalls).toBe(0); // evict never kills
    expect(fake?.isAlive).toBe(true);
    expect(registry.get(summary.id)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('evict() on an unknown id returns undefined and does not throw', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    expect(registry.evict(999_999)).toBeUndefined();
  });

  it('reinstate() puts an evicted session back under the same id, visible again in get()/list()', () => {
    const { factory } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams({ name: 'buried-2' }));
    const evicted = registry.evict(summary.id);
    expect(evicted).toBeDefined();
    if (evicted === undefined) throw new Error('unreachable');

    // Simulates the graveyard reporting the session died while buried.
    const revivedSummary = { ...evicted.summary, status: 'exited' as const };
    registry.reinstate(revivedSummary, evicted.session);

    expect(registry.get(summary.id)?.summary).toEqual(revivedSummary);
    expect(registry.list().map((s) => s.id)).toEqual([summary.id]);
  });

  it('reinstate() re-wires exit tracking: a later exit updates the summary just like a never-buried session', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const evicted = registry.evict(summary.id);
    if (evicted === undefined) throw new Error('unreachable');
    registry.reinstate(evicted.summary, evicted.session);

    const fake = sessions[0];
    fake?.emitExit({ exitCode: 7 });

    expect(registry.get(summary.id)?.summary.status).toBe('exited');
    expect(registry.get(summary.id)?.exit).toEqual({ exitCode: 7 });
  });

  it('reinstate() throws INTERNAL_ERROR if the id is already registered', () => {
    const { factory, sessions } = makeFactory();
    const registry = new Registry({ sessionFactory: factory });

    const summary = registry.create(baseParams());
    const fake = sessions[0];
    if (fake === undefined) throw new Error('unreachable');

    let thrown: unknown;
    try {
      registry.reinstate(summary, fake);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe(PROTOCOL_ERROR_CODE.INTERNAL_ERROR);
  });
});
