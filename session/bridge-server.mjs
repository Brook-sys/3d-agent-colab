/**
 * Ponte Chili3D <-> agentes externos.
 *
 * A página (Chili3D) é o CLIENTE WebSocket e conecta em ws://127.0.0.1:17373/ws
 * quando carregada com `?bridge=`. Este processo é o servidor:
 *
 *   - guarda a lista de ferramentas que a página anuncia no `hello`
 *   - recebe chamadas por HTTP (POST /call) e as encaminha como {type:"call",...}
 *   - devolve a resposta da página ({type:"result",...}) para o chamador
 *
 * Protocolo copiado de packages/ai/src/bridge/index.ts do Chili3D (AGPL-3.0):
 *   pagina -> {"type":"hello","protocol":1,"tools":[...]}
 *   servidor -> {"type":"call","id":"...","name":"...","args":{...}}
 *   pagina -> {"type":"result","id":"...","ok":true,"content":"..."}
 *
 * Códigos de fechamento terminais (a página não tenta reconectar):
 *   4002 = outra aba assumiu a ponte   4003 = protocolo incompatível
 */
import http from "node:http";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const WS_PORT = Number(process.env.BRIDGE_PORT ?? 17373);
const HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT ?? 17400);
const DATA_DIR = process.env.BRIDGE_DATA_DIR ?? "/data";
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_CALL_TIMEOUT_MS ?? 240000);

/** @type {{socket: import("ws").WebSocket, tools: any[], connectedAt: string} | null} */
let page = null;
const pending = new Map();
let seq = 0;

function log(...args) {
    console.log(new Date().toISOString(), "[bridge]", ...args);
}

function persistTools(protocol, tools) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
            `${DATA_DIR}/page-tools.json`,
            JSON.stringify({ protocol, capturedAt: new Date().toISOString(), tools }, null, 2),
        );
    } catch (err) {
        log("não consegui gravar page-tools.json:", err.message);
    }
}

function closePage(code, reason) {
    if (!page) return;
    try {
        page.socket.close(code, reason);
    } catch {
        /* socket já morto */
    }
}

const wss = new WebSocketServer({ port: WS_PORT, path: "/ws" });

wss.on("connection", (socket) => {
    if (page && page.socket.readyState === socket.OPEN) {
        log("outra aba pediu a ponte; fechando a anterior (4002)");
        closePage(4002, "replaced by a newer page");
        for (const [id, entry] of pending) {
            pending.delete(id);
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, content: "a ponte foi assumida por outra aba" });
        }
    }
    page = { socket, tools: [], connectedAt: new Date().toISOString() };
    log("página conectada, aguardando hello");

    socket.on("message", (raw, isBinary) => {
        log(`mensagem recebida (binária=${Boolean(isBinary)}, ${raw.length || 0} bytes): ${String(raw).slice(0, 300)}`);
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            log("mensagem não é JSON válido — descartada");
            return;
        }
        if (msg?.type === "hello") {
            page.tools = Array.isArray(msg.tools) ? msg.tools : [];
            persistTools(msg.protocol, page.tools);
            log(`hello: protocolo=${msg.protocol}, ${page.tools.length} ferramentas anunciadas`);
            return;
        }
        if (msg?.type === "result") {
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve({ ok: msg.ok !== false, content: msg.content ?? "", images: msg.images });
        }
    });

    socket.on("close", (code) => {
        if (page?.socket === socket) {
            log(`página desconectou (código ${code})`);
            page = null;
            for (const [id, entry] of pending) {
                pending.delete(id);
                clearTimeout(entry.timer);
                entry.resolve({ ok: false, content: `a página fechou a conexão (${code})` });
            }
        }
    });
    socket.on("error", (err) => log("erro no socket da página:", err.message));
});

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end(payload);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return {};
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${HTTP_PORT}`);

    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    if (url.pathname === "/health") {
        return sendJson(res, 200, {
            ok: true,
            pageConnected: Boolean(page),
            tools: page?.tools.length ?? 0,
            pending: pending.size,
        });
    }

    if (url.pathname === "/tools") {
        return sendJson(res, page ? 200 : 503, {
            ok: Boolean(page),
            connected: Boolean(page),
            connectedAt: page?.connectedAt ?? null,
            tools: page?.tools ?? [],
        });
    }

    if (url.pathname === "/call" && req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.name ?? "");
        const args = body.args && typeof body.args === "object" ? body.args : {};
        if (!page) return sendJson(res, 503, { ok: false, content: "nenhuma página conectada na ponte" });
        if (!name) return sendJson(res, 400, { ok: false, content: "nome da ferramenta é obrigatório" });

        const id = `c${++seq}`;
        const resultPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ ok: false, content: `tempo esgotado (${CALL_TIMEOUT_MS}ms) chamando ${name}` });
            }, CALL_TIMEOUT_MS);
            pending.set(id, { resolve, timer });
        });
        try {
            page.socket.send(JSON.stringify({ type: "call", id, name, args }));
        } catch (err) {
            const entry = pending.get(id);
            if (entry) {
                clearTimeout(entry.timer);
                pending.delete(id);
            }
            return sendJson(res, 502, { ok: false, content: `falha ao enviar para a página: ${err.message}` });
        }
        const result = await resultPromise;
        return sendJson(res, result.ok ? 200 : 200, result);
    }

    if (url.pathname === "/disconnect" && req.method === "POST") {
        closePage(4002, "desconectado a pedido");
        return sendJson(res, 200, { ok: true });
    }

    // Capturas: os arquivos que a página baixou (o kiosk grava em
    // $DATA_DIR/capturas). `export_nodes` devolve só metadados — os bytes vêm
    // parar aqui, e o núcleo busca por GET /capturas/<arquivo>.
    if (url.pathname === "/capturas") {
        const dir = `${DATA_DIR}/capturas`;
        const lista = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith(".step")).map((f) => ({
                  nome: f,
                  bytes: fs.statSync(`${dir}/${f}`).size,
                  em: fs.statSync(`${dir}/${f}`).mtimeMs,
              }))
            : [];
        return sendJson(res, 200, { ok: true, capturas: lista });
    }

    // Recarregar a página do kiosk. As ferramentas da página não têm como
    // fechar um documento aberto, e trocar de peça exige uma página limpa.
    // O pedido vai por arquivo: quem mexe no navegador é o companheiro CDP.
    if (url.pathname === "/kiosk/recarregar" && req.method === "POST") {
        try {
            fs.mkdirSync(`${DATA_DIR}/pedidos`, { recursive: true });
            fs.writeFileSync(
                `${DATA_DIR}/pedidos/recarregar-${Date.now()}.json`,
                JSON.stringify({ acao: "recarregar", em: new Date().toISOString() }),
            );
        } catch (err) {
            return sendJson(res, 500, { ok: false, erro: String(err.message || err) });
        }
        return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/capturas/apagar" && req.method === "POST") {        const body = await readBody(req);
        const nome = String(body.nome ?? "");
        if (!nome || nome.includes("/") || nome.includes("\\") || nome.startsWith(".")) {
            return sendJson(res, 400, { ok: false, erro: "nome inválido" });
        }
        const full = `${DATA_DIR}/capturas/${nome}`;
        try {
            if (fs.existsSync(full)) fs.rmSync(full);
        } catch (err) {
            return sendJson(res, 200, { ok: false, erro: String(err.message || err) });
        }
        return sendJson(res, 200, { ok: true, removido: nome });
    }

    if (url.pathname.startsWith("/capturas/") && req.method === "GET") {
        // Só o nome do arquivo: `..` num caminho não sai do diretório.
        const nome = decodeURIComponent(url.pathname.slice("/capturas/".length));
        if (nome.includes("/") || nome.includes("\\") || nome.startsWith(".")) {
            return sendJson(res, 400, { ok: false, erro: "nome inválido" });
        }
        const full = `${DATA_DIR}/capturas/${nome}`;
        if (!fs.existsSync(full)) {
            return sendJson(res, 404, { ok: false, erro: `captura ${nome} não encontrada` });
        }
        const bytes = fs.readFileSync(full);
        res.writeHead(200, {
            "content-type": "application/step; charset=utf-8",
            "access-control-allow-origin": "*",
            "content-length": bytes.length,
        });
        return res.end(bytes);
    }

    return sendJson(res, 404, { ok: false, content: `rota desconhecida: ${url.pathname}` });
});

server.listen(HTTP_PORT, "0.0.0.0", () => log(`HTTP de relay em 0.0.0.0:${HTTP_PORT}`));
log(`WebSocket da ponte em 0.0.0.0:${WS_PORT}/ws`);
