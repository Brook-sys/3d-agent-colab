# Usando a IA dentro do Chili3D

O Chili3D deste deploy **já traz um assistente de IA embutido**: um painel de chat que conversa com o modelo que você configurar e que age no documento aberto — cria e edita geometria, ajusta variáveis, tira fotos da viewport, responde "como se faz…" lendo o manual do app. Ele não é um plugin nosso: é o pacote `@chili3d/ai` do próprio Chili3D (AGPL-3.0), compilado dentro da imagem `core` a partir do commit fixado em [`chili3d.ref`](../chili3d.ref).

Este guia mostra como abrir, configurar e usar — e o que a IA **não** pode fazer, que é tão importante quanto o resto.

---

## 1. O pré-requisito que ninguém explica: `?bridge=`

O pacote de IA só é **importado** quando a URL traz o parâmetro `bridge`. Não é uma preferência: é o gate do `AppBuilder`.

```ts
// packages/builder/src/appBuilder.ts (commit fixado)
protected async connectBridge(): Promise<void> {
    if (!new URLSearchParams(window.location.search).has("bridge")) return;
    const { bridgePortFromUrl, connectBridge } = await import("@chili3d/ai");
    ...
}
```

Sem `?bridge=` a URL não carrega o módulo — e sem o módulo não existe painel de IA, nem comando na ribbon. **Com** `?bridge=` (vazio), a porta assume o default `17373`.

O que isso significa na prática:

| onde | situação |
|---|---|
| **kiosk** (a sessão headless do container) | a `KIOSK_URL` padrão já traz `?bridge=&plugin=…`, então a IA está disponível — e o companheiro CDP a abre sozinho quando a página carrega |
| **seu navegador** | abra com `&bridge=` na URL — o parâmetro é o que carrega o pacote de IA |

**Consequência honesta de adicionar `?bridge=` na sua máquina:** a página passa a tentar `ws://127.0.0.1:17373/ws` de 0,5 s em 0,5 s, com backoff até 8 s — porque não existe ponte rodando aí. Fica um aviso no console e linhas de WebSocket falhando na aba Rede. **Não afeta o assistente**: ele conversa direto com o provedor de IA que você configurou. O que não funciona sem ponte é o caminho inverso (um agente externo dirigir *a sua* aba).

Se a página for servida em HTTPS, o `WebSocket` inseguro levanta `SecurityError` — o cliente marca o status `blocked` e o app continua carregando normalmente (o erro é capturado justamente para não derrubar o `AppBuilder.build()`).

---

## 2. Abrir o assistente

1. **Ribbon ▸ Manager ▸ Other ▸ AI Assistant** — o comando `ai.toggleChat`. O rótulo depende do idioma: `AI Assistant` (en), `Assistente IA` (pt-br), `AI 助手` (zh-cn).
2. **Kiosk** — o companheiro CDP confere na carga da página e publica `toggleChatPanel` no PubSub **somente se o painel ainda não estiver aberto** (o tópico alterna: publicar de novo fecharia).

O painel é o custom element `chili-ai-chat`, montado pelo `Editor` do `@chili3d/ui`. Ele **começa acoplado e aberto**; arraste o cabeçalho para destacá-lo como janela flutuante e arraste de volta para re-acoplar. Envie com **Ctrl+Enter** ou o botão de envio; dá para anexar imagens.

> A ribbon do kiosk foi conferida ao vivo: `Manager / Other / AI Assistant / ai.toggleChat` aparece ao lado de `Manager / Other / 3D Agent Colab / painel.panel`.

### O botão da ribbon precisa de um documento aberto

Não é defeito do kiosk, é regra do app: `CommandService.checking()` recusa — **em silêncio**, com um `Logger.error("No active document")` que ninguém vê — todo comando que não seja `isApplicationCommand` quando `activeView` é `undefined`. `ai.toggleChat` não é comando de aplicação.

Medido neste deployment, **sem** documento:

```
clique no botão da ribbon   → nenhum efeito
dispatchEvent               → nenhum efeito
pub("executeCommand")       → nenhum efeito
pub("toggleChatPanel")      → FUNCIONA
```

Medido **com** documento aberto (boot novo do kiosk, documento criado pelo companheiro):

```
clique no botão da ribbon   → LOG: executing command ai.toggleChat, e o painel FECHA (toggle real)
pub("toggleChatPanel")      → reabre o painel
```

O caminho pelo PubSub funciona nos dois casos porque `editor.ts` assina o tópico `toggleChatPanel` **direto**, sem passar pelo serviço de comandos. O da ribbon passa pelo `CommandService` — por isso depende de `activeView`.

Daí duas decisões deste projeto:

- o companheiro do kiosk **cria um documento no boot** chamando a ferramenta `new_document` (que invoca `app.newDocument()` sem passar pelo `CommandService` e recusa se já houver documento — é idempotente). Com `activeView` definido, o botão da ribbon volta a funcionar e o assistente tem no que agir;
- o caminho do companheiro para abrir a IA é **só** o PubSub, e ele é idempotente de propósito: `editor.ts` chama `showChat()` no boot, então o painel **começa aberto** e publicar `toggleChatPanel` de novo o **fecharia**. O companheiro confere antes e o log diz `assistente de IA: ja-aberto · painel aberto`. O clique na ribbon saiu do nosso código por escolha (menos gancho no nativo), não porque esteja morto — morto ele estava só sem documento.

Na sua máquina, a consequência prática é a mesma: abrir o app pelo `/` sem documento deixa o botão "AI Assistant" sem efeito até você criar um documento (menu ▸ novo, ou `doc.new` na ribbon, que **é** comando de aplicação).

---

## 3. Configurar o provedor (a engrenagem)

Aberto o painel, a **engrenagem** do cabeçalho abre as configurações. São cinco campos:

| campo | o que é | valores |
|---|---|---|
| `provider` | dialeto da API | `anthropic` · `completions` · `responses` |
| `baseURL` | endpoint; vazio = padrão do provedor | `https://api.anthropic.com` · `https://api.openai.com/v1` · o seu |
| `model` | nome do modelo | `claude-opus-5` · `gpt-5.5` · o seu |
| `reasoningEffort` | profundidade de raciocínio | `low` · `medium` · `high` · `xhigh` · `max` |
| `contextWindow` | janela usada no medidor de contexto | número; omitido = default do módulo |

Os três provedores cobrem a maioria dos serviços existentes, porque quase todo gateway fala um desses dialetos:

| preset do painel | `provider` | `baseURL` | `model` |
|---|---|---|---|
| OpenAI (compatível) | `completions` | `https://api.openai.com/v1` | `gpt-5.5` |
| OpenAI Responses (compatível) | `responses` | `https://api.openai.com/v1` | `gpt-5.5` |
| Anthropic (compatível) | `anthropic` | `https://api.anthropic.com` | `claude-opus-5` |
| Outro endpoint (compatível) | à sua escolha | o que você digitar | o que você digitar |

O preset **"Outro endpoint"** é para um gateway seu (LLM local, proxy corporativo, OpenRouter, LiteLLM…). Basta apontar `baseURL` e `model`; o `provider` continua sendo um dos três dialetos.

A configuração é **só na engrenagem** do cabeçalho do painel de chat. Não existe segundo lugar para configurar: o formulário que o painel 3D Agent Colab já teve foi removido, porque duplicava — de forma inferior — o que o assistente nativo oferece aqui. A engrenagem abre sozinha quando não há chave (`connectedCallback → showSettings()`), então o primeiro uso já joga você nela.

O que persiste entre recargas é só o que não é segredo: `localStorage` → `chili3d.app.ai.config`. Provedor, endpoint e modelo ficam; a chave, não (seção seguinte). Janela de contexto e profundidade de raciocínio têm default do módulo (1.000.000) quando o campo falta — e deixar faltar é melhor que um número errado digitado por fora.

### A chave de API

- Você **cola** na engrenagem do painel da IA. Não existe campo de chave no nosso painel, de propósito.
- Ela vive só na **memória do módulo** desta aba. `persist()` a retira antes de gravar, e uma config antiga que a tivesse em texto puro é migrada para fora na primeira leitura.
- **Ela some a cada F5.** Não é esquecimento: é a decisão do projeto Chili3D, e é a razão de o repositório nunca ter tido campo para ela.
- O que persiste entre recargas é só o que não é segredo: `localStorage` → `chili3d.app.ai.config`.

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

O painel de chat também lê o manual do app (`app-guide`), então perguntas do tipo "como faço X" ou "onde está Y" têm resposta sem você sair da conversa.

---

## 5. Como a IA aprende este projeto

A IA não nasce sabendo o fluxo do 3D Agent Colab. O gancho é o `guide` do plugin:

```
painel/src/extension.js  →  Plugin.guide: [{name, content}, …]
        │  (PluginManager registra cada seção)
        ▼
   AppGuideStore  →  seções acumuladas
        │
        ▼
   skill "app-guide"  →  buildAppGuideDoc(): texto base + cada seção como "## <nome>"
        │
        ▼
   load_skill(name: "app-guide")  →  a IA lê sob demanda, quando precisa
```

O plugin publica duas seções: **"3D Agent Colab — visão geral"** (o que é o registro `/parts/<slug>/`, o que o painel faz, os dois caminhos de IA) e **"3D Agent Colab — regras de trabalho"** (unidades em mm, graus; prefira variáveis a reconstruir; não dá para fechar documento — troque `?part=` e recarregue; `run_program` cria forma, não feature; use a fila de mensagens para combinar tarefa com o humano).

Note o mecanismo: as seções entram no **conteúdo** da skill `app-guide`, que é montado sob demanda — `get content()`. Nada é lido na construção. E referências do tipo `{command.key}` são resolvidas, então você pode citar comandos da ribbon no texto.

As 8 skills que o build oferece (a IA carrega quando julga necessário):

| skill | conteúdo |
|---|---|
| `app-guide` | o manual do app: onde cada comando fica, navegação, seleção, árvore, modo sketch, features |
| `modeling-api` | as operações de criação do `run_program` |
| `shape-query`, `curve-query`, `surface-query` | métodos de consulta por família |
| `modeling-recipes` | receitas de modelagem |
| `error-recovery` | como se recuperar de um erro de modelagem |
| `parametric-modeling` | modelagem paramétrica |

Se quiser ensinar algo novo à IA deste deploy, o lugar é uma nova seção em `guide` — não o prompt de cada conversa.

---

## 6. Cooperação com o agente externo

Os dois caminhos de IA **não disputam**: compartilham o registro e a fila de conversa.

```
   IA embutida ── age no documento desta aba ──┐
                                              ├──▶ mesma fila: GET/POST /mensagens
   agente externo ── age no servidor e na ────┘    (autor "usuario" x autor "agente")
   ponte, publica e valida
```

- O chat do painel publica com `autor: "usuario"`; a ferramenta MCP `enviar_mensagem` publica com `autor: "agente"`.
- Você pode, no painel, pedir algo e deixar o agente executar (ou o contrário): a mensagem fica na fila, e o terminal do agente lê a mesma.
- Comentários ancorados (`GET/POST /parts/<slug>/anotacoes`) são outro canal: ancorados na **seleção ou variável atuais**, nunca em face id — face id quebra a cada rebuild.

**O que só o agente externo faz:** `publicar` (arquiva versão com STEP), `validar` (roda o portal FDM), `construir_python` (caminho headless com build123d), `parte_criar`, commit no git do registro. A IA embutida modela; quem arquiva, mede e versiona é o núcleo.

---

## 7. Limitações — leia antes de confiar

- **A chave evapora a cada F5.** Em sessão longa você vai colar de novo. É o preço de ela não persistir.
- **O kiosk começa com documento vazio, não com a peça pronta.** O companheiro cria o documento no boot (`new_document`, idempotente — se o IndexedDB restaurar um, ele recusa). A consequência para o agente: o primeiro passo muda de "criar documento" para "usar o documento que está aberto", e um documento **novo** exige recarregar com outro `?part=` — não existe ferramenta de fechar documento. Geometria continua não vindo de graça: as duas peças semeadas têm **zero versões publicadas** neste deploy, então não há STEP para a IA abrir nem delta de volume para comparar.
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
- [arquitetura](arquitetura.md) — o protocolo da ponte e o caminho do STEP
- [painel](painel.md) — como o painel é feito e como estendê-lo
- [operação](operacao.md) — sintoma → causa → ação e as limitações conhecidas
