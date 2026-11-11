/**
 * Painel "3D Agent Colab" (JavaScript puro, sem build).
 *
 * Painel colaborativo dentro do Chili3D:
 *   - lista as variáveis do documento com controles deslizantes (fonte da verdade paramétrica)
 *   - comentários ancorados na seleção/variável atuais (nunca em face id, que quebra a cada rebuild)
 *   - chat que compartilha a mesma fila do terminal do agente
 *   - publica versão (documento + variáveis + STEP exportado pelo núcleo)
 *   - configura e abre o assistente de IA embutido do Chili3D (provedor, endpoint, modelo)
 *
 * Tudo em JS puro com o global Chili3dCore (ver plugins/helloworld-js do upstream).
 */

const { CommandStore, PubSub } = Chili3dCore;

const PARAMS = new URLSearchParams(location.search);
const API = (PARAMS.get("api") || `http://${location.hostname}:9001`).replace(/\/$/, "");
const SLUG = PARAMS.get("part") || "teste";
const PAINEL_LIGADO = PARAMS.get("painel") !== "0";

/* ------------------------------------------------- IA embutida do Chili3D */

// O assistente de IA do app (pacote @chili3d/ai) só é importado quando a URL
// traz `?bridge=` — `appBuilder.connectBridge()` devolve antes do import sem
// esse parâmetro, "an ordinary visit never pays for an agent feature".
// Verificado no fonte fixado (chili3d.ref, packages/builder/src/appBuilder.ts).
const IA_DISPONIVEL = PARAMS.has("bridge");

// Chave da config do assistente, e não nossa: `ObjectStorage.default` do core
// prefixa `chili3d.app.` e o módulo de IA grava em `ai.config`
// (packages/ai/src/settings.ts, STORAGE_KEY) — daí `chili3d.app.ai.config`.
// Escrevemos os campos que não são segredo (provedor, endpoint, modelo,
// janela de contexto). A CHAVE NÃO: `persist()` a retira antes de gravar, e o
// `sessionApiKey` vive só na memória do módulo. Uma config antiga que ainda
// tivesse chave em texto puro é migrada para fora pelo próprio módulo. Nós
// nunca a escrevemos — quem usa cola a chave na engrenagem do painel da IA.
const IA_CHAVE = "chili3d.app.ai.config";
// Espelho só nosso, para o formulário lembrar o que foi digitado. Também sem
// segredo: se um dia alguém guardar a chave aqui, ela vai para o repositório
// de qualquer um que abrir o DevTools — é exatamente o que não queremos.
const PAINEL_CONFIG_CHAVE = "painel.config";

const IA_PRESETS = [
    {
        id: "openai",
        rotulo: "OpenAI (compatível)",
        provider: "completions",
        baseURL: "https://api.openai.com/v1",
        modelo: "gpt-5.5",
    },
    {
        id: "responses",
        rotulo: "OpenAI Responses (compatível)",
        provider: "responses",
        baseURL: "https://api.openai.com/v1",
        modelo: "gpt-5.5",
    },
    {
        id: "anthropic",
        rotulo: "Anthropic (compatível)",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
        modelo: "claude-opus-5",
    },
    { id: "livre", rotulo: "Outro endpoint (compatível)", provider: "completions", baseURL: "", modelo: "" },
];

const IA_PROVIDERS = [
    { id: "anthropic", rotulo: "anthropic" },
    { id: "completions", rotulo: "openai completions" },
    { id: "responses", rotulo: "openai responses" },
];

// Janela de contexto e profundidade de raciocínio NÃO são gravadas daqui: o
// módulo de IA aplica o próprio default quando o campo falta (é a filosofia
// dele — "omitido" não é "médio", é "o que este endpoint fizer sozinho"), e um
// número errado escrito pelo painel pioraria o medidor de contexto sem
// melhorar o modelo. Quem precisar mexer nisso usa a engrenagem do painel da
// IA. O default do módulo é 1.000.000, que é o que a maioria dos modelos
// atuais aguenta.

function lerStorage(chave) {
    try {
        const cru = localStorage.getItem(chave);
        return cru ? JSON.parse(cru) : null;
    } catch {
        return null;
    }
}

function gravarStorage(chave, valor) {
    try {
        localStorage.setItem(chave, JSON.stringify(valor));
        return true;
    } catch (err) {
        console.log("[painel] localStorage recusou a gravação:", err);
        return false;
    }
}

function iaConfig() {
    const salvo = lerStorage(IA_CHAVE) || {};
    const espelho = lerStorage(PAINEL_CONFIG_CHAVE) || {};
    return { ...espelho, ...salvo };
}

/** Escreve a config do assistente SEM a chave — ver o comentário de IA_CHAVE. */
function salvarIaConfig(campos) {
    const { apiKey: _chave, ...resto } = campos;
    const atual = lerStorage(IA_CHAVE) || {};
    const nova = { ...atual, ...resto };
    // `undefined` explicitamente gravaria a chave no JSON algumas vezes;
    // `JSON.stringify` a omite, mas o merge abaixo a traria de volta.
    for (const chave of Object.keys(nova)) if (nova[chave] === undefined) delete nova[chave];
    const ok = gravarStorage(IA_CHAVE, nova);
    if (ok) gravarStorage(PAINEL_CONFIG_CHAVE, { ...resto, preset: campos.preset });
    return ok;
}

/**
 * Abre o assistente de IA do app. Duas vias, na ordem: o botão da ribbon
 * (passa pelo comando `ai.toggleChat`, que é o caminho que a UI usa) e, se o
 * botão não existir nesta build, o PubSub direto — `Chili3dCore` é o namespace
 * do core exposto em `globalThis` por `AppBuilder.ensureAPI()`.
 */
function abrirIa() {
    const titulos = ["AI Assistant", "Assistente IA", "AI 助手"];
    let botao = null;
    for (const titulo of titulos) {
        botao = [...document.querySelectorAll("ribbon-button")].find((b) => b.getAttribute("title") === titulo);
        if (botao) break;
    }
    if (botao) {
        botao.click();
        return "ribbon";
    }
    try {
        PubSub.default.pub("toggleChatPanel");
        return "pubsub";
    } catch (err) {
        console.log("[painel] não foi possível abrir o assistente de IA:", err);
        return null;
    }
}


/* ------------------------------------------------------------------ util */

async function api(path, options = {}) {
    const opts = {
        method: options.method || "GET",
        headers: { "content-type": "application/json" },
    };
    if (options.body !== undefined) opts.body = JSON.stringify(options.body);
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { ok: false, content: text.slice(0, 4000) };
    }
    if (!res.ok && json.error === undefined) json.error = `HTTP ${res.status}`;
    return json;
}

function toast(message) {
    try {
        PubSub.default.pub("showToast", message);
    } catch {
        console.log("[painel]", message);
    }
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    for (const child of children) node.appendChild(child);
    return node;
}

/* --------------------------------------------------- acesso ao documento */

function getApp() {
    try {
        return globalThis.app ?? null;
    } catch {
        return null;
    }
}

function getDocument() {
    const app = getApp();
    return app?.activeView?.document ?? app?.document ?? null;
}

/** A API de seleção muda de nome entre versões: sondamos e devolvemos o que existe. */
function getSelection() {
    const app = getApp();
    const candidates = [
        app?.activeView?.selection,
        app?.selection,
        globalThis.selection,
    ];
    for (const candidate of candidates) if (candidate) return candidate;
    return null;
}

function selectionSummary() {
    const selection = getSelection();
    if (!selection) return { disponivel: false };
    try {
        const nodes = selection.nodes ?? selection.selectedNodes ?? [];
        return {
            disponivel: true,
            nomes: (Array.isArray(nodes) ? nodes : []).map((node) => node?.name ?? String(node)),
        };
    } catch (err) {
        return { disponivel: true, erro: err.message };
    }
}

function variableRows(document) {
    const table = document?.variables;
    if (!table) return [];
    let evaluated = { scope: new Map(), errors: new Map() };
    try {
        evaluated = table.evaluate();
    } catch {
        /* tabela pode estar inconsistentes; seguimos com o que der */
    }
    return table.items.map((item) => ({
        name: item.name,
        type: item.type,
        expression: item.expression,
        description: item.description,
        value: evaluated.scope?.get?.(item.name)?.value,
        error: evaluated.errors?.get?.(item.id),
    }));
}

function setVariable(document, name, value) {
    const items = document.variables.items.map((item) =>
        item.name === name ? { ...item, expression: String(value) } : item,
    );
    document.variables.setItems(items);
}

/* ----------------------------------------------------------------- painel */

const state = {
    variables: [],
    messages: [],
    annotations: [],
    version: null,
    bridge: null,
    lastVariablesJson: "",
    suffix: {},
};

let panel = null;
let variablesBox = null;
let chatBox = null;
let versionLabel = null;
let bridgeLabel = null;
let notesBox = null;
let iaBox = null;

function buildPanel() {
    panel = el("div", {
        id: "painel-root",
        style: {
            position: "fixed",
            top: "12px",
            right: "12px",
            width: "320px",
            maxHeight: "calc(100vh - 24px)",
            overflowY: "auto",
            background: "rgba(18,20,26,0.94)",
            color: "#e8ecf3",
            border: "1px solid #2c3444",
            borderRadius: "10px",
            boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
            font: "13px/1.45 system-ui, sans-serif",
            zIndex: "9999",
            padding: "10px 12px",
        },
    });

    const header = el(
        "div",
        {
            style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
        },
        [
            el("strong", { text: "3D Agent Colab" }),
            el(
                "button",
                {
                    text: "recolher",
                    style: {
                        background: "transparent",
                        border: "1px solid #2c3444",
                        color: "#9fb0c8",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontSize: "11px",
                    },
                    onclick: (clickEvent) => {
                        const body = panel.querySelector("#painel-body");
                        const escondido = body.style.display === "none";
                        body.style.display = escondido ? "block" : "none";
                        clickEvent.target.textContent = escondido ? "recolher" : "expandir";
                    },
                },
                [],
            ),
        ],
    );

    const body = el("div", { id: "painel-body" });

    versionLabel = el("div", { text: "peça: …", style: { color: "#8fa3bd", marginBottom: "6px" } });
    bridgeLabel = el("div", { text: "ponte: …", style: { color: "#8fa3bd", marginBottom: "10px" } });

    const varTitle = el("div", { text: "Variáveis paramétricas", style: { fontWeight: "600", margin: "6px 0" } });
    variablesBox = el("div", {});

    const notesTitle = el("div", { text: "Comentários e medições", style: { fontWeight: "600", margin: "12px 0 6px" } });
    notesBox = el("div", { text: "nenhum comentário ainda", style: { color: "#7d8da0" } });
    const noteInput = el("input", {
        placeholder: "comente sobre a seleção atual…",
        style: {
            width: "100%",
            boxSizing: "border-box",
            background: "#12161f",
            border: "1px solid #2c3444",
            color: "#e8ecf3",
            borderRadius: "6px",
            padding: "6px",
            marginTop: "6px",
        },
    });
    const noteButton = el(
        "button",
        {
            text: "Ancorar comentário",
            style: {
                marginTop: "6px",
                width: "100%",
                background: "#1d4e6f",
                border: "none",
                color: "#fff",
                padding: "7px",
                borderRadius: "6px",
                cursor: "pointer",
            },
            onclick: async () => {
                const texto = noteInput.value.trim();
                if (!texto) return;
                noteInput.value = "";
                await api(`/parts/${SLUG}/anotacoes`, {
                    method: "POST",
                    body: { texto, selecao: selectionSummary(), variaveis: state.variables },
                });
                await refreshAnnotations();
                toast("comentário ancorado");
            },
        },
        [],
    );

    const chatTitle = el("div", { text: "Conversa com o agente", style: { fontWeight: "600", margin: "12px 0 6px" } });
    chatBox = el("div", { style: { maxHeight: "180px", overflowY: "auto", fontSize: "12px" } });
    const chatInput = el("input", {
        placeholder: "escreva para o agente…",
        style: {
            width: "100%",
            boxSizing: "border-box",
            background: "#12161f",
            border: "1px solid #2c3444",
            color: "#e8ecf3",
            borderRadius: "6px",
            padding: "6px",
            marginTop: "6px",
        },
    });
    const chatButton = el(
        "button",
        {
            text: "Enviar",
            style: {
                marginTop: "6px",
                width: "100%",
                background: "#2a4d3a",
                border: "none",
                color: "#fff",
                padding: "7px",
                borderRadius: "6px",
                cursor: "pointer",
            },
            onclick: async () => {
                const texto = chatInput.value.trim();
                if (!texto) return;
                chatInput.value = "";
                await api("/mensagens", { method: "POST", body: { autor: "usuario", texto, parte: SLUG } });
                await refreshMessages();
            },
        },
        [],
    );

    const iaTitle = el("div", { text: "Assistente de IA (embutido)", style: { fontWeight: "600", margin: "12px 0 6px" } });
    iaBox = el("div", { style: { fontSize: "12px", color: "#8fa3bd" } });

    const iaPreset = el("select", { style: { width: "100%", boxSizing: "border-box", marginTop: "4px", background: "#12161f", border: "1px solid #2c3444", color: "#e8ecf3", borderRadius: "6px", padding: "5px" } });
    for (const preset of IA_PRESETS) iaPreset.appendChild(el("option", { value: preset.id, text: preset.rotulo }));
    const iaProviderRow = el("div", { style: { display: "none", marginTop: "4px" } });
    const iaProvider = el("select", { style: { width: "100%", boxSizing: "border-box", background: "#12161f", border: "1px solid #2c3444", color: "#e8ecf3", borderRadius: "6px", padding: "5px" } });
    for (const provider of IA_PROVIDERS) iaProvider.appendChild(el("option", { value: provider.id, text: provider.rotulo }));
    iaProviderRow.appendChild(iaProvider);

    const campo = (placeholder, valor) =>
        el("input", {
            placeholder,
            value: valor ?? "",
            style: {
                width: "100%",
                boxSizing: "border-box",
                background: "#12161f",
                border: "1px solid #2c3444",
                color: "#e8ecf3",
                borderRadius: "6px",
                padding: "5px",
                marginTop: "4px",
            },
        });

    const configAtual = iaConfig();
    const presetAtual = IA_PRESETS.find((p) => p.id === configAtual.preset) || IA_PRESETS[0];
    iaPreset.value = presetAtual.id;
    iaProvider.value = configAtual.provider || presetAtual.provider;
    const iaBase = campo("endpoint (baseURL)", configAtual.baseURL ?? presetAtual.baseURL);
    const iaModelo = campo("modelo", configAtual.model ?? presetAtual.modelo);

    // O botão de abrir/fechar vive dentro de `iaBox` (ver `renderIa`): ele
    // mostra o estado atual do painel da IA, o que um botão solto não faria.
    const salvarIa = el("button", {
        text: "Salvar configuração da IA",
        style: {
            marginTop: "6px",
            width: "100%",
            background: "#1d4e6f",
            border: "none",
            color: "#fff",
            padding: "7px",
            borderRadius: "6px",
            cursor: "pointer",
        },
        onclick: async () => {
            const preset = IA_PRESETS.find((p) => p.id === iaPreset.value) || IA_PRESETS[3];
            const campos = {
                preset: preset.id,
                provider: preset.id === "livre" ? iaProvider.value : preset.provider,
                baseURL: iaBase.value.trim() || preset.baseURL,
                model: iaModelo.value.trim() || preset.modelo,
            };
            if (salvarIaConfig(campos)) toast("configuração da IA salva neste navegador");
            else toast("não foi possível salvar (localStorage bloqueado)");
            renderIa();
        },
    });

    iaPreset.addEventListener("change", () => {
        const preset = IA_PRESETS.find((p) => p.id === iaPreset.value) || IA_PRESETS[3];
        iaProviderRow.style.display = preset.id === "livre" ? "block" : "none";
        if (!iaBase.value.trim()) iaBase.placeholder = preset.baseURL || "http://SEU-HOST:4000/v1";
        if (!iaModelo.value.trim()) iaModelo.placeholder = preset.modelo || "nome-do-modelo";
        if (preset.baseURL && !iaBase.value.trim()) iaBase.value = preset.baseURL;
        if (preset.modelo && !iaModelo.value.trim()) iaModelo.value = preset.modelo;
        iaProvider.value = preset.provider;
    });

    const iaNota = el("div", {
        text: "A chave da API não passa por aqui: ela é colada na engrenagem do painel da IA e fica só na memória da aba. Endpoint e modelo são gravados no navegador.",
        style: { color: "#7d8da0", marginTop: "6px", fontSize: "11px" },
    });

    const iaAtivar = el("button", {
        text: IA_DISPONIVEL ? "" : "Ativar IA nesta página (adiciona ?bridge= e recarrega)",
        style: { display: IA_DISPONIVEL ? "none" : "block", marginTop: "6px", width: "100%", background: "transparent", border: "1px solid #2c3444", color: "#9fb0c8", borderRadius: "6px", padding: "6px", cursor: "pointer", fontSize: "11px" },
        onclick: () => {
            const url = new URL(location.href);
            url.searchParams.set("bridge", "");
            location.href = url.toString();
        },
    });

    body.appendChild(iaTitle);
    body.appendChild(iaBox);
    body.appendChild(iaPreset);
    body.appendChild(iaProviderRow);
    body.appendChild(iaBase);
    body.appendChild(iaModelo);
    body.appendChild(salvarIa);
    body.appendChild(iaNota);
    body.appendChild(iaAtivar);

    const publishButton = el(
        "button",
        {
            text: "Publicar versão (STEP + documento)",
            style: {
                marginTop: "12px",
                width: "100%",
                background: "#5a3d12",
                border: "none",
                color: "#fff",
                padding: "8px",
                borderRadius: "6px",
                cursor: "pointer",
            },
            onclick: async () => {
                toast("publicando versão…");
                const documento = getDocument();
                const res = await api(`/parts/${SLUG}/publicar`, {
                    method: "POST",
                    body: { variaveis: state.variables, documento: Boolean(documento) },
                });
                refreshVersion();
                toast(res.ok ? `versão ${res.versao ?? "?"} publicada` : `falha: ${res.error ?? res.content}`);
            },
        },
        [],
    );

    body.appendChild(versionLabel);
    body.appendChild(bridgeLabel);
    body.appendChild(varTitle);
    body.appendChild(variablesBox);
    body.appendChild(notesTitle);
    body.appendChild(notesBox);
    body.appendChild(noteInput);
    body.appendChild(noteButton);
    body.appendChild(chatTitle);
    body.appendChild(chatBox);
    body.appendChild(chatInput);
    body.appendChild(chatButton);
    body.appendChild(publishButton);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);
}

function renderVariables() {
    if (!variablesBox) return;
    variablesBox.replaceChildren();
    if (!state.variables.length) {
        variablesBox.appendChild(el("div", { text: "nenhuma variável no documento", style: { color: "#7d8da0" } }));
        return;
    }
    for (const row of state.variables) {
        const numeric = typeof row.value === "number" && Number.isFinite(row.value);
        const label = el("label", {
            text: `${row.name} (${row.type})${row.error ? " ⚠" : ""}`,
            style: { display: "block", marginTop: "6px", color: "#cfe0f2" },
        });
        const input = el("input", {
            type: numeric ? "range" : "text",
            style: { width: "100%", boxSizing: "border-box" },
        });
        if (numeric) {
            const magnitude = Math.abs(row.value) || 1;
            input.min = String(row.value - magnitude * 4);
            input.max = String(row.value + magnitude * 4);
            input.step = String(Math.max(magnitude / 100, 0.01));
            input.value = String(row.value);
            let timer = null;
            input.addEventListener("input", () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const documento = getDocument();
                    if (!documento) return;
                    setVariable(documento, row.name, input.value);
                    await reportState();
                }, 250);
            });
        } else {
            input.value = row.expression ?? "";
            let timer = null;
            input.addEventListener("input", () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const documento = getDocument();
                    if (!documento) return;
                    setVariable(documento, row.name, input.value);
                    await reportState();
                }, 400);
            });
        }
        const valueText = el("span", { text: row.error ? String(row.error) : `= ${row.value}`, style: { color: "#8fa3bd" } });
        variablesBox.appendChild(label);
        variablesBox.appendChild(input);
        variablesBox.appendChild(valueText);
        variablesBox.appendChild(el("div", { style: { height: "2px" } }));
    }
}

function renderMessages() {
    if (!chatBox) return;
    chatBox.replaceChildren();
    if (!state.messages.length) {
        chatBox.appendChild(el("div", { text: "sem mensagens", style: { color: "#7d8da0" } }));
        return;
    }
    for (const message of state.messages.slice(-30)) {
        chatBox.appendChild(
            el("div", {
                text: `${message.autor ?? "?"}: ${message.texto ?? ""}`,
                style: { marginBottom: "4px", color: message.autor === "agente" ? "#9fe6b8" : "#cfe0f2" },
            }),
        );
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

function renderAnnotations() {
    if (!notesBox) return;
    notesBox.replaceChildren();
    if (!state.annotations.length) {
        notesBox.appendChild(el("div", { text: "nenhum comentário ainda", style: { color: "#7d8da0" } }));
        return;
    }
    for (const note of state.annotations.slice(-10)) {
        notesBox.appendChild(
            el("div", {
                text: `${note.autor ?? "?"}: ${note.texto ?? ""} ${note.selecao?.nomes?.length ? `«${note.selecao.nomes.join(", ")}»` : ""}`,
                style: { marginBottom: "4px", color: "#cfe0f2" },
            }),
        );
    }
}

/** Uma linha de espelho do que o assistente de IA vai usar, e do que falta. */
async function renderIa() {
    if (!iaBox) return;
    iaBox.replaceChildren();
    if (!IA_DISPONIVEL) {
        iaBox.appendChild(
            el("div", {
                text: "assistente indisponível: o módulo de IA só é carregado quando a URL traz ?bridge= (veja o botão abaixo)",
                style: { color: "#d79a7a" },
            }),
        );
        return;
    }
    const config = iaConfig();
    const aberto = Boolean(document.querySelector("chili-ai-chat"));
    const partes = [];
    partes.push(aberto ? "painel da IA: aberto" : "painel da IA: fechado");
    partes.push(config.model ? `modelo: ${config.model}` : "modelo: não definido");
    partes.push(config.baseURL ? `endpoint: ${config.baseURL}` : "endpoint: padrão do provedor");
    // A chave nunca é lida daqui. O que dá para dizer com honestidade é se ela
    // existe em algum lugar: `ai.config` não a guarda, então a única fonte é a
    // memória da aba — e ela some a cada F5.
    iaBox.appendChild(el("div", { text: partes.join(" · "), style: { color: "#8fa3bd" } }));
    iaBox.appendChild(
        el("div", {
            text: "chave: cole na engrenagem do painel da IA (não é guardada; some ao recarregar)",
            style: { color: "#7d8da0", fontSize: "11px", marginTop: "2px" },
        }),
    );
    const botao = el("button", {
        text: aberto ? "fechar assistente de IA" : "abrir assistente de IA",
        style: {
            marginTop: "6px",
            width: "100%",
            background: "#3a2a5e",
            border: "none",
            color: "#fff",
            padding: "7px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "12px",
        },
        onclick: () => {
            abrirIa();
            renderIa();
        },
    });
    iaBox.appendChild(botao);
}

/* ------------------------------------------------------------- refresh */

async function refreshVariables() {
    const documento = getDocument();
    const rows = variableRows(documento);
    const json = JSON.stringify(rows);
    if (json !== state.lastVariablesJson) {
        state.lastVariablesJson = json;
        state.variables = rows;
        renderVariables();
    }
    return rows;
}

async function refreshMessages() {
    const res = await api("/mensagens");
    if (Array.isArray(res.mensagens)) {
        state.messages = res.mensagens;
        renderMessages();
    }
}

async function refreshAnnotations() {
    const res = await api(`/parts/${SLUG}/anotacoes`);
    if (Array.isArray(res.anotacoes)) {
        state.annotations = res.anotacoes;
        renderAnnotations();
    }
}

async function refreshVersion() {
    const res = await api(`/parts/${SLUG}`);
    state.version = res.ultima_versao ?? null;
    if (versionLabel) {
        versionLabel.textContent = `peça: ${SLUG} · versão: ${state.version ?? "—"} · api: ${API}`;
    }
}

async function refreshBridge() {
    try {
        const res = await api("/ponte/estado");
        state.bridge = res;
        if (bridgeLabel) {
            bridgeLabel.textContent = res.conectada
                ? `ponte: agente conectado (${res.ferramentas ?? 0} ferramentas)`
                : "ponte: nenhuma página do agente conectada";
        }
    } catch (err) {
        if (bridgeLabel) bridgeLabel.textContent = `ponte: ${err.message}`;
    }
}

async function reportState() {
    const documento = getDocument();
    await api("/estado-plugin", {
        method: "POST",
        body: {
            parte: SLUG,
            documento: Boolean(documento),
            variaveis: state.variables,
            selecao: selectionSummary(),
            userAgent: navigator.userAgent.slice(0, 120),
        },
    }).catch(() => {});
}

/* --------------------------------------------------------------- plugin */

class PainelCommand {
    async execute() {
        if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
        return Promise.resolve();
    }
}

const PainelPlugin = {
    commands: [PainelCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.manager",
            groups: [{ groupName: "ribbon.group.other", items: ["painel.panel"] }],
        },
    ],
    // `guide` é o único gancho de IA que um plugin tem: cada seção entra no
    // `AppGuideStore` e a skill `appGuide` do assistente as lê sob demanda
    // (packages/core/src/guide/appGuideStore.ts + pluginManager). É assim que
    // a IA embutida aprende o fluxo deste projeto sem que ninguém precise
    // repetir as regras em cada conversa.
    guide: [
        {
            name: "3D Agent Colab — visão geral",
            content: [
                "O Chili3D aqui está integrado ao 3D Agent Colab. A página é a fonte da verdade da geometria;",
                "o núcleo (FastAPI em core:9001) arquiva, mede e valida.",
                "",
                "- Registro de peças em /parts/<slug>/: `spec.json`, `modelo.py`, `anotacoes.json` e `v000N/`",
                "  (STEP, documento, params, validação e manifest de cada versão).",
                "- A peça aberta agora vem de `?part=<slug>` na URL; o painel lateral do 3D Agent Colab",
                "  mostra variáveis, comentários ancorados, a fila de conversa e publica versões.",
                "- Existem dois caminhos de IA: este assistente embutido (age no documento daqui) e um",
                "  agente externo via MCP em `http://<host>:9001/mcp` (age pelo servidor, pela ponte WebSocket).",
                "  Os dois podem cooperar pela mesma fila de mensagens (`POST /mensagens` no núcleo).",
            ].join("\n"),
        },
        {
            name: "3D Agent Colab — regras de trabalho",
            content: [
                "Unidades em milímetros, ângulos em graus. Prefira ajustar variáveis a reconstruir geometria:",
                "`document_variables` é a fonte da verdade paramétrica.",
                "",
                "- Não feche um documento aberto: não existe ferramenta de fechar. Para trocar de peça,",
                "  mude `?part=<slug>` na URL e peça o recarregamento (`POST /kiosk/recarregar` no núcleo,",
                "  porta 8080). Sem isso o `new_document` recusa.",
                "- Para arquivar uma versão: `export_nodes` (os bytes do STEP chegam como download e o",
                "  núcleo os busca em /capturas), ou o botão Publicar do painel, ou `publicar` pelo MCP.",
                "- `run_program` e `run_parametric` criam formas, não features de corpo paramétrico:",
                "  o resultado é um nó de forma na árvore.",
                "- Escreva na fila com `enviar_mensagem` (MCP) ou `POST /mensagens` — o painel e o terminal",
                "  do agente leem a mesma fila. É o canal para combinar tarefa com o humano.",
            ].join("\n"),
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: { "command.painel.panel": "3D Agent Colab" },
        },
        {
            language: "zh-CN",
            display: "简体中文",
            translation: { "command.painel.panel": "3D Agent Colab" },
        },
        {
            language: "pt-BR",
            display: "Português (Brasil)",
            translation: {
                "command.painel.panel": "3D Agent Colab",
                "ribbon.tab.manager": "Gerenciar",
                "ribbon.group.other": "Outros",
            },
        },
    ],
};

CommandStore.registerCommand(PainelCommand, {
    key: "painel.panel",
    icon: { type: "path", value: "icon.svg" },
});

if (PAINEL_LIGADO) {
    buildPanel();
    renderIa();
    setInterval(() => {
        refreshVariables();
        refreshVersion();
        refreshBridge();
        reportState();
    }, 2000);
    setInterval(() => {
        refreshMessages();
        refreshAnnotations();
        renderIa();
    }, 3000);
    refreshMessages();
    refreshAnnotations();
    refreshVersion();
    refreshBridge();
    reportState();
    console.log(`[painel] painel ativo · api=${API} · parte=${SLUG} · ia=${IA_DISPONIVEL ? "disponível" : "indisponível"}`);
}

export default PainelPlugin;
