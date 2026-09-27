import './connection-banner.css';

// docs/specs/m4.8-daemon-resilience.md section 3.3: once boot has already
// finished, losing the daemon connection must never unmount the whole UI
// (the pre-M4.8 behavior `App.tsx` had) — this banner is what replaces the
// old full-screen "Desconectado do daemon" status for that case. It sits
// above the tab bar, never covers the grid, and is not a status bar (no
// permanent, always-present strip) — it only renders while there is
// something to say.
//
// Three kinds, matching the spec's own three messages:
// - `'reconnecting'`: the connection dropped and the daemon-supervisor is
//   retrying — "Daemon desconectado — reconectando…".
// - `'blocked'`: the supervisor found a daemon it can't safely talk to
//   (zombie/version-mismatch/token-rejected) and, per M2.1 section 2's
//   policy, will never retry on its own — the reason is shown, plus that it
//   won't try again.
// - `'restarted'`: the reconnected daemon was a *different* lifetime (no
//   session matched during resync, docs/specs/m4.8-daemon-resilience.md
//   section 3.4's last paragraph) — shown for a few seconds by `App.tsx`,
//   then cleared automatically.

export type ConnectionBannerKind = 'reconnecting' | 'blocked' | 'restarted';

export interface ConnectionBannerProps {
  kind: ConnectionBannerKind;
  /** The `'blocked'` reason (`daemon-client.ts`'s `zombie`/`version-mismatch`/`token-rejected`), shown verbatim next to the message. Ignored for every other `kind`. */
  reason?: string;
}

const MESSAGE_BY_REASON: Record<string, string> = {
  zombie: 'processo encontrado, mas não responde',
  'version-mismatch': 'versão do protocolo incompatível',
  'token-rejected': 'token de acesso não reconhecido',
};

export function ConnectionBanner({ kind, reason }: ConnectionBannerProps) {
  switch (kind) {
    case 'reconnecting':
      return (
        <div className="th-connection-banner th-connection-banner--reconnecting" role="status">
          Daemon desconectado — reconectando…
        </div>
      );
    case 'blocked':
      return (
        <div className="th-connection-banner th-connection-banner--blocked" role="status">
          Daemon bloqueado
          {reason !== undefined ? ` (${MESSAGE_BY_REASON[reason] ?? reason})` : ''} — não vai tentar
          de novo.
        </div>
      );
    case 'restarted':
      return (
        <div className="th-connection-banner th-connection-banner--restarted" role="status">
          Daemon reiniciado — as sessões anteriores foram encerradas.
        </div>
      );
  }
}
