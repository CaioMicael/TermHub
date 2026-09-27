# Retomada do desenvolvimento

Estado em 2026-09-27, escrito para quem assumir a coordenação em outra sessão ou máquina. Leia antes `CLAUDE.md` e `.claude/rules/agent-workflow.md`. O processo (coordenador que escreve spec, verifica e commita; subagente Sonnet que implementa) está todo ali, com os casos reais que o justificam. No M4, o dono liberou até 3 subagentes em paralelo; o limite real continua sendo arquivos disjuntos e no máximo um instalando dependência.

## Onde as coisas estão

| Branch | Conteúdo | Estado |
|---|---|---|
| `main` | M0 a M3 mergeados | CI verde. Gate do M3 aprovado pelo dono em 26/09 (PR #2) |
| `m4-sidebar-persistence` | M4.1 a M4.8, todas verificadas pelo coordenador | CI verde. PR do M4 aberto contra a `main`, esperando o gate do dono |

## O M4

Cada tarefa tem um commit próprio, e a mensagem dele diz o que foi provado, o que não foi, e as lacunas. Os commits de correção que vieram depois também.

| Tarefa | Commit | Resumo |
|---|---|---|
| M4.1 estado em disco | `a3db562` | `config.json` e `workspaces.json`, escrita atômica, fila por arquivo, flush no `before-quit`, lock de instância única. Spec: `docs/specs/m4.1-atomic-state.md` |
| M4.2 sidebar e activity bar | `87bae55` | Árvore workspace → sessões, conforme o protótipo |
| M4.3 persistência de layout | `cf711d1` | Folha casa por `id` + `createdAt` (o daemon renumera a partir de 1 a cada início) |
| M4.4 cemitério | `f12e9bf` | `session.close` enterra; `session.kill`, `session.restore`, `graveyard.list` |
| M4.5 UI do cemitério | `30bac48` | "Fechados recentemente" e `Ctrl+Shift+T`, barrado no xterm |
| M4.6 perfis de shell | `3f6b61a`, `d458634` | Detecção no daemon (UTF-16LE do `wsl`, timeout), menu no `+`, fim do `powershell.exe` fixo |
| M4.7 launch de workspace | ver o log | O daemon executa o `command`; sessão morta relança no mesmo lugar; modelos de workspace |
| M4.8 resiliência do daemon | `005462b` | Supervisor com reconexão, faixa no topo, ressincronização. Spec: `docs/specs/m4.8-daemon-resilience.md` |

### O gate do M4 é do dono

Nada do M4 foi visto em Electron real: as sessões de desenvolvimento rodaram num container Linux, sem o binário do Electron. A UI foi exercitada num Chromium real com uma ponte falsa, e o daemon com PTYs reais em Linux e no CI em Windows. O gate, no Windows:

- matar o processo da janela no Gerenciador de Tarefas, reabrir, e tudo volta vivo, com o mesmo layout;
- fechar uma aba e trazê-la de volta viva, com o scrollback (`Ctrl+Shift+T`);
- as provas manuais que cada spec pede (M4.1: segunda instância foca a primeira, arquivo corrompido vira `.corrupt-*`; M4.8: matar o daemon isolado e ver a faixa e a volta).

Com o ok do dono: merge do PR com `--no-ff`, e CI verde na `main`.

## Depois: M5

Tarefas em `docs/milestones.md`. A **M5.1** (parser de OSC) é ⬥ e precisa de techspec antes de disparar. Pendências herdadas que tocam o M5:

- **Animação das bolinhas de estado** (`breathe`/`pulse` do protótipo): nenhuma bolinha anima ainda (TabBar, PaneHeader, sidebar). A M5.4 é quem faz.
- **Notificações**: restaurar uma entrada expirada do cemitério só atualiza a lista, sem aviso ao usuário. Não há sistema de toast ainda.

## Armadilhas que custaram caro, e que continuam valendo

- **Typecheck do zero.** `npx tsc --build --clean` antes do `npm run typecheck`. O cache incremental já escondeu um CI vermelho.
- **Isolamento do daemon nas provas manuais.** `APPDATA` **e** `TERMHUB_PIPE_SUFFIX` próprios, os dois. Os arquivos de estado da M4.1 seguem o `APPDATA` da variável, como o daemon; o `app.getPath('appData')` do Electron não seguiria.
- **Nunca matar daemon sem conferir o PID contra o `daemon.json`, e nunca matar o do dono.**
- **O `@termhub/ui` recebe a ponte por prop.** Nunca lê `window.termhub`.
- **Os terminais vivem no registro** (`terminal-registry.ts`, M3.5), fora da árvore do React.
- **Uma sessão por folha.** O segundo terminal da mesma sessão não recebe snapshot.
- **Pacote do monorepo nunca vai nas dependências do `packages/app/package.json`.** O `externalizeDepsPlugin` transforma o que está declarado em `require` de runtime, e o Electron tentaria carregar TypeScript. Depois do build, confira que o `dist/preload/index.js` só tem `require("electron")`.
- **Enter é `\r`.** O PowerShell sob ConPTY só executa a linha com `\r`; em Linux o tty converte. Todo teste de PTY real manda `\r`.
- **Eco sob ConPTY: use `hasEchoOutput`, não `hasStandaloneLine`.** O ConPTY repinta a tela com movimentos de cursor, e às vezes o prompt cai colado logo depois do texto ecoado. O `hasStandaloneLine` falha nisso de forma intermitente, só no Windows (`66a73e7`, `78a1804`).
- **O daemon renumera as sessões a partir de 1 a cada início.** Tudo que guarda `sessionId` entre execuções ou conexões casa por `id` + `createdAt` (layout da M4.3, enterro da M4.5).
- **Container Linux (sessão na nuvem).** Os 3 testes antigos que abrem PTY real com `powershell.exe` fixo (`session`, `service` "real PTY end to end", `cli`) falham em Linux, na base também. Os testes de PTY novos escolhem o shell pela plataforma e rodam nos dois lugares. O rename com `EPERM` do NTFS também não se reproduz em Linux.
- **O relatório do subagente erra.** No M4, três prompts do coordenador tinham premissas erradas sobre o código, e um relatório descreveu um visual que o screenshot desmentia. Abra os PNGs, refaça uma mutação, confira a afirmação que decide a tarefa.

## Pendências conhecidas, registradas nos commits

- **Causa raiz do daemon zumbi.** O processo sai de qualquer jeito (`3f2dfb3`), mas não se sabe qual handle do `node-pty`/ConPTY segura o event loop.
- **Painel estreito.** Com menos de ~150px, os botões do cabeçalho ficam cortados.
- **Botões da barra de abas.** Os ícones do `.tabbar-right` do protótipo não foram feitos. Adiados pelo dono no fechamento do M3.
- **Perfis de shell configuráveis** (`config.json`) e o **TTL do cemitério** vindo da configuração: o `config.json` ainda não chega ao renderer.
- **Enterro depende da sidebar montada** (M4.5). Se ela puder ser escondida, o observador tem que sair do React.
- **Cada ciclo enterrar/restaurar** soma uma assinatura de `onExit` na sessão (M4.4). Vazamento pequeno num daemon de vida longa.
- **Duas janelas no mesmo processo** gravam o mesmo `workspaces.json`, e a última vence.
