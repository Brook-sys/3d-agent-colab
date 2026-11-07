/**
 * Plugin "Fluxo de Peças" (JavaScript puro, sem build).
 *
 * Painel colaborativo dentro do Chili3D:
 *   - lista as variáveis do documento com controles deslizantes (fonte da verdade paramétrica)
 *   - comentários ancorados na seleção/variável atuais (nunca em face id, que quebra a cada rebuild)
 *   - chat que compartilha a mesma fila do terminal do agente
 *   - publica versão (documento + variáveis + STEP exportado pelo núcleo)
 *
 * Tudo em JS puro com o global Chili3dCore (ver plugins/helloworld-js do upstream).
 */

const { CommandStore, PubSub } = Chili3dCore;

const PARAMS = new URLSearchParams(location.search);
const API = (PARAMS.get("api") || `http://${location.hostname}:9001`).replace(/\/$/, "");
const SLUG = PARAMS.get("part") || "teste";
const PAINEL_LIGADO = PARAMS.get("painel") !== "0";

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
        console.log("[fluxo]", message);
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

function buildPanel() {
    panel = el("div", {
        id: "flow-panel",
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
            el("strong", { text: "Fluxo de Peças" }),
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
                        const body = panel.querySelector("#flow-body");
                        const escondido = body.style.display === "none";
                        body.style.display = escondido ? "block" : "none";
                        clickEvent.target.textContent = escondido ? "recolher" : "expandir";
                    },
                },
                [],
            ),
        ],
    );

    const body = el("div", { id: "flow-body" });

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

class FlowPanelCommand {
    async execute() {
        if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
        return Promise.resolve();
    }
}

const FlowPlugin = {
    commands: [FlowPanelCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.manager",
            groups: [{ groupName: "ribbon.group.other", items: ["flow.panel"] }],
        },
    ],
    guide: [
        {
            name: "Painel do Fluxo",
            content:
                "O painel Fluxo de Peças mostra as variáveis paramétricas do documento com controles deslizantes, permite ancorar comentários na seleção atual, conversar com o agente e publicar uma versão (STEP + documento).",
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: { "command.flow.panel": "Part Flow" },
        },
        {
            language: "zh-CN",
            display: "简体中文",
            translation: { "command.flow.panel": "零件流程" },
        },
        {
            language: "pt-BR",
            display: "Português (Brasil)",
            translation: {
                "command.flow.panel": "Fluxo de Peças",
                "ribbon.tab.manager": "Gerenciar",
                "ribbon.group.other": "Outros",
            },
        },
    ],
};

CommandStore.registerCommand(FlowPanelCommand, {
    key: "flow.panel",
    icon: { type: "path", value: "icon.svg" },
});

if (PAINEL_LIGADO) {
    buildPanel();
    setInterval(() => {
        refreshVariables();
        refreshVersion();
        refreshBridge();
        reportState();
    }, 2000);
    setInterval(() => {
        refreshMessages();
        refreshAnnotations();
    }, 3000);
    refreshMessages();
    refreshAnnotations();
    refreshVersion();
    refreshBridge();
    reportState();
    console.log(`[fluxo] painel ativo · api=${API} · parte=${SLUG}`);
}

export default FlowPlugin;
