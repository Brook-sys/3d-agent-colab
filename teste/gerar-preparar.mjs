/**
 * Gera os cenários da seção "preparar o kiosk" de `session/kiosk-cdp.mjs`
 * (`esperarApp` → `esperarPonte` → `garantirDocumento` → `abrirAssistenteIa`,
 * dentro do envelope `prepararKiosk`).
 *
 * Como no gerador do `vigiar`: a seção é extraída do arquivo real a cada
 * execução. O que é mockado aqui é o mundo do outro lado — a ponte HTTP, o
 * `avaliar` do CDP e o relógio — nunca o código sob teste.
 *
 * Uso: node teste/gerar-preparar.mjs [fonte] [diretorioDeSaida]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AQUI, FONTE } from "./comum.mjs";

const MOCKS = `
// ---- mocks -----------------------------------------------------------------
const LOG = [];
const linha = (...a) => LOG.push(a.map((x) => String(x)).join(" "));

// O mundo do outro lado: ponte HTTP e o avaliar do CDP. Trocável por cenário.
let cenario = { ponte: "conectada", newDocument: { ok: true, data: { documentId: "doc-1", name: "espacador" } } };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) {
        return { json: async () => ({ pageConnected: cenario.ponte === "conectada" }) };
    }
    if (u.endsWith("/call")) {
        if (cenario.ponte !== "conectada") {
            return { status: 503, json: async () => ({ ok: false, content: '{"error":"no page"}' }) };
        }
        const corpo = JSON.parse(opts.body);
        if (corpo.name !== "new_document") {
            return { status: 200, json: async () => ({ ok: false, content: JSON.stringify({ error: "ferramenta inexistente" }) }) };
        }
        dom.ultimoArgs = corpo.args;
        return { status: 200, json: async () => ({ ok: cenario.newDocument.ok, content: JSON.stringify(cenario.newDocument.data) }) };
    }
    throw new Error("fetch inesperado: " + u);
};

// O avaliar recebe UMA expressão JavaScript — é o contrato que a seção usa.
// ultimoArgs guarda os argumentos do último new_document: é assim que os
// cenários conferem se a ?part= da URL virou nome do documento.
const dom = { appPronto: true, iaAberta: false, pubsubFalha: false, pubsubChamado: 0, ultimoArgs: null };
const avaliar = async (expr) => {
    if (expr.includes("document.querySelector('chili-ribbon')")) return dom.appPronto;
    if (expr.startsWith("Boolean(document.querySelector('chili-ai-chat'))")) return dom.iaAberta;
    if (expr.includes("chili-ai-chat')) return 'ja-aberto'")) {
        if (dom.iaAberta) return "ja-aberto";
        if (dom.pubsubFalha) return "falhou: Error: PubSub morto";
        dom.pubsubChamado += 1;
        setTimeout(() => { dom.iaAberta = true; }, 150);
        return "pubsub";
    }
    return "EXPRESSAO-DESCONHECIDA";
};

const real = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...r) => real(fn, Math.max(1, Math.round((ms || 0) / 100)), ...r);

function zerar(c) {
    LOG.length = 0;
    cenario = c;
    dom.appPronto = true;
    dom.iaAberta = false;
    dom.pubsubFalha = false;
    dom.pubsubChamado = 0;
    dom.ultimoArgs = null;
}
`;

// A `?part=` NÃO abre peça do registro — nenhum parâmetro de URL abre. O único
// que ainda a lê é o `parteDaUrl` do companheiro CDP, e só para dar NOME ao
// documento que ele cria no boot (`new_document({ name: parte })`). A distinção
// entre os dois alvos é exatamente essa, e por isso ela continua tendo teste:
// com `?part=` a ferramenta recebe o nome; sem, recebe `{}`.
const ALVO = "http://core:9001/?bridge=&part=espacador";
const ALVO_SEM_PARTE = "http://core:9001/?bridge=";

const CENARIOS = [
    {
        nome: "1-caminho-feliz",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: { documentId: "doc-1", name: "espacador" } } }`,
        asserts: `
            criouDocumento: /documento do kiosk: criado "espacador" \\(doc-1\\)/.test(log()),
            iaAbriu: /assistente de IA: pubsub · chat aberto/.test(log()),
            pubsubUmaVez: dom.pubsubChamado === 1,
            passouONomeDaUrl: dom.ultimoArgs && dom.ultimoArgs.name === "espacador",
        `,
    },
    {
        // `new_document` RECUSA quando já há documento: a chamada é idempotente,
        // e a recusa tem que aparecer como diagnóstico, não como silêncio.
        nome: "2-documento-ja-existia",
        cenario: `{ ponte: "conectada", newDocument: { ok: false, data: { error: "a document is already open" } } }`,
        asserts: `
            recusouSemQuebrar: /já havia documento: a document is already open/.test(log()),
            iaAbriu: /chat aberto/.test(log()),
        `,
    },
    {
        // Sem ponte não há documento — mas a IA segue: o painel não depende da
        // ponte, depende do CDP.
        nome: "3-ponte-nao-reconecta",
        cenario: `{ ponte: "fraca", newDocument: { ok: true, data: {} } }`,
        asserts: `
            avisouPonte: /página não reconectou na ponte/.test(log()),
            iaAindaAbre: /chat aberto/.test(log()),
            naoCriouDocumento: !/documento do kiosk: criado/.test(log()),
        `,
    },
    {
        // app não ficou de pé: nem documento nem IA, com o motivo dito — e a
        // mensagem diz "20 s", que é o que o log promete.
        nome: "4-app-nao-fica-pronto",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: {} } }`,
        antes: "dom.appPronto = false;",
        asserts: `
            desistiuComAviso: /app não ficou pronto em 20 s: documento e IA não foram preparados/.test(log()),
            naoTentouIa: !/assistente de IA/.test(log()),
        `,
    },
    {
        // `toggleChatPanel` alterna: publicar com o painel aberto o FECHARIA.
        nome: "5-ia-ja-aberta",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: { documentId: "d", name: "espacador" } } }`,
        antes: "dom.iaAberta = true;",
        asserts: `
            naoFechouPorEngano: /assistente de IA: ja-aberto · chat aberto/.test(log()),
            pubsubNaoChamado: dom.pubsubChamado === 0,
        `,
    },
    {
        nome: "6-pubsub-quebrado",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: { documentId: "d", name: "espacador" } } }`,
        antes: "dom.pubsubFalha = true;",
        asserts: `
            diagnosticou: /assistente de IA: falhou: Error: PubSub morto · chat NAO apareceu/.test(log()),
            documentoAindaCriado: /criado "espacador"/.test(log()),
        `,
    },
    {
        // Sem `?part=` a ferramenta é chamada sem argumentos: o documento nasce
        // sem nome, e o log não pode dizer que houve erro.
        nome: "7-sem-part-na-url",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: { documentId: "d", name: "sem-nome" } } }`,
        semParte: true,
        asserts: `
            chamouSemArgs: /criado "sem-nome"/.test(log()),
            semAvisoDeErro: !/inesperado|falhou/.test(log()),
        `,
    },
    {
        // O envelope: uma exceção no meio da preparação não pode derrubar o
        // processo — com ele morrem o tratamento de diálogo e o download.
        nome: "8-envelope-aguenta-excecao",
        cenario: `{ ponte: "conectada", newDocument: { ok: true, data: { documentId: "d", name: "espacador" } } }`,
        antes: `const originalFetch = globalThis.fetch;
        let chamadas = 0;
        globalThis.fetch = async (...a) => { chamadas += 1; if (chamadas >= 2) throw new Error("ponte caiu no meio"); return originalFetch(...a); };`,
        asserts: `
            naoEstourou: !estourou,
            avisouNoLog: log().includes("preparação do kiosk falhou"),
        `,
    },
];

/** Extrai a seção entre o marcador e `listarPaginas`. */
export function extrair(fonte) {
    const linhas = fs.readFileSync(fonte, "utf8").split("\n");
    const inicio = linhas.findIndex((l) => l.startsWith("/* ---") && l.includes("preparar o kiosk"));
    const fim = linhas.findIndex((l) => l.startsWith("async function listarPaginas"));
    if (inicio === -1 || fim === -1 || fim <= inicio) {
        throw new Error(`fronteiras não encontradas (marcador em ${inicio}, listarPaginas em ${fim})`);
    }
    return linhas.slice(inicio, fim).join("\n");
}

export function gerar(fonte, saida) {
    const secao = extrair(fonte);
    fs.mkdirSync(saida, { recursive: true });
    const escritos = [];
    for (const c of CENARIOS) {
        const cena = `
// ---- cenário ----------------------------------------------------------------
const alvo = { url: ${JSON.stringify(ALVO)} };
const alvoSemParte = { url: ${JSON.stringify(ALVO_SEM_PARTE)} };
const log = () => LOG.join(" | ");

zerar(${c.cenario});
${c.antes || "// sem ajuste de DOM"}

const alvoUsado = ${c.semParte ? "alvoSemParte" : "alvo"};
let estourou = false;
try {
    await prepararKiosk(alvoUsado, avaliar);
} catch (err) {
    // A exceção escapando do envelope É a falha deste teste, mas capturada:
    // capturada ela vira mais uma asserção quebrada, com o log do lado.
    estourou = true;
    LOG.push("EXCEÇÃO ESCAPOU DO ENVELOPE: " + (err?.message || err));
}

const r = {
    ${c.asserts}
};
const ruins = Object.entries(r).filter(([, v]) => v !== true).map(([k]) => k);
console.log((ruins.length ? "FALHOU  " : "ok      ") + ${JSON.stringify(c.nome)} + "  (" + Object.keys(r).length + " asserções)" + (ruins.length ? "  → " + ruins.join(", ") : ""));
console.log("   log: " + (log() || "(vazio)"));
`;
        const corpo = MOCKS + "\n" + secao + "\n" + cena;
        if (corpo.includes("@@")) throw new Error("placeholder não resolvido em " + c.nome);
        const arquivo = path.join(saida, `preparar-${c.nome}.mjs`);
        fs.writeFileSync(arquivo, corpo);
        escritos.push(arquivo);
    }
    return escritos;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const fonte = process.argv[2] || FONTE;
    const saida = process.argv[3] || path.join(AQUI, ".gerado-preparar");
    console.log(`${gerar(fonte, saida).length} cenários em ${saida}`);
}
