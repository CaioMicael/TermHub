# Regras de TypeScript e lint

Regras obrigatórias para qualquer agente ou contribuidor que mexa em código deste repo.

## O TypeScript está preso em 6.x de propósito

**Não suba o TypeScript para 7.x.** Não é dívida técnica esquecida, é uma escolha com motivo.

O TypeScript 7 é o compilador reescrito em nativo. Com ele, o pacote npm `typescript` passou a exportar **apenas** `version` e `versionMajorMinor` — a API JS clássica do compilador (`createProgram`, `createSourceFile`, `SyntaxKind`) **não existe mais no pacote**. Qualquer ferramenta que parseia TypeScript por essa API para de funcionar.

É o caso do `typescript-eslint`: ele recusa TS 7 com um guard explícito, e o `peerDependencies.typescript` dele é `>=4.8.4 <6.1.0`. Instalar TS 7 junto quebra o `npm install` com `ERESOLVE`.

Consequência prática, e é aqui que mora a armadilha: o `typescript-eslint` **não falha em silêncio** com TS 7. Ele lança um erro duro (`typescript-eslint does not support TS 7.0.`) que derruba a execução inteira do `eslint .` assim que o parser encosta no primeiro `.ts`.

O perigo não é a ferramenta, é o contorno. A saída óbvia pra "fazer o lint voltar a passar" é jogar `ignores: ['**/*.ts', '**/*.tsx']` na config — e aí o `eslint .` fica verde **lintando zero arquivo TypeScript**. Foi exatamente isso que aconteceu neste repo uma vez: comando verde, cobertura zero.

**Quando reconsiderar:** quando o `typescript-eslint` passar a suportar TS >= 7.1. A mensagem de erro do próprio typescript-eslint aponta a issue #10940 como rastreamento. Até lá, `typescript` fica em `^6.0.3`.

## Regras de lint que não se desliga

Estas quatro existem porque o projeto é cheio de assincronia e corrida — daemon com PTYs, attach/detach de sessão, streams sendo multiplexados. São regras **type-aware**: só funcionam com o typescript-eslint ligado ao tsconfig, e são o motivo de termos aberto mão do compilador nativo.

- `@typescript-eslint/no-floating-promises`
- `@typescript-eslint/no-misused-promises`
- `@typescript-eslint/await-thenable`
- `@typescript-eslint/no-explicit-any`

Promise solta é exatamente a classe de bug que as techspecs em `docs/specs/` existem para evitar. Ter o linter pegando isso em toda tarefa vale mais que velocidade de compilação.

## Se o lint ou o typecheck barrar sua tarefa

Não resolva desligando.

Proibido, sem exceção: baixar a versão do TypeScript, relaxar flag de strictness no `tsconfig.base.json`, desativar regra no `eslint.config.mjs`, espalhar `eslint-disable` pra fechar a tarefa, ou trocar a ferramenta por outra.

O caminho é: entregue o que der dentro do escopo, deixe o resto intacto e **reporte o bloqueio no fim** com a saída do erro. A decisão de mexer em toolchain é do dono do projeto, não da tarefa.

Exceção única do `any`: é permitido com um comentário na linha explicando por que é inevitável (ex.: `// any: os tipos do node-pty não cobrem este callback`). Sem o comentário, é erro.

## Estilo de tipagem

- `strict: true` vale no monorepo inteiro, via `tsconfig.base.json`. Não relaxe flag de strictness num pacote específico pra destravar uma tarefa.
- Prefira `unknown` + narrowing, generics, ou o tipo real quando ele existir.
- Evite type assertion (`as`) como atalho pra calar o compilador. Se for mesmo necessária, comente o motivo na linha.

## Provar que o lint funciona

Toda tarefa que **configura** lint tem que provar que a configuração enxerga os arquivos, não só que o comando passa.

A prova é: introduza temporariamente uma violação real (um `any` explícito e uma promise solta num `.ts`), rode o lint e mostre a saída **com o nome da regra** apontando cada uma; depois remova e mostre o verde voltando.

Comando que passa não é evidência — uma config que ignora todos os arquivos passa também.
