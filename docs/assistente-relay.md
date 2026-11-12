# O assistente nativo e o relay: diagnóstico e correção

**Situação:** o assistente de IA do Chili3D, apontado para os modelos do relay
local (9router), respondia **"Erro: Connection error."** para qualquer pedido.

**Conclusão, toda medida:** a causa é **CORS no relay**. Não é o modelo, não é a
chave, não é a rede, não é o Chili3D.

Este documento registra como se chegou a isso — porque o sintoma aponta para o
lugar errado, e a resposta errada (trocar de modelo, recriar chave, "deve ser a
rede") já foi tentada por gente competente.

---

## A cadeia do sintoma

Oito elos, cada um medido, nenhum inferido:

1. O assistente usa o **SDK da OpenAI** no navegador
   (`chili3d-upstream/packages/ai/src/llm/completions.ts`,
   `dangerouslyAllowBrowser: true`). O pedido é
   `POST {baseURL}/chat/completions` com **dois headers não-simples**:
   `authorization: Bearer <chave>` e `content-type: application/json`.
2. Dois headers não-simples exigem **preflight** (`OPTIONS`) antes do POST.
3. O preflight **não carrega** `Authorization` — o Chrome o gera sozinho.
4. O middleware do 9router (`.next/server/middleware.js`) barra os prefixos
   `["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"]` sem
   chave: `{"error":"API key required for remote API access"}`, status **401**.
5. Esse 401 sai **sem nenhum cabeçalho `Access-Control-Allow-*`**.
6. O Chrome exige 2xx + `Access-Control-Allow-Origin` no preflight. Sem isso,
   **nem manda o POST**: `TypeError: Failed to fetch` / `net::ERR_FAILED`.
7. O SDK embrulha a falha em `APIConnectionError`, cuja mensagem padrão é
   literalmente `"Connection error."` — medido no artefato que roda
   (`dist/575.js`: `APIConnectionError ... super(void 0,void 0,e||"Connection error.",void 0)`).
8. `chatPanel.ts` → `handleSendError` → `appendError(err.message)` →
   `I18n.translate("ai.error.prefix", ...)` ⇒ **"Erro: Connection error."**

A mensagem, portanto, não fala de CORS. Ela é o texto genérico que o SDK usa
para "o fetch estourou", e o fetch estourou porque o Chrome barrou o pedido antes
de enviá-lo.

---

## Provas

### O relay sabe fazer CORS — o middleware é só o bloqueador

De dentro do container do relay, por **loopback e sem `Origin`** (a isenção local
do middleware passa):

```
OPTIONS /v1/chat/completions  ->  200
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: GET, POST, OPTIONS
```

De dentro do container, por **loopback com `Origin` estrangeiro**, e por qualquer
caminho que não seja loopback:

```
OPTIONS /v1/chat/completions  ->  401   (zero headers Access-Control-*)
corpo: {"error":"API key required for remote API access"}
GET     /v1/models            ->  401   (zero headers Access-Control-*)
POST    /v1/chat/completions  ->  401   (zero headers Access-Control-*)
```

A isenção local (função `aO` do middleware) só passa quem traz
`x-9r-real-ip ∈ {localhost, 127.0.0.1, ::1}` (conjunto `aM`), mais o
`x-9r-peer-token` do processo — cravado pelo `custom-server.js` em toda conexão,
como segredo por processo — e, se `Origin` estiver presente, com hostname local.
**IP de rede Docker não entra:**

```js
aM = new Set(["localhost", "127.0.0.1", "::1"]);
```

Ou seja: não há configuração do lado do navegador que resolva, porque o
preflight não tem onde carregar uma chave.

### Reprodução em navegador real (Chromium 131 headless, via CDP)

Página servida em `http://127.0.0.1:8899` (origem HTTP de verdade), alvo a porta
publicada do relay — o mesmo caminho que o navegador do usuário usa:

```
===== O QUE A PÁGINA VIU =====
--- CONTROLE: GET /api/health - pedido simples, sem header extra ---
resposta: HTTP 200 | corpo: {"ok":true}
--- ASSISTENTE: POST /v1/chat/completions - authorization + content-type ---
FALHOU: erro de rede (status=0) - o Chrome barrou o pedido

===== PEDIDOS DE REDE =====
XHR   | GET    .../api/health            (sai)
XHR   | POST   .../v1/chat/completions   (sai)
Other | OPTIONS .../v1/chat/completions  <<< PREFLIGHT CORS

===== RESPOSTAS =====
200 .../api/health          | CORS: access-control-allow-origin=* , allow-methods=GET, OPTIONS , allow-headers=*
401 .../v1/chat/completions | CORS: NENHUM
FALHOU: net::ERR_FAILED

===== CONSOLE DO CHROME =====
[error] Access to XMLHttpRequest at '.../v1/chat/completions' from origin
'http://127.0.0.1:8899' has been blocked by CORS policy: Response to preflight
request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

**O controle é a peça que separa as hipóteses.** O mesmo Chromium, no mesmo
instante, alcança o relay e recebe 200 com CORS. Conectividade e rede estão
perfeitas. O que falha é só o preflight de `/v1/*`.

### Topologia (medida)

- o relay (`decolua/9router:latest`, `next-server v16.4.5`) está na rede
  `aiNetwork`;
- a stack antiga do app estava em outra rede, **sem rota** entre as duas: o IP
  direto do relay dá *timeout*; pelo gateway do host, na porta publicada, funciona;
- o caminho que o navegador do usuário usa é o da porta publicada — por onde a
  reprodução acima foi feita.

---

## O que não é

| hipótese | por que caiu |
|---|---|
| é o modelo | o POST nunca sai; o relay não chega a julgar o modelo |
| é a chave | a chave não participa do preflight; e a rota simples responde 200 sem chave alguma |
| é a rede | o controle prova alcance em 200, com CORS, no mesmo instante |
| é o Chili3D | o app está correto: `dangerouslyAllowBrowser` é a decisão certa para app estático. Quem não fala CORS é o servidor do relay |

---

## A correção: proxy mesmo-origem

Como o preflight não carrega chave, a única saída honesta é fazer o pedido sair
da própria origem da página — aí não existe preflight nenhum.

É o que `chili3d/servidor.mjs` faz: serve o app e encaminha `/v1/*` para o relay.
Dois detalhes que não são decoração:

- o proxy fala com o relay **sem `origin`**, como cliente comum. É o que impede o
  middleware de exigir chave por causa da origem;
- o proxy **repassa** o `authorization` que o usuário colou no assistente. A chave
  passa por aqui e não mora em lugar nenhum — nem no container, nem em variável
  de ambiente, nem em arquivo versionado.

O servidor também responde o preflight de `/v1/` corretamente (204 com os três
cabeçalhos), de modo que apontar o assistente para outro host na mesma rede
continua funcionando. A falha de CORS do relay não precisa virar a nossa.

A alternativa descartada era injetar CORS no `custom-server.js` do 9router: ponto
de patch único, mas em container de terceiro, perdido a cada atualização de
imagem, e abre o relay a qualquer origem.

---

## Como verificar num deploy

```
# o proxy responde o preflight por conta própria (não repassa)
# 8081 enquanto a stack antiga conviver; 8080 depois
curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://SEU-HOST:8081/v1/chat/completions
# 204

# e os três cabeçalhos
curl -s -D - -o /dev/null -X OPTIONS http://SEU-HOST:8081/v1/chat/completions | grep -i access-control
# access-control-allow-origin: *
# access-control-allow-methods: GET, POST, OPTIONS
# access-control-allow-headers: authorization, content-type, accept
```

A última milha — assistente apontado para a própria origem, chave colada na
interface, modelo respondendo — **só se mede em deploy com chave válida**, e não
está coberta pela suíte (`teste/`): o relay de lá é falso, de propósito. Em deploy
ela foi medida até a borda do HTTP: com chave válida, o proxy respondeu `200` com
o modelo, em JSON e em streaming. O que falta é o passo dentro da interface do
app, que exige o navegador do usuário.

**Porta:** durante a transição entre a stack antiga e a nova, a nova sobe em
`8081` (`PORTA_APP=8081`); a URL Base fica `http://SEU-HOST:8081/v1`. Quando a
stack antiga sair, volta a `8080`.

### A configuração certa no assistente, que tem uma pegadinha

**Provedor:** o OpenAI-compatível (o padrão do app). Anthropic é outro dialeto.

**URL Base:** `http://SEU-HOST:8081/v1` (**8081** enquanto a stack antiga
conviver; `8080` depois) — **com `/v1`**, e o `/v1` é o **deste servidor**, não o
do relay.

**Chave:** uma chave de API do próprio relay (a tela de chaves do 9router), não
uma chave de provedor de modelo. **Modelo:** `topmodel`.

A razão é o SDK, não gosto: `completions.ts` cria o cliente OpenAI com o
`baseURL` que o usuário digitou, e o SDK cola o caminho por conta própria
(`this._client.post('/chat/completions', …)`). Para o pedido sair como
`/v1/chat/completions` — o caminho que este servidor intercepta — a URL digitada
precisa terminar em `/v1`.

O que acontece sem o `/v1`, e por que o sintoma engana: o pedido sai como
`/chat/completions`, não bate no proxy, cai no **fallback de SPA** deste servidor
e volta `200 text/html` com o index.html. O SDK esperava JSON, recebe HTML, e
estoura com o mesmo `"Connection error."`. Ou seja: a URL errada reproduz o
sintoma original com uma causa diferente — e o 200 apaixonante piora o
diagnóstico, porque não parece erro.

Duas armadilhas de configuração, ambas já medidas:

- `RELAY_URL` (variável do container) leva a raiz **sem** `/v1`; a **URL Base** do
  assistente leva a origem **com** `/v1`. Os dois `/v1` são de servidores
  diferentes. Confundi-los dá 404 do relay ou o HTML do SPA, nenhum dos quais
  aponta para a configuração.
- provedor **Anthropic** bate em `{baseURL}/v1/messages` (`anthropic.ts`), então a
  URL Base dele fica **sem** `/v1` — e o relay local, OpenAI-compatível, não fala
  esse dialeto.

### Como distinguir "o proxy não repassou a chave" de "o relay rejeitou a chave"

O instinto é o controle: a mesma chave, o mesmo corpo, direto no relay, sem passar
pelo proxy. Se os dois derem o mesmo resultado, o proxy está inocente. É bom
instinto — e **não basta**, porque um controle pode ser tão vazio quanto o teste
que ele pretendia conferir. Foi o que aconteceu aqui, e o registro fica porque o
erro é fácil de repetir:

- o `exec` do Portainer **não herda variável do meu código**: `process.env.X` no
  script só tem valor se o corpo do `POST /exec` trouxer `Env: ["X=..."]`;
- sem isso, o script rodou com `CHAVE_TESTE === undefined` e o header saiu
  literalmente `Authorization: Bearer undefined`;
- o resultado, `401 {"error":"API key required for remote API access"}`, é
  **indistinguível** do de uma chave inválida — o relay usa a mesma resposta para
  os dois casos;
- portanto o "controle" comparou o proxy contra o relay **com a mesma chave podre
  nos dois**, e o 401 idêntico não provou nada sobre a chave. A conclusão tirada
  dele — "a chave é que o relay não aceita" — estava errada.

A lição se mede assim: **antes de comparar dois caminhos, confirme que o valor
chegou**. Uma linha de log com o comprimento da chave recebida evitaria tudo
isso; o proxy já sabia o que recebeu, faltava o teste provar o que enviou.

### A chave, e o que o relay exige dela

Com a chave passando de verdade, o pedido funciona. Medido pelo proxy do próprio
container novo (`/v1/chat/completions`, `model: topmodel`, sem stream):

```
status: 200 | application/json | access-control-allow-origin: * | 3342ms
{"id":"8dd50a9f29647394","model":"stepfun-ai/step-5-preview",
 "choices":[{"finish_reason":"stop","texto":"OK-PROXY"}]}
```

E em streaming: `200 text/event-stream`, com os `delta` do modelo chegando em
pedaços. A última milha do proxy está fechada — chave aceita, modelo respondendo,
CORS presente, streaming intacto.

O que o relay exige da chave (`chunks/9100.js`, módulo `74452`, função `o`):

```js
db.get("SELECT isActive FROM apiKeys WHERE key = ?", [a])
```

Casamento exato de string na tabela `apiKeys`, ativa. Sem prefixo, sem hash, sem
espaço. O middleware lê a chave de quatro lugares, e qualquer um serve
(`middleware.js`, função `aQ`): `Authorization: Bearer <chave>`, `x-api-key`,
`x-goog-api-key`, e `?key=` na query. Nosso proxy repassa todos — ele só remove
`origin`, `host`, `accept-encoding` e companhia.

### O que a verificação em deploy mediu, e o que não mediu

Medido na stack nova (container `Up (healthy)`, publicado, rede `aiNetwork`):

- `/healthz` → `200`, com o relay configurado; `/` → `200 text/html`; rota
  profunda → `200`; asset inexistente → `404`;
- preflight `/v1/chat/completions` → `204` com os três cabeçalhos;
- `/v1/models` pelo proxy, com chave válida → `200`, lista de modelos do relay;
- `/v1/chat/completions` pelo proxy, com chave válida → `200`, modelo responde
  (`stepfun-ai/step-5-preview`), em JSON e em `text/event-stream`;
- `/chat/completions` **sem `/v1`** → `200 text/html` (o fallback de SPA — a
  armadilha acima, e um 200 que parece sucesso);
- o assistente está dentro da imagem: o bundle carregado sob demanda contém
  `dangerouslyAllowBrowser`, `APIConnectionError`, `Connection error.` e
  `chat/completions` — 17,9 MB de `dist`, plugins presentes;
- o relay responde a outros clientes no mesmo instante (modelo `topmodel` servido
  normalmente), o que descarta relay morto.

**Não medido:** o modelo respondendo **dentro da interface do app**, no navegador
do usuário. O caminho HTTP inteiro foi medido de dentro do container — inclusive
com `origin` e preflight, que é o que o navegador faz —, mas o sandbox de
desenvolvimento não alcança o host Docker, e nenhum teste deste repositório
cobre a interface: o relay da suíte é falso de propósito. O que falta é o clique
do usuário: abrir `http://SEU-HOST:8081`, colar a chave, mandar "oi".

---

## Como reproduzir o diagnóstico

Os dois scripts do reprodutor ficam em `/tmp/opencode/` (não versionados, porque
contêm endereço da rede do usuário):

- `repro.html` — a página de teste: um controle de rota simples e o pedido exato
  do assistente;
- `driver-cdp.mjs` — dirige o Chromium por CDP e imprime pedidos, respostas,
  cabeçalhos CORS e o console do Chrome.

Rodam dentro de um container que tenha Chromium. Duas armadilhas ao usá-los:

- `--virtual-time-budget` com XHR entra em deadlock e o dump nunca sai. Use
  `--timeout` ou dirija por CDP;
- página `file:` não é origem HTTP de verdade: os pedidos não completam. Sirva a
  página por HTTP local.
