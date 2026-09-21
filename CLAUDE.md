# CLAUDE.md

Instruções para agentes (Claude ou outros) que forem trabalhar neste repositório.

## O projeto

TermHub é um app desktop (Electron) que hospeda múltiplos terminais de agentes de IA em abas/splits, com um daemon separado que é dono dos PTYs — fechar a janela não mata os agentes. Antes de tocar em qualquer código, leia:

- `docs/plan.md` — fonte da verdade de arquitetura e decisões técnicas. Qualquer dúvida sobre "como isso deveria funcionar" se resolve ali antes de inventar uma solução nova.
- `docs/milestones.md` — backlog de tarefas, dependências e critério de aceite de cada uma.
- `prototype.html` (raiz) — referência visual **obrigatória** para qualquer tarefa de UI. A UI final tem que bater com ele; não é inspiração, é especificação visual aprovada. Não existe "ficha visual" alternativa.

## Stack

Electron + TypeScript + React + xterm.js (`@xterm/xterm`, `@xterm/headless`) + `node-pty`, organizados em npm workspaces (`packages/shared`, `packages/daemon`, `packages/app`, `packages/ui`). Build com `electron-vite`. Testes com Vitest (unit e integração); E2E com `@playwright/test` quando existir (M7).

## Idioma

- Código, nomes de arquivo, identificadores (variáveis, funções, tipos, branches de git) e comentários no código: **inglês**.
- Documentação em `docs/`, mensagens de commit e descrições de PR: **português**.
- Não misture os dois dentro do mesmo artefato — um arquivo `.ts` não leva comentário em português, e um `.md` em `docs/` não é escrito em inglês.

## TypeScript e lint

Regras próprias, em arquivo separado: versão do compilador (preso em 6.x de propósito), as regras de lint que não se desliga, estilo de tipagem, e o que fazer quando o lint barrar sua tarefa.

@.claude/rules/typescript-rules.md

## Testes

- Teste junto do código: `foo.ts` testado por `foo.test.ts` no mesmo diretório, não em uma árvore `__tests__/` separada.
- Toda tarefa que cria lógica nova (parser, reducer, protocolo, detector de estado, etc.) cria o teste junto. Tarefa sem teste só é aceitável quando é puramente visual (ver `docs/milestones.md`).
- Preste atenção especial ao caso de borda que o teste ingênuo não cobre — streams partidos entre chunks, corrida entre desanexar/reanexar, arquivo corrompido no boot. Essas são exatamente as situações que as techspecs em `docs/specs/` (quando existirem para a tarefa) descrevem; se a tarefa aponta para uma techspec, ela é normativa, não sugestão.

## Escopo

Cada tarefa tem fronteira de arquivo definida (ver `docs/milestones.md`). Não edite arquivos que pertencem a outra tarefa em paralelo, mesmo que pareça mais eficiente resolver ali. Se no meio do trabalho você perceber que o escopo pedido está incompleto, ambíguo, ou exige mudar algo fora da fronteira: **não pare para resolver isso na hora e não decida sozinho por conta própria**. Termine o que dá para terminar dentro do escopo original, e reporte a divergência no final da entrega — o que encontrou, por que não resolveu ali, e o que isso implica para outra tarefa.

## Outras convenções

- Não crie arquivos de documentação (`.md`) fora de `docs/` ou fora do que a tarefa pediu explicitamente (README, CLAUDE.md, techspecs em `docs/specs/`).
- `.gitattributes` já normaliza finais de linha (`* text=auto eol=lf`, com exceções para `.bat`/`.cmd`/`.ps1`). Não gere arquivos com CRLF manualmente nem adicione BOM — em especial cuidado ao editar com PowerShell, que adiciona BOM por padrão em alguns cmdlets (`Out-File`, `Set-Content`); prefira ferramentas que escrevam UTF-8 sem BOM.
- Windows é a plataforma primária (é a dor que o projeto resolve), mas o código não deve cravar nada Windows-only na arquitetura sem necessidade — ver seção de riscos em `docs/plan.md`.
