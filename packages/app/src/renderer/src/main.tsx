import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Dark placeholder shell for M0.3 — just proves the renderer boots and HMRs.
// The real UI (App.tsx, Terminal.tsx, Sidebar.tsx, ...) is built in
// packages/ui starting at M2/M3 and mounted here later.
function Placeholder() {
  const versions = window.termhub?.versions;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#1e1e1e',
        color: '#cccccc',
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        fontSize: '14px',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <p>TermHub</p>
        {versions ? (
          <p style={{ color: '#8d8d8d', fontSize: '12px' }}>
            electron {versions.electron} &middot; chrome {versions.chrome} &middot; node{' '}
            {versions.node}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
