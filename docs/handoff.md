# Retomada do desenvolvimento

Estado em 2026-09-26, escrito para quem assumir a coordenação em outra sessão ou máquina. Leia antes `CLAUDE.md` e `.claude/rules/agent-workflow.md`. O processo (coordenador que escreve spec, verifica e commita; subagente Sonnet que implementa, no máximo 2 em paralelo) está todo ali, com os casos reais que o justificam.

## Onde as coisas estão

| Branch | Conteúdo | Estado |
|---|---|---|
| `main` | M0, M1 e M2 mergeados | CI verde. Gate do M2 fechado pelo dono em 24/09 |
| `m3-tabs-splits` | M3.1 a M3.5 e três correções, **tudo verificado** | CI verde. PR #2 em draft |
| `wip/m3.6-e-retry-rename` | Trabalho **não verificado**, interrompido no meio (abaixo) | Não mergear sem verificar |

## O que falta no M3

### M3.6: arrastar abas e painéis (na branch `wip/`)

O agente foi interrompido logo depois de o typecheck passar. Está implementado: `pane-drag.ts`, `tab-drag.ts` e os testes deles, mais mudanças em `TabBar.tsx`, `PaneHeader.tsx`, `SplitTree.tsx` e nos `.css`. **Falta:** lint, format, os testes vistos falhando com a lógica quebrada, e a prova do gate do M3 em Electron real. O prompt original pedia:

- 4 sessões em 2×2 com conteúdo distinto; arrastar a divisória; mover um painel para a borda de outro; reordenar abas; trocar de aba;
- no fim, cada painel com o próprio conteúdo e a contagem de `session.attach` igual ao número de sessões;
- o drag sintético do HTML5 pode não disparar na automação. Nesse caso, o movimento é feito pela store, e o gesto fica declarado para o teste manual do dono.

Para retomar: ou reverifica o que está na `wip/` e completa, ou dispara um subagente novo com o mesmo escopo, partindo do código da `wip/`.

### Correção do retry do `rename` do `daemon.json` (na branch `wip/`)

O teste 5 de `packages/daemon/src/daemon.test.ts` (escrita atômica) passa isolado e falha às vezes no suite completo, sob carga. A pausa fixa de 30ms dos leitores (`d302f7b`) era empírica e frágil. A decisão tomada:

- em **produção**, `renameWithRetry` com backoff exponencial e jitter, e orçamento total de 3 a 5 segundos, em vez dos 400ms fixos. No Windows, o antivírus pode segurar um arquivo recém-escrito por mais tempo que isso;
- no **teste**, pausa dos leitores com jitter.

Está implementado na `wip/` (`daemon.ts` e `daemon.test.ts`). **Falta:** provar a estabilidade (suite completo 5 vezes seguidas e o teste isolado 10 vezes), mostrar o teste ainda falhando com uma escrita direta no destino, e o teste unitário do retry com o `rename` injetado.

### Fechar o M3

Depois das duas acima, o gate é teste manual do dono: 4 agentes (`claude` de verdade) em grade 2×2, divisórias arrastáveis, troca de aba sem perder scrollback. Com o ok dele: tirar o PR #2 do draft, merge `--no-ff` na `main`, confirmar o CI na `main`.

## Depois: M4

8 tarefas em `docs/milestones.md`. Três já têm pendência herdada:

- **M4.6** (perfis de shell): toda sessão nova nasce com `powershell.exe` em `C:\`, fixos. O renderer em sandbox não enxerga PATH nem a home.
- **M4.4** (cemitério): fechar painel ou aba deixa a sessão viva e invisível no daemon, de propósito. O cemitério é quem cuida dela.
- **M4.3** (persistência de layout): hoje o layout é reconstruído a cada boot, com todas as sessões vivas num workspace padrão.

A M4.1 é ⬥ e precisa de techspec antes de disparar.

## Armadilhas que custaram caro, e que continuam valendo

- **Typecheck do zero.** `npx tsc --build --clean` antes do `npm run typecheck`. O cache incremental já escondeu um CI vermelho.
- **Isolamento do daemon nas provas manuais.** `APPDATA` **e** `TERMHUB_PIPE_SUFFIX` próprios, os dois. Só o `APPDATA` não isola nada, porque o nome do pipe vem do usuário.
- **Nunca matar daemon sem conferir o PID contra o `daemon.json`, e nunca matar o do dono.** Um agente já chamou o daemon do dono de "órfão de teste".
- **O `@termhub/ui` recebe a ponte por prop.** Nunca lê `window.termhub`.
- **Os terminais vivem no registro** (`terminal-registry.ts`, M3.5), fora da árvore do React. Qualquer layout novo usa `TerminalSlot`; nunca monte xterm dentro de componente de layout. O motivo está em `docs/specs/m3.5-terminal-lifecycle.md`, seção 2.
- **Uma sessão por folha.** O segundo terminal da mesma sessão não recebe snapshot (spec da M2.6, seção 6).

## Pendências conhecidas, registradas nos commits

- **Causa raiz do daemon zumbi.** O processo agora sai de qualquer jeito (`3f2dfb3`), mas não se sabe qual handle do `node-pty`/ConPTY segura o event loop depois que uma sessão sai sozinha. Pode reaparecer como vazamento num daemon de vida longa.
- **Painel estreito.** Com menos de ~150px de largura, os botões do cabeçalho ficam cortados.
- **Botões da barra de abas.** Os ícones do `.tabbar-right` do protótipo (dividir e grade) não foram feitos.
