# Arquitetura

Dois containers, um processo cada, uma rede. Duas escolhas definem o resto: **o núcleo também serve o app** e **faz o proxy do relay de IA**.

```
                          ┌──────────────────────────────────────────────┐
                          │  host Docker                                 │
                          │                                              │
  navegador do usuário    │   ┌───────────────────────┐   ┌───────────────┴──────┐
  http://SEU-HOST:8080 ───┼──▶│ core                 │   │ session              │
        (app + chat IA)   │   │ FastAPI + MCP (13)   │◀─▶│ ponte WS :17373       │
                          │   │ registro /parts      │   │ relay HTTP :17400     │
  cliente MCP             │   │ portal FDM           │   │ kiosk Chromium        │
  http://SEU-HOST:9001 ───┼──▶│ estático (app)       │   │ companheiro CDP       │
        (13 ferramentas)  │   └───────┬──────────────┘   └───────────────┬──────┘
                          │           │ binds                            │ binds
                          │   /opt/3d-agent-colab/parts        /opt/3d-agent-colab/session
                          │           │                                  │
                          │           ▼                                  ▼
                          │   registro + .git + v000N/      capturas .step, perfil
                          │                                 Chromium, pedidos
                          └──────────────────────────────────────────────┘
                                            ▲
                    ws://127.0.0.1:17373 ◀──┘   a PÁGINA é o cliente; a ponte é o servidor
                    (só quando a URL traz ?bridge=)
```

A linha de baixo é a que costuma surpreender: **a página do Chili3D é o cliente WebSocket**. Uma aba não pode escutar, então a conexão é de saída, para um processo local. O `?bridge=` é o que pede essa conexão — e só isso. O assistente de IA **não** depende dele: o `ChatPanel` entra por import estático no `editor.ts` do `@chili3d/ui` e já está no bundle (medido, veja [uso com IA](uso-chili3d-ia.md)).

---

## Portas e rede

| serviço | porta no container | publicada no host | por quê |
|---|---|---|---|
| `core` | 9001 | `8080:9001` (app) e `9001:9001` (REST/MCP) | 8080 é o endereço do app e é por ele que o chat alcança o `/relay/`; 9001 é o que os clientes HTTP e o MCP usam |
| `session` | 17373 (WS), 17400 (HTTP) | **nenhuma** | a ponte é controle remoto sem autenticação sobre o navegador; só o núcleo precisa dela, pela rede interna |

Rede Docker com nome exato `3d-agent-colab`; containers fixos `3d-agent-colab-core` e `3d-agent-colab-session`. O nome fixo não é estética: scripts de verificação e o `BRIDGE_URL` padrão dependem dele.

---

## Por que o núcleo serve o app

Houve um terceiro container, de nginx, só para os arquivos estáticos. Ele saiu por uma regra do `PluginManager` do Chili3D: um plugin carregado por `?plugin=` precisa estar **no mesmo host** da página. Servir os dois pelo mesmo processo satisfaz a regra por construção — sem `location ^~`, sem alias, sem segundo container para sincronizar. Nenhum plugin é carregado no deploy atual, mas a regra continua valendo para quem carregar o seu.

O preço é real e está anotado: **uvicorn não é nginx**. O middleware `cache_estatico` (`core/main.py`) faz o que dá cache de arquivo estático, mas uvicorn é um servidor de aplicação. Para um kiosk com uma aba e um usuário ocasional, a diferença é irrelevante; para tráfego público, não é.

---

## O proxy do relay (`/relay/`)

O assistente de IA embutido no Chili3D chama o provedor **direto do navegador**: o `baseURL` da engrenagem é usado pelo SDK dentro da página. Quando o provedor é o `9router` da casa, a chamada morre antes de sair — **medido**:

```
OPTIONS /v1/chat/completions  →  401, sem nenhum header Access-Control-Allow-*
(o Chrome nem envia o POST; o assistente acusa "Failed to fetch")

contraste: api.anthropic.com devolve access-control-allow-origin: *
```

O 9router é um gateway Next.js e não tem handler de CORS; patchar a imagem dele estava fora de questão. A saída foi servir o relay pela **mesma origem** da página: `/relay/<caminho>` encaminha para `RELAY_URL/<caminho>` com `StreamingResponse`, sem buffer. Same-origin não tem CORS — não existe preflight, não existe o que bloquear.

Medido hoje no container, com o código novo rodando: o preflight por `/relay/` **não chega ao relay** — o `CORSMiddleware` do próprio núcleo (`allow_origins=["*"]`, `core/main.py`) o responde com 200, `access-control-allow-origin: *` e `access-control-allow-headers: authorization,content-type`; e o POST de volta também sai com `access-control-allow-origin: *`. Same-origin continua sendo o caminho recomendado (aí não há preflight nenhum), mas cross-origin pelo `/relay/` também passa.

Medido no container, com o código novo: `POST /relay/chat/completions` com chave válida devolve 200 e o SSE passa inteiro (`finish_reason`, `usage`, `[DONE]`); chave errada devolve o 401 do relay **tal qual**; sem `RELAY_URL`, 503; com endereço morto, 502 trazendo o motivo. `GET /relay/models` lista os modelos. As rotas da API e o mount em `/` seguem íntegros depois da rota — conferido no mesmo processo.

A chave não passa por aqui guardada: o usuário a cola na engrenagem do assistente, ela vem no header `Authorization` de cada pedido e é repassada sem ser lida. O núcleo não a conhece, não a registra em log e não a persiste.

O que a rota expõe, sem maquiar:

- a porta 8080 já é aberta e sem autenticação, então quem alcança o host alcança o `/relay/` — mas ainda precisa de uma chave válida do relay, e essa só quem a tem apresenta;
- o relay passa a ver o IP do container no lugar do da máquina: rate limit e registro de acesso dele mudam de referente;
- o corpo do pedido é lido inteiro antes de seguir (`await request.body()`), porque o assistente envia a conversa completa de uma vez — não é streaming de upload;
- o `timeout` de 600 s vale para cada **leitura**, não para a resposta inteira: um modelo que silencie mais de dez minutos no meio do stream tem a conexão cortada.

`RELAY_URL` não tem default que resolva: é dado do ambiente do usuário, e sem ele a rota responde **503** dizendo o que falta, em vez de tentar alcançar um endereço inventado.

A rota é registrada **antes** do bloco estático, e isso é obrigatório: o mount em `/` é casado antes de qualquer rota registrada depois dele.

---

## A ponte

Protocolo copiado de `packages/ai/src/bridge/index.ts` do Chili3D (AGPL-3.0). Três mensagens:

| direção | mensagem |
|---|---|
| página → servidor | `{"type":"hello","protocol":1,"tools":[…]}` |
| servidor → página | `{"type":"call","id":"c1","name":"run_program","args":{…}}` |
| página → servidor | `{"type":"result","id":"c1","ok":true,"content":"…"}` |

O `hello` é o que faz a ponte saber o que a página oferece; a lista é gravada em `$DATA_DIR/page-tools.json` a cada conexão. Hoje são **30 ferramentas**, protocolo **1**.

Códigos de fechamento terminais — o cliente **não** tenta reconectar:

| código | significado |
|---|---|
| `4002` | outra aba assumiu a ponte (a nova derruba a anterior) |
| `4003` | protocolo incompatível ou `hello` ausente |

### Relay HTTP da ponte (`session:17400`)

| rota | método | para quê |
|---|---|---|
| `/health` | GET | `pageConnected`, `tools`, `pending` |
| `/tools` | GET | ferramentas anunciadas (503 sem página) |
| `/call` | POST | encaminha uma chamada para a página |
| `/disconnect` | POST | derruba a página com 4002 |
| `/capturas` | GET | lista os `.step` baixados |
| `/capturas/<nome>` | GET | os bytes de um `.step` |
| `/capturas/apagar` | POST | apaga uma captura |
| `/kiosk/recarregar` | POST | escreve um pedido de recarga (quem mexe no navegador é o companheiro CDP) |

Timeout de chamada: **240 s** (`BRIDGE_CALL_TIMEOUT_MS`). CORS é `*` — a ponte foi feita para ser chamada por processo local, não para ser exposta.

---

## O caminho do STEP

É o coração do projeto, e tem três detalhes que só quem leu o código adivinha:

1. `export_nodes` **não devolve os bytes**. Devolve metadados e entrega o STEP como *download do navegador*.
2. O kiosk (companheiro CDP) libera o download para `$DATA_DIR/capturas` — sem isso o download é descartado pelo Chromium headless.
3. A ponte publica o arquivo em `GET /capturas/<nome>`, e o núcleo busca por aí.

A sequência completa de um `publicar`:

```text
pick_page_tool("document","state")      # nome descoberto por padrão, não fixo
   └─▶ conferir hasActiveDocument       # ANTES de criar diretório algum
pick_page_tool("export","node")
   └─▶ bridge_call(export, {format:".step",
                            filename:"<slug>-v000N-<marca8>.step"})
                                      # marca única: uma publicação não pega
                                      # o arquivo da anterior
   └─▶ até 30 s, pesquisando GET /capturas/<nome> a cada 1 s
                                      # o download é ASSÍNCRONO: o arquivo
                                      # nasce depois da resposta da ferramenta
   └─▶ grava v000N/model.step · apaga a captura
params.json · manifest.json · validacao.json   # entra tudo no commit
git_commit("publicado (<veredicto>)")
```

Dois comportamentos que parecem defeitos e são defesa:

- **Uma versão sem STEP continua arquivada**, com `manifest.json: {completa:false, sem_step:true}`. Senão ela parece uma peça pronta e o próximo `validar` repete o "bloqueado" sem explicar o motivo.
- **A ordem é conferir, depois arquivar.** Já foi o contrário: um kiosk recarregado (o documento vive na RAM da página) produzia um diretório `vN/` vazio, 30 segundos de espera por um download que nunca viria e um veredicto "bloqueado" arquivado no registro.

`construir_python` é o caminho headless paralelo: um script build123d que define `result`, executado no `/venv` do container, sem página nenhuma no meio.

---

## Validação: o que é medido de fato

O portal importa o `model.step` com build123d/OCP e mede o BREP:

| métrica | de onde vem |
|---|---|
| `volume_mm3`, `area_mm2` | integrais do sólido |
| `bbox_mm` (`min`, `max`, `size`) | caixa envolvente |
| `centro_mm` | centro de massa |
| `solidos`, `faces`, `arestas` | topologia |
| `massa_g` | volume × densidade do material (`PLA` 1,24 · `PETG` 1,27 · `ABS` 1,04 · `RESINA` 1,10 g/cm³) |
| `filamento_m` | volume ÷ área do filamento de 1,75 mm |
| `delta_volume_vs_anterior` | volume desta versão − o da anterior |

Veredictos: **`ok`** · **`atencao`** (aviso) · **`bloqueado`** (problema).

| classe | regra aplicada |
|---|---|
| problema (bloqueado) | envelope excede o volume da impressora (`220×220×250` por default) |
| aviso (atenção) | mais de um sólido no STEP; volume mudou mais de 50% vs. a versão anterior |

O material da validação é o com que a versão foi **publicada** (`params.json`), não o do spec: publicar com PETG e validar em separado devolvia a massa do PLA — o mesmo volume gerava 1,48 g num caminho e 1,44 g no outro, e o delta passava a medir coisas diferentes. A ordem é: argumento explícito → `params.json` → `spec.json` → PLA.

### O que NÃO é medido — e está escrito dentro do resultado

`PROCESSO` declara as regras do processo (`parede_minima_mm` 1,6 · `topo_minimo_mm` 0,8 · `furo_minimo_mm` 1,6 · `overhang_graus` 45 · `ponte_maxima_mm` 10). Elas são **declaração de intenção**, não medição. O `validacao.json` carrega um campo `limitacoes` dizendo isso explicitamente:

```json
["espessura de parede, overhang e diâmetro mínimo de furo NÃO são medidos na geometria:",
 "só o envelope, volume, topologia e massa são calculados do BREP.",
 "As regras declaradas no spec são conferidas pelo agente na revisão."]
```

Ou seja: **a validação é métrica, não veredicto de manufaturabilidade.** Nada no portal detecta uma parede fina, um furo pequeno demais ou um overhang impossível. Quem garante isso é a revisão — humana ou do agente — contra o `spec.json` da peça.

---

## O registro (`/parts`)

```text
/parts/
  _estado/                 # fora do git: fila de mensagens, estado da ponte
    mensagens/conversa.json
    plugin/<slug>.json
  .semeadura               # marca do primeiro boot
  .git/
  <slug>/
    spec.json              # intenção, material, processo
    spec.md                # a intenção escrita, com tabela de parâmetros
    modelo.py              # referência headless (build123d)
    anotacoes.json         # comentários ancorados em seleção/variável
    v0001/
      model.step           # o STEP exportado pelo kernel
      documento.json       # estado do documento no momento da publicação
      params.json          # variáveis, material, diagnóstico
      manifest.json        # completa? sem_step?
      validacao.json       # métricas, veredicto e limitacoes
```

Cada publicação é um **commit git** no `/parts/.git`, com a mensagem carregando o veredicto — a medição nasce no mesmo commit que a geometria. Um `/parts` sem o marcador `.semeadura` é **semeado** da imagem no primeiro boot; com o marcador, **nunca** é sobrescrito. É assim que o histórico sobrevive a um redeploy.

---

## Kiosk e companheiro CDP

O kiosk é Chromium headless com `--remote-debugging-port=9222`. O companheiro (`session/kiosk-cdp.mjs`) existe por três razões concretas, não por zelo:

1. **`alert()` congela o renderer.** No kiosk não há ninguém para clicar "OK"; sem um cliente de DevTools fechando o diálogo, a thread principal trava — e com ela o evento `open` do WebSocket da ponte, os timers e qualquer fetch. O app chama `alert()` em dezenas de caminhos de erro.
2. **O download do STEP precisa ser liberado** para `$DATA_DIR/capturas`.
3. **Recarregar a página** é a única forma de trocar de peça, e quem mexe no navegador é ele: o pedido chega por arquivo (`/data/pedidos/`) e ele executa `Page.reload`. Ele também abre o assistente de IA depois da carga.

Os três comportamentos dele são conferidos em `/data/kiosk-cdp.log` (`diálogo fechado`, `download concluído`, `assistente de IA: … chat aberto`) — e **não** no `docker logs`, porque o `start.sh` redireciona esse processo para arquivo.

---

## Trade-offs conscientes

| decisão | o que ganha | o que custa |
|---|---|---|
| núcleo serve o estático | um processo a menos; regra do mesmo host satisfeita de graça | uvicorn não é nginx |
| `/relay/` encaminha o LLM | o assistente nativo fala com o relay local sem CORS | superfície nova na 8080; o relay vê o IP do container; timeout de 600 s é por leitura |
| binds em `/opt` em vez de volumes nomeados | dados visíveis, backup trivial, `docker inspect` dispensável | o caminho aparece no host e no backup do `/opt` |
| sessão sem `ports:` | a ponte não fica alcançável de fora | recarregar o kiosk depende do núcleo |
| estado do documento na RAM da página | kiosk descartável, sem sync de storage | reiniciar perde geometria não publicada |
| `pick_page_tool` por padrão | nenhum nome de ferramenta fixo no núcleo | a descoberta pode escolher a ferramenta errada se duas casarem |
| versão sem STEP arquivada e marcada | registro honesto da tentativa | diretórios `vN/` que não são peças prontas |

---

## Modos de falha já medidos

Nenhum destes é hipotético: todos aconteceram neste repositório.

| sintoma | causa | o que foi feito |
|---|---|---|
| container `core` em restart loop com imagem recém-construída | rota com `dict \| Response` sem `response_model=None` mata o import do `main.py`; build verde | corrigido; `core/probe-build.py` agora **importa o `main.py`** no CI antes de publicar |
| chat da IA não abre, página abre normal | **histórico do painel**: `constbotaoIa` — `node --check` aceitava (identificador válido) e o `appendChild` morreria dentro do `buildPanel` | o plugin saiu do deploy; a lição ficou no CI, que roda `node --check` em tudo que entra na imagem |
| `tentativ++` no companheiro CDP | mesmo caso, uma linha abaixo da anterior: nome truncado, sintaticamente válido | corrigido e envelopado em try/catch — rejeição não tratada derruba o processo no Node ≥ 15 |
| núcleo "Up" há 10 minutos sem responder em 8080/9001 | `chown -R /parts /venv /app` no entrypoint: no overlayfs cada arquivo é copiado para a camada superior antes de trocar o dono, e o venv tem dezenas de milhares de arquivos | conta movida para o build (`COPY --chown` + `chown` na camada do venv); no boot só o topo de `/parts` |
| validação morria com `Permission denied` no ezdxf | processo caía para uid 1000 mas `HOME` seguia `/root` | `HOME`/`XDG_CONFIG_HOME` apontam para `/tmp/colab-home` |
| kiosk congela sem rastro | `alert()` modal no renderer headless | companheiro CDP fecha diálogos (`Page.handleJavaScriptDialog`) |
| ponte devolve "outra aba assumiu" | duas abas com `?bridge=`; 4002 é terminal | documentado; recarregar a aba antiga retoma |
| publicação sem STEP, 30 s de espera | kiosk recarregado: documento vive na RAM | ordem invertida: confere o documento **antes** de criar o diretório |
| massa diferente para o mesmo volume | material da validação vinha do spec, não da publicação | ordem explícita: argumento → `params.json` → spec → PLA |

### Duas armadilhas de plantão, já conhecidas e ainda vivas

- **A ordem dos `app.mount` em `main.py` é frágil.** O último mount é casado antes de qualquer rota registrada depois dele: `app.mount("/", StaticFiles(...))` fica no fim do arquivo, e é por isso que o `/relay/` é registrado **antes** dele. Se alguém mover uma rota da API para depois do bloco estático, ela fica inacessível. O sintoma **não** grita: GET em caminho inexistente continua dando 404 do FastAPI, mas **POST num caminho com barra final devolve 405 do mount**, não da API.
- **A semeadura é guardada por marcador, não por diretório vazio.** O `entrypoint.sh` só copia `cp -a` a semente quando `/parts/.semeadura` **não existe**. Um `/parts` restaurado de um backup anterior à marca ganha a semente por cima — e `cp -a` sobrescreve `spec.json` dos slugs coincidentes. Se você restaura backup, confirme que `.semeadura` veio junto.

---

## Ver também

- [uso com IA no Chili3D](uso-chili3d-ia.md) · [uso pelo OpenCode](uso-opencode.md) · [operação](operacao.md)
