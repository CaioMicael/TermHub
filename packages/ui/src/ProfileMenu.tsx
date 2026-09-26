import { useEffect, useRef, useState } from 'react';
import type { ShellProfile } from '@termhub/shared';

import {
  isProfileMenuCloseKey,
  loadShellProfiles,
  type ProfileMenuBridge,
} from './profile-menu-actions.js';
import './profile-menu.css';

export interface ProfileMenuProps {
  /** The `+` button's own bridge — `TabBar.tsx` already threads a `SessionActionsBridge` prop through, which structurally satisfies this narrower `ProfileMenuBridge` (see that type's own doc comment). */
  bridge: ProfileMenuBridge;
  /** Called with the chosen profile; never called for Esc/outside-click (those go through `onClose` instead). */
  onSelect: (profile: ShellProfile) => void;
  /** Called on Esc, a click outside the menu, or (if `list()` failed) nothing — this component never closes itself on a failed fetch, so the person can read the error. */
  onClose: () => void;
}

/**
 * M4.6's second half: the `+` button's dropdown, opened instead of
 * immediately creating a `powershell.exe` workspace. Fetches
 * `profiles.list` once on mount (the daemon's own cache makes a fresh fetch
 * on every open cheap — see `loadShellProfiles`'s doc comment), then lists
 * every detected shell in the visual language of the prototype's
 * `.palette`/`.pitem` (`termhub-prototipo.html` — see this task's final
 * report for the exact mapping, since the prototype itself has no menu here
 * to copy pixel-for-pixel: it never drew this one).
 *
 * Closing is Esc or a click outside the menu (this task's prompt, section
 * 2) — both wired here via `document`-level listeners, installed only while
 * this component is mounted (i.e. only while the menu is actually open;
 * `TabBar.tsx` conditionally renders this component rather than always
 * mounting it hidden).
 */
export function ProfileMenu({ bridge, onSelect, onClose }: ProfileMenuProps) {
  const [profiles, setProfiles] = useState<ShellProfile[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadShellProfiles(bridge)
      .then((list) => {
        if (!cancelled) {
          setProfiles(list);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
    // Empty deps deliberately: `bridge` is a stable object for this menu's
    // lifetime (`TabBar.tsx` never recreates it across renders, it's a
    // module-level constant there), and this effect is meant to run exactly
    // once per mount, matching "carregue a lista quando o menu abrir" (this
    // task's prompt) rather than on every re-render.
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isProfileMenuCloseKey(event.key)) {
        onClose();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div className="th-profile-menu" ref={menuRef} role="menu">
      {error !== undefined && <div className="th-profile-menu-error">{error}</div>}
      {error === undefined && profiles === undefined && (
        <div className="th-profile-item th-profile-item-empty">Carregando shells…</div>
      )}
      {error === undefined && profiles !== undefined && profiles.length === 0 && (
        <div className="th-profile-item th-profile-item-empty">nenhum shell encontrado</div>
      )}
      {error === undefined &&
        profiles !== undefined &&
        profiles.map((profile) => (
          <div
            key={profile.id}
            className="th-profile-item"
            role="menuitem"
            onClick={() => {
              onSelect(profile);
            }}
          >
            <span className="th-profile-item-name">{profile.name}</span>
            <span className="th-profile-item-shell">{profile.shell}</span>
          </div>
        ))}
    </div>
  );
}
