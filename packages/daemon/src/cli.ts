import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import type { SessionCreateResult, SessionId } from '@termhub/shared';

import type { DaemonInfo } from './daemon.js';
import { defaultDaemonJsonPath, readDaemonInfo } from './daemon.js';
import type { DaemonRuntime } from './daemon-runtime.js';
import { runDaemon } from './daemon-runtime.js';
import { TransportClient } from './transport-client.js';

// The diagnostic CLI docs/specs/m1.8-single-instance.md section 3.6
// describes, and the vehicle for the M1 gate criterion (docs/milestones.md
// M1.8's acceptance row): create a session, send "echo hi" as a binary
// frame, see it stream back, disconnect, reconnect, re-attach, and print
// the buffer that comes back — proving the session survived the
// disconnect, which is the entire premise of a daemon separate from the UI
// process.
//
// `runDiagnostic` is the testable core (cli.test.ts drives it directly,
// in-process, real daemon + real PTY, no subprocess spawn); `main` below is
// the thin process wrapper that only runs when this file is executed
// directly (`node --experimental-strip-types cli.ts` / `npm run cli`).
//
// ## Step 1 necessarily includes an attach the spec's own numbered list
// ## doesn't call out separately, and why
//
// Section 3.6 lists steps 2-4 as "cria uma sessão; manda echo hi; espera o
// hi chegar na saída" with no `session.attach` mentioned before them. But
// per docs/specs/m1.7-attach-detach.md section 3.6, a session's output is
// only ever delivered to clients actually attached to it — a session with
// nobody attached still runs, but nothing streams anywhere. Without an
// attach between "create" and "send echo hi", step 4 ("espera o hi chegar
// na saída") could never be satisfied: there would be nothing subscribing
// to receive it at all. This implementation attaches immediately after
// create, before sending any input, which is the only reading of section
// 3.6 consistent with M1.7's own architecture — flagged here, and in this
// task's final report, as one of the two things the spec left ambiguous.

/** Options controlling `runDiagnostic`. Everything defaults to what a person running `npm run cli` on this machine would want. */
export interface DiagnosticOptions {
  /** Where to read/write `daemon.json`. Defaults to `defaultDaemonJsonPath()`. */
  daemonJsonPath?: string;
  /** Pipe/socket address, forwarded to `runDaemon` if a daemon needs to be started. Defaults to the real per-user address. Tests should override this (and `daemonJsonPath`) to a unique value, same as every other suite in this package. */
  address?: string;
  /** Shell to spawn for the diagnostic session. Defaults to `pwsh.exe` if it's on PATH, else `powershell.exe`. */
  shell?: string;
  /** Arguments for `shell`. Defaults to `['-NoLogo', '-NoProfile']`, matching this package's own PTY test suites. */
  shellArgs?: string[];
  cwd?: string;
  /** How long to wait for the "hi" line to stream back before giving up. Defaults to 15000ms — spawning a real shell and running a real command, same generous budget session.test.ts/service.test.ts use for the same reason. */
  timeoutMs?: number;
}

export interface DiagnosticResult {
  sessionId: SessionId;
  /** Everything received on the first connection, from session.create through the "echo hi" round trip. */
  firstConnectionOutput: string;
  /** What arrived after disconnecting, reconnecting, and re-attaching — the snapshot (docs/specs/m1.7-attach-detach.md) plus anything since. This is the buffer step 7 asks this tool to print, and the one required test 8 asserts contains "hi". */
  reattachBuffer: string;
}

const ESC = '\x1b';
const BEL = '\x07';

/**
 * Strips ANSI CSI/OSC sequences. Same technique, for the same reason, as
 * session.test.ts/service.test.ts: PowerShell's line editor (PSReadLine)
 * echoes typed input wrapped in SGR color codes, and real output arrives
 * glued to cursor-visibility codes — without stripping these, a plain
 * substring check on "hi" would false-positive on the echoed "echo hi"
 * command line itself, before the shell ever produced real output. Written
 * as a manual scan rather than a regex for the same reason those two files
 * are: a pattern matching control characters on purpose still trips
 * ESLint's `no-control-regex`, and this project doesn't relax lint rules to
 * get code to pass.
 */
function stripAnsi(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input.charAt(i) === ESC && input.charAt(i + 1) === '[') {
      let j = i + 2;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        j += 1;
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
      i = j;
      continue;
    }
    if (input.charAt(i) === ESC && input.charAt(i + 1) === ']') {
      let j = i + 2;
      while (j < input.length && input.charAt(j) !== BEL) {
        if (input.charAt(j) === ESC && input.charAt(j + 1) === '\\') {
          j += 2;
          break;
        }
        j += 1;
      }
      if (input.charAt(j) === BEL) {
        j += 1;
      }
      i = j;
      continue;
    }
    out += input.charAt(i);
    i += 1;
  }
  return out;
}

/** Whether `output`, once ANSI sequences are stripped, contains a line whose trimmed content is exactly `line` — as opposed to merely containing `line` as a substring, which would also match the echoed input line itself (see `stripAnsi`'s doc comment). Exported so cli.test.ts's own assertions use the exact same definition of "the buffer contains hi" this module's own wait-loop uses, rather than a second, possibly-diverging copy. */
export function hasStandaloneLine(output: string, line: string): boolean {
  return stripAnsi(output)
    .split(/\r?\n/)
    .some((candidate) => candidate.trim() === line);
}

function resolveDefaultShell(): string {
  try {
    execFileSync('where', ['pwsh.exe'], { stdio: 'ignore' });
    return 'pwsh.exe';
  } catch {
    return 'powershell.exe';
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }
}

/**
 * Runs the full diagnostic docs/specs/m1.8-single-instance.md section 3.6
 * describes: start-or-connect, create a session, round-trip "echo hi" as a
 * binary frame, disconnect, reconnect, re-attach, and return what the
 * reattach buffer contains. This is the M1 gate — required test 8 in
 * cli.test.ts calls this directly and asserts "hi" is in
 * `reattachBuffer`.
 */
export async function runDiagnostic(options: DiagnosticOptions = {}): Promise<DiagnosticResult> {
  const daemonJsonPath = options.daemonJsonPath ?? defaultDaemonJsonPath();
  const timeoutMs = options.timeoutMs ?? 15_000;

  // Step 1: "sobe (ou conecta ao) daemon". runDaemon() itself resolves the
  // single-instance race (docs/specs/m1.8-single-instance.md sections
  // 3.1-3.2); losing it here just means some other daemon already owns
  // this address, and its info — not this call's — is what every client
  // (including this one) needs to connect to.
  const started = await runDaemon({
    daemonJsonPath,
    ...(options.address !== undefined ? { address: options.address } : {}),
  });

  let ownedRuntime: DaemonRuntime | undefined;
  let info: DaemonInfo;
  if (started.outcome === 'started') {
    ownedRuntime = started.runtime;
    info = started.runtime.info;
  } else {
    const existing = await readDaemonInfo(daemonJsonPath);
    if (existing === undefined) {
      throw new Error(
        `lost the race to start a daemon, but daemon.json at ${daemonJsonPath} is missing or unreadable — ` +
          'cannot find the daemon that won it to connect to',
      );
    }
    info = existing;
  }

  try {
    const shell = options.shell ?? resolveDefaultShell();
    const shellArgs = options.shellArgs ?? ['-NoLogo', '-NoProfile'];
    const cwd = options.cwd ?? process.cwd();

    let client = new TransportClient({
      address: info.pipe,
      token: info.token,
      clientName: 'termhub-cli',
    });
    await client.connect();

    const createResult = await client.request<SessionCreateResult>('session.create', {
      shell,
      args: shellArgs,
      cwd,
      cols: 80,
      rows: 24,
    });
    const sessionId = createResult.session.id;

    let firstConnectionOutput = '';
    // Per the M1.7 client contract (docs/specs/m1.7-attach-detach.md
    // section 3.4, documented on TransportClient.onData): the data handler
    // must be installed before calling session.attach, since the snapshot
    // (and anything that raced it) arrives as binary frames ahead of the
    // RPC response, on the same ordered stream.
    client.onData((sid, data) => {
      if (sid === sessionId) {
        firstConnectionOutput += Buffer.from(data).toString('utf8');
      }
    });
    // See this file's header comment: attaching here, immediately after
    // create and before sending any input, is required for step 4 ("espera
    // o hi chegar na saída") to be satisfiable at all — an unattached
    // session produces no stream to wait on.
    await client.request('session.attach', { sessionId });

    // Step 3: "echo hi" as a binary frame via client.sendData — not an RPC.
    client.sendData(sessionId, Buffer.from('echo hi\r', 'utf8'));
    // Step 4.
    await waitFor(() => hasStandaloneLine(firstConnectionOutput, 'hi'), timeoutMs);

    // Step 5: disconnect.
    await client.close();

    // Step 6: reconnect and session.attach.
    client = new TransportClient({
      address: info.pipe,
      token: info.token,
      clientName: 'termhub-cli',
    });
    await client.connect();
    let reattachBuffer = '';
    client.onData((sid, data) => {
      if (sid === sessionId) {
        reattachBuffer += Buffer.from(data).toString('utf8');
      }
    });
    await client.request('session.attach', { sessionId });
    // The snapshot frame(s) are guaranteed to be queued on the wire ahead
    // of session.attach's own response (same contract as the first
    // attach), and TransportClient dispatches every frame synchronously in
    // arrival order — so by the time the request above resolves, `onData`
    // has already been called for all of them. This wait is a defensive
    // margin, not evidence the ordering guarantee is being doubted: it
    // turns "the buffer was somehow one event-loop turn late" into a clear
    // timeout instead of a flaky false negative.
    await waitFor(() => hasStandaloneLine(reattachBuffer, 'hi'), timeoutMs);

    // Cleanup hygiene: this diagnostic's session shouldn't outlive it,
    // whether or not this call owns the daemon it ran against.
    await client.request('session.close', { sessionId });
    await client.close();

    return { sessionId, firstConnectionOutput, reattachBuffer };
  } finally {
    // Only tear down a daemon this call actually started — never a
    // pre-existing one this call merely connected to (docs/specs/
    // m1.8-single-instance.md's whole point is that a daemon outlives any
    // one client).
    if (ownedRuntime !== undefined) {
      await ownedRuntime.shutdown();
    }
  }
}

async function main(): Promise<void> {
  const result = await runDiagnostic();
  process.stdout.write(
    `session ${result.sessionId}: first-connection output after "echo hi":\n${result.firstConnectionOutput}\n`,
  );
  process.stdout.write(
    `reattach buffer (after disconnect + reconnect + session.attach):\n${result.reattachBuffer}\n`,
  );
}

// ESM equivalent of `require.main === module`: only run `main()` when this
// file is executed directly, not when cli.test.ts imports `runDiagnostic`
// from it.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
