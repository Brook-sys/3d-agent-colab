// Servidor do container `chili3d`.
//
// Duas coisas, e só duas:
//
//   1. servir o app Chili3D original, tal qual vem do commit fixado em
//      chili3d.ref — nenhum fork, nenhum plugin, nenhum painel;
//   2. encaminhar `/v1/*` para o relay de IA, para que o assistente nativo
//      fale com ele pela MESMA ORIGEM da página.
//
// O segundo item é a correção do "Erro: Connection error." e merece explicação,
// porque a causa não é óbvia e já fez gente caçar defeito no lugar errado.
//
// MEDIDO (Chromium 131 headless, dentro da rede Docker, contra o relay):
//
//   OPTIONS /v1/chat/completions  ->  401
//     {"error":"API key required for remote API access"}
//     ...e ZERO cabeçalhos Access-Control-Allow-*.
//
// O assistente usa o SDK da OpenAI no navegador (dangerouslyAllowBrowser) e manda
// `authorization` + `content-type: application/json`. Dois headers não-simples
// exigem preflight, e preflight NÃO carrega chave — o Chrome o gera sozinho. Sem
// 2xx + Access-Control-Allow-Origin no preflight, o Chrome nem manda o POST: o
// fetch estoura, o SDK embrulha em APIConnectionError e a mensagem padrão dessa
// classe é literalmente "Connection error.".
//
// Por que não adianta configurar o relay: a isenção de chave dele só vale para
// origem local (127.0.0.1/localhost/::1 — o conjunto `aM` do middleware). Qualquer
// outro endereço, incluindo IP da rede Docker, exige chave, e o preflight não tem
// onde carregar uma. Não há configuração do lado do navegador que resolva.
//
// A saída é fazer o pedido sair da própria origem da página: aí não existe
// preflight. É o que este servidor faz. Ele fala com o relay como cliente
// comum, sem `origin`, e repassa o cabeçalho `authorization` que o próprio
// usuário colou no assistente — a chave não mora em lugar nenhum.
//
// Este servidor também responde o preflight de /v1/ CORRETAMENTE (204 com os
// três cabeçalhos), de modo que apontar o assistente para outro host na mesma
// rede continua funcionando. A falha de CORS do relay não precisa virar a nossa.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Onde está o `dist` compilado do Chili3D. */
export const DIST = process.env.DIST_DIR || path.join(AQUI, "dist");

/** Raiz do relay, sem `/v1`: o `/v1` é este servidor que põe. */
export const RELAY = (process.env.RELAY_URL || "").replace(/\/+$/, "");

/** Porta do assistente no navegador do usuário. */
export const PORTA = Number(process.env.PORT || 8080);

/** Origem devolvida nos cabeçalhos CORS que este servidor emite. */
const CORS_ORIGEM = process.env.CORS_ORIGEM || "*";

/**
 * Quanto esperar o relay antes de desistir.
 *
 * Não é enfeite: sem isto, um relay que aceita a conexão e nunca responde deixa
 * o socket pendurado aqui para sempre. O assistente tem o seu próprio tempo de
 * espera, mas o socket do servidor ficaria aberto — e bastariam alguns pedidos
 * desses para esgotar o que der e vier.
 */
const RELAY_TIMEOUT = Number(process.env.RELAY_TIMEOUT || 60000);

/**
 * Tamanho máximo do corpo encaminhado ao relay.
 *
 * O assistente manda conversa: alguns KB. Um corpo grande vindo de quem alcança
 * a porta 8080 não é pedido legítimo, e encaminhá-lo seria emprestar o relay
 * para um terceiro. 1 MB é ordem de grandeza acima de qualquer pedido real.
 */
const CORPO_MAX = Number(process.env.CORPO_MAX || 1024 * 1024);

const TIPOS = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
};

/** Cabeçalhos que não se repassam em nenhum dos dois sentidos. */
const IDA_PROIBIDOS = new Set([
    "host", // o do relay, não o do navegador
    "origin", // somos o servidor, não o navegador: sem origin não há CORS no meio
    "referer",
    "connection",
    "keep-alive",
    "content-length", // o node recalcula ao encaminhar o corpo
    "accept-encoding", // sem compactação o stream de SSE chega inteiro e na hora
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
]);

const VOLTA_PROIBIDOS = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding", // o node reencadeia sozinho
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
]);

function log(mensagem) {
    const quando = new Date().toISOString();
    process.stdout.write(`[chili3d] ${quando} ${mensagem}\n`);
}

/** Tipo de conteúdo pela extensão; `application/octet-stream` no desconhecido. */
function tipoDe(caminho) {
    return TIPOS[path.extname(caminho).toLowerCase()] || "application/octet-stream";
}

/**
 * Traduz a URL pedida em caminho de arquivo dentro de DIST, ou `null` se sairia
 * de lá. A checagem é pelo caminho RESOLVIDO, não pelo texto: `..%2f` e
 * `..%5c` já vêm decodificados pelo `decodeURIComponent`, e comparar strings
 * antes de resolver é o erro clássico que deixa escapar `../`.
 */
function resolverEstatico(urlPath) {
    let decodificado;
    try {
        decodificado = decodeURIComponent(urlPath);
    } catch {
        return null;
    }
    const alvo = path.resolve(DIST, "." + path.posix.normalize(decodificado));
    if (alvo !== DIST && !alvo.startsWith(DIST + path.sep)) return null;
    return alvo;
}

/** Resposta de erro em JSON, com o motivo em português e o que fazer. */
function erroJson(res, status, erro, como) {
    const corpo = JSON.stringify({ erro, ...(como ? { como } : {}) });
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": CORS_ORIGEM,
        "content-length": Buffer.byteLength(corpo),
    });
    res.end(corpo);
}

/** Preflight respondido por nós: o do relay não passaria (medido, 401 seco). */
function preflight(res) {
    res.writeHead(204, {
        "access-control-allow-origin": CORS_ORIGEM,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, accept",
        "access-control-max-age": "86400",
        "content-length": "0",
    });
    res.end();
}

function servirEstatico(req, res, urlPath) {
    const alvo = resolverEstatico(urlPath.split("?")[0]);
    if (alvo === null) {
        erroJson(res, 400, "caminho inválido", "a URL sai do diretório do app");
        return;
    }

    const semExtensao = path.extname(alvo) === "";
    // Sem extensão é rota do app (o Chili3D é SPA): devolve o index, não 404.
    const arquivo = semExtensao ? path.join(DIST, "index.html") : alvo;

    fs.stat(arquivo, (err, estado) => {
        if (err || !estado.isFile()) {
            if (semExtensao && fs.existsSync(path.join(DIST, "index.html"))) {
                servirArquivo(res, path.join(DIST, "index.html"));
                return;
            }
            erroJson(res, 404, "não encontrado", `nada em ${urlPath}`);
            return;
        }
        servirArquivo(res, arquivo);
    });
}

function servirArquivo(res, arquivo) {
    res.writeHead(200, {
        "content-type": tipoDe(arquivo),
        // O app é arquivo estático com hash no nome: cache longo é seguro e
        // encurta o boot. O index.html fica de fora da regra abaixo.
        ...(arquivo.endsWith("index.html") ? { "cache-control": "no-cache" } : {}),
    });
    fs.createReadStream(arquivo).pipe(res);
}

/**
 * Encaminha /v1/* para o relay.
 *
 * O corpo é encaminhado como stream (nunca bufferizado): o assistente usa SSE,
 * e bufferar aqui atrasaria cada token até o fim da resposta.
 */
function encaminhar(req, res, resto) {
    if (!RELAY) {
        erroJson(
            res,
            502,
            "RELAY_URL não está configurado neste container",
            "defina RELAY_URL no ambiente do container chili3d com a raiz do relay (ex.: http://SEU-RELAY:20128, sem /v1)",
        );
        return;
    }

    const alvo = new URL(RELAY);
    const porta = alvo.port ? Number(alvo.port) : alvo.protocol === "https:" ? 443 : 80;
    const cabecalhos = {};
    for (const [chave, valor] of Object.entries(req.headers)) {
        if (IDA_PROIBIDOS.has(chave)) continue;
        cabecalhos[chave] = valor;
    }

    const pedido = http.request(
        {
            host: alvo.hostname,
            port: porta,
            path: `/v1${resto}`,
            method: req.method,
            headers: cabecalhos,
            timeout: RELAY_TIMEOUT,
        },
        (resposta) => {
            const volta = {};
            for (const [chave, valor] of Object.entries(resposta.headers)) {
                if (VOLTA_PROIBIDOS.has(chave)) continue;
                volta[chave] = valor;
            }
            volta["access-control-allow-origin"] = CORS_ORIGEM;
            res.writeHead(resposta.statusCode, volta);
            resposta.pipe(res);
        },
    );

    // Tempo esgotado: 504, não 502. A diferença importa no diagnóstico — 502 diz
    // "não falei com o relay", 504 diz "falei e ele não respondeu a tempo".
    let esgotado = false;
    pedido.on("timeout", () => {
        esgotado = true;
        // Quem registra no log é o handler de `error` abaixo: uma linha só, e já
        // com o status que o cliente vai ver.
        pedido.destroy(new Error("tempo esgotado"));
    });

    pedido.on("error", (erro) => {
        // A mensagem do log tem de distinguir os dois casos: "tempo esgotado" e
        // "não falei" têm diagnósticos diferentes, e um log que diga "inacessível"
        // para os dois manda procurar defeito no lugar errado.
        log(
            esgotado
                ? `relay demorou mais de ${RELAY_TIMEOUT}ms (${RELAY}) — desistindo (504)`
                : `relay inacessível (${RELAY}): ${erro.code || erro.message}`,
        );
        if (!res.headersSent) {
            erroJson(
                res,
                esgotado ? 504 : 502,
                esgotado ? "relay demorou demais" : "relay inacessível",
                esgotado
                    ? `o relay não respondeu em ${RELAY_TIMEOUT}ms (${RELAY})`
                    : `não foi possível falar com ${RELAY}`,
            );
        } else {
            res.destroy();
        }
    });

    // Corpo encaminhado bloco a bloco, e não por `pipe`, por uma razão: `pipe`
    // não dá onde inserir a conta de bytes. Contar aqui é o que permite recusar
    // um corpo grande antes de encaminhá-lo. O streaming continua sendo bloco a
    // bloco — nada é bufferizado.
    let recebido = 0;
    let recusado = false;
    req.on("data", (pedaco) => {
        if (recusado) return;
        recebido += pedaco.length;
        if (recebido > CORPO_MAX) {
            recusado = true;
            log(`corpo de ${recebido} bytes recusado (limite ${CORPO_MAX})`);
            erroJson(
                res,
                413,
                "corpo grande demais",
                `o pedido passou de ${CORPO_MAX} bytes e não foi encaminhado ao relay`,
            );
            pedido.destroy();
            return;
        }
        pedido.write(pedaco);
    });
    req.on("end", () => {
        if (!recusado) pedido.end();
    });
    req.on("aborted", () => pedido.destroy());
}

/**
 * Cria o servidor. Separado do `listen` para os testes subirem uma instância em
 * porta efêmera sem depender de variável de ambiente.
 */
export function criarServidor() {
    return http.createServer((req, res) => {
        const urlPath = req.url || "/";

        // /healthz: o healthcheck do Docker e a verificação pós-deploy.
        if (urlPath === "/healthz" || urlPath.startsWith("/healthz?")) {
            const corpo = JSON.stringify({ ok: true, servico: "chili3d", relay: RELAY || null });
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength(corpo),
            });
            res.end(corpo);
            return;
        }

        // /v1 é o relay. ANTES do fallback de SPA, senão uma rota desconhecida
        // do app engoliria o caminho do relay.
        if (urlPath === "/v1" || urlPath.startsWith("/v1/") || urlPath.startsWith("/v1?")) {
            if (req.method === "OPTIONS") {
                preflight(res);
                return;
            }
            const resto = urlPath.slice("/v1".length); // inclui a "/" e a query
            encaminhar(req, res, resto);
            return;
        }

        if (req.method === "OPTIONS") {
            preflight(res);
            return;
        }

        servirEstatico(req, res, urlPath);
    });
}

// Só escuta quando executado diretamente — os testes importam o módulo.
const executadoDireto =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(AQUI, "servidor.mjs");

if (executadoDireto) {
    if (!fs.existsSync(path.join(DIST, "index.html"))) {
        log(`AVISO: ${DIST}/index.html não existe — o app não vai servir`);
    }
    if (!RELAY) {
        log("AVISO: RELAY_URL vazio — /v1/ vai responder 502 até ser configurado");
    }
    criarServidor().listen(PORTA, "0.0.0.0", () => {
        log(`servindo ${DIST} e /v1/ → ${RELAY || "(sem relay)"} em 0.0.0.0:${PORTA}`);
    });
}
