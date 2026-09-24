# Como este projeto é construído por agentes

Regras de processo, descobertas executando os milestones M0 a M2. Quem coordena tarefas neste repo segue isto.

O papel se divide: **um coordenador** (modelo forte) decide, escreve techspec, verifica e commita; **subagentes** (Sonnet) implementam uma tarefa cada, no máximo 2 em paralelo. Ver `docs/milestones.md`.

## Subagente não roda git

Nenhum comando git de escrita: nada de `add`, `commit`, `branch`, `checkout`. Leitura (`status`, `diff`, `log`, `check-attr`) é livre.

Dois agentes na mesma árvore com `git add -A` disputam o índice, e um commita o trabalho pela metade do outro. Já quase aconteceu: na M1.1 o agente viu `tsconfig.json` e `package-lock.json` modificados sem ter tocado neles — era a M1.3 instalando `node-pty` em paralelo. Ele reportou em vez de commitar.

O coordenador commita, staging por caminho (`git add packages/shared`), nunca `-A`, enquanto houver tarefa paralela em voo.

## Nunca commite em cima do relatório

O relatório do agente é uma alegação, não evidência. Verifique por fora antes de commitar. Isto não é desconfiança do modelo — é que o relatório é escrito por quem tem interesse em ter terminado.

Casos reais deste repo:

- A M0.4 entregou `npm run lint` verde. O lint estava configurado para **ignorar todos os arquivos `.ts`**. Verde legítimo, cobertura zero.
- A M1.3 afirmou que o TypeScript 7 era o `latest` e fixou a versão do projeto inteiro nele. Estava certo — mas se estivesse errado, o custo apareceria três tarefas adiante.
- A M2.1 afirmou que o bundle do daemon era byte-idêntico entre dev e build. Confirmado conferindo o tamanho do artefato.

Verifique o que **decide** a tarefa, não tudo. Em geral: rode os cinco comandos, leia o teste que sustenta o aceite principal, e confirme uma afirmação factual que o agente tenha feito sobre o mundo externo (versão de pacote, comportamento de biblioteca, tamanho de artefato).

## Verde só conta se souber ficar vermelho

Para qualquer tarefa que **configura** algo — lint, formatador, CI, cobertura — o aceite não é "o comando passa". É:

> introduza uma violação real, mostre a ferramenta acusando **pelo nome da regra**, remova, mostre o verde voltar.

Uma configuração que não enxerga nenhum arquivo passa em todos os comandos. Foi exatamente o buraco da M0.4, e a M0.4b nasceu só para fechá-lo.

Mesma lógica para código que roda só em outra plataforma: a M1.8 corrigiu um caminho que **não executa no Windows**. A função ganhou `platform` como parâmetro injetável para o teste forçar `linux` e a linha corrigida rodar de verdade. Teste que passa sem executar o que corrige não prova nada — e, se não der para exercitar no ambiente, **declare a lacuna** em vez de entregar um teste decorativo.

## Techspec autoriza o mecanismo, não só o comportamento

Toda exigência de comportamento numa techspec precisa vir com a autorização do que a dispara, **conferida contra a superfície pública real do código**, não contra a lembrança dela.

Errado duas vezes no M1:

- a M1.5 recebeu ordem de trocar a entrada de teclado para frame binário, e proibição de editar o transporte — que descartava frame binário de cliente por design antigo;
- a M1.7 recebeu ordem de limpar clientes anexados no disconnect, e o transporte não expunha nenhum hook de conexão fechada. A limpeza ficou implementada, testada e **sem chamador**.

Nas duas o agente parou e reportou. Antes de escrever a autorização, liste os métodos públicos que a tarefa vai precisar chamar e confirme que existem.

## Reportar bloqueio é sucesso

Diga isso no prompt, com precedente. A saída natural de um modelo preso é afrouxar a restrição — desligar a regra, baixar a versão, editar o arquivo proibido — e entregar verde.

A regra em `typescript-rules.md` ("entregue o que der, deixe o resto intacto e reporte") foi escrita para lint e generalizou para decisões estruturais. Mantenha-a citada nos prompts.

## Paralelismo é limitado por npm, não pelo teto de custo

Duas tarefas em paralelo **nunca** podem ambas rodar `npm install`. O lockfile não é seguro sob concorrência: as duas escritas disputam e o arquivo pode sair corrompido.

Antes de formar um par, confirme: conjuntos de arquivos disjuntos **e** no máximo uma instalando dependência. Foi por isso que M0.3 e M0.4 foram sequenciais apesar de independentes.

## Escrever a techspec encontra bugs

Três vezes, escrever a spec de uma tarefa achou problema que nenhum teste tinha achado — porque exige ler o código de que a tarefa **depende**, e não o que ela produz:

- **M1.7**: a assincronia do `serialize()` permitia um chunk existir no snapshot e na fila ao mesmo tempo, de forma não-determinística.
- **M1.8**: `removeStaleSocketFile` apagava o socket de um daemon vivo fora do Windows, fazendo o lock falhar em silêncio.
- **M2.1**: o entrypoint do daemon é TypeScript e o Electron não executa TypeScript — decisão de empacotamento que só apareceria no M7.

Nenhum era culpa de quem escreveu o código: a dependência não estava no escopo daquela tarefa. Só fica visível quando alguém precisa dela.

## Prompt de tarefa: o que não pode faltar

1. O que ler primeiro, em ordem, **incluindo a techspec quando houver** e a observação de que ela é normativa.
2. A entrega, concreta.
3. **O aceite como prova**, não como descrição: o que o agente tem que _mostrar_, não o que tem que _fazer_.
4. As armadilhas conhecidas desta tarefa, nomeadas. Se a spec explica por que a solução óbvia é errada, aponte a seção — senão o modelo "simplifica de volta" para o bug.
5. As fronteiras de arquivo, e a instrução de parar e reportar ao bater nelas.
6. Proibição de comandos git de escrita.
7. Pedido explícito de crítica à spec, quando houver uma. As três primeiras tinham furo, e quem descobre é quem tenta executá-la.

## Decisões que não são da tarefa

Toolchain (versão de compilador, troca de ferramenta, relaxar strictness), protocolo, e qualquer coisa destrutiva para o usuário. O agente reporta; o coordenador decide, e às vezes o dono do projeto.

Exemplo: a política de **nunca matar o daemon** (`docs/specs/m2.1-daemon-client.md`, seção 2) é decisão do dono, com teste dedicado espiando `process.kill` para travá-la contra um refactor bem-intencionado.

## Commit

Um por tarefa, mensagem em português, explicando **por que** e não só o quê — em especial o modo de falha que a decisão evita. Uma lacuna conhecida vai escrita na mensagem, como na M0.4.

Ao fechar um milestone, merge na `main` com `--no-ff` e confirme o CI verde antes de seguir.
