// Pure logic behind `session-boot.ts`'s "the boot session's shell is no
// longer hardcoded" change (M4.6's second half, this task's prompt section
// 2): given the daemon's `profiles.list` result, which one is the default
// the first session of a fresh boot should launch with.
//
// Lives in `@termhub/app` (not `@termhub/ui`) on purpose — `session-boot.ts`
// is the only caller, and `@termhub/ui`'s `index.ts` is a forbidden file for
// this task; a new export there would need one. See this task's final
// report for the boundary this avoids crossing.
//
// No `platform` parameter is needed here, unlike `packages/daemon/src/
// profiles.ts`'s own injectable-platform pattern: `ShellProfile.kind` (the
// same type this module reads) already tells Windows and posix kinds apart
// on its own, since `profiles.ts` only ever produces `'pwsh'`/`'powershell'`/
// `'cmd'`/`'git-bash'`/`'wsl'` on `win32` and only ever `'posix'` everywhere
// else (its own doc comment). A machine's own `profiles.list` result is
// never a mix of both, so picking by `kind` alone is equivalent to switching
// on the platform, without this module needing to know what the platform
// actually is.

import type { ShellProfile } from '@termhub/shared';

/**
 * Preference order for Windows profile kinds (this task's prompt: "no
 * Windows, o primeiro que existir de pwsh, powershell, cmd"). `git-bash`/
 * `wsl` profiles are never picked as the *default* — they're real, useful
 * shells, but not what a brand-new agent workspace should silently open
 * into; a person who wants one picks it explicitly from the `+` button's
 * menu (`ProfileMenu.tsx`, `@termhub/ui`).
 */
const WINDOWS_DEFAULT_KIND_ORDER: ReadonlyArray<ShellProfile['kind']> = [
  'pwsh',
  'powershell',
  'cmd',
];

/**
 * Picks the profile a fresh boot's first session should launch with, out of
 * whatever `profiles.list` detected on this machine.
 *
 * - Windows: the first of `pwsh` / `powershell` / `cmd` that's present, in
 *   that order.
 * - Everywhere else: the first `posix` profile in `profiles`, which is
 *   already `$SHELL` when it exists and is a real file (this task's prompt:
 *   "o $SHELL vem primeiro na detecção" — `packages/daemon/src/profiles.ts`'s
 *   `detectPosixProfiles` puts it first in the list it returns), falling
 *   back to whichever of `bash`/`zsh`/`sh` that function found instead.
 * - `undefined` if none of the above matches — an empty `profiles` list, or
 *   (a should-never-happen case) only `wsl`/`git-bash` profiles with no
 *   Windows shell proper detected at all. The caller
 *   (`session-boot.ts`'s `resolveDefaultShellParams`) falls back to the
 *   fixed `DEFAULT_SHELL` in that case, exactly as it already did before
 *   this task, so a `profiles.list` result that can't offer a default never
 *   makes the boot worse than it was.
 */
export function pickDefaultShellProfile(
  profiles: readonly ShellProfile[],
): ShellProfile | undefined {
  for (const kind of WINDOWS_DEFAULT_KIND_ORDER) {
    const found = profiles.find((profile) => profile.kind === kind);
    if (found !== undefined) {
      return found;
    }
  }
  return profiles.find((profile) => profile.kind === 'posix');
}
