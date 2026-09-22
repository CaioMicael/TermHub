import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

// M0.3's placeholder is gone as of M2.3: the real UI starts here now,
// mounting packages/ui's `Terminal` inside `App`'s connection/session-boot
// shell (see App.tsx's own header comment for what is and isn't this
// task's scope). Sidebar/TabBar/SplitTree (packages/ui) come in M3/M4 and
// wrap `App`'s single-terminal shell in a real layout then.
const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
