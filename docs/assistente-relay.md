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
curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://SEU-HOST:8080/v1/chat/completions
# 204

# e os três cabeçalhos
curl -s -D - -o /dev/null -X OPTIONS http://SEU-HOST:8080/v1/chat/completions | grep -i access-control
# access-control-allow-origin: *
# access-control-allow-methods: GET, POST, OPTIONS
# access-control-allow-headers: authorization, content-type, accept
```

A última milha — assistente apontado para a própria origem, chave colada na
interface, modelo respondendo — **só se mede em deploy com chave válida**, e não
está coberta pela suíte (`teste/`): o relay de lá é falso, de propósito. Sem
chave válida não há como medir essa etapa, e ela não foi medida.

### A configuração certa no assistente, que tem uma pegadinha

**Provedor:** o OpenAI-compatível (o padrão do app). Anthropic é outro dialeto.

**URL Base:** `http://SEU-HOST:8080/v1` — **com `/v1`**, e o `/v1` é o **deste
servidor**, não o do relay.

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
