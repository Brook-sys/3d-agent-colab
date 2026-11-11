# O painel

Plugin do Chili3D, em **JavaScript puro, sem build**. Resumo: alterar `painel/src/extension.js`, commitar, e a imagem `core` o copia tal e qual.

[`painel/manifest.json`](../painel/manifest.json) declara `main: src/extension.js`, `engines.chili3d >=0.6` e é servido pelo núcleo em `http://SEU-HOST:8080/painel/`.

---

## O que ele faz

| seção | fonte | atualização |
|---|---|---|
| **variáveis** | `document.variables` do documento ativo, com `evaluate()` | 2 s |
| **comentários** | `GET/POST /parts/<slug>/anotacoes`, ancorados na seleção/variável atual | 3 s |
| **conversa** | `GET/POST /mensagens` — a **mesma fila** que o terminal do agente lê | 3 s |
| **publicar** | `POST /parts/<slug>/publicar` | sob demanda |

Duas linhas de espelho no topo mostram a peça e a versão atuais e o estado da ponte.

---

## Parâmetros de URL

| parâmetro | default | efeito |
|---|---|---|
| `plugin` | — | obrigatório para o painel existir; **precisa estar no mesmo host da página** (regra do `PluginManager`) |
| `part` | `teste` | slug da peça: define conversa, anotações e publicação |
| `painel` | ligado | `painel=0` desliga o plugin inteiro |
| `api` | `http://<hostname>:9001` | endereço do núcleo |
| `bridge` | ausente | **é o que importa o pacote de IA**; sem ele não há `AI Assistant` na ribbon |

---

## Como ele se liga ao app

Pelo global `Chili3dCore` (exposto por `AppBuilder.ensureAPI()`) e por `globalThis.app`. Nada de import, nada de bundler.

```js
const { CommandStore, PubSub } = Chili3dCore;
const app = globalThis.app;                       // global do app
const document = app?.activeView?.document ?? app?.document;
```

A seleção é **sondada**, não presumida: `activeView.selection`, `app.selection` e `globalThis.selection` são tentados nessa ordem, porque a API muda de nome entre versões.

O plugin declara:

- `commands` → `painel.panel`, que mostra/oculta o painel;
- `ribbons` → aba **Manager**, grupo **Other**, botão **3D Agent Colab**;
- `guide` → duas seções que a IA embutida lê (veja [uso com IA](uso-chili3d-ia.md)).

---

## Estendendo

O arquivo tem uma convenção simples: um helper `el(tag, attrs, children)` cria elementos, `api(path, options)` faz fetch no núcleo com tratamento de erro, e `render*()` redesenha uma seção. Para acrescentar uma seção:

1. **Estado**: uma chave em `state` e uma referência de DOM (`let minhaBox = null;`).
2. **Construção**: dentro de `buildPanel()`, crie os elementos com `el()` e dê `appendChild` no `body`.
3. **Render**: uma função `renderMinhaSecao()` que comece com `if (!minhaBox) return;` e use `replaceChildren()`.
4. **Atualização**: uma `async function refreshMinhaSecao()` que chame `api(...)` e, se os dados mudaram, chame o render.
5. **Ligar no laço**: acrescente a `refresh` num `setInterval` existente (2 s para estado, 3 s para listas).

O laço de 2 s também publica `POST /estado-plugin` com peça, documento aberto, variáveis, seleção e userAgent — é o que a ferramenta MCP `estado_plugin` lê.

### Exemplo mínimo

```js
// 1. estado
state.tarefas = [];

// 2–3. dentro de buildPanel(), depois das seções existentes:
tarefasBox = el("div", { style: { fontSize: "12px" } });
body.appendChild(el("div", { text: "Tarefas", style: { fontWeight: "600", margin: "12px 0 6px" } }));
body.appendChild(tarefasBox);

// 4. render + refresh
function renderTarefas() {
    if (!tarefasBox) return;
    tarefasBox.replaceChildren();
    if (!state.tarefas.length) {
        tarefasBox.appendChild(el("div", { text: "nenhuma tarefa", style: { color: "#7d8da0" } }));
        return;
    }
    for (const tarefa of state.tarefas) {
        tarefasBox.appendChild(el("div", { text: tarefa.texto, style: { marginBottom: "4px" } }));
    }
}

async function refreshTarefas() {
    const res = await api("/minha-rota");
    if (Array.isArray(res.tarefas)) {
        state.tarefas = res.tarefas;
        renderTarefas();
    }
}

// 5. laço
setInterval(refreshTarefas, 3000);
```

---

## A IA: só o `guide`

O painel **não** tem seção de IA, e isso é decisão. Ele já teve um formulário de provedor, endpoint e modelo, com botão de salvar e de abrir/fechar o assistente — e o formulário era redundante *e inferior* ao que o Chili3D já oferece: sem campo de chave, sem `reasoningEffort`, sem `contextWindow`, sem handoff para o gerenciador de senhas do navegador. Configurar a IA é função da engrenagem do painel nativo, e é lá que mora agora.

O que sobra do painel é o único gancho de IA que um plugin realmente tem: o **`guide`**. Duas seções entram no `AppGuideStore` e a skill `app-guide` do assistente as lê sob demanda — é assim que a IA embutida sabe que `document_variables` é a fonte da verdade paramétrica e que não existe ferramenta de fechar documento. Nenhum outro ponto de extensão do app é alcançável sem fork (presets de provedor, campos novos no formulário e skills novas são `const`/array fixo no fonte do `@chili3d/ai`).

O que o companheiro do kiosk faz pela IA — criar o documento no boot e abrir o painel por `PubSub.pub("toggleChatPanel")` — está em `session/kiosk-cdp.mjs`, com a medição que motiva os dois. O motivo de o clique na ribbon ter sido removido está em [uso com IA](uso-chili3d-ia.md#2-abrir-o-assistente).

---

## Conferir que funciona

O CI roda `node --check` no arquivo e falha o build em erro de sintaxe. Isso **não** pega referência solta (um identificador válido passa; o `appendChild` que morreria, morre dentro do `buildPanel()`). A verificação real é o **console da página**, que o kiosk escreve em `/data/chrome.log`:

```sh
grep -a "painel ativo" /opt/3d-agent-colab-session/chrome.log | tail -3
# [painel] painel ativo · api=http://…:9001 · parte=espacador
```

**Não é `docker logs`:** o `start.sh` redireciona o Chromium para esse arquivo (e o companheiro CDP para `kiosk-cdp.log`), então o stdout do container não tem o console. Sem a linha acima, o plugin não chegou a rodar — e a página abre normal, o que é o pior dos sintomas.

## Fragilidades sabidas

- **JS puro, sem build, sem lint de tipos.** Um typo de referência só aparece em runtime.
- **Acoplamento com globais.** `globalThis.app` e a forma da seleção são detalhes internos do app; uma atualização do Chili3D pode quebrar o painel sem aviso.
- **O painel é um `div` sobreposto**, não um painel nativo do app: redimensionar a janela pode sobrepô-lo ao viewport.
- **`localStorage` por origem.** A config da IA é por host+porta; trocar de porta é perder a configuração (a chave já se perde a cada F5 de qualquer forma).

---

## Ver também

- [uso com IA no Chili3D](uso-chili3d-ia.md) · [uso pelo OpenCode](uso-opencode.md) · [arquitetura](arquitetura.md) · [operação](operacao.md)
