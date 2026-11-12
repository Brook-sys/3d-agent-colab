/**
 * Gera os cenários de `vigiar` + laço externo de `session/kiosk-cdp.mjs`.
 *
 * A seção testada é EXTRAÍDA DO ARQUIVO REAL em cada execução. Um teste com o
 * código copiado à mão passaria verde muito tempo depois de o código mudar, que
 * é o pior tipo de teste: ele não falha, ele mente.
 *
 * O laço infinito (`for (;;)`) vira `for (let v = 0; v < VOLTAS; v++)` e cada
 * `await vigiar(...)` é embrulhado num `corrida()` com prazo. Sem as duas
 * trocas a última volta do laço ficaria pendurada — a promessa não resolve
 * enquanto ninguém fecha o socket — e as asserções nunca rodariam. Foi
 * exatamente o que aconteceu na primeira versão deste gerador.
 *
 * Uso: node teste/gerar-vigiar.mjs [fonte] [diretorioDeSaida]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AQUI, RAIZ, FONTE } from "./comum.mjs";

const MOCKS = `
// ---- mocks -----------------------------------------------------------------
// O detalhe que faz este teste valer a pena: o socket real emite "open" de
// forma ASSÍNCRONA. Sem esse agendamento o handler de open nunca roda, os
// cenários passam sem exercitar nada, e o node --check não reclama de nada.
const LOG = [];
const linha = (...a) => LOG.push(a.map((x) => String(x)).join(" "));
const CAPTURAS = "/tmp/capturas-falso";
const CDP_HTTP = "http://127.0.0.1:9222";
const ALVO = "http://core:9001/?bridge=";

const real = globalThis.setTimeout;
// Tempos encolhidos por 100: a rede de segurança de 12 s vira 120 ms, a pausa
// do laço vira 3 ms. O teste precisa rodar em segundos, não em minutos.
globalThis.setTimeout = (fn, ms, ...r) => real(fn, Math.max(1, Math.round((ms || 0) / 100)), ...r);

class FakeWS {
    constructor(url) {
        this.url = url;
        this.handlers = {};
        this.enviados = [];
        this.fechado = false;
        FakeWS.instancias.push(this);
        real(() => {
            this.emitir("open");
        }, 1);
    }
    on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
    async emitir(ev, ...args) { for (const cb of (this.handlers[ev] || []).slice()) await cb(...args); }
    send(str) {
        const m = JSON.parse(str);
        this.enviados.push(m.method);
        this.emitir("message", JSON.stringify({ id: m.id, result: {} }));
    }
    close() { if (this.fechado) return; this.fechado = true; this.emitir("close"); }
}
FakeWS.instancias = [];
const WS = FakeWS;

let PEDIDOS = [];
const lerPedidos = async () => { const p = PEDIDOS; PEDIDOS = []; return p; };

const PREPARACOES = [];
// O roteiro de cada cenário roda aqui dentro: é o único momento em que a sessão
// já está aberta e pronta para receber eventos de página.
const prepararKiosk = async (alvo) => {
    PREPARACOES.push(alvo.url);
    if (typeof ROTEIRO === "function") {
        await ROTEIRO(FakeWS.instancias[PREPARACOES.length - 1]);
    }
};

const listarPaginas = async () => [{ type: "page", url: ALVO, webSocketDebuggerUrl: "ws://falso/page" }];

// Prazo só do teste: na última volta não há quem feche o socket.
const corrida = (p) => Promise.race([p, new Promise((r) => real(r, 1500))]);

const ROTEIRO = null;
const VOLTAS = 1;
`;

// Cada roteiro age sobre o socket da sessão que acabou de ser preparada.
const CENARIOS = [
    {
        nome: "1-boot-quieto",
        voltas: 1,
        roteiro: "async (s) => { s.close(); }",
        asserts: [
            ["umaConexao", "FakeWS.instancias.length === 1"],
            ["umaPreparacao", "PREPARACOES.length === 1"],
            ["semNavegacaoNoLog", "!LOG.some((l) => l.includes('página navegou'))"],
            ["downloadConfigurado", "FakeWS.instancias[0].enviados.includes('Page.setDownloadBehavior')"],
        ],
    },
    {
        // O defeito de produção, em miniatura: navegação no MESMO alvo não fecha
        // o socket, e o companheiro ficava preso a uma sessão que nunca mais
        // reconfigurava nada — só um restart do container o soltava.
        nome: "2-navegacao-reconfigura",
        voltas: 2,
        roteiro: `async (s) => {
            await s.emitir("message", JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "F1", url: ALVO } } }));
            await s.emitir("message", JSON.stringify({ method: "Page.loadEventFired" }));
        }`,
        asserts: [
            ["reconectou", "FakeWS.instancias.length === 2"],
            ["preparouDuasVezes", "PREPARACOES.length === 2"],
            ["avisouNoLog", "LOG.some((l) => l.includes('página navegou'))"],
            ["reaplicouDownload", "(FakeWS.instancias[1] || { enviados: [] }).enviados.includes('Page.setDownloadBehavior')"],
            ["fechouASessaoVelha", "FakeWS.instancias[0].fechado === true"],
        ],
    },
    {
        nome: "3-iframe-nao-reconfigura",
        voltas: 1,
        roteiro: `async (s) => {
            await s.emitir("message", JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "IF", parentId: "F1", url: "http://outra/" } } }));
            await new Promise((r) => real(r, 40));
            s.close();
        }`,
        asserts: [
            ["continuouNaMesma", "FakeWS.instancias.length === 1"],
            ["semReconfigurar", "!LOG.some((l) => l.includes('página navegou'))"],
        ],
    },
    {
        nome: "4-dialogo-e-fechado",
        voltas: 1,
        roteiro: `async (s) => {
            await s.emitir("message", JSON.stringify({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: "opa" } }));
            await s.emitir("message", JSON.stringify({ method: "Page.downloadProgress", params: { state: "completed" } }));
            await new Promise((r) => real(r, 20));
            s.close();
        }`,
        asserts: [
            ["fechouDialogo", "FakeWS.instancias[0].enviados.includes('Page.handleJavaScriptDialog')"],
            ["avisouDownload", "LOG.some((l) => l.includes('download concluído'))"],
            ["naoReconfigurou", "FakeWS.instancias.length === 1"],
        ],
    },
    {
        nome: "5-pedido-de-recarga",
        voltas: 2,
        pedido: true,
        roteiro: "async (s) => { s.close(); }",
        asserts: [
            ["recarregou", "(FakeWS.instancias[0] || { enviados: [] }).enviados.includes('Page.reload')"],
            ["reconectou", "FakeWS.instancias.length === 2"],
            ["preparouNaVoltaSeguinte", "PREPARACOES.length === 1"],
            ["avisouPedido", "LOG.some((l) => l.includes('recarregando a página a pedido'))"],
            ["semPrepararInterrompida", "!LOG.some((l) => l.includes('app não ficou pronto'))"],
        ],
    },
    {
        // O caminho que funcionava antes da correção: socket fechado.
        nome: "6-socket-fechado",
        voltas: 2,
        roteiro: "async (s) => { s.close(); }",
        asserts: [
            ["reconectou", "FakeWS.instancias.length === 2"],
            ["preparouDuasVezes", "PREPARACOES.length === 2"],
        ],
    },
    {
        // `loadEventFired` não vem (navegação abortada, download). Sem a rede de
        // 12 s a conexão emperraria de novo — o defeito que a correção cura.
        nome: "7-seguranca-sem-load",
        voltas: 2,
        roteiro: `async (s) => {
            await s.emitir("message", JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "F1", url: ALVO } } }));
        }`,
        asserts: [
            ["reconfigurouMesmoAssim", "FakeWS.instancias.length === 2"],
            ["avisouOMotivo", "LOG.some((l) => l.includes('não sinalizou'))"],
        ],
    },
    {
        // Evento malformado não pode derrubar o handler: com o processo morto,
        // morrem juntos o tratamento de diálogo e a liberação do download.
        nome: "8-evento-malformado",
        voltas: 1,
        roteiro: `async (s) => {
            await s.emitir("message", "{isto não é json");
            await new Promise((r) => real(r, 20));
            s.close();
        }`,
        asserts: [
            ["seguiuVivo", "FakeWS.instancias.length === 1"],
            ["avisouNoLog", "LOG.some((l) => l.includes('evento ignorado'))"],
        ],
    },
];

/** Extrai `vigiar` + o laço externo, do fim do comentário até o fim do arquivo. */
export function extrair(fonte) {
    const linhas = fs.readFileSync(fonte, "utf8").split("\n");
    const inicio = linhas.findIndex((l) => l.startsWith("function vigiar("));
    if (inicio === -1) throw new Error("não achei `function vigiar(` em " + fonte);
    const trecho = linhas.slice(inicio).join("\n");
    if (!trecho.includes("for (;;) {")) throw new Error("não achei o laço externo `for (;;) {`");
    return trecho.replace("for (;;) {", "for (let v = 0; v < VOLTAS; v++) {");
}

/**
 * A corrida é aplicada na forma que existir no arquivo: o código atual escreve
 * `await vigiar(alvo).catch(...)` e uma versão anterior escrevia
 * `await vigiar(alvo);`. Sem esse desvio a comparação contra o código antigo
 * penduraria pelo motivo errado — o teste acusaria falha onde a única
 * diferença é a forma de escrever.
 *
 * O argumento da corrida é a PROMISSA, não um `await` dela: `corrida(await p)`
 * resolveria o p antes de correr, e a corrida não protegeria nada.
 */
function emCorrida(forma) {
    return "await corrida(" + forma.replace(/^await\s+/, "").replace(/;$/, "") + ");";
}

export function gerar(fonte, saida) {
    let trecho = extrair(fonte);
    let encontrouForma = 0;
    for (const forma of [
        "await vigiar(alvo).catch(() => {});",
        "await vigiar(alvo, true).catch(() => {});",
        "await vigiar(alvo);",
        "await vigiar(alvo, true);",
    ]) {
        if (trecho.includes(forma)) {
            trecho = trecho.split(forma).join(emCorrida(forma));
            encontrouForma++;
        }
    }
    if (encontrouForma < 2) {
        throw new Error(
            "esperava encontrar as duas chamadas do vigiar no laço, encontrei " +
                encontrouForma +
                " — o código mudou de forma e o teste não exercita o laço atual"
        );
    }

    fs.mkdirSync(saida, { recursive: true });
    const escritos = [];
    for (const c of CENARIOS) {
        const asserts = c.asserts.map(([nome, expr]) => `["${nome}", ${JSON.stringify(expr)}]`).join(",\n        ");
        const mocks = MOCKS.replace("const VOLTAS = 1;", `const VOLTAS = ${c.voltas};`)
            .replace("const ROTEIRO = null;", `const ROTEIRO = ${c.roteiro};`)
            .replace(
                "let PEDIDOS = [];",
                c.pedido ? `let PEDIDOS = [{ acao: "recarregar" }];` : "let PEDIDOS = [];"
            );
        const final = `
// ---- asserções --------------------------------------------------------------
const checks = [
        ${asserts},
    ];
const ruins = checks.filter(([nome, expr]) => {
    let v;
    try { v = eval(expr); } catch (e) { v = false; }
    return v !== true;
}).map(([nome]) => nome);
console.log((ruins.length ? "FALHOU  " : "ok      ") + ${JSON.stringify(c.nome)} + "  (" + checks.length + " asserções)" + (ruins.length ? "  → " + ruins.join(", ") : ""));
console.log("   log: " + (LOG.join(" | ") || "(vazio)"));
console.log("   sessões: " + FakeWS.instancias.length + " | preparações: " + PREPARACOES.length);
`;
        const corpo = mocks + "\n" + trecho + "\n" + final;
        if (corpo.includes("@@")) throw new Error("placeholder não resolvido em " + c.nome);
        const arquivo = path.join(saida, `vigiar-${c.nome}.mjs`);
        fs.writeFileSync(arquivo, corpo);
        escritos.push(arquivo);
    }
    return escritos;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const fonte = process.argv[2] || FONTE;
    const saida = process.argv[3] || path.join(AQUI, ".gerado-vigiar");
    console.log(`${gerar(fonte, saida).length} cenários em ${saida}`);
}
