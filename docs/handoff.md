# Retomada do desenvolvimento

Estado em 2026-09-26, escrito para quem assumir a coordenação em outra sessão ou máquina. Leia antes `CLAUDE.md` e `.claude/rules/agent-workflow.md`. O processo (coordenador que escreve spec, verifica e commita; subagente Sonnet que implementa, no máximo 2 em paralelo) está todo ali, com os casos reais que o justificam.

## Onde as coisas estão

| Branch | Conteúdo | Estado |
|---|---|---|
| `main` | M0, M1 e M2 mergeados | CI verde. Gate do M2 fechado pelo dono em 24/09 |
| `m3-tabs-splits` | M3.1 a M3.6 e quatro correções, **tudo verificado** | Gate do M3 aprovado pelo dono em 26/09. Mergeada na `main` pelo PR #2 |

A branch `wip/m3.6-e-retry-rename` foi desmontada em dois commits verificados, um por tarefa: `cf706fb` (retry do rename) e `6ed3c0f` (M3.6). O que ficou provado e o que não ficou está na mensagem de cada um.

## Onde o M3 está

O código do M3 está completo. A M3.6 foi exercitada num Chromium real, com os componentes montados numa ponte falsa, e os gestos nativos de drag funcionaram: divisória, painel solto na borda de outro, reordenação de abas e troca de aba. No fim, cada painel tinha o próprio conteúdo, e cada sessão teve um `session.attach` só. **Não** foi provada em Electron real com daemon: a sessão de retomada rodou num container Linux, sem o binário do Electron, e toda sessão nova nasce em `powershell.exe` fixo (M4.6).

O protótipo chegou depois dos commits da M3.6. Ele não desenha drag, então o realce da zona de soltura e o indicador de inserção da aba não conflitam com ele: os dois usam o `--accent-hi`.

### Gate e divergência adiada

O dono rodou o gate no Windows e aprovou em 26/09. Uma divergência com o protótipo ficou adiada por decisão dele: os três botões do `.tabbar-right` (dividir na vertical, dividir na horizontal, grade 2×2) não existem. O aceite da M3.3 pedia visual idêntico ao protótipo, então isso é dívida do M3, e ainda não tem tarefa dona.

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
- **Container Linux (sessão na nuvem).** Os 3 testes que abrem PTY real (`session`, `service`, `cli`) exigem `powershell.exe` e falham em Linux, na base também. Quem os roda é o CI em Windows. O rename do `daemon.json` também nunca falha com `EPERM` em Linux, então flake de NTFS não se reproduz aqui.
- **Uma sessão por folha.** O segundo terminal da mesma sessão não recebe snapshot (spec da M2.6, seção 6).

## Pendências conhecidas, registradas nos commits

- **Causa raiz do daemon zumbi.** O processo agora sai de qualquer jeito (`3f2dfb3`), mas não se sabe qual handle do `node-pty`/ConPTY segura o event loop depois que uma sessão sai sozinha. Pode reaparecer como vazamento num daemon de vida longa.
- **Painel estreito.** Com menos de ~150px de largura, os botões do cabeçalho ficam cortados.
- **Botões da barra de abas.** Os ícones do `.tabbar-right` do protótipo (dividir e grade) não foram feitos. Adiados pelo dono no fechamento do M3, sem tarefa dona ainda.
