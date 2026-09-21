# TermHub — IDE de terminais para desenvolvimento agêntico

## 1. Contexto

O usuário é dev e roda 5-6 agentes de IA em paralelo, cada um no seu terminal. O Windows Terminal não dá conta disso:

- cada terminal vira uma guia solta do Windows, e o alt-tab de grupo não funciona direito;
- fechou uma aba sem querer? Não existe reabrir — tem que abrir terminal novo e navegar até a pasta de novo;
- não há noção de projeto, de layout salvo, nem de "esse agente terminou / está te esperando". A vigilância é manual, por alt-tab.

O TermHub é um app desktop open source (MIT) que trata **sessão de agente como objeto de primeira classe**: com nome, projeto, estado observável, scrollback persistente e layout. É "o VS Code dos terminais" — sidebar de workspaces onde o VS Code põe arquivos, abas e splits em grade, tudo numa janela só.

Diferencial frente ao que existe: Windows Terminal / Tabby / WezTerm são emuladores — não sabem o que roda dentro. Warp é fechado e aposta em outra coisa. Ninguém modela o ciclo de vida de um agente.

## 2. Referência visual

A **referência visual aprovada** é um protótipo estático e interativo da UI, validado antes de escrever qualquer código. Ele não é versionado aqui; o caminho do arquivo entra no prompt de cada tarefa de UI. A UI final deve bater com ele. Decisões de UI já fechadas nele:

- Tema Dark+ do VS Code na régua: activity bar `#333`, sidebar `#252526`, editor `#1e1e1e`, texto `#cccccc`. Segoe UI na interface, Cascadia Mono nos terminais.
- **Aba = workspace/projeto**; os terminais são painéis dentro da aba. Troca de contexto entre projetos é um clique.
- **Um terminal só = tela cheia**: sem moldura, sem divisória, cabeçalho liso.
- **Sem status bar.** Estado de daemon aparece só quando há problema (faixa de aviso), nunca como enfeite permanente.
- Estado da sessão é comunicado por bolinha colorida: verde pulsando = rodando, amarelo piscando = esperando você, cinza = ocioso, vermelho = saiu com erro. Aparece na sidebar, na aba e no cabeçalho do painel.
- Seção "Fechados recentemente" na sidebar mostra o cemitério, com o tempo de vida restante de cada sessão.

## 3. Arquitetura

Dois processos, e isso é o coração do produto:

```
┌─ termhub-daemon (Node destacado, sobrevive ao app) ──────────┐
│  node-pty (ConPTY)  ·  @xterm/headless por sessão (buffer)   │
│  detector de status ·  registry + graveyard  ·  busca global │
└──────────────── named pipe \\.\pipe\termhub-<user> ──────────┘
                              │
┌─ Electron main ─────────────┴────────────────────────────────┐
│  spawna/reata o daemon · relay de frames · Notification API  │
└──────────────────────────────────────────────────────────────┘
                              │ ipcRenderer (Uint8Array)
┌─ Renderer (React) ──────────┴────────────────────────────────┐
│  xterm.js + WebGL · split tree · sidebar · palette           │
└──────────────────────────────────────────────────────────────┘
```

**Por que o daemon resolve a dor original:** fechar a janela (ou ela crashar) não mata agente nenhum. Reabrir reata com a tela e o scrollback intactos. `Ctrl+Shift+T` devolve a aba fechada **viva**, não "na mesma pasta".

### Decisões técnicas

| Decisão | Escolha | Motivo |
|---|---|---|
| Stack | Electron + TypeScript + React + xterm.js + node-pty | Stack do VS Code; `node-pty` é o binding ConPTY mais maduro no Windows. |
| Spawn do daemon | `ELECTRON_RUN_AS_NODE=1` no próprio binário do Electron, `detached: true` + `unref()` | ABI do módulo nativo bate com o Electron e não exige Node no sistema. É o que o VS Code faz com o pty host. |
| Transporte | Named pipe (`net`, mesma API = unix socket no Linux/macOS) | ACL por usuário de graça, sem porta aberta. Camada de transporte isolada para plugar WebSocket depois (viewer web/mobile). |
| Framing | `[uint32 len][uint8 type][payload]` — type 0 = JSON de controle, type 1 = `[uint32 sessionId][bytes]` | Dados de PTY não passam por JSON/base64. |
| Reattach | `@xterm/headless` + `@xterm/addon-serialize` no daemon | Serializa tela + scrollback como sequências VT; o cliente escreve isso no xterm e continua o stream. |
| Estado da UI | Zustand | Store pequena, sem boilerplate. |
| Splits | `react-resizable-panels` sobre uma árvore binária própria | Evita reimplementar drag de divisória. |
| Build | `electron-vite` + `electron-builder` (NSIS + portable) + `@electron/rebuild` | Padrão atual, HMR no renderer. |
| Plataforma | Windows primeiro, código cross-platform | É a dor real; nada Windows-only cravado na arquitetura. |

Versões: instalar as estáveis mais recentes no scaffold (não pinar aqui).
Deps principais: `electron`, `react`, `zustand`, `react-resizable-panels`, `node-pty`, `@xterm/xterm`, `@xterm/headless`, `@xterm/addon-{webgl,fit,search,serialize,unicode11,web-links}`, `vitest`, `@playwright/test`.

### Estrutura (npm workspaces — o ambiente tem npm 11, sem pnpm/cargo)

```
TermHub/
├─ docs/plan.md               este documento
├─ docs/milestones.md         quebra dos milestones em tarefas de subagente
├─ packages/
│  ├─ shared/     protocol.ts (tipos + framing), events.ts, config-schema.ts
│  ├─ daemon/     index.ts, server.ts, session.ts, registry.ts,
│  │              status-detector.ts, graveyard.ts, search.ts, profiles.ts
│  ├─ app/        main/ (bootstrap, daemon-client, notifications, menus, keymap)
│  │              preload/ (bridge tipada)
│  └─ ui/         App.tsx, Terminal.tsx, SplitTree.tsx, TabBar.tsx,
│                 Sidebar.tsx, CommandPalette.tsx, SearchPanel.tsx, store/
├─ .github/workflows/ci.yml   (windows-latest: lint, test, build)
└─ LICENSE (MIT), README.md, CLAUDE.md
```

Estado em `%APPDATA%/TermHub/`: `config.json` (settings/tema/keybindings), `workspaces.json` (workspaces, layout, sessões, comandos de launch), `daemon.json` (pipe, pid, token).

---

## 4. Sequência de execução

Um milestone por vez, em branch própria. **Só passa pro próximo quando o gate fecha.** Cada milestone termina com uma entrega que dá pra ver ou rodar.

| # | Milestone | Tam. | Entrega | Gate (como provo que funciona) |
|---|---|---|---|---|
| **M0** | Scaffold | P | Monorepo npm workspaces, TS strict, electron-vite, ESLint/Prettier, Vitest, CI no `windows-latest`, LICENSE MIT, README | `npm run dev` abre janela Electron vazia; `npm test` e o CI passam verdes |
| **M1** | Daemon + PTY | **G** | Daemon no named pipe com `session.create/write/resize/close/attach/detach/list`; cada sessão = `node-pty` (ConPTY) + `@xterm/headless`; handshake com token | Script CLI cria sessão, roda `echo hi`, desconecta, reconecta e **recebe o buffer serializado com o `hi` lá** |
| **M2** | Casca da UI, um terminal | M | Main spawna/reata o daemon (lock por pipe: existe → conecta, senão sobe); `Terminal.tsx` com xterm + WebGL + fit + unicode11; teclado, copy/paste, resize propagando pro PTY | Rodar `claude` dentro do TermHub e conversar com ele sem nada quebrado; fechar a janela e reabrir → sessão volta viva |
| **M3** | Abas + splits em grade | M | Árvore binária de painéis na store, render recursivo com `react-resizable-panels`; abas por workspace; drag pra reordenar e pra criar split | Grade 2×2 com 4 agentes, divisórias arrastáveis, trocar de aba **sem perder scrollback nem reatar** |
| **M4** | Sidebar, persistência, reabrir fechado | **G** | Árvore workspace→sessões; layout e sessões salvos com debounce; graveyard com TTL de 10 min; `Ctrl+Shift+T`; lista de fechados; perfis (pwsh, cmd, Git Bash, WSL); launch de workspace | Fechar aba e trazer de volta viva com scrollback; matar o processo da janela no Gerenciador de Tarefas e reabrir → tudo volta. **Daqui pra frente já dá pra usar no dia a dia** |
| **M5** | Status do agente + notificações | M | `status-detector.ts` no daemon consumindo o stream: BEL `0x07`, OSC 9 / OSC 777, OSC 133 A/B/C/D, OSC 0/2 + timer de ociosidade; badges na UI; toast do Windows com clique-pra-focar | Deixar um `claude` numa pergunta em aba de fundo → badge amarelo + toast; clicar no toast foca a sessão certa |
| **M6** | Quick switcher + busca | M | `Ctrl+P` sobre as sessões (nome, workspace, cwd, status); busca no buffer com `addon-search`; busca global via RPC varrendo os buffers headless | `Ctrl+P` acha sessão por projeto e por estado; busca global acha string em sessão que a janela nunca abriu |
| **M7** | Acabamento e release | M | Settings, temas, keybindings configuráveis, NSIS + portable, docs de contribuição, release no GitHub | Instalar o `.exe` numa máquina limpa e abrir 5 agentes |

A quebra de cada milestone em tarefas de subagente está em [milestones.md](./milestones.md) — 50 tarefas, com dependências e critério de aceite por tarefa.

**Ordem é dependência real, não preferência:** M1 é a fundação (sem daemon, M2/M4 não existem); M3 depende do terminal de M2 funcionando; M5 lê o mesmo stream que M1 já intercepta; M6 lê os buffers que M1 mantém. M0→M4 é o caminho crítico até o app ser usável — M5 e M6 são a camada que diferencia.

### Protocolo de trabalho

1. Cada milestone vira uma branch (`m1-daemon`, `m2-ui-shell`, …), com commits pequenos.
2. Ao fim de cada um eu entrego: **o que mudou**, **como rodar** e **o que você valida na mão**.
3. Só sigo pro próximo depois do seu ok.
4. Mudança de escopo no meio do milestone → anoto e trago no fim, não desvio.

---

## 5. Riscos e mitigações

- **Throughput do IPC com 6 agentes cuspindo output.** v1 relaya pelo main com `Uint8Array` (sem base64). Se medir lag de digitação ou CPU alta no main, migrar pra `MessageChannelMain` (renderer fala direto com o socket) — é a rota do VS Code. Coalescer writes numa janela de ~8ms.
- **Contextos WebGL são limitados (~16 no Chromium).** Anexar o addon WebGL só nos painéis visíveis; os ocultos ficam vivos mas sem contexto. Terminais ocultos **não desmontam** (só `display:none`), senão cada troca de aba paga reattach.
- **`node-pty` é nativo.** `@electron/rebuild` no postinstall e no CI; validar que o prebuild carrega sob `ELECTRON_RUN_AS_NODE`.
- **Daemon órfão ou zumbi.** `daemon.json` com pid + versão de protocolo; no boot, se o pipe não responde ou a versão diverge, mata e sobe de novo. Daemon se encerra sozinho após X min sem cliente **e** sem sessão viva.
- **Detecção de status é heurística.** Tratar como dica, nunca como verdade: nunca bloquear ação do usuário com base nela, e deixar limiar de ociosidade configurável por perfil.

## 6. Fora do escopo do v1

Viewer web/mobile para acompanhar agentes de fora, API de plugin, broadcast de input para N terminais, auto-update, empacotamento Linux/macOS. Nada disso é descartado — a arquitetura de daemon foi escolhida justamente para não travar esses caminhos.

## 7. Verificação

- **Unit (Vitest):** detector de status alimentado com streams sintéticos de OSC/BEL; framing do protocolo (incluindo frames partidos); reducer da árvore de splits; matcher do quick switcher.
- **Integração (Vitest, node-pty real no Windows):** criar sessão → escrever → ler; detach/reattach preserva buffer; graveyard expira no TTL; busca global acha string em sessão não anexada.
- **E2E (`@playwright/test` com `_electron`):** abrir app, criar 4 terminais em grade, screenshot, `Ctrl+P` alterna, `Ctrl+Shift+T` restaura.
- **Manual, o teste que importa:** subir 3 agentes, matar o processo da janela pelo Gerenciador de Tarefas, reabrir o TermHub — as 3 sessões voltam vivas, com scrollback, e os agentes continuaram trabalhando no meio tempo.
