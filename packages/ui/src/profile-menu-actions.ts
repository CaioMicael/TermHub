// Pure/testable logic behind `ProfileMenu.tsx`'s two non-trivial behaviors
// (M4.6's second half, this task's prompt section 2 — "menu no `+`"): what
// counts as fetching the shell profiles a menu open should show, and what
// key closes it without picking anything. Kept out of the component itself
// for the same reason `tab-bar-actions.ts`'s own header comment gives:
// unit-testable in plain `node`, no DOM, no React.

import type { ProfilesListParams, ProfilesListResult, ShellProfile } from '@termhub/shared';

/**
 * The minimal bridge surface `ProfileMenu.tsx` needs to load the profile
 * list — a narrower, locally-typed slice of `SessionActionsBridge`
 * (`store/session-actions.ts`), the same "small structural interface"
 * approach that type's own doc comment describes. `SessionActionsBridge`'s
 * `request` is generic over every method it lists (including
 * `'profiles.list'`, added there for this task), so the real object
 * `TabBar.tsx` already threads through as a prop satisfies this narrower
 * type with no adapter needed at the call site. Params/result are typed
 * against `@termhub/shared`'s real `ProfilesListParams`/`ProfilesListResult`
 * (not a bare `Record<string, never>`/inline shape) so this stays exactly
 * assignable from `SessionActionsBridge.request`'s generic signature.
 */
export interface ProfileMenuBridge {
  request(method: 'profiles.list', params: ProfilesListParams): Promise<ProfilesListResult>;
}

/**
 * Fetches the daemon's detected shell profiles for the menu to list. The
 * daemon's own `profiles.list` service (`packages/daemon/src/profiles.ts`)
 * already caches detection for the process's lifetime, so this never passes
 * `refresh: true` — every menu open is cheap, no re-detection cost, per this
 * task's prompt ("Carregue a lista quando o menu abrir (o daemon já faz
 * cache)"). Propagates a rejected `profiles.list` unchanged; `ProfileMenu.tsx`
 * is what turns that into an error message in the menu.
 */
export async function loadShellProfiles(bridge: ProfileMenuBridge): Promise<ShellProfile[]> {
  const { profiles } = await bridge.request('profiles.list', {});
  return profiles;
}

/**
 * Whether a keyboard event's `key` should close the menu without selecting
 * anything — this task's prompt: "Esc ... fecham o menu". A named predicate
 * rather than an inline `=== 'Escape'` check at the two call sites
 * (`ProfileMenu.tsx`'s `keydown` listener) that would otherwise both have to
 * agree on the exact key string.
 */
export function isProfileMenuCloseKey(key: string): boolean {
  return key === 'Escape';
}
