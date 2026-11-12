/**
 * Utilidades compartilhadas pelas suítes do servidor `chili3d`.
 *
 * O que é testado aqui é o arquivo REAL — `chili3d/servidor.mjs` — executado como
 * processo filho, com um relay falso do outro lado. Nada de código copiado à mão
 * dentro do teste: um teste com o código duplicado passaria verde muito tempo
 * depois de o código mudar, que é o pior tipo de teste porque ele não falha, ele
 * mente.
 *
 * Duas peças de infraestrutura moram aqui e em nenhum outro lugar:
 *
 *   - `subirRelay`   relay falso que ANOTA o que recebeu (é assim que se prova
 *                    que `origin` não é repassado e que `authorization` é) e
 *                    encadeia SSE com atraso, para separar stream de buffer;
 *   - `fonteMutada`  cópia do servidor com trocas textuais, que é o que dá valor
 *                    ao resto: sem ela, um verde significa apenas "rodou".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "..");

/**
 * O fonte sob teste. `TESTE_SERVIDOR` aponta para outra cópia — foi assim que a
 * suíte foi validada contra as mutações (onde ela FALHA, que é o que se espera).
 */
export const SERVIDOR = process.env.TESTE_SERVIDOR
    ? path.resolve(process.env.TESTE_SERVIDOR)
    : path.join(RAIZ, "chili3d/servidor.mjs");

export function tmp(prefixo) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

/** Relatório acumulado pelo `checar`. */
export const relatorio = [];

/**
 * Uma asserção. O formato da saída é contrato: `rodarCenario` o parseia para
 * classificar o cenário (`^(ok|FALHOU)\s+(\S+)`), e o `→ motivo` é o que aparece
 * no diagnóstico quando algo quebra.
 */
export function checar(nome, ok, motivo = "") {
    relatorio.push({ nome, ok, motivo });
    console.log(`${ok ? "ok   " : "FALHOU"} ${nome}${ok || !motivo ? "" : ` → ${motivo}`}`);
}

/** Fecha o cenário: imprime o veredicto e sai com código não-zero se falhou. */
export function fim(nomeDaSuite) {
    const ruins = relatorio.filter((c) => !c.ok);
    if (ruins.length === 0) {
        console.log(`VERDE: ${relatorio.length}/${relatorio.length} cenários ok (${nomeDaSuite})`);
    } else {
        console.log(`VERMELHO: ${ruins.length} de ${relatorio.length} cenários falharam (${nomeDaSuite})`);
        for (const r of ruins) console.log(`   ${r.nome}: ${r.motivo}`);
    }
    process.exit(ruins.length ? 1 : 0);
}

/** Porta TCP livre — evita colisão entre suítes rodando em paralelo. */
export function portaLivre() {
    return new Promise((resolucao) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const porta = srv.address().port;
            srv.close(() => resolucao(porta));
        });
    });
}

/**
 * Cria um `dist` de mentira com o suficiente para exercitar o servidor: html,
 * js, css, wasm e um asset em subdiretório.
 */
export function criarDist(dir) {
    const alvo = path.join(dir, "dist");
    fs.mkdirSync(path.join(alvo, "assets"), { recursive: true });
    fs.writeFileSync(
        path.join(alvo, "index.html"),
        '<!doctype html><html><body><div id="app">APP CHILI3D</div></body></html>',
    );
    fs.writeFileSync(path.join(alvo, "main.js"), "console.log('app');\n");
    fs.writeFileSync(path.join(alvo, "estilo.css"), "body{margin:0}\n");
    fs.writeFileSync(path.join(alvo, "kernel.wasm"), "asm\r");
    fs.writeFileSync(path.join(alvo, "assets", "logo.svg"), "<svg></svg>");
    return alvo;
}

/**
 * Relay falso. Grava cada pedido em `recebido` e responde SSE em dois blocos,
 * com o segundo atrasado de propósito: é o que separa stream de buffer.
 */
export function subirRelay() {
    const recebido = [];
    const servidor = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.startsWith("/v1/chat/completions")) {
            if (req.method === "OPTIONS") {
                // Espelha o relay real: 401 sem nenhum Access-Control-*. Se o
                // servidor repassar o preflight em vez de respondê-lo, o cenário
                // correspondente falha — que é exatamente o defeito em questão.
                recebido.push({ metodo: "OPTIONS", url });
                res.writeHead(401, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "API key required for remote API access" }));
                return;
            }
            let corpo = "";
            req.on("data", (c) => (corpo += c));
            req.on("end", () => {
                recebido.push({
                    metodo: req.method,
                    url,
                    authorization: req.headers.authorization || null,
                    contentType: req.headers["content-type"] || null,
                    origin: req.headers.origin ?? null,
                    host: req.headers.host || null,
                    aceitaEncoding: req.headers["accept-encoding"] ?? null,
                    corpo,
                });
                res.writeHead(200, {
                    "content-type": "text/event-stream",
                    "transfer-encoding": "chunked",
                });
                res.write('data: {"delta":"primeiro"}\n\n');
                setTimeout(() => {
                    res.write('data: {"delta":"segundo"}\n\n');
                    res.write("data: [DONE]\n\n");
                    res.end();
                }, 400);
            });
            return;
        }
        if (url.startsWith("/v1/models")) {
            recebido.push({ metodo: req.method, url });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "flashmodel" }] }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rota desconhecida" }));
    });
    return new Promise((resolucao) => {
        servidor.listen(0, "127.0.0.1", () =>
            resolucao({
                servidor,
                porta: servidor.address().port,
                recebido,
                parar: () => new Promise((r) => servidor.close(r)),
            }),
        );
    });
}

/**
 * Sobe o servidor real como processo filho, na porta do APP pedida, com o relay
 * falso no alvo. São duas portas distintas e confundi-las é defeito silencioso: o
 * teste bateria na porta errada e todo cenário daria "connection refused".
 *
 * `relayVazio: true` deixa RELAY_URL deserto — o cenário de despejo sem
 * configuração, que tem que falhar ALTO e explicativo, não em silêncio.
 */
export function subirServidor({ dist, porta, relayPorta, relayVazio = false }) {
    return new Promise((resolucao, rejeicao) => {
        const filho = spawn(process.execPath, [SERVIDOR], {
            env: {
                ...process.env,
                PORT: String(porta),
                DIST_DIR: dist,
                RELAY_URL: relayVazio ? "" : `http://127.0.0.1:${relayPorta}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let boot = "";
        const juntar = (b) => {
            boot += String(b);
        };
        filho.stdout.on("data", juntar);
        filho.stderr.on("data", juntar);
        filho.on("exit", (codigo) => {
            rejeicao(new Error(`servidor saiu com código ${codigo}: ${boot}`));
        });
        resolucao({ filho, boot: () => boot, parar: () => filho.kill("SIGKILL") });
    });
}

/**
 * Copia o servidor aplicando trocas textuais. Se uma troca não pegar, é falha —
 * uma mutação que não se aplica produziria um verde enganoso.
 */
export function fonteMutada(trocas, nome) {
    const original = fs.readFileSync(SERVIDOR, "utf8");
    let mutado = original;
    for (const [de, para] of trocas) {
        if (!mutado.includes(de)) {
            throw new Error(`mutação "${nome}" não se aplica: não achei ${JSON.stringify(de)}`);
        }
        mutado = mutado.replaceAll(de, para);
    }
    const dir = tmp("chili3d-mutacao-");
    const alvo = path.join(dir, "servidor-mutado.mjs");
    fs.writeFileSync(alvo, mutado);
    return alvo;
}

/**
 * Roda um arquivo de cenário em processo filho e devolve
 * `{ nome, estado, falhos, saida, codigo }`.
 *
 * `estado` é "ok", "falhou" (asserção quebrada) ou "quebrou" (exit != 0 sem
 * linha de veredicto — crash, timeout, erro de sintaxe). As três são falha, mas a
 * diferença importa no diagnóstico: um crash com stdout vazio é defeito do
 * próprio cenário, não do código sob teste.
 *
 * `env` existe por causa do teste de mutação: ele precisa apontar
 * `TESTE_SERVIDOR` para a cópia mutada sem sujar o ambiente do processo pai.
 */
export function rodarCenario(arquivo, tempoLimite = 40000, env = {}) {
    return new Promise((resolve) => {
        const filho = spawn(process.execPath, [arquivo], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...env },
        });
        let saida = "";
        const juntar = (b) => {
            saida += String(b);
        };
        filho.stdout.on("data", juntar);
        filho.stderr.on("data", juntar);
        const relogio = setTimeout(() => {
            try {
                filho.kill("SIGKILL");
            } catch {
                /* já morreu */
            }
        }, tempoLimite);
        filho.on("close", (codigo) => {
            clearTimeout(relogio);
            const m = saida.match(/^(ok|FALHOU)\s+(\S+)/m);
            const estado = m ? (m[1] === "ok" ? "ok" : "falhou") : "quebrou";
            const ruins = saida.match(/→ (.+)$/m);
            resolve({
                nome: m ? m[2] : path.basename(arquivo),
                estado,
                falhos: cenariosFalhos(saida),
                ruins: ruins ? ruins[1].trim() : "",
                saida,
                codigo,
            });
        });
    });
}

/**
 * Nomes dos cenários que FALHARAM, lidos da saída.
 *
 * Só os que aparecem como `FALHOU <token>`: a linha de veredicto
 * (`VERMELHO: 3 de 17...`) e o `→ motivo` não entram. É esse conjunto que o
 * teste de mutação compara com o esperado — e comparar conjunto, e não apenas
 * "falhou?", é o que separa uma mutação que prova algo de uma que só faz barulho.
 */
export function cenariosFalhos(saida) {
    const nomes = [];
    for (const linha of saida.split("\n")) {
        const m = /^FALHOU\s+(\S+)/.exec(linha);
        if (m) nomes.push(m[1]);
    }
    return nomes;
}

/** Roda em paralelo com limite, preservando a ordem. */
export async function rodarVarios(arquivos, tempoLimite) {
    const saida = [];
    for (let i = 0; i < arquivos.length; i += 4) {
        const lote = arquivos.slice(i, i + 4).map((a) => rodarCenario(a, tempoLimite));
        saida.push(...(await Promise.all(lote)));
    }
    return saida;
}
