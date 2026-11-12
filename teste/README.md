# teste — suíte do servidor `chili3d`

Testa `chili3d/servidor.mjs` **sem Docker e sem rede**: o servidor real sobe como
processo filho, com um relay falso do outro lado. O que ele prova é o que o build
da imagem não prova — que o app serve, que o `/v1/` encaminha, e que o proxy não
é o que causa o "Connection error." que ele existe para resolver.

```
node teste/rodar.mjs        # entrada única; saída não-zero em qualquer falha
```

Leva ~15 s. Depende só de Node 20+ (usa `fetch` global e `response.body`).

## Três etapas, e a terceira é a que dá valor às duas primeiras

1. `estático` — o Chili3D servido como vem: index, tipos de conteúdo (o `.wasm`
   com `application/wasm` errado não sobe o app, e o sintoma não aponta para o
   servidor), rotas de SPA, 404 de asset, travessia de diretório;
2. `proxy` — o `/v1/`: o pedido do assistente atravessa, a resposta de SSE chega
   como stream, o relay não recebe `origin`, `authorization` chega intacto, o
   preflight é respondido por nós, e sem `RELAY_URL` o despejo falha alto;
3. **teste de mutação** — ver abaixo.

## Por que o código testado é o real, e não uma cópia

Os cenários sobem `chili3d/servidor.mjs` como processo filho. Um teste com o
código copiado à mão passaria verde muito tempo depois de o código mudar — o pior
tipo de teste, porque ele não falha: ele mente. Se o servidor mudar de forma, os
cenários passam a falhar por falta de socket, e não com um verde enganoso.

O que é mockado é o mundo do outro lado: o relay falso (`subirRelay`, em
`comum.mjs`) **anota** cada pedido que recebeu, e é assim que se prova que
`origin` não é repassado e que `authorization` é.

## O teste de mutação, que é o que dá valor ao resto

Um verde sozinho não significa nada: uma suíte que passa no código certo **e** no
código quebrado não testa nada. Por isso a terceira etapa introduz defeitos de
propósito e exige que a suíte acuse — e exige que acuse **exatamente** os
cenários previstos, nem mais nem menos.

| mutação | espera que quebre | por que esse defeito importa |
|---|---|---|
| `origin` repassado | `relay-nao-recebe-origin` | o relay exigiria chave por causa da origem — o sintoma original com outro nome |
| preflight repassado | `preflight-nao-repassado`, `preflight-acah`, `preflight-acam` | o relay responde 401 seco: foi assim que o sintoma nasceu |
| sem fallback de SPA | `rota-sem-extensao-devolve-index`, `rota-profunda-devolve-index` | atualizar a página numa rota interna do app daria 404 |
| resposta bufferizada | `primeiro-bloco-nao-bufferizado` | cada token do assistente só chegaria no fim |
| sem CORS na resposta | `resposta-proxy-tem-acao` | apontar o assistente para outro host voltaria a ser barrado |
| sem saneamento de caminho | `travessia-barrada-1..3` | `..%2f` lê arquivo fora do `dist` |

Uma mutação que não se aplica ao fonte ("não pegou") é falha, não silêncio — uma
mutação que não pega produziria um verde que não significa nada.

## Duas armadilhas que esta suíte já pegou

As duas estão documentadas no fonte dos cenários, porque foram medidas e não
supostas:

- **`origin` explícito no pedido.** Medido: o `fetch` do Node não põe `Origin`
  sozinho. Sem a linha que força o cabeçalho, `relay-nao-recebe-origin` passaria
  verde com o proxy repassando tidy o que nunca veio. É o oposto do navegador
  real, onde o Chrome sempre carrega `Origin` em pedido cruzado.
- **o relógio começa ANTES do `fetch`.** Medir o primeiro byte a partir da
  resposta pronta não mede nada: o `await fetch` só resolve quando os cabeçalhos
  chegam, e num proxy que bufferiza os cabeçalhos só são escritos no fim.

E uma terceira, que decidiu a lista de caminhos de travessia:

- **o cliente normaliza parte dos ataques.** `/%2e%2e/` chega ao servidor como
  `/segredo.txt` — inofensivo. E `/..%2f..%2fsegredo.txt`, medido contra o
  servidor com a proteção removida, dá 404: sobe dois níveis e aponta para /tmp.
  Só entraram no teste caminhos que, medidos, furam com a proteção fora.

## Para rodar contra outra revisão

```
TESTE_SERVIDOR=/caminho/para/servidor.mjs node teste/rodar.mjs
```

Foi assim que as mutações foram validadas: cada uma aponta para uma cópia, e a
suíte tem de falhar nos cenários previstos.

## O que esta suíte NÃO cobre

- o app de fato abrindo no navegador — isso é verificação pós-deploy;
- o relay real (9router) e a chave do usuário: o relay daqui é falso, de
  propósito. A última milha — assistente apontado, chave colada, modelo
  respondendo — só se mede em deploy, com chave válida;
- o build da imagem (o Dockerfile) e o healthcheck do Docker.
