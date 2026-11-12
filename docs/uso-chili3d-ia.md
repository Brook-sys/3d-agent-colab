# Usando a IA dentro do Chili3D

O Chili3D deste deploy **já traz um assistente de IA embutido**: um painel de chat que conversa com o modelo que você configurar e que age no documento aberto — cria e edita geometria, ajusta variáveis, tira fotos da viewport, responde "como se faz…" lendo o manual do app. Ele não é um plugin nosso: é o pacote `@chili3d/ai` do próprio Chili3D (AGPL-3.0), compilado dentro da imagem `core` a partir do commit fixado em [`chili3d.ref`](../chili3d.ref).

Este guia mostra como abrir, configurar e usar — e o que a IA **não** pode fazer, que é tão importante quanto o resto.

---

## 1. O pré-requisito de verdade: um documento aberto

A má notícia primeiro: não é `?bridge=`. **Medido neste deployment**: o `ChatPanel` entra por import estático em `packages/ui/src/editor.ts` e já está no `main.js` do bundle — o assistente existe em **qualquer** URL, com ou sem parâmetro. Quem ensina o contrário faz você caçar um defeito que não existe.

```ts
// packages/ui/src/editor.ts (commit fixado) — import estático, sem gate algum
import { ChatPanel } from "./chat";
```

O que o `?bridge=` faz de verdade é uma coisa só: ligar o cliente da **ponte WebSocket**, para que um processo local dirija a sua aba. Serve para o agente externo pelo MCP, não para o assistente. Consequência prática de adicioná-lo na sua máquina, onde não há ponte: a aba tenta `ws://127.0.0.1:17373/ws` a cada 8 s para sempre, com linhas falhando na aba Rede. **Ruído, não falha.**

O pré-requisito real é outro. `CommandService.checking()` (`packages/app/src/services/commandService.ts`) recusa — **em silêncio**, com um `Logger.error("No active document")` que ninguém vê — todo comando que não seja `isApplicationCommand` quando `activeView` é `undefined`. `ai.toggleChat` não é comando de aplicação. Ou seja: **sem documento aberto, o botão da ribbon não faz nada.**

Medido neste deployment, **sem** documento:

```
clique no botão da ribbon   → nenhum efeito
dispatchEvent               → nenhum efeito
pub("executeCommand")       → nenhum efeito
pub("toggleChatPanel")      → FUNCIONA
```

Medido **com** documento aberto (boot novo do kiosk, documento criado pelo companheiro):

```
clique no botão da ribbon   → LOG: executing command ai.toggleChat, e o chat FECHA (toggle real)
pub("toggleChatPanel")      → reabre o chat
```

O caminho pelo PubSub funciona nos dois casos porque `editor.ts` assina o tópico `toggleChatPanel` **direto**, sem passar pelo serviço de comandos. O da ribbon passa pelo `CommandService` — por isso depende de `activeView`.

Daí a decisão deste projeto: o companheiro do kiosk **cria um documento no boot** chamando a ferramenta `new_document` (que invoca `app.newDocument()` sem passar pelo `CommandService` e recusa se já houver documento — é idempotente). Na sua máquina, abrir o app pelo `/` sem documento deixa o botão "AI Assistant" sem efeito até você criar um (menu ▸ novo, ou `doc.new` na ribbon, que **é** comando de aplicação).

Se a página for servida em HTTPS, o `WebSocket` inseguro levanta `SecurityError` — o cliente marca o status `blocked` e o app continua carregando normalmente (o erro é capturado justamente para não derrubar o `AppBuilder.build()`).

---

## 2. Abrir o assistente

1. **Ribbon ▸ Manager ▸ Other ▸ AI Assistant** — o comando `ai.toggleChat`. O rótulo depende do idioma: `AI Assistant` (en), `Assistente IA` (pt-br), `AI 助手` (zh-cn).
2. **Kiosk** — o companheiro CDP confere na carga da página e publica `toggleChatPanel` no PubSub **somente se o chat ainda não estiver aberto** (o tópico alterna: publicar de novo fecharia).

O chat é o custom element `chili-ai-chat`, montado pelo `Editor` do `@chili3d/ui`. Ele **começa acoplado e aberto**; arraste o cabeçalho para destacá-lo como janela flutuante e arraste de volta para re-acoplar. Envie com **Ctrl+Enter** ou o botão de envio; dá para anexar imagens.

> A ribbon do kiosk foi conferida ao vivo: `Manager / Other / AI Assistant / ai.toggleChat`. A seção `3D Agent Colab` que existia ao lado dela vinha do plugin, que saiu do deploy.

O caminho do companheiro para abrir a IA é **só** o PubSub, e ele é idempotente de propósito: `editor.ts` chama `showChat()` no boot, então o chat **começa aberto** e publicar `toggleChatPanel` de novo o **fecharia**. O companheiro confere antes e o log diz `assistente de IA: ja-aberto · chat aberto`. O clique na ribbon saiu do nosso código por escolha (menos gancho no nativo), não porque esteja morto — morto ele estava só sem documento.

---

## 3. Configurar o provedor (a engrenagem)

Aberto o chat, a **engrenagem** do cabeçalho abre as configurações. São cinco campos:

| campo | o que é | valores |
|---|---|---|
| `provider` | dialeto da API | `anthropic` · `completions` · `responses` |
| `baseURL` | endpoint; vazio = padrão do provedor | `https://api.anthropic.com` · `https://api.openai.com/v1` · o seu |
| `model` | nome do modelo | `claude-opus-5` · `gpt-5.5` · o seu |
| `reasoningEffort` | profundidade de raciocínio | `low` · `medium` · `high` · `xhigh` · `max` |
| `contextWindow` | janela usada no medidor de contexto | número; omitido = default do módulo |

Os três provedores cobrem a maioria dos serviços existentes, porque quase todo gateway fala um desses dialetos:

| preset | `provider` | `baseURL` | `model` |
|---|---|---|---|
| OpenAI (compatível) | `completions` | `https://api.openai.com/v1` | `gpt-5.5` |
| OpenAI Responses (compatível) | `responses` | `https://api.openai.com/v1` | `gpt-5.5` |
| Anthropic (compatível) | `anthropic` | `https://api.anthropic.com` | `claude-opus-5` |
| Outro endpoint (compatível) | à sua escolha | o que você digitar | o que você digitar |

O preset **"Outro endpoint"** é para um gateway seu (LLM local, proxy corporativo, OpenRouter, LiteLLM…). Basta apontar `baseURL` e `model`; o `provider` continua sendo um dos três dialetos.

A engrenagem abre sozinha quando não há chave (`connectedCallback → showSettings()`), então o primeiro uso já joga você nela. Não existe segundo lugar para configurar: o formulário que o painel 3D Agent Colab já teve foi removido com o plugin, porque duplicava — de forma inferior — o que o assistente nativo oferece aqui.

O que persiste entre recargas é só o que não é segredo: `localStorage` → `chili3d.app.ai.config`. Provedor, endpoint e modelo ficam; a chave, não (seção seguinte). Janela de contexto e profundidade de raciocínio têm default do módulo (1.000.000) quando o campo falta — e deixar faltar é melhor que um número errado digitado por fora.

### 3.1 Com chave pública: funciona sem deploy

Se o seu provedor é `api.anthropic.com` ou `api.openai.com` com uma chave da sua conta, o assistente nativo funciona **direto**: esses gateways respondem preflight com `access-control-allow-origin: *` (medido, por contraste com o caso abaixo). Não há o que instalar.

### 3.2 Com o relay da casa: o proxy `/relay/`

O assistente chama o provedor **de dentro do navegador**. Quando o provedor é o relay local (`9router` neste deploy), a chamada morre antes de sair — **medido**:

```
OPTIONS /v1/chat/completions  →  401, sem nenhum header Access-Control-Allow-*
(o Chrome nem envia o POST; o assistente acusa "Failed to fetch")
```

O `9router` é um gateway Next.js e não tem handler de CORS; patchar a imagem dele estava fora de questão. A saída foi o núcleo servir o relay pela **mesma origem** da página: `/relay/<caminho>` encaminha para `RELAY_URL/<caminho>`. Same-origin não tem CORS — não existe preflight, não existe o que bloquear.

Medido hoje no container, com o código novo rodando: o preflight por `/relay/` **não chega ao relay** — o `CORSMiddleware` do próprio núcleo (`allow_origins=["*"]`, `core/main.py`) o responde com 200, `access-control-allow-origin: *` e `access-control-allow-headers: authorization,content-type`; e o POST de volta também sai com `access-control-allow-origin: *`. Same-origin continua sendo o caminho recomendado (aí não há preflight nenhum), mas cross-origin pelo `/relay/` também passa.

A configuração fica assim:

| campo | valor |
|---|---|
| `provider` | `completions` |
| `baseURL` | `http://SEU-HOST:8080/relay` — **sem** `/v1`: o `RELAY_URL` já o traz, e o proxy monta `RELAY_URL/<caminho>` |
| `model` | o que o relay expõe em `GET /relay/models` |
| chave | colada na engrenagem, como sempre |
| `reasoningEffort` | **deixe vazio** |

E no ambiente do container `core`, `RELAY_URL` com o endereço do relay **na rede que ele alcança** (ex.: `http://SEU-HOST:20128/v1`). Sem ele a rota responde **503** dizendo o que falta — de propósito, em vez de tentar alcançar um endereço inventado.

Sobre `reasoningEffort`: o código do Chili3D é explícito — campo ausente não é "médio", é "nada é pedido", e é o default certo num relay que pode rejeitar campo desconhecido. Baixar o esforço é a alavanca para um modelo que gasta todo o orçamento de saída pensando e nunca chega à resposta.

O proxy é só um encanamento: repassa método, caminho, corpo e headers (inclusive o `Authorization` com a sua chave), e devolve o status e o corpo do erro **tal qual**. Um 401 de chave errada chega como 401, não como "Failed to fetch". A chave não é lida nem guardada pelo núcleo — ela vive na memória da aba e some no F5.

### 3.3 O relay é compatível — medido, não suposto

Testado contra o relay com `flashmodel`, o corpo exato que o assistente envia:

| o que o assistente manda | o relay aceita? |
|---|---|
| `stream: true` (SSE) | sim |
| `parallel_tool_calls: true` | sim |
| `stream_options:include_usage` | sim |
| `tools: [...]` (function calling) | sim |
| fim de stream com `finish_reason` + `usage.prompt_tokens_details.cached_tokens` + `[DONE]` | sim, nessa ordem |

Um detalhe que engana: o relay emite `reasoning` e `reasoning_details` nos chunks, e o Chili3D lê `reasoning_content`. Consequência: o bloco "pensando" do assistente fica **vazio**, mas o conteúdo strema normal. Não é falha de conexão — não procure uma.

### 3.4 A chave de API

- Você **cola** na engrenagem do chat. Não existe campo de chave em arquivo nenhum, de propósito.
- Ela vive só na **memória do módulo** desta aba. `persist()` a retira antes de gravar, e uma config antiga que a tivesse em texto puro é migrada para fora na primeira leitura.
- **Ela some a cada F5.** Não é esquecimento: é a decisão do projeto Chili3D, e é a razão de o repositório nunca ter tido campo para ela.
- Com o `/relay/`, a chave continua sendo só sua: o núcleo a repassa no header e não a registra em log.

> **Nunca** coloque a chave em arquivo versionado, nem em `spec.json`, nem em print, nem em issue. Se ela vazar, revogue no console do provedor.

---

## 4. O que a IA pode fazer

A IA embutida age pelas **30 ferramentas da página** — o mesmo repertório que a ponte expõe ao agente externo. Elas vêm da skill e do host de ferramentas do `@chili3d/ai`:

**Ler o estado**

| ferramenta | serve para |
|---|---|
| `get_document_state` | há documento ativo? quais nós existem? |
| `get_selection` | o que está selecionado agora |
| `get_ribbon` | a ribbon inteira: abas, grupos, botões, comandos e atalhos |
| `get_node_properties` | as propriedades editáveis de um nó (o mesmo que o painel de propriedades edita) |
| `list_materials`, `get_material` | os materiais do documento e suas propriedades |
| `load_skill` | carregar um documento de referência sob demanda (ver seção 5) |

**Modelar e editar**

| ferramenta | serve para |
|---|---|
| `run_program` | uma sequência de operações de modelagem e consulta numa única chamada |
| `run_parametric` | criar corpo paramétrico: sketch + lista ordenada de features |
| `document_variables` | ler e escrever as variáveis do documento |
| `transform_node` | mover, rotacionar, escalar, espelhar |
| `delete_node`, `set_node_visible` | apagar; mostrar/ocultar |
| `create_folder`, `move_nodes` | organizar a árvore |
| `set_material`, `set_material_properties` | aparência: cor, opacidade |
| `set_node_properties` | mudar propriedades de um nó |
| `undo`, `redo` | desfazer/refazer |
| `new_document` | criar e ativar um documento vazio (recusa se já houver um aberto) |

**Ver e interagir**

| ferramenta | serve para |
|---|---|
| `capture_screenshot`, `capture_views` | fotografar a viewport (várias vistas padrão de uma vez) |
| `click_view`, `select_nodes` | clicar num ponto; selecionar nós para o usuário ver o destaque |
| `fit_content`, `isolate_view`, `rotate_view`, `set_camera_type` | enquadrar, isolar, girar, trocar projeção |
| `export_nodes` | exportar nós para arquivo CAD (**os bytes vêm como download do navegador**) |

O chat também lê o manual do app (`app-guide`), então perguntas do tipo "como faço X" ou "onde está Y" têm resposta sem você sair da conversa.

---

## 5. Como a IA aprende — e o que perdemos aqui

O mecanismo é a skill `app-guide`, montada **sob demanda** (`get content()` do `@chili3d/ai`):

```
buildAppGuideDoc()
   ├─ texto embutido: o manual do próprio app (ribbon, navegação, seleção,
   │   árvore, modo sketch, features)  — sempre presente
   └─ AppGuideStore.getSections()      — seções que módulos e plugins registram
```

**O que mudou com a saída do painel:** as duas seções específicas deste projeto — *"3D Agent Colab — visão geral"* e *"3D Agent Colab — regras de trabalho"* — eram publicadas pelo plugin (`Plugin.guide`), e o plugin não é mais carregado. Elas **não existem mais** no assistente. A IA embutida hoje sabe operar o Chili3D (o manual embutido) e nada sobre o fluxo deste projeto: não sabe que existe `/parts`, que há uma fila de mensagens, que publicação exige o agente externo.

As 8 skills que o build oferece (a IA carrega quando julga necessário):

| skill | conteúdo |
|---|---|
| `app-guide` | o manual do app: onde cada comando fica, navegação, seleção, árvore, modo sketch, features |
| `modeling-api` | as operações de criação do `run_program` |
| `shape-query`, `curve-query`, `surface-query` | métodos de consulta por família |
| `modeling-recipes` | receitas de modelagem |
| `error-recovery` | como se recuperar de um erro de modelagem |
| `parametric-modeling` | modelagem paramétrica |

Se quiser devolver o contexto do projeto ao assistente, o caminho é um plugin que registre seções em `guide` — a regra do `PluginManager` continua satisfeita, porque o núcleo serve o app. Não existe segundo caminho: prompt de conversa some a cada sessão.

---

## 6. Cooperação com o agente externo

Os dois caminhos de IA **não disputam**: compartilham o registro e a fila de conversa.

```
   IA embutida ── age no documento desta aba ──┐
                                               ├──▶ mesma fila: GET/POST /mensagens
   agente externo ── age no servidor e na ────┘    (autor "usuario" x autor "agente")
   ponte, publica e valida
```

- O chat publica com `autor: "usuario"`; a ferramenta MCP `enviar_mensagem` publica com `autor: "agente"`.
- Você pode, no chat, pedir algo e deixar o agente executar (ou o contrário): a mensagem fica na fila, e o terminal do agente lê a mesma.
- Comentários ancorados (`GET/POST /parts/<slug>/anotacoes`) são outro canal: ancorados na **seleção ou variável atuais**, nunca em face id — face id quebra a cada rebuild.

**O que só o agente externo faz:** `publicar` (arquiva versão com STEP), `validar` (roda o portal FDM), `construir_python` (caminho headless com build123d), `parte_criar`, commit no git do registro. A IA embutida modela; quem arquiva, mede e versiona é o núcleo.

---

## 7. Limitações — leia antes de confiar

- **A chave evapora a cada F5.** Em sessão longa você vai colar de novo. É o preço de ela não persistir.
- **O bloco "pensando" fica vazio com o relay.** O relay emite `reasoning`, o Chili3D lê `reasoning_content`. O conteúdo chega normal; o raciocínio, não.
- **CORS é do gateway, e o relay local não o tem.** Sem o `/relay/`, o assistente não sai do `Failed to fetch`. Com chave pública, esse parágrafo não se aplica.
- **O `/relay/` não tem autenticação própria.** Quem alcança a 8080 alcança o caminho — mas ainda precisa de chave válida do relay para queimar cota. Rate limit do relay passa a contar por IP do container.
- **O proxy tem timeout de 600 s por leitura.** Modelo lento passa; modelo que silencia mais de dez minutos no meio do stream tem a conexão cortada.
- **O kiosk começa com documento vazio, não com a peça pronta.** O companheiro cria o documento no boot (`new_document`, idempotente — se o IndexedDB restaurar um, ele recusa). Nenhum parâmetro de URL abre peça: `?part=` não carrega STEP nem registro — quem ainda o lê é o companheiro CDP, e só para dar **nome** ao documento (`new_document({ name: parte })`); o app só lê `?url=`/`?model=`. Geometria continua não vindo de graça: as duas peças semeadas têm **zero versões publicadas** neste deploy, então não há STEP para a IA abrir nem delta de volume para comparar.
- **A busca por `?url=` salvaria as variáveis? Não.** Um STEP importado pela URL abriria com geometria, mas **perderia as variáveis paramétricas** — os controles do painel ficariam vazios a cada recarga. Foi por isso que a criação de documento venceu o `?url=`.
- **Sem autenticação em lugar nenhum.** 8080 e 9001 são abertos. Quem alcança o host conversa com a IA usando *a sua* chave, publica versões e dirige o kiosk.
- **Reconexão fantasma.** Com `?bridge=` e sem ponte, a aba tenta `ws://127.0.0.1:17373` a cada 8 s para sempre. Ruído de console, não falha.
- **Duas abas, uma ponte.** Se duas abas com `?bridge=` disputarem a mesma ponte, a mais nova derruba a anterior com código `4002` e a aba antiga **para de tentar** ("outra aba assumiu a ponte; recarregue para retomar").
- **`run_program`/`run_parametric` criam formas, não features de corpo paramétrico.** O resultado é um nó de forma na árvore; features vêm de comandos e do documento.
- **O medidor de contexto é informativo.** `contextWindow` só alimenta o medidor; mandar número errado piora a leitura, não melhora o modelo.
- **A validação FDM é métrica, não veredicto de manufaturabilidade.** Parede mínima, furo, overhang e ponte estão declarados no `spec.json`, mas **não** são medidos na geometria. O `validacao.json` diz o que foi medido de fato.
- **O estado do documento vive na RAM do kiosk.** Reiniciar a sessão perde geometria não publicada.

---

## Ver também

- [uso pelo OpenCode (MCP)](uso-opencode.md) — o outro caminho de IA, com as 13 ferramentas do servidor
- [arquitetura](arquitetura.md) — o protocolo da ponte, o caminho do STEP e o proxy `/relay/`
- [operação](operacao.md) — sintoma → causa → ação e as limitações conhecidas
