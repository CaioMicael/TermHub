import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// `node:child_process`'s `spawn` export can't be `vi.spyOn`'d directly:
// under Vitest's real-ESM execution, a builtin module's namespace is not
// configurable ("Cannot redefine property: spawn"). `vi.mock` with a
// factory is the supported way to replace a builtin export — it's hoisted
// above this file's other imports by Vitest, so `spawnDaemonProcess`'s own
// `import { spawn } from 'node:child_process'` (daemon-process.ts) resolves
// to this same mock. `vi.hoisted` is required (rather than a plain `const`)
// because the mock factory itself is hoisted above ordinary declarations —
// without it, `spawnMock` would be referenced before its initialization.
//
// Typed against this narrow local signature (not `typeof spawn`, whose real
// overloads don't reduce to one `Procedure` shape `vi.fn`'s generic
// accepts) purely so `spawnMock.mock.calls`/`toHaveBeenCalledWith` are
// properly typed instead of `any` — this repo's lint forbids `any` without
// a per-line justification, and a typed mock avoids needing one at every
// call site below.
interface ExpectedSpawnOptions {
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: string;
  windowsHide: boolean;
}
type SpawnLike = (
  command: string,
  args: readonly string[],
  options: ExpectedSpawnOptions,
) => ChildProcess;
const spawnMock = vi.hoisted(() => vi.fn<SpawnLike>());
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { spawnDaemonProcess } = await import('./daemon-process.js');

// Not one of docs/specs/m2.1-daemon-client.md's 9 required tests (that
// module's own required test 8 covers "no process.kill" at the
// connectToDaemon level), but section 4's spawn recipe is specific enough —
// and section 2's "never killable by construction" guarantee rests on it
// closely enough — to deserve direct coverage of its own.

/**
 * A real `ChildProcess` is a full `EventEmitter`; only `.unref()` is
 * actually called by `spawnDaemonProcess`, so a plain `EventEmitter` plus
 * that one method is a faithful enough stand-in without pulling in a real
 * process. `unref` is returned separately (rather than read back off
 * `child.unref`) so assertions target the mock function directly instead of
 * a property access typed as `ChildProcess`'s real (possibly `this`-bound)
 * method — the pattern `@typescript-eslint/unbound-method` flags.
 */
function fakeChildProcess(): { child: ChildProcess; unref: Mock } {
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), { unref }) as unknown as ChildProcess;
  return { child, unref };
}

describe('spawnDaemonProcess', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it("spawns with process.execPath, ELECTRON_RUN_AS_NODE=1, detached, ignored stdio and a hidden window — section 4's exact recipe", () => {
    const { child } = fakeChildProcess();
    spawnMock.mockReturnValue(child);

    spawnDaemonProcess('C:\\fake\\daemon.js');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Asserted field-by-field (rather than via `expect.objectContaining`,
    // whose return type is `any` in vitest's own matcher typings) so this
    // stays fully typed against `ExpectedSpawnOptions` instead of tripping
    // `@typescript-eslint/no-unsafe-assignment` on a matcher-library type
    // gap that has nothing to do with this code's own type safety.
    const [call] = spawnMock.mock.calls;
    if (call === undefined) {
      throw new Error('expected spawnDaemonProcess to have called spawn');
    }
    const [command, args, options] = call;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['C:\\fake\\daemon.js']);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.windowsHide).toBe(true);
    expect(options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('unrefs the child so it never keeps the app process alive or attached', () => {
    const { child, unref } = fakeChildProcess();
    spawnMock.mockReturnValue(child);

    spawnDaemonProcess('C:\\fake\\daemon.js');

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('never calls process.kill — it never even keeps a reference to the child past unref() (docs/specs/m2.1-daemon-client.md section 2)', () => {
    const { child } = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    spawnDaemonProcess('C:\\fake\\daemon.js');

    expect(killSpy).not.toHaveBeenCalled();
  });
});
