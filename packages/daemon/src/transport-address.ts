import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// Derives the `net.Server`/`net.Socket` address the daemon's transport
// (transport-server.ts, transport-client.ts) listens on / connects to.
// docs/plan.md section 3 calls for a named pipe whose name derives from the
// user, "same API = unix socket on Linux/macOS": `net.createServer().listen()`
// already accepts either a Windows named pipe path or a POSIX filesystem
// path for a unix domain socket, so the only platform-specific work is
// formatting that one string. Nothing in transport-server.ts/
// transport-client.ts branches on `process.platform` beyond calling into
// this module.

/**
 * Options controlling how the pipe/socket name is derived. Everything is
 * optional and defaults to "the real address a production daemon would
 * use" — tests override `username`/`suffix` to get a unique, collision-free
 * address per run (see this file's test suite and transport.test.ts) so
 * parallel test files, or a real daemon already running on the same
 * machine, never fight over the same pipe.
 */
export interface PipeAddressOptions {
  /** Overrides the OS username used to derive the name. Defaults to `os.userInfo().username`. */
  username?: string;
  /**
   * Extra discriminator folded into the hash alongside the username, e.g. a
   * per-test-run id. Production callers leave this unset so every client on
   * the same machine, for the same user, derives the same address.
   */
  suffix?: string;
  /** Overrides `process.platform` for the path-formatting decision. Defaults to `process.platform`. Exists so the win32/POSIX formatting can be unit-tested from any host OS. */
  platform?: NodeJS.Platform;
}

/**
 * Stable, filesystem/pipe-name-safe identifier derived from `username` (and
 * `suffix`, when given). Hex-encoded SHA-256, truncated to 16 characters —
 * plenty of collision resistance for "distinguish the handful of local
 * Windows accounts / test runs that might share a machine" while keeping
 * the resulting pipe/socket name short. Never includes the raw username
 * verbatim: usernames can contain characters that are not valid in a
 * Windows pipe name or a POSIX path segment (spaces, unicode, `\`), and
 * hashing sidesteps that entirely instead of trying to sanitize it.
 */
function stableUsernameHash(username: string, suffix: string | undefined): string {
  const material = suffix !== undefined ? `${username}:${suffix}` : username;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/** Pure name derivation (no path/platform formatting yet), split out so it's independently testable and so `resolvePipeAddress` reads as "derive the name, then format it for this platform". */
export function derivePipeName(options: PipeAddressOptions = {}): string {
  const username = options.username ?? userInfo().username;
  return `termhub-${stableUsernameHash(username, options.suffix)}`;
}

/**
 * Formats a bare name (from `derivePipeName`) into the address `net.Server`/
 * `net.Socket` expect for the given platform: a Windows named pipe path on
 * `win32`, or a filesystem path for a unix domain socket everywhere else.
 * `os.tmpdir()` is per-user on every platform this project targets (it
 * honors `$TMPDIR`/`$TEMP` and Windows never lets two users share one
 * without opting in), so this gets the same per-user isolation the pipe
 * path gets on Windows without any extra ACL handling here.
 */
export function formatPipePath(name: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${name}`;
  }
  return join(tmpdir(), `${name}.sock`);
}

/** Resolves the full address the daemon's transport listens on / connects to. See `PipeAddressOptions` for how to get a unique one in tests. */
export function resolvePipeAddress(options: PipeAddressOptions = {}): string {
  const name = derivePipeName(options);
  return formatPipePath(name, options.platform ?? process.platform);
}
