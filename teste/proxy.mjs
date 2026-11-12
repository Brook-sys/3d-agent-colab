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

process.on("exit", () => {
    servidor.parar();
    relay.parar();
});

fim("proxy /v1/");
