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
 * A terceira tarefa é preparar o kiosk no boot: garantir um documento aberto
 * (sem ele, `activeView` não existe e o sistema de comandos do app recusa em
 * silêncio — inclusive o botão nativo do assistente de IA) e abrir o painel do
 * assistente. Ver `garantirDocumento`, que tem a medição que motiva as duas.
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

/* ------------------------------------------------------- preparar o kiosk */

const BRIDGE_HTTP = `http://127.0.0.1:${process.env.BRIDGE_HTTP_PORT || 17400}`;

/** A peça que a página trabalha, lida da própria URL (`?part=`). */
function parteDaUrl(url) {
    try {
        return new URL(url).searchParams.get("part") || "";
    } catch {
        return "";
    }
}

/**
 * Espera o app estar de pé: `Chili3dCore` no global e a ribbon no DOM. Antes
 * disso qualquer chamada se perde no vácuo, e o sintoma seria um log dizendo
 * "falhou" sem dizer que o problema era ser cedo demais.
 *
 * Cada `tentativa++` completo, de propósito: um nome truncado aqui é
 * sintaticamente válido, passa no `node --check` e estoura em runtime — a
 * falha silenciosa que este arquivo existe para não ter.
 */
async function esperarApp(avaliar, teto = 40, passo = 500) {
    for (let tentativa = 0; tentativa < teto; tentativa++) {
        if (await avaliar("Boolean(globalThis.Chili3dCore && document.querySelector('chili-ribbon'))")) return true;
        await new Promise((r) => setTimeout(r, passo));
    }
    return false;
}

/**
 * Depois de um reload a página precisa reconectar na ponte: sem `page` do outro
 * lado, `POST /call` devolve 503 e a preparação falharia por um motivo que não
 * tem nada a ver com o documento. `/health` da ponte expõe `pageConnected`.
 *
 * Devolve o motivo, não um booleano: um `catch` mudo indistinguiria "a ponte
 * ainda está subindo" de "o código está quebrado" — diagnósticos opostos, e o
 * segundo apareceria como o primeiro. (Foi assim que um teste desta função deu
 * falso negativo: a ponte parecia não reconectar, mas a chamada é que estourava
 * por outro motivo, engolido em silêncio.)
 */
async function esperarPonte(teto = 20, passo = 500) {
    let ultimoErro = null;
    for (let tentativa = 0; tentativa < teto; tentativa++) {
        try {
            const res = await fetch(`${BRIDGE_HTTP}/health`);
            const estado = await res.json();
            if (estado.pageConnected) return { ok: true, motivo: "" };
        } catch (err) {
            ultimoErro = err?.message || String(err);
        }
        await new Promise((r) => setTimeout(r, passo));
    }
    return {
        ok: false,
        motivo: ultimoErro ? `último erro: ${ultimoErro}` : "a página não conectou dentro do prazo",
    };
}

/** Chama uma ferramenta da página pela API HTTP pública da ponte. */
async function chamarFerramenta(nome, args = {}) {
    const res = await fetch(`${BRIDGE_HTTP}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nome, args }),
    });
    const corpo = await res.json().catch(() => ({}));
    let conteudo = corpo.content;
    try {
        conteudo = JSON.parse(conteudo);
    } catch {
        /* devolvido como texto: fica como está */
    }
    return { status: res.status, ok: corpo.ok, conteudo };
}

/**
 * CAMADA 1 — a raiz: o kiosk precisa de um documento aberto.
 *
 * Medido neste deployment: `hasActiveDocument: false` e `app.activeView:
 * false`, porque `KIOSK_URL` traz `?part=` — parâmetro que só o NOSSO painel
 * lê. O app abre documento por `?url=`/`?model=` (`startupParams.ts` do
 * Chili3D); `?part=` ele ignora.
 *
 * A consequência não é só estética. `CommandService.checking()` recusa em
 * SILÊNCIO todo comando que não seja `isApplicationCommand` quando não há
 * `activeView` — e `ai.toggleChat` não é. Por isso o botão "AI Assistant" da
 * ribbon nativa estava morto para qualquer usuário, não só para o nosso
 * caminho: o comando morria com `Logger.error("No active document")`, que
 * ninguém vê. Com documento aberto, `activeView` existe e o sistema de
 * comandos inteiro volta a responder.
 *
 * `new_document` é a ferramenta certa para isso: o handler chama
 * `globalThis.app.newDocument()` direto (`documentTools.ts`), sem passar pelo
 * `CommandService` — funciona mesmo sem active view, que é exatamente o estado
 * em que estamos. E ela RECUSA quando já há documento aberto, o que torna a
 * chamada idempotente: depois de um reload, se o IndexedDB restaurar o
 * documento, nada é criado por cima.
 *
 * O preço, dito na cara: o agente passa a encontrar documento aberto no boot.
 * O primeiro passo dele muda de "criar documento" para "usar o documento" — e
 * como não existe ferramenta de fechar documento, um documento novo exige
 * recarregar com outro `?part=`.
 */
async function garantirDocumento(alvo) {
    const parte = parteDaUrl(alvo.url);
    const r = await chamarFerramenta("new_document", parte ? { name: parte } : {});
    const c = r.conteudo;
    if (c && c.documentId) return `criado "${c.name}" (${c.documentId})`;
    if (c && c.error) return `já havia documento: ${c.error}`;
    return `inesperado: status ${r.status} · ${JSON.stringify(c).slice(0, 200)}`;
}

/**
 * Abre o assistente de IA do app, e só por um caminho: `PubSub.pub(
 * "toggleChatPanel")`.
 *
 * O caminho pela ribbon foi MEDIDO e não funciona aqui. `RibbonPushButton`
 * publica `executeCommand`, e o `CommandService` recusa o comando quando não há
 * `activeView` (ver `garantirDocumento`). Clicar no botão — e também
 * `dispatchEvent`, e também publicar `executeCommand` direto — nenhum dos três
 * teve efeito neste kiosk; só o tópico `toggleChatPanel` teve, porque
 * `editor.ts` assina esse tópulo direto, sem passar pelo serviço de comandos.
 * Por isso não existe mais tentativa de clique: ela só adicionaria um caminho
 * que parece funcionar e não funciona.
 *
 * `toggleChatPanel` alterna: se o painel já estiver aberto, publicar de novo o
 * FECHARIA. Por isso a conferência de `chili-ai-chat` vem antes.
 */
async function abrirAssistenteIa(avaliar) {
    const expressao = `(() => {
        if (document.querySelector('chili-ai-chat')) return 'ja-aberto';
        try { globalThis.Chili3dCore.PubSub.default.pub('toggleChatPanel'); return 'pubsub'; }
        catch (err) { return 'falhou: ' + err; }
    })()`;
    const caminho = await avaliar(expressao);

    for (let tentativa = 0; tentativa < 8; tentativa++) {
        if (await avaliar("Boolean(document.querySelector('chili-ai-chat'))")) return `${caminho} · painel aberto`;
        await new Promise((r) => setTimeout(r, 400));
    }
    return `${caminho} · painel NAO apareceu`;
}

/**
 * Envelope à prova de falha: o companheiro NÃO pode morrer por causa da
 * preparação. Uma rejeição não tratada derruba o processo no Node >= 15 — e com
 * ele a vigilância de diálogos (o `alert()` que congela o renderer) e a
 * liberação do download do STEP. Falha em preparar o kiosk é um diagnóstico,
 * não uma queda.
 */
async function prepararKiosk(alvo, avaliar) {
    try {
        return await prepararKioskSeguro(alvo, avaliar);
    } catch (err) {
        linha("preparação do kiosk falhou (o companheiro segue vivo):", err?.message || err);
    }
}

async function prepararKioskSeguro(alvo, avaliar) {
    if (!(await esperarApp(avaliar))) {
        linha("app não ficou pronto em 20 s: documento e IA não foram preparados");
        return;
    }
    const ponte = await esperarPonte();
    if (!ponte.ok) {
        linha("página não reconectou na ponte:", ponte.motivo, "— documento não garantido (a IA segue)");
    } else {
        linha("documento do kiosk:", await garantirDocumento(alvo));
    }
    linha("assistente de IA:", await abrirAssistenteIa(avaliar));
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
            // `prepararKiosk` fala em expressões JavaScript (`avaliar`), não em
            // métodos CDP (`enviar`). Passar `enviar` direto seria sintaticamente
            // válido e semanticamente morto: o CDP receberia "Boolean(...)" como
            // nome de método, responderia com erro, e o `undefined` que voltasse
            // viraria "app não ficou pronto em 20 s" — um diagnóstico certo na
            // forma e errado na causa. É a armadilha que o AGENTS.md registra.
            const avaliar = async (expression) => {
                const r = await enviar("Runtime.evaluate", { expression, returnByValue: true });
                return r?.result?.result?.value;
            };
            await prepararKiosk(alvo, avaliar);
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
