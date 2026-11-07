/**
 * Companheiro CDP do kiosk (proteção do runtime, não é o produto).
 *
 * Um `alert()`/`confirm()` abre um diálogo MODAL no renderer. No kiosk não há
 * ninguém para clicar "OK" e, sem um cliente de DevTools fechando o diálogo, a
 * thread principal da página congela — e com ela o evento `open` do WebSocket da
 * ponte, os timers e qualquer fetch. O app chama alert() em dezenas de caminhos
 * de erro (inclusive num `catch` de build), então isto é proteção contra um
 * congelamento silencioso que não deixa rastro.
 *
 * A segunda tarefa é o transporte do STEP: `export_nodes` devolve só metadados
 * e entrega os bytes como download do navegador. Aqui o comportamento de
 * download é liberado para $DATA_DIR/capturas, e o servidor da ponte publica
 * esses arquivos em GET /capturas/<nome> — é assim que o núcleo recebe a
 * geometria que a página realmente exportou.
 *
 * Conecta no DevTools do próprio Chromium (--remote-debugging-port=9222) e
 * responde `Page.handleJavaScriptDialog {accept:false}` para cada diálogo.
 * Se o Chromium reiniciar, o loop volta a procurar a página.
 */
import WS from "ws";
import fs from "node:fs";

const CDP_HTTP = process.env.KIOSK_CDP || "http://127.0.0.1:9222";
const DATA_DIR = process.env.BRIDGE_DATA_DIR || "/data";
const CAPTURAS = `${DATA_DIR}/capturas`;
const PEDIDOS = `${DATA_DIR}/pedidos`;
const linha = (...a) => console.log(new Date().toISOString(), "[kiosk-cdp]", ...a);

fs.mkdirSync(CAPTURAS, { recursive: true });
fs.mkdirSync(PEDIDOS, { recursive: true });

/**
 * Pedidos chegados por arquivo (o servidor da ponte os escreve). Só existe
 * "recarregar": as ferramentas da página não têm como fechar um documento
 * aberto, e trocar de peça exige uma página limpa.
 */
async function lerPedidos() {
    let arquivos = [];
    try {
        arquivos = fs.readdirSync(PEDIDOS).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }
    const pedidos = [];
    for (const arquivo of arquivos) {
        const full = `${PEDIDOS}/${arquivo}`;
        try {
            const corpo = JSON.parse(fs.readFileSync(full, "utf8"));
            fs.rmSync(full);
            pedidos.push(corpo);
        } catch {
            /* arquivo pela metade: some com ele e siga */
            try {
                fs.rmSync(full);
            } catch {}
        }
    }
    return pedidos;
}

async function listarPaginas() {
    try {
        const res = await fetch(`${CDP_HTTP}/json/list`);
        const lista = await res.json();
        return Array.isArray(lista) ? lista.filter((t) => t.type === "page" && t.webSocketDebuggerUrl) : [];
    } catch {
        return [];
    }
}

/**
 * `soRecarregar`: conexão de vida curta — liga, atende os pedidos de recarga e
 * sai. Sem isso, a vigilância de diálogos e a recarga brigam pela mesma sessão.
 */
function vigiar(alvo, soRecarregar = false) {
    return new Promise((resolve) => {
        let sock;
        try {
            sock = new WS(alvo.webSocketDebuggerUrl, { perMessageDeflate: false });
        } catch {
            return resolve();
        }
        let seq = 0;
        const pendentes = new Map();
        const enviar = (method, params = {}) =>
            new Promise((res) => {
                const id = ++seq;
                pendentes.set(id, res);
                sock.send(JSON.stringify({ id, method, params }));
                setTimeout(() => {
                    if (pendentes.has(id)) {
                        pendentes.delete(id);
                        res(null);
                    }
                }, 5000);
            });
        sock.on("message", async (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && pendentes.has(msg.id)) {
                pendentes.get(msg.id)(msg);
                pendentes.delete(msg.id);
                return;
            }
            if (msg.method === "Page.javascriptDialogOpening") {
                const p = msg.params || {};
                linha(`diálogo fechado: ${String(p.message || "").slice(0, 200)} (${p.type})`);
                await enviar("Page.handleJavaScriptDialog", { accept: false });
            }
            if (msg.method === "Page.downloadProgress" && msg.params?.state === "completed") {
                linha("download concluído em", CAPTURAS);
            }
        });
        sock.on("open", async () => {
            if (soRecarregar) {
                // Recarga não precisa de Page.enable nem de comportamento de
                // download: a página nasce de novo e o laço externo a reconfigura.
                await enviar("Page.reload", { ignoreCache: false });
                await new Promise((r) => setTimeout(r, 500));
                sock.close();
                resolve();
                return;
            }
            linha("vigilando:", alvo.url.slice(0, 90));
            await enviar("Page.enable");
            // `Page.setDownloadBehavior` é por sessão de página: uma navegação
            // pode perdê-lo, então é reaplicado a cada ciclo do laço externo.
            await enviar("Page.setDownloadBehavior", {
                behavior: "allow",
                downloadPath: CAPTURAS,
                eventsEnabled: true,
            });
            for (const pedido of (await lerPedidos()).filter((p) => p.acao === "recarregar")) {
                linha("recarregando a página a pedido");
                await enviar("Page.reload", { ignoreCache: false });
            }
        });
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
    });
}

linha(`companheiro CDP iniciado (${CDP_HTTP}, capturas em ${CAPTURAS})`);
for (;;) {
    const paginas = await listarPaginas();
    const alvo = paginas.find((t) => /bridge=/.test(t.url)) || paginas[0];
    if (alvo) {
        // Pedido de recarga tem prioridade: é atendido por uma conexão curta,
        // porque a conexão de vigilância só avalia pedidos quando abre.
        const pedidos = await lerPedidos();
        if (pedidos.some((p) => p.acao === "recarregar")) {
            linha("recarregando a página a pedido");
            await vigiar(alvo, true);
            continue;
        }
        await vigiar(alvo);
    } else {
        await new Promise((r) => setTimeout(r, 2000));
    }
}
