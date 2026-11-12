/**
 * Cenários do proxy /v1/ — a correção do "Erro: Connection error.".
 *
 * O que estes cenários sustentam:
 *
 *   - o pedido do assistente passa (POST com authorization + content-type);
 *   - a resposta de SSE chega como STREAM, não bufferizada — medido no PRIMEIR
 *     byte, porque olhar o tempo total não distinguiria stream de buffer;
 *   - o relay não recebe `origin`, que é o que o faria exigir chave por causa da
 *     origem, e o que faz do nosso proxy um cliente comum;
 *   - `authorization` chega INTACTO, e portanto a chave continua sendo só do
 *     usuário: passa pelo proxy e não mora em lugar nenhum;
 *   - o preflight é respondido POR NÓS, com os três cabeçalhos certos, e nunca
 *     repassado ao relay (que devolveria 401 seco — foi assim que o sintoma
 *     nasceu);
 *   - sem RELAY_URL, o /v1/ falha alto e explicativo, e o app continua servindo.
 *
 * Nomes em token: `teste/rodar.mjs` exige falha seletiva por eles.
 */
import {
    checar,
    criarDist,
    fim,
    portaLivre,
    subirRelay,
    subirServidor,
    tmp,
} from "./comum.mjs";

const dir = tmp("chili3d-proxy-");
const dist = criarDist(dir);
const relay = await subirRelay();
const porta = await portaLivre();
const servidor = await subirServidor({ dist, porta, relayPorta: relay.porta });
const BASE = `http://127.0.0.1:${porta}`;

async function esperarBoot(base) {
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(base + "/healthz");
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error("servidor não abriu o socket");
}
await esperarBoot(BASE);

// ------------------------------------------------------------ o pedido passa
let r = await fetch(BASE + "/v1/models");
const modelos = await r.json();
checar("get-models-atravessa", r.status === 200 && modelos.data[0].id === "flashmodel", `status ${r.status}`);
checar("resposta-proxy-tem-acao", r.headers.get("access-control-allow-origin") === "*", String(r.headers.get("access-control-allow-origin")));

const corpo = JSON.stringify({ model: "flashmodel", messages: [{ role: "user", content: "oi" }] });
// `origin` vai EXPLÍCITO no pedido, e isso não é enfeite: medido, o `fetch` do
// Node não põe `Origin` sozinho, então sem esta linha o cenário
// `relay-nao-recebe-origin` passaria verde com o proxy repassando tidy o que
// nunca veio — um verde que não prova nada. É o oposto do navegador real, onde
// o Chrome sempre carrega `Origin` num pedido de origem cruzada.
// A medição que importa é a do PRIMEIRO byte, e o relógio começa ANTES do
// `fetch`: medir a partir da resposta pronta seria medir nada, porque o
// `await fetch` só resolve quando os cabeçalhos chegam — e num proxy que
// bufferiza, os cabeçalhos só são escritos no fim. Foi assim que a mutação
// "resposta-bufferizada" passou despercebida na primeira versão deste teste.
//
// O relay falso só escreve o segundo bloco 400 ms depois. Sem buffer, o primeiro
// bloco vem junto com os cabeçalhos; com buffer, nada chega antes do fecho.
const t0 = Date.now();
const resposta = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: {
        origin: "http://origem-do-usuario:8080",
        authorization: "Bearer chave-do-usuario",
        "content-type": "application/json",
    },
    body: corpo,
});
const leitor = resposta.body.getReader();
const { value: primeirosBytes } = await leitor.read();
const tPrimeiro = Date.now() - t0;
let texto = new TextDecoder().decode(primeirosBytes);
for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    texto += new TextDecoder().decode(value);
}
checar("post-chat-atravessa", resposta.status === 200, `status ${resposta.status}`);
checar("sse-completo", texto.includes("primeiro") && texto.includes("segundo") && texto.includes("[DONE]"), texto.slice(0, 80));
checar("sse-content-type", /text\/event-stream/.test(resposta.headers.get("content-type") || ""), resposta.headers.get("content-type"));
checar("primeiro-bloco-nao-bufferizado", tPrimeiro < 250, `primeiro byte em ${tPrimeiro}ms`);

// ------------------------------------------------------- o que o relay viu
const pedido = relay.recebido.find((p) => p.url.startsWith("/v1/chat/completions") && p.metodo === "POST");
checar("relay-recebe-authorization", pedido?.authorization === "Bearer chave-do-usuario", String(pedido?.authorization));
checar("relay-recebe-content-type", pedido?.contentType === "application/json", String(pedido?.contentType));
checar("relay-nao-recebe-origin", pedido?.origin == null, String(pedido?.origin));
checar("relay-recebe-host-dele", /127\.0\.0\.1/.test(pedido?.host || ""), String(pedido?.host));
checar("relay-recebe-corpo-intacto", pedido?.corpo === corpo, String(pedido?.corpo).slice(0, 60));

// ---------------------------------------------------------------- preflight
const antes = relay.recebido.length;
const pre = await fetch(BASE + "/v1/chat/completions", {
    method: "OPTIONS",
    headers: { origin: "http://outra-origem:8080", "access-control-request-method": "POST" },
});
const depois = relay.recebido.length;
checar("preflight-nao-repassado", pre.status === 204 && antes === depois, `status ${pre.status}, repassados=${depois - antes}`);
checar("preflight-acao", pre.headers.get("access-control-allow-origin") === "*", String(pre.headers.get("access-control-allow-origin")));
checar("preflight-acah", /authorization/.test(pre.headers.get("access-control-allow-headers") || ""), pre.headers.get("access-control-allow-headers"));
checar("preflight-acam", /POST/.test(pre.headers.get("access-control-allow-methods") || ""), pre.headers.get("access-control-allow-methods"));

// --------------------------------------------------- relay não configurado
const porta2 = await portaLivre();
const semRelay = await subirServidor({ dist, porta: porta2, relayPorta: relay.porta, relayVazio: true });
const BASE2 = `http://127.0.0.1:${porta2}`;
await esperarBoot(BASE2);
r = await fetch(BASE2 + "/v1/chat/completions", { method: "POST", body: "{}" });
const aviso = await r.json();
checar("sem-relay-502", r.status === 502, `status ${r.status}`);
checar("sem-relay-mensagem-explicativa", /RELAY_URL/.test(aviso.erro || "") && Boolean(aviso.como), JSON.stringify(aviso).slice(0, 140));
checar("sem-relay-app-contina-servindo", (await fetch(BASE2 + "/")).status === 200, "");
semRelay.parar();

// ------------------------------------------------- corpo grande recusado
// O limite é 1 MB por default; o servidor sobe com 4 KB aqui para o teste não
// precisar gerar 1 MB. O que se mede é que o corpo é recusado ANTES de chegar ao
// relay — não depois, e não com o relay tendo recebido tudo.
const porta3 = await portaLivre();
const comLimite = await subirServidor({
    dist,
    porta: porta3,
    relayPorta: relay.porta,
    env: { CORPO_MAX: String(4096) },
});
const BASE3 = `http://127.0.0.1:${porta3}`;
await esperarBoot(BASE3);
const antesDoGrande = relay.recebido.length;
r = await fetch(BASE3 + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(20000),
});
// Texto, e não `.json()`: com a proteção fora, a resposta é SSE — e `.json()`
// estouraria, matando o cenário calado em vez de acusar com nome.
const textoRecusa = await r.text();
let recusa = {};
try {
    recusa = JSON.parse(textoRecusa);
} catch {
    recusa = { erro: textoRecusa.slice(0, 100) };
}
const depoisDoGrande = relay.recebido.length;
checar("corpo-grande-da-413", r.status === 413, `status ${r.status}`);
checar("corpo-grande-explica", /limite|CORPO_MAX|bytes/.test(recusa.erro + " " + (recusa.como || "")), textoRecusa.slice(0, 120));
checar("corpo-grande-nao-chega-ao-relay", antesDoGrande === depoisDoGrande, `recebidos a mais: ${depoisDoGrande - antesDoGrande}`);
checar("corpo-grande-nao-mata-o-servidor", (await fetch(BASE3 + "/healthz")).status === 200, "");
// E um pedido pequeno continua passando depois da recusa: a recusa não pode
// deixar o servidor em estado travado.
r = await fetch(BASE3 + "/v1/models");
checar("depois-da-recusa-o-proxy-segue", r.status === 200, `status ${r.status}`);
comLimite.parar();

// ------------------------------------------- relay que nunca responde
// 504 e não 502: a diferença é diagnóstico — 502 é "não falei com o relay",
// 504 é "falei e ele não respondeu a tempo". Sem tempo de espera, um relay
// travado deixaria o socket pendurado aqui para sempre.
const porta4 = await portaLivre();
const comTempo = await subirServidor({
    dist,
    porta: porta4,
    relayPorta: relay.porta,
    env: { RELAY_TIMEOUT: String(1500) },
});
const BASE4 = `http://127.0.0.1:${porta4}`;
await esperarBoot(BASE4);
const tTravado = Date.now();
r = null;
let tEsgotado = 0;
try {
    r = await fetch(BASE4 + "/v1/travado", {
        method: "POST",
        body: "{}",
        // Sem tempo de espera no servidor, o pedido fica pendurado. Com o signal,
        // o CLIENTE desiste — e o cenário ainda acusa com nome, em vez de morrer
        // calado e fazer o runner classificar a mutação como "quebrou".
        signal: AbortSignal.timeout(20000),
    });
    tEsgotado = Date.now() - tTravado;
} catch (erro) {
    checar("relay-travado-da-504", false, `o servidor nunca respondeu (${erro.name}) — socket pendurado`);
    checar("relay-travado-desiste-no-tempo", false, "não desistiu: o pedido ficou pendurado");
}
if (r) {
    const travado = await r.json();
    checar("relay-travado-da-504", r.status === 504, `status ${r.status}`);
    checar("relay-travado-explica", /relay/.test(travado.erro || ""), JSON.stringify(travado).slice(0, 120));
    // Desiste em RELAY_TIMEOUT, não em "algum momento". A margem é folgada de
    // propósito: o relógio do CI varia, e um teste de tempo apertado demais
    // falha sozinho de vez em quando.
    checar("relay-travado-desiste-no-tempo", tEsgotado < 12000, `desistiu em ${tEsgotado}ms`);
    checar("relay-travado-nao-mata-o-servidor", (await fetch(BASE4 + "/healthz")).status === 200, "");
}
comTempo.parar();

process.on("exit", () => {
    servidor.parar();
    relay.parar();
});

fim("proxy /v1/");
