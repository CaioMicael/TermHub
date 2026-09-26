import { useLayoutEffect, useRef } from 'react';
import type { SessionId } from '@termhub/shared';

import type { TerminalRegistry } from './terminal-registry.js';

export interface TerminalSlotProps {
  sessionId: SessionId;
  /** `App.tsx`'s single, long-lived registry (docs/specs/m3.5-terminal-lifecycle.md section 4.5) — never created here. */
  registry: TerminalRegistry;
}

/**
 * A plain, empty `div` — the "lugar" `SplitTree.tsx`'s leaf renders instead
 * of mounting a `Terminal` (docs/specs/m3.5-terminal-lifecycle.md section
 * 4.2). This component owns no xterm state at all; it only tells the
 * registry where its slot is.
 *
 * `useLayoutEffect`, not `useEffect`: `place`/`unplace` move a real DOM node
 * (the host element the registry created), and doing that after paint
 * (`useEffect`) would let the browser paint one frame with the host
 * element still in its *previous* slot (or nowhere), which is exactly the
 * kind of flash `useLayoutEffect` — synchronous, before the browser paints —
 * exists to avoid.
 *
 * React.StrictMode mounts, cleans up and mounts this effect again in dev.
 * That plays out as `place(A)` → `unplace(A)` → `place(A)` again, all
 * against the *same* slot element — harmless by construction: `unplace`
 * only parks the host element if it's still a child of the slot it's asked
 * about (section 4.2's own ordering guarantee, `terminal-registry.ts`'s
 * `unplace`), and the second `place()` simply moves it back. No terminal is
 * created or destroyed either way — this is exactly what "o registro não
 * tem ciclo de efeito do React" (section 4.1) is buying: the only thing
 * StrictMode's double-invoke can touch here is which DOM node currently
 * holds the (unaffected) host element.
 *
 * The ordering between this slot's cleanup and another slot's effect for
 * the *same* `sessionId` — e.g. moving a pane across the tree in one commit
 * — deliberately isn't resolved here: `terminal-registry.ts`'s `place`/
 * `unplace` contract (section 4.2) is what makes either order land on the
 * same end state, not anything this component does.
 */
export function TerminalSlot({ sessionId, registry }: TerminalSlotProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null) {
      return;
    }
    registry.place(sessionId, slot);
    return () => {
      registry.unplace(sessionId, slot);
    };
  }, [sessionId, registry]);

  return <div ref={slotRef} style={{ width: '100%', height: '100%' }} />;
}
