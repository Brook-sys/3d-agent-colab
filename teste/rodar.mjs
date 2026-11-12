/**
 * Entrada única dos testes do servidor `chili3d`: `node teste/rodar.mjs`.
 *
 * Duas etapas, e a segunda é a que dá valor à primeira:
 *
 *  1. suítes `estático` e `proxy` contra o fonte real — o verde aqui diz apenas
 *     "rodou";
 *  2. teste de MUTAÇÃO: para cada defeito que estes testes existem para impedir,
 *     introduzo o defeito de propósito no servidor e exijo que a suíte falhe
 *     EXATAMENTE nos cenários previstos.
 *
 * A segunda etapa é o que impede o pior tipo de suíte: a que passa verde porque
 * os cenários são vaculos. Um exemplo concreto, ocorrido aqui: o cenário
 * `relay-nao-recebe-origin` passava verde porque o `fetch` do Node não põe
 * `Origin` sozinho — o proxy poderia estar repassando tidy o que nunca veio, e
 * a asserção nunca veria a diferença. Foi pensando "o que esta mutação quebraria?"
 * que a vacuidade apareceu. Sem a mutação, ela passaria para sempre.
 *
 * Se uma mutação NÃO quebrar o esperado, o runner falha: significa que os
 * cenários não vedam aquele defeito, e o conserto é no teste, não no runner.
 */

import fs from "node:fs";
import path from "node:path";
import { AQUI, RAIZ, rodarCenario } from "./comum.mjs";

const SUITES = [
    { arquivo: path.join(AQUI, "estatico.mjs"), nome: "estático" },
    { arquivo: path.join(AQUI, "proxy.mjs"), nome: "proxy" },
];

/** Resultado de uma mutação: quais cenários deveriam cair, e quais caíram. */
const mutacoes = [
    {
        nome: "origin-repassado",
        porque:
            "o proxy repassa o `origin` do navegador. O relay exigiria chave por causa da origem — é o sintoma original, com outro nome.",
        trocas: [
            [
                '    "origin", // somos o servidor, não o navegador: sem origin não há CORS no meio\n',
                "",
            ],
        ],
        espera: ["relay-nao-recebe-origin"],
    },
    {
        nome: "preflight-repassado",
        porque:
            "o preflight de /v1/ vai para o relay, que responde 401 seco. É exatamente como o sintoma nasceu.",
        trocas: [
            [
                '            if (req.method === "OPTIONS") {\n                preflight(res);\n                return;\n            }\n            const resto',
                "            const resto",
            ],
        ],
        // `preflight-acao` NÃO está na lista, e isso é deliberado: com o preflight
        // repassado, o proxy ainda injeta `Access-Control-Allow-Origin` na
        // resposta 401 do relay (é a linha `volta[...] = CORS_ORIGEM`). O
        // cabeçalho de origem sobrevive à mutação; o que morre é o 204, o
        // allow-headers e o allow-methods, que só o `preflight()` escreve.
        // Exigir a queda de `preflight-acao` aqui seria exigir algo que o código
        // certo de fato não faz.
        espera: [
            "preflight-nao-repassado",
            "preflight-acah",
            "preflight-acam",
        ],
    },
    {
        nome: "sem-fallback-de-spa",
        porque:
            "rotas sem extensão do app dão 404 em vez do index. Atualizar a página numa rota interna do app quebraria — e o sintoma não aponta para o servidor.",
        trocas: [
            [
                'const arquivo = semExtensao ? path.join(DIST, "index.html") : alvo;',
                'const arquivo = alvo === DIST ? path.join(DIST, "index.html") : alvo;',
            ],
            [
                'if (semExtensao && fs.existsSync(path.join(DIST, "index.html"))) {',
                "if (false) {",
            ],
        ],
        espera: ["rota-sem-extensao-devolve-index", "rota-profunda-devolve-index"],
    },
    {
        nome: "resposta-bufferizada",
        porque:
            "a resposta do relay é acumulada antes de ser devolvida. O assistente é conversa: cada token só chegaria no fim, e a travessia pareceria lenta em vez de errada.",
        trocas: [
            [
                '            res.writeHead(resposta.statusCode, volta);\n            resposta.pipe(res);',
                '            let acumulado = [];\n            resposta.on("data", (pedaco) => acumulado.push(pedaco));\n            resposta.on("end", () => {\n                res.writeHead(resposta.statusCode, volta);\n                res.end(Buffer.concat(acumulado));\n            });',
            ],
        ],
        espera: ["primeiro-bloco-nao-bufferizado"],
    },
    {
        nome: "sem-cors-na-resposta",
        porque:
            "a resposta do proxy sai sem Access-Control-Allow-Origin. O assistente apontando para outro host na mesma rede voltaria a ser barrado.",
        trocas: [['            volta["access-control-allow-origin"] = CORS_ORIGEM;\n', ""]],
        espera: ["resposta-proxy-tem-acao"],
    },
    {
        nome: "sem-saneamento-de-caminho",
        porque:
            "o caminho da URL é resolvido sem normalize e sem a guarda de prefixo. `/%2e%2e/` ou `/assets/..%2f` lê arquivo fora do dist — furos de travessia clássicos, e silenciosos.",
        trocas: [
            [
                'const alvo = path.resolve(DIST, "." + path.posix.normalize(decodificado));',
                'const alvo = path.resolve(DIST, "." + decodificado);',
            ],
            [
                "    if (alvo !== DIST && !alvo.startsWith(DIST + path.sep)) return null;",
                "    if (false) return null;",
            ],
        ],
        espera: ["travessia-barrada-1", "travessia-barrada-2", "travessia-barrada-3"],
    },
];

/** Aplica as trocas textuais de uma mutação e devolve o caminho da cópia. */
function fonteMutada(mutacao) {
    const original = fs.readFileSync(path.join(RAIZ, "chili3d/servidor.mjs"), "utf8");
    let mutado = original;
    for (const [de, para] of mutacao.trocas) {
        if (!mutado.includes(de)) {
            throw new Error(
                `mutação "${mutacao.nome}" não se aplica: não achei ${JSON.stringify(de.slice(0, 60))}`,
            );
        }
        mutado = mutado.replaceAll(de, para);
    }
    const dir = fs.mkdtempSync(path.join("/tmp", "chili3d-mutacao-"));
    const alvo = path.join(dir, "servidor.mjs");
    fs.writeFileSync(alvo, mutado);
    return { alvo, dir };
}

/** Compara dois conjuntos de nomes. A ORDEM não importa; a diferença, sim. */
function diferenca(a, b) {
    const faltando = b.filter((x) => !a.includes(x));
    const sobrando = a.filter((x) => !b.includes(x));
    return { faltando, sobrando };
}

const linhas = [];
function dizer(texto) {
    linhas.push(texto);
    console.log(texto);
}

// ---------------------------------------------------------------- etapa 1
dizer("=== ETAPA 1: suítes contra o fonte real ===\n");
const etapas = [];
for (const suite of SUITES) {
    const r = await rodarCenario(suite.arquivo);
    etapas.push(r);
    dizer(`${suite.nome}: ${r.estado === "ok" ? "VERDE" : "VERMELHO"} (${r.saida.match(/VER\w+: .*/)?.[0] || r.estado})`);
    if (r.estado !== "ok" && r.saida) dizer(r.saida.trim().split("\n").slice(0, 25).join("\n"));
}

// ---------------------------------------------------------------- etapa 2
dizer("\n=== ETAPA 2: teste de mutação ===\n");
const veredictos = [];
for (const mutacao of mutacoes) {
    let alvo;
    let dir;
    try {
        ({ alvo, dir } = fonteMutada(mutacao));
    } catch (erro) {
        veredictos.push({ mutacao, estado: "não-aplica", detalhe: erro.message });
        continue;
    }

    const resultados = [];
    for (const suite of SUITES) {
        resultados.push(await rodarCenario(suite.arquivo, 40000, { TESTE_SERVIDOR: alvo }));
    }
    fs.rmSync(dir, { recursive: true, force: true });

    // Só contam as suítes que pelo menos rodaram: uma que QUE BROU (crash) não
    // produz conjunto de falhos para comparar, e seria desonesto contar isso
    // como "a mutação quebrou os cenários certos".
    const quebrou = resultados.filter((r) => r.estado === "quebrou");
    const falhos = [...new Set(resultados.flatMap((r) => r.falhos))];
    const { faltando, sobrando } = diferenca(falhos, mutacao.espera);

    let estado;
    let detalhe;
    if (quebrou.length > 0) {
        estado = "quebrou";
        detalhe = quebrou.map((q) => `${q.nome}: ${q.ruins || q.saida.slice(0, 200)}`).join(" | ");
    } else if (faltando.length > 0 && sobrando.length === 0) {
        estado = "parcial";
        detalhe = `quebrou só ${falhos.length} de ${mutacao.espera.length}: faltou ${faltando.join(", ")}`;
    } else if (faltando.length > 0) {
        estado = "divergente";
        detalhe = `quebrou ${falhos.join(", ")} — esperava ${mutacao.espera.join(", ")}`;
    } else if (sobrando.length > 0) {
        estado = "ruidosa";
        detalhe = `quebrou ${falhos.join(", ")} — mais do que o previsto (${mutacao.espera.join(", ")})`;
    } else {
        estado = "prova";
        detalhe = `${falhos.length} cenário(s) caíram, exatamente os previstos`;
    }
    veredictos.push({ mutacao, estado, detalhe, falhos });
}

// -------------------------------------------------------------- resumo
dizer("");
for (const v of veredictos) {
    const marca = { prova: "ok  ", parcial: "FALH", divergente: "FALH", ruidosa: "FALH", quebrou: "FALH", "não-aplica": "FALH" }[v.estado];
    dizer(`${marca} ${v.mutacao.nome}: ${v.detalhe}`);
    if (v.estado !== "prova") dizer(`     porque: ${v.mutacao.porque}`);
}

const etapa1Ok = etapas.every((e) => e.estado === "ok");
const etapa2Ok = veredictos.every((v) => v.estado === "prova");
const ruins = veredictos.filter((v) => v.estado !== "prova").length;

dizer(`\n${etapa1Ok && etapa2Ok ? "VERDE" : "VERMELHO"}: ${SUITES.length} suítes ok e ${veredictos.length - ruins} de ${veredictos.length} mutações provadas`);

if (!etapa1Ok) dizer("\nas suítes contra o fonte real falharam — conserte isso antes de olhar as mutações");
if (!etapa2Ok) dizer("\numa mutação não quebrou o que deveria: os cenários não vedam aquele defeito");

process.exit(etapa1Ok && etapa2Ok ? 0 : 1);
