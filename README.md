# 3D Agent Colab

> O Chili3D original, empacotado num container, com o assistente de IA nativo funcionando contra o relay local.

![CI](https://github.com/Brook-sys/3d-agent-colab/actions/workflows/imagens.yml/badge.svg)
![imagens](https://img.shields.io/badge/GHCR-ghcr.io%2Fbrook--sys%2Fchili3d-2496ED?logo=docker&logoColor=white)
![status](https://img.shields.io/badge/status-prot%C3%B3tipo-orange)
![app](https://img.shields.io/badge/app-Chili3D%20AGPL--3.0-blueviolet)

---

## O que é

Um container, uma imagem: o **Chili3D** servido tal qual vem do commit fixado em
[`chili3d.ref`](chili3d.ref), mais um único adicional — um processo Node que
encaminha `/v1/*` para o relay de IA local.

Esse adicional existe por um motivo medido, não por preferência: o assistente
nativo do Chili3D, apontado direto para os modelos do relay, respondia
**"Erro: Connection error."** para qualquer pedido. A causa é CORS no relay, e a
cadeia completa está em [docs/assistente-relay.md](docs/assistente-relay.md) —
com a reprodução em navegador real e o controle que separa as hipóteses.

```
   ┌──────────────────────────────────────────────┐
   │  chili3d  (node:20-bookworm-slim)            │
   │                                              │
   │  · serve o app (estático, SPA)        :8080   │
   │  · encaminha /v1/* → relay de IA              │
   │  · responde o preflight de /v1/ (204)         │
   └───────────────────┬──────────────────────────┘
                       │  rede aiNetwork (externa)
                       ▼
              ┌─────────────────┐
              │  relay de IA    │
              │  9router :20128 │
              └─────────────────┘
```

O pedido do assistente sai da **mesma origem** da página. Por isso não existe
preflight nenhum no caminho, e por isso nada é barrado.

## Começo rápido

O deploy é pelo Portainer: a stack aponta para `ghcr.io/brook-sys/chili3d:main` e
o host Docker só faz o pull. Nada de toolchain, nada de Node, nada de Python na
máquina.

Para conferir que subiu:

```sh
curl -s http://SEU-HOST:8080/healthz          # {"ok":true,"servico":"chili3d","relay":"..."}
curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://SEU-HOST:8080/v1/chat/completions
# 204 — o preflight é respondido por nós, não repassado ao relay
```

Para usar o assistente: abra o app, cole a chave do relay na interface (ela fica
na memória do navegador e evapora a cada recarregamento — é decisão do Chili3D,
não deste repo) e configure o **provedor OpenAI-compatível** com a URL Base
`http://SEU-HOST:8080/v1` — **com `/v1`**, apontando para a própria origem.

O `/v1` na URL não é o do relay, e confundir os dois já custeu uma tentativa: o
SDK da OpenAI cola `/chat/completions` no baseURL (`completions.ts`:
`this._client.post('/chat/completions')`), então a URL que o usuário digita
**precisa** terminar em `/v1` para o pedido sair como `/v1/chat/completions` —
que é o caminho que este servidor intercepta. Sem o `/v1`, o pedido bate em
`/chat/completions`, cai no fallback de SPA e devolve o index.html: o SDK recebe
HTML onde esperava JSON e estoura com "Connection error." de novo.

Provedor **Anthropic** é outro dialeto: aquele SDK bate em `{baseURL}/v1/messages`
(`anthropic.ts`), e a URL Base precisa ficar **sem** `/v1`. O relay local é
OpenAI-compatível — use o provedor padrão.

## Configuração

| variável | default | o que é |
|---|---|---|
| `PORTA_APP` | `8080` | porta publicada no host. Parametrizada porque durante a troca da stack antiga pela nova as duas coexistem e a 8080 fica ocupada |
| `RELAY_URL` | `http://9router:20128` | raiz do relay, **sem `/v1`**. O default é o alias do relay na rede `aiNetwork` |
| `CORS_ORIGEM` | `*` | origem devolvida nos cabeçalhos CORS deste servidor |
| `PORT` | `8080` | porta em que o processo escuta **dentro** do container |

A rede `aiNetwork` é declarada `external` no compose: ela é criada pela stack do
relay. Entrar nela é o que permite falar com o relay pelo nome.

## Estrutura

```
chili3d/     Dockerfile + servidor.mjs (estático + proxy /v1/)
teste/       suíte do servidor, com teste de mutação
deploy/      ciclo curto: build local com os mesmos Dockerfiles
docs/        assistente-relay.md — o diagnóstico completo
chili3d.ref  commit do Chili3D compilado na imagem
```

## Testes

```sh
node teste/rodar.mjs
```

Leva ~15 s, sem Docker e sem rede: o servidor real sobe como processo filho, com
um relay falso do outro lado. Além das suítes, a terceira etapa **introduz
defeitos de propósito** e exige que a suíte acuse, exatamente nos cenários
previstos — foi assim que dois cenários vacuosos foram pegos antes de ir para
produção. Os detalhes estão em [teste/README.md](teste/README.md).

## Limitações conhecidas

Este repositório é um **protótipo**. As fragilidades são reais, não teóricas:

- **A última milha não foi medida.** A suíte usa um relay falso. O teste com
  **chave válida e modelo real** — assistente apontado, chave colada, modelo
  respondendo — só se faz em deploy, e não foi feito. Até ser feito, a correção
  está provada até a borda do navegador, e não além dela.
- **Sem autenticação em lugar nenhum.** Quem alcança a porta 8080 alcança o relay
  pela nossa origem, sem barreira de CORS no caminho. Queimar cota do relay não
  exige chave de ninguém — mas usar um **modelo** exige a chave, e ela não está
  no servidor.
- **Sem limite de taxa.** Existem teto de corpo (1 MB) e tempo de espera do relay
  (60 s), e ambos são recusas claras — mas nada impede uma enxurrada de pedidos
  pequenos e legítimos. Quem alcança a porta 8080 dispara contra o relay à
  vontade; a única trava é a chave, que só o usuário tem.
- **O proxy não filtra caminhos.** `/v1/*` vai integralmente para o relay, o que
  for pedido. Num relay OpenAI-compatível isso é a API toda; se o relay tiver
  rota sensível sob `/v1/`, ela fica alcançável por quem alcança o container.
- **Sem volume.** O container é stateless e o estado do documento vive na RAM do
  navegador: recarregar perde a geometria não salva. É cache, não memória durável.
- **A chave evapora a cada F5.** `settings.ts` do pacote `ai` do Chili3D guarda a
  chave em memória. É decisão do app, não deste repo — mas significa que o
  assistente precisa da chave de novo depois de qualquer recarga.
- **`/healthz` não testa o relay.** Ele diz que o servidor está de pé, não que o
  relay responde. Conferir o relay é verificação pós-deploy.

## Licenças

O app servido pela imagem é o **Chili3D**, **AGPL-3.0**
(`xiangechen/chili3d`, commit fixado em [`chili3d.ref`](chili3d.ref)); ele é
compilado do fonte a cada build, e o fonte correspondente continua público no
repositório oficial — que é a obrigação da licença.

O código **deste** repositório (`chili3d/servidor.mjs`, `teste/`) não tem licença
declarada — escolha em aberto, não esquecimento: sem `LICENSE`, o padrão legal é
"todos os direitos reservados".

## Contribuindo

Commits no formato `<emoji> <tipo>: <descrição>` (`✨ feat` · `🐛 fix` ·
`♻️ refactor` · `📝 docs` · `🔧 chore`). O caminho oficial de mudança é
**commit + CI**: o Portainer só faz pull. Para iterar sem CI, existe o ciclo
curto em [`deploy/`](deploy/) — build local com os mesmos Dockerfiles.

Se você vai pedir trabalho a um agente de IA neste repositório, comece por
[AGENTS.md](AGENTS.md): ele descreve o protocolo de colaboração, as regras que
não se quebram e o que conferir antes de publicar.
