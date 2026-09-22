# TermHub — Backlog de execução

Quebra dos 8 milestones do [plan.md](./plan.md) em tarefas pequenas o bastante para um subagente Sonnet executar de ponta a ponta sem perder contexto.

**Como usar:** cada linha da tabela é **uma tarefa para um subagente**. O prompt do subagente deve carregar `docs/plan.md` (arquitetura e decisões), o protótipo aprovado da UI (referência visual obrigatória quando a tarefa for de UI; não é versionado, o caminho vai no prompt) e a linha da tarefa. A coluna **Aceite** é o que o subagente tem que provar antes de devolver — sem isso, a tarefa não está pronta.

**Um subagente Sonnet por tarefa, no máximo 2 ao mesmo tempo.** As 7 tarefas marcadas ⬥ recebem antes uma techspec escrita pelo Opus; o resto vai direto. Ver [Execução](#execução-quem-faz-o-quê) no fim do documento.

**Convenções:**
- Uma branch por milestone (`m1-daemon`, `m2-ui-shell`, …); um commit por tarefa.
- `Mx.y ← a,b` significa que a tarefa depende das tarefas `a` e `b`. Tarefas sem dependência entre si podem rodar **em paralelo**, em subagentes simultâneos.
- Toda tarefa que cria lógica nova cria também o teste dela. Tarefa sem teste só é aceitável quando é puramente visual.
- Nenhuma tarefa mexe em arquivo que outra tarefa paralela está editando — as fronteiras de arquivo abaixo já foram desenhadas pra isso.
- Tarefa marcada ⬥ não é disparada sem a techspec dela em `docs/specs/` já escrita.
- O processo de trabalho com subagentes (quem roda git, como se verifica uma entrega, por que o paralelismo é limitado pelo npm) está em [`.claude/rules/agent-workflow.md`](../.claude/rules/agent-workflow.md).

| Milestone | Tarefas | Independentes entre si |
|---|---|---|
| M0 Scaffold | 5 | 2 |
| M1 Daemon + PTY | 8 | 3 |
| M2 Casca da UI | 6 | 2 |
| M3 Abas + splits | 6 | 3 |
| M4 Sidebar + persistência | 8 | 3 |
| M5 Status + notificações | 6 | 2 |
| M6 Switcher + busca | 5 | 3 |
| M7 Acabamento | 6 | 4 |
| **Total** | **50** | |

> A última coluna diz quantas tarefas ficam livres ao mesmo tempo, não quantas rodam. **O teto de execução é 2 subagentes simultâneos**; quando houver mais de 2 livres, escolher 2 e deixar o resto pra próxima rodada.

---

## M0 — Scaffold

| # | Tarefa | Aceite |
|---|---|---|
| **M0.1** | Base do repo: `LICENSE` (MIT), `README.md` (o que é, por que existe, como rodar), `CLAUDE.md` (convenções pra agentes: TS strict, nomes em inglês, testes junto do código). `.gitignore` e `.gitattributes` já estão commitados | README explica o projeto sem depender do plan.md; `git check-attr text -- docs/plan.md` confirma a normalização |
| **M0.2** ← 0.1 | npm workspaces: `package.json` raiz com `workspaces: ["packages/*"]`, `tsconfig.base.json` (strict, ES2022, moduleResolution bundler), `packages/shared` com tsconfig próprio e um `index.ts` | `npm install` na raiz resolve; `npm run typecheck` passa |
| **M0.3** ← 0.2 | electron-vite em `packages/app`: main, preload e renderer mínimos (janela 1400×900, dark, sem menu nativo), script `npm run dev` com HMR no renderer | `npm run dev` abre uma janela Electron escura e vazia; editar o renderer recarrega sem fechar a janela |
| **M0.4** ← 0.2 | Ferramental de qualidade: ESLint (flat config) + Prettier + Vitest configurados na raiz, rodando em todos os workspaces; um teste de exemplo em `shared` | `npm run lint`, `npm run test` e `npm run typecheck` passam limpos |
| **M0.5** ← 0.3,0.4 | CI em `.github/workflows/ci.yml`: `windows-latest`, Node 22, cache de npm, roda install → lint → typecheck → test → build | Workflow verde no push da branch |

---

## M1 — Daemon + PTY

O milestone de fundação e o mais arriscado. `M1.1`, `M1.3` e `M1.4` são independentes entre si — dá pra disparar as três juntas.

| # | Tarefa | Aceite |
|---|---|---|
| **M1.1** | `packages/shared/protocol.ts`: tipos de RPC, eventos e erros + `encodeFrame`/`FrameDecoder` no formato `[uint32 len][uint8 type][payload]` (type 0 = JSON, type 1 = `[uint32 sessionId][bytes]`) | Testes cobrindo frame partido em 2 chunks, 2 frames no mesmo chunk, payload binário com bytes nulos e frame maior que o buffer |
| **M1.2** ← 1.1 | `packages/daemon/transport.ts`: servidor `net` em named pipe `\\.\pipe\termhub-<hash do usuário>`, múltiplos clientes, handshake com token, RPC request/response por id + broadcast; cliente correspondente pra reuso nos testes e no app | Teste de integração: 2 clientes conectam, um `ping` responde `pong`, token errado derruba a conexão |
| **M1.3** | `packages/daemon/session.ts`: wrapper de `node-pty` (spawn, write, resize, kill, onData, onExit) com ConPTY | Teste: spawna `pwsh`, escreve `echo hi`, captura `hi` na saída, encerra sem deixar processo órfão |
| **M1.4** | `packages/daemon/registry.ts`: ciclo de vida e metadados das sessões (id, nome, tag, cwd, shell, comando de launch, criada em, estado) com create/get/list/close | Testes de CRUD e de ids não reutilizados após close |
| **M1.5** ← 1.2,1.3,1.4 | RPCs `session.create/write/resize/close/list` ligando transport ↔ registry ↔ pty, com broadcast de `session.data` (binário) e `session.exit` | Teste ponta a ponta pelo pipe: cria sessão, escreve comando, recebe a saída em frames binários, fecha |
| **M1.6** ← 1.3 | Buffer headless: uma instância `@xterm/headless` por sessão espelhando o stream, scrollback configurável, `serialize()` via `@xterm/addon-serialize` | Teste: escrever 3 comandos e uma sequência de limpeza de tela; o serialize reproduz o estado final correto |
| **M1.7** ← 1.5,1.6 | `session.attach/detach`: no attach devolve o snapshot serializado e passa a receber o stream ao vivo; controle de clientes anexados; resize aplicado por quem está anexado | Teste: cliente A anexa, gera saída, desanexa, reconecta e recebe snapshot **com a saída anterior**, sem duplicar o stream |
| **M1.8** ← 1.7 | `packages/daemon/index.ts`: entrypoint com lock de instância única, `daemon.json` (pid, pipe, token, versão do protocolo) em `%APPDATA%/TermHub`, encerramento automático sem cliente e sem sessão viva; `cli.ts` de diagnóstico | **Gate do M1:** `node cli.ts` cria sessão, roda `echo hi`, desconecta, reconecta e imprime o buffer com `hi` |

---

## M2 — Casca da UI, um terminal

| # | Tarefa | Aceite |
|---|---|---|
| **M2.1** | `packages/app/main/daemon-client.ts`: lê `daemon.json`, tenta conectar; se não houver daemon ou a versão divergir, spawna com `ELECTRON_RUN_AS_NODE=1` + `detached:true` + `unref()` e faz retry com backoff | Fechar o app e reabrir **não** sobe um segundo daemon; apagar `daemon.json` com daemon vivo não cria duplicata |
| **M2.2** ← 2.1 | Ponte IPC: preload com `contextBridge` tipado, canais de RPC e de dados de PTY como `Uint8Array` (sem base64), coalescing de writes numa janela de ~8ms | Teste: 1000 frames pequenos chegam íntegros e em ordem no renderer |
| **M2.3** ← 2.2 | `packages/ui/Terminal.tsx`: xterm + `addon-fit` + `addon-unicode11` + `addon-web-links`, monta, anexa à sessão, envia teclado, escreve o stream recebido | Digitar num `pwsh` dentro do app e ver o eco correto, incluindo acentuação |
| **M2.4** ← 2.3 | Renderer WebGL com fallback para canvas + tema do xterm com a paleta ANSI do protótipo; fonte Cascadia Mono | Cores do terminal batem com o protótipo lado a lado; sem erro de contexto WebGL no console |
| **M2.5** ← 2.3 | Resize (`ResizeObserver` → `fit` → `session.resize` com debounce) e clipboard (Ctrl+Shift+C/V + menu de contexto) | Redimensionar a janela reflui a saída sem lixo; `claude` redesenha a TUI corretamente |
| **M2.6** ← 2.1,2.3 | Reattach no boot: lista sessões vivas no daemon, reata, escreve o snapshot e emenda no stream ao vivo sem duplicar | **Gate do M2:** rodar `claude` no app, fechar a janela, reabrir → a sessão volta viva com o histórico |

---

## M3 — Abas + splits em grade

`M3.1` primeiro (todo o resto lê a store). Depois `M3.2`, `M3.3` e `M3.4` são paralelas.

| # | Tarefa | Aceite |
|---|---|---|
| **M3.1** | Store Zustand: modelo workspace → aba → árvore binária de painéis (`{dir, ratio, a, b}` / folha `{sessionId}`) e reducers `split`, `closePane`, `movePane`, `setRatio` | Testes do reducer: dividir, fechar folha colapsando o nó pai, mover painel entre ramos, ratio preservado |
| **M3.2** ← 3.1 | `SplitTree.tsx`: render recursivo com `react-resizable-panels`, divisórias arrastáveis gravando o ratio na store | Grade 2×2 arrastável; o ratio sobrevive à troca de aba |
| **M3.3** ← 3.1 | `TabBar.tsx`: aba = workspace, com bolinha de estado agregado, contador de sessões, fechar e botão `+` | Visual idêntico ao protótipo; trocar de aba troca a grade |
| **M3.4** ← 3.1 | `PaneHeader.tsx`: nome, tag, cwd, badge de estado e botões maximizar/dividir/fechar; **painel solo = tela cheia** (sem moldura, sem divisória, cabeçalho liso) | Workspace com 1 painel renderiza igual à aba `landing-page` do protótipo |
| **M3.5** ← 3.2 | Terminais ocultos permanecem montados (`display:none`, nunca desmontar); WebGL anexado só nos painéis visíveis, liberado nos ocultos | Alternar 3 abas 10 vezes não reata sessão nenhuma e não estoura contexto WebGL |
| **M3.6** ← 3.2,3.3 | Drag & drop: reordenar abas e arrastar um painel pra borda de outro criando split | **Gate do M3:** 4 agentes em grade 2×2, divisórias arrastáveis, troca de aba sem perder scrollback |

---

## M4 — Sidebar, persistência e reabrir fechado

| # | Tarefa | Aceite |
|---|---|---|
| **M4.1** | `packages/shared/config-schema.ts` (zod) + `packages/app/main/store-files.ts`: leitura/escrita **atômica** (tmp + rename) de `config.json` e `workspaces.json` em `%APPDATA%/TermHub`, com debounce e defaults ao falhar validação | Testes: arquivo corrompido cai no default sem crash; escrita concorrente não trunca |
| **M4.2** | `Sidebar.tsx` + activity bar: árvore workspace → sessões com bolinhas de estado, ações no hover (dividir/fechar), colapsar grupo, troca de vista | Visual idêntico ao protótipo; clicar numa sessão foca o painel dela |
| **M4.3** ← 4.1,4.2 | Persistência de layout: salvar e restaurar abas, árvore de splits, ordem e painel focado | Fechar e reabrir o app devolve a mesma disposição de painéis |
| **M4.4** | `packages/daemon/graveyard.ts`: ao fechar, a sessão vai pro cemitério com TTL (default 10 min, configurável); `session.restore`; expiração mata o PTY de verdade; `session.kill` encerra na hora | Testes com fake timers: restaurar antes do TTL devolve a sessão viva; depois do TTL, o PTY está morto |
| **M4.5** ← 4.2,4.4 | UI do cemitério: seção "Fechados recentemente" com tempo restante, botão restaurar e `Ctrl+Shift+T` pra última fechada | Fechar aba e apertar `Ctrl+Shift+T` devolve a sessão **viva com o scrollback** |
| **M4.6** | `packages/daemon/profiles.ts`: detecção de pwsh, powershell, cmd, Git Bash e distros WSL (`wsl -l -q`), com perfis configuráveis; menu no botão `+` | Numa máquina com WSL, as distros aparecem no menu e abrem corretamente |
| **M4.7** ← 4.3,4.6 | Launch de workspace: `{name, cwd, shell, command}` por sessão; abrir workspace sobe todas as sessões definidas; relançar sessão morta com o mesmo comando | Definir 3 agentes num workspace e abrir tudo com um clique |
| **M4.8** ← 4.1 | Resiliência do daemon: se cair ou reiniciar, faixa de aviso no topo (não status bar) e re-sync do estado ao reconectar | **Gate do M4:** matar o processo da janela no Gerenciador de Tarefas e reabrir → tudo volta vivo |

---

## M5 — Status do agente + notificações

| # | Tarefa | Aceite |
|---|---|---|
| **M5.1** | `packages/daemon/osc-parser.ts`: extrai BEL `0x07`, OSC 0/2 (título), OSC 9 e OSC 777 (notificação) e OSC 133 A/B/C/D do stream **sem alterar o passthrough** | Testes com streams sintéticos, incluindo sequência partida entre dois chunks e OSC sem terminador |
| **M5.2** ← 5.1 | `packages/daemon/status-detector.ts`: máquina de estados `running` / `awaiting-input` / `idle` / `exited`, com limiar de ociosidade configurável por perfil | Testes de transição com fake timers cobrindo cada aresta |
| **M5.3** ← 5.2 | Evento `session.status` no protocolo e propagação daemon → main → store | Deixar um comando longo rodando e ver o estado mudar sozinho na store |
| **M5.4** ← 5.3 | Badges na UI: bolinhas e animações do protótipo na sidebar, nas abas e no cabeçalho do painel; estado agregado por workspace (esperando > rodando > ocioso) | Visual idêntico ao protótipo com os 4 estados |
| **M5.5** ← 5.3 | Notificações nativas: `app.setAppUserModelId`, toast em `awaiting-input` e `exited` **só** quando a janela não está focada, com throttle por sessão | Agente pedindo input em aba de fundo gera 1 toast, não 10 |
| **M5.6** ← 5.5 | Clique no toast foca janela + workspace + painel certos; fila de notificações quando a janela está fechada | **Gate do M5:** `claude` faz uma pergunta em aba de fundo → badge amarelo + toast → clicar leva direto nele |

---

## M6 — Quick switcher + busca

| # | Tarefa | Aceite |
|---|---|---|
| **M6.1** | `packages/shared/fuzzy.ts`: matcher de subsequência com pontuação por campo (nome > tag > workspace > cwd), sem dependência externa | Testes: `clau tm` acha `claude` em `TermHub`; ordenação estável |
| **M6.2** ← 6.1 | `CommandPalette.tsx`: `Ctrl+P` lista sessões vivas e fechadas, setas navegam, Enter foca, `Ctrl+Enter` abre em split novo, `Esc` fecha | Comportamento e visual iguais aos do protótipo |
| **M6.3** | Busca no buffer: `@xterm/addon-search` com `Ctrl+F` no painel focado, próximo/anterior e destaque | Buscar num scrollback de 10k linhas responde sem travar a UI |
| **M6.4** | RPC `search.global` no daemon varrendo os buffers headless de **todas** as sessões, inclusive as não anexadas e as do cemitério, com limite e paginação | Teste: string escrita numa sessão nunca aberta pela janela é encontrada |
| **M6.5** ← 6.4 | `SearchPanel.tsx`: resultados agrupados por sessão com trecho e destaque; clicar pula pra sessão e rola até a linha | **Gate do M6:** achar uma string em sessão de outro workspace e cair na linha certa |

---

## M7 — Acabamento e release

`M7.1` a `M7.4` são independentes entre si.

| # | Tarefa | Aceite |
|---|---|---|
| **M7.1** | Tela de settings: fonte e tamanho, tema, TTL do cemitério, limiar de ociosidade, tamanho do scrollback — aplicando sem reiniciar | Mudar a fonte reflete nos terminais abertos na hora |
| **M7.2** | Keybindings configuráveis (`keymap.json`) sobre um registro central de comandos | Trocar o atalho de `Ctrl+P` e ver valer sem recompilar |
| **M7.3** | Temas: paleta do protótipo como padrão + importador de tema do VS Code (JSON) | Importar um tema conhecido e ver UI e ANSI mudarem juntos |
| **M7.4** | E2E com `@playwright/test` + `_electron`: abrir, criar 4 terminais em grade, `Ctrl+P`, `Ctrl+Shift+T`, screenshot | Suíte verde no CI |
| **M7.5** ← 7.1,7.2,7.3 | Empacotamento `electron-builder`: NSIS + portable, ícone, AppUserModelId, artefato publicado pelo CI. **Herdado da M2.1:** `node-pty` **não** é dependência declarada de `@termhub/app` (fica externo ao bundle de propósito), então o `electron-builder` precisa ser instruído a incluí-lo explicitamente, com o `.node` em `asarUnpack` — binário nativo não carrega de dentro do asar. Sem rebuild por ABI: ver riscos no `plan.md` | Instalador roda numa máquina limpa sem Node instalado |
| **M7.6** ← 7.5 | `README` com GIF de demonstração, `CONTRIBUTING.md`, release `v0.1.0` no GitHub | **Gate do M7:** instalar o `.exe` numa máquina limpa e abrir 5 agentes |

---

## Execução: quem faz o quê

**Implementação é sempre Sonnet.** Um subagente por tarefa, **no máximo 2 rodando ao mesmo tempo** — o teto é de custo, não de dependência.

**Opus não implementa: especifica.** Nas 7 tarefas marcadas ⬥, antes de disparar o subagente, Opus escreve uma techspec em `docs/specs/<tarefa>.md` e o prompt do Sonnet aponta pra ela.

### O que a techspec precisa ter

Sem estes cinco itens ela não serve — vira um texto bonito que o Sonnet contorna:

1. **A decisão já tomada**, não o problema descrito. Não "cuidado com a corrida no attach", e sim "assine o stream → bufferize → serialize → despeje o buffer → siga ao vivo, nesta ordem".
2. **O modo de falha que a decisão evita**, escrito com todas as letras. É o que impede o Sonnet de "simplificar" de volta pro bug quando a implementação ficar deselegante.
3. **Os casos de teste obrigatórios**, com destaque pro caso que o teste ingênuo não pega. Sem isso o agente escreve o teste que a própria implementação dele passa, e o verde não significa nada.
4. **Assinaturas** das funções públicas e o contrato de cada uma (o que pode lançar, o que é síncrono, quem é dono do recurso).
5. **O que está fora de escopo** — o que a tarefa não deve tocar, pra não vazar pra tarefa vizinha.

### Quando escrever

**Na hora da tarefa, não agora.** A techspec do M1.7 depende de como M1.5 e M1.6 ficaram no código real; escrever as 7 hoje seria especificar sobre código que não existe. A regra é: dependências fechadas → Opus lê o que ficou de pé → escreve a spec → dispara o Sonnet.

### As 7 tarefas com techspec

| # | Techspec | O que a spec tem que resolver |
|---|---|---|
| **M1.7** attach/detach ⬥ | `docs/specs/m1.7-attach-detach.md` | A janela entre serializar o snapshot e assinar o stream ao vivo. Assinar depois do serialize perde bytes; assinar antes sem bufferizar duplica. O teste ingênuo passa nas duas versões erradas — só quebra com output chegando no exato instante do reattach, que é o caso do agente trabalhando. |
| **M1.8** lock de instância única ⬥ | `docs/specs/m1.8-single-instance.md` | Dois apps abrindo juntos: ambos leem `daemon.json`, ambos não acham nada, ambos sobem um daemon. O lock tem que ser a criação do named pipe (atômica no SO), não `existsSync`. |
| **M2.1** spawn/reattach do daemon ⬥ | `docs/specs/m2.1-daemon-client.md` | A mesma corrida pelo lado do cliente, mais backoff, versão de protocolo divergente e daemon zumbi que aceita conexão e não responde. |
| **M2.6** reattach no boot ⬥ | `docs/specs/m2.6-boot-reattach.md` | A janela do M1.7 de novo, agora com o xterm do renderer no meio: snapshot escrito no terminal e stream ao vivo emendado sem duplicar nem embaralhar. |
| **M3.5** ciclo de vida do WebGL ⬥ | `docs/specs/m3.5-webgl-lifecycle.md` | Recurso escasso (~16 contextos no Chromium) com montagem e desmontagem constantes. Vazar contexto não quebra no teste, quebra na vigésima troca de aba. |
| **M4.1** escrita atômica de estado ⬥ | `docs/specs/m4.1-atomic-state.md` | tmp + rename, corrida entre o debounce e o fechamento do app, arquivo corrompido caindo no default. Perder o `workspaces.json` apaga o layout do usuário. |
| **M5.1** parser de OSC ⬥ | `docs/specs/m5.1-osc-parser.md` | Sequência partida entre dois chunks, terminador ausente, e a obrigação de não corromper o passthrough. Erro aqui suja o terminal do usuário com lixo de escape. |

As outras 43 tarefas vão direto pro Sonnet com a linha da tabela e o critério de aceite.
