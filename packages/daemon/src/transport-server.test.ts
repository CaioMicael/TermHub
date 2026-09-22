import { access, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { derivePipeName, formatPipePath, resolvePipeAddress } from './transport-address.js';
import { TransportClient } from './transport-client.js';
import { TransportServer, removeStaleSocketFile } from './transport-server.js';

// Required test 3 (docs/specs/m1.8-single-instance.md section 5): the
// orphaned-socket probe added to `removeStaleSocketFile` (transport-
// server.ts section 3.3). That fix only changes behavior off win32 — the
// function still returns immediately on win32 before ever probing anything
// — so the central problem this suite has to solve is proving the
// *corrected* branch actually executes on the machine running it, which is
// Windows. `removeStaleSocketFile` takes `platform` as an explicit,
// overridable parameter (default `process.platform`) for exactly this
// reason: every test below forces the POSIX branch regardless of host OS,
// the same technique transport-address.ts's own `PipeAddressOptions.platform`
// already uses.
//
// What's real and what's injected here, and why:
//
// - 'alive' (a live daemon must never be unlinked out from under itself) is
//   proven against a REAL server listening on a REAL named pipe, with
//   `platform` forced to 'linux' so the fixed probing logic actually runs
//   its `net.connect` attempt against that real, live pipe before ever
//   considering `unlink`. Windows named pipes accept a real connection when
//   a server is listening, which is exactly the signal the probe needs —
//   no mocking required. The proof that nothing was torn down is an RPC
//   sent over the already-connected client *after* the probe runs.
// - 'absent' (nothing there — never blocks startup) is also real: a probe
//   against a pipe address nobody ever created reliably yields ENOENT here,
//   same as it would against a missing POSIX socket file.
// - 'stale' (ECONNREFUSED against a leftover file with no live listener) is
//   the one branch this machine cannot reproduce with a real socket. Two
//   things were tried and ruled out before falling back to injection:
//     1. A real POSIX-style unix-domain-socket file — the actual production
//        scenario this branch exists for — can't even be *created* here:
//        `net.createServer().listen(<tmp path>.sock)` on this Windows
//        sandbox fails with EACCES before any socket exists to go stale.
//     2. A real Windows named pipe has no equivalent "leftover file, dead
//        listener" state at all — verified directly against this Windows
//        install: closing a pipe's server makes the pipe disappear outright,
//        so connecting to it afterward yields ENOENT, never ECONNREFUSED,
//        because named pipes carry no filesystem entry able to outlive
//        their listener the way a unix socket file can.
//   So 'stale' is proven by injecting a fake `SocketConnector` that
//   synthesizes a real `ECONNREFUSED`-coded `Error` off a fake socket — this
//   still runs the actual `removeStaleSocketFile` decision code (the thing
//   that was buggy), just with the one OS-level primitive this sandbox can't
//   reproduce swapped for a controlled stand-in, and the resulting `unlink`
//   is checked against a real file on disk standing in for the leftover
//   socket entry. Stated explicitly, per this task's own instructions: a
//   test that never touches the fixed branch proves nothing, and this is
//   the one branch here that cannot be exercised any other way on this
//   machine.

function uniquePipeAddress(): string {
  return resolvePipeAddress({ suffix: `stale-socket-test-${randomUUID()}` });
}

/** A real filesystem path (not a named pipe) even when run on Windows — `formatPipePath(..., 'linux')` always builds a plain `os.tmpdir()` path, which is a perfectly ordinary file on any OS. Used only by the 'stale' test below, which needs `writeFile`/`unlink` to behave like they would against a real leftover POSIX socket file. */
function uniqueFilePath(): string {
  const name = derivePipeName({ suffix: `stale-socket-file-test-${randomUUID()}` });
  return formatPipePath(name, 'linux');
}

let cleanup: Array<() => Promise<void> | void>;

beforeEach(() => {
  cleanup = [];
});

afterEach(async () => {
  for (const teardown of cleanup.reverse()) {
    try {
      await teardown();
    } catch {
      // best-effort cleanup only
    }
  }
});

/** A minimal fake `net.Socket`: just enough of an `EventEmitter` for `probeSocket`'s internals to attach `'connect'`/`'error'` listeners to, plus a no-op `destroy()`. */
class FakeSocket extends EventEmitter {
  destroy(): void {
    // Nothing real to tear down.
  }
}

describe('removeStaleSocketFile (docs/specs/m1.8-single-instance.md section 3.3)', () => {
  it('does not unlink a socket a live daemon still owns, and the live daemon keeps answering RPCs afterward ("alive" branch, real pipe)', async () => {
    const address = uniquePipeAddress();
    const token = 'tok-alive';
    const server = new TransportServer({ token, address });
    server.registerMethod('ping', () => 'pong');
    cleanup.push(() => server.close());
    await server.listen();

    const client = new TransportClient({ address, token });
    cleanup.push(() => client.close());
    await client.connect();
    await expect(client.request('ping')).resolves.toBe('pong');

    // The actual line under test: with the POSIX branch forced on via
    // `platform: 'linux'`, this must probe the live pipe, see the
    // connection accepted, and resolve WITHOUT attempting an unlink. Before
    // this fix, the unconditional `unlink(address)` would have thrown
    // `EINVAL` against a live Windows pipe (confirmed directly against this
    // OS while building this test) — so this assertion alone would already
    // fail loudly against the old, buggy implementation on this machine,
    // not just pass by omission.
    await expect(removeStaleSocketFile(address, 'linux')).resolves.toBeUndefined();

    // The real proof it left the daemon's socket alone: the connection that
    // was already open before the probe still round-trips an RPC after it.
    await expect(client.request('ping')).resolves.toBe('pong');

    // And a second daemon racing the same address still correctly loses —
    // named pipe creation is atomic at the OS level regardless of this
    // probe, so this stays true either way, but it documents the end state
    // this fix exists to protect: the lock still works.
    const second = new TransportServer({ token, address });
    cleanup.push(() => second.close());
    let secondListenError: NodeJS.ErrnoException | undefined;
    try {
      await second.listen();
    } catch (err) {
      secondListenError = err as NodeJS.ErrnoException;
    }
    expect(secondListenError?.code).toBe('EADDRINUSE');
  });

  it('does nothing when nothing is listening at the address ("absent" branch, real pipe) — a fresh listen() there still succeeds', async () => {
    const address = uniquePipeAddress();
    // Forcing 'linux' proves the fixed function's ENOENT-derived 'absent'
    // branch actually runs and resolves cleanly, even on Windows, even
    // though nothing was ever created at this path.
    await expect(removeStaleSocketFile(address, 'linux')).resolves.toBeUndefined();

    const server = new TransportServer({ token: 'tok-absent', address });
    cleanup.push(() => server.close());
    await expect(server.listen()).resolves.toBeUndefined();
  });

  it('unlinks a leftover socket file when the probe reports ECONNREFUSED ("stale" branch — injected connector; see this file\'s header comment for why a real socket can\'t produce this here)', async () => {
    const path = uniqueFilePath();

    // Injected in place of `net.createConnection`: synthesizes exactly the
    // one signal this branch cares about (a real `Error` coded
    // `ECONNREFUSED`) off a fake socket, so `removeStaleSocketFile`'s actual
    // decision logic — the code this task fixed — runs against it
    // unmodified; only the OS-level connection attempt is stood in for.
    const refusingConnector = (addr: string): Socket => {
      const socket = new FakeSocket();
      queueMicrotask(() => {
        const err = Object.assign(new Error(`connect ECONNREFUSED ${addr}`), {
          code: 'ECONNREFUSED',
        });
        socket.emit('error', err);
      });
      // `removeStaleSocketFile`'s probe only ever calls `once('connect' |
      // 'error', ...)` and `destroy()` on what this returns — this cast
      // documents that `FakeSocket` satisfies exactly that structural
      // slice of `net.Socket`, not the type's full surface.
      return socket as unknown as Socket;
    };

    // A real file on disk standing in for "the leftover unix-socket file" —
    // proves the fixed code really calls through to a real `unlink`, not
    // just that it decided to.
    await writeFile(path, 'stale socket placeholder', 'utf8');
    cleanup.push(async () => {
      try {
        await unlink(path);
      } catch {
        // Already removed by the assertion below in the success case.
      }
    });

    await removeStaleSocketFile(path, 'linux', refusingConnector);

    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op on win32 regardless of what a connector would report — the platform gate short-circuits first', async () => {
    const address = uniquePipeAddress();
    let connectorCalled = false;
    const neverActuallyUsed = (): Socket => {
      connectorCalled = true;
      return new FakeSocket() as unknown as Socket;
    };

    await removeStaleSocketFile(address, 'win32', neverActuallyUsed);
    expect(connectorCalled).toBe(false);
  });
});
