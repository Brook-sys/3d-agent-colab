/**
 * Cenários do app estático: o Chili3D servido como vem, mais o que um servidor
 * de arquivos errado faz em silêncio — rota de SPA virando 404, tipo de conteúdo
 * errado no .wasm (o app não sobe, e o sintoma não aponta para cá) e travessia
 * de diretório.
 *
 * Os nomes dos cenários são tokens sem espaço de propósito: `teste/rodar.mjs` os
 * parseia da saída (`^(ok|FALHOU)\s+(\S+)`) para exigir que uma mutação quebre
 * EXATAMENTE os cenários esperados. Nome com espaço esconderia colisão.
 *
 * Roda o servidor REAL; ver teste/comum.mjs.
 */
import fs from "node:fs";
import {
    checar,
    criarDist,
    fim,
    portaLivre,
    subirRelay,
    subirServidor,
    tmp,
} from "./comum.mjs";

const dir = tmp("chili3d-estatico-");
const dist = criarDist(dir);
// Arquivo FORA do dist, com conteúdo inconfundível: é o alvo da travessia. Sem
// ele, a mutação que remove a guarda simplesmente não acha nada para vazar — e a
// mutação passaria sem provar nada, que é o pior verde que existe.
fs.writeFileSync(dir + "/segredo.txt", "SEGREDO-NAO-DEVE-SAIR");

const relay = await subirRelay();
const porta = await portaLivre();
const servidor = await subirServidor({ dist, porta, relayPorta: relay.porta });
const BASE = `http://127.0.0.1:${porta}`;

process.on("exit", () => {
    servidor.parar();
    relay.parar();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Espera o socket aceitar conexão — o spawn não garante o listen. */
async function esperarBoot(base) {
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(base + "/healthz");
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error("servidor não abriu o socket: " + servidor.boot());
}
await esperarBoot(BASE);

// --------------------------------------------------------------- o app serve
let r = await fetch(BASE + "/");
let html = await r.text();
checar("raiz-devolve-index", r.status === 200, `status ${r.status}`);
checar("index-com-o-app", html.includes("APP CHILI3D"), html.slice(0, 60));
checar("index-texto-html", /text\/html/.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));
checar("index-sem-cache", /no-cache/.test(r.headers.get("cache-control") || ""), r.headers.get("cache-control"));

r = await fetch(BASE + "/main.js");
checar("js-tipo-certo", r.status === 200 && /text\/javascript/.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));

r = await fetch(BASE + "/kernel.wasm");
checar("wasm-tipo-certo", r.status === 200 && /application\/wasm/.test(r.headers.get("content-type") || ""), `${r.status} ${r.headers.get("content-type")}`);

r = await fetch(BASE + "/estilo.css");
checar("css-tipo-certo", r.status === 200 && /text\/css/.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));

r = await fetch(BASE + "/assets/logo.svg");
checar("asset-em-subdiretorio", r.status === 200 && /image\/svg/.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));

// ------------------------------------------------------ rotas de SPA (e 404)
r = await fetch(BASE + "/sobre");
checar("rota-sem-extensao-devolve-index", r.status === 200 && (await r.text()).includes("APP CHILI3D"), `status ${r.status}`);

r = await fetch(BASE + "/peca/42/editar");
checar("rota-profunda-devolve-index", r.status === 200 && (await r.text()).includes("APP CHILI3D"), `status ${r.status}`);

r = await fetch(BASE + "/nao-existe.js");
checar("asset-inexistente-da-404", r.status === 404, `status ${r.status}`);

// ------------------------------------------------------------------ saúde
r = await fetch(BASE + "/healthz");
const saude = await r.json();
checar("healthz-ok", r.status === 200 && saude.ok === true, JSON.stringify(saude));
checar("healthz-informa-relay", saude.relay === `http://127.0.0.1:${relay.porta}`, JSON.stringify(saude));

// --------------------------------------------------------------- travessia
// Os caminhos vêm com a BARRA codificada (`%2f`) de propósito, e a razão é medida:
// o cliente `fetch` normaliza `/%2e%2e/` em `/segredo.txt` ANTES de enviar, então
// um caminho com o ponto codificado chegaria ao servador já inofensivo e o
// cenário passaria sem testar a proteção. Com `..%2f` o `..` sobrevive à viagem
// e quem tem de lidar com ele é o servidor — que é o que se quer medir.
//
// O alvo é um arquivo FORA do dist (criado lá em cima, com conteúdo inconfundível):
// sem um alvo real, uma mutação que removesse a guarda não teria nada para vazar
// e passaria verde sem provar nada.
for (const [indice, caminho] of [
    "/..%2fsegredo.txt", // o `..` direto na raiz
    "/%2e%2e%2fsegredo.txt", // o mesmo ataque com o ponto codificado
    "/assets/..%2f..%2fsegredo.txt", // o `..` depois de um subdiretório que existe
].entries()) {
    r = await fetch(BASE + caminho, { redirect: "manual" });
    const corpo = r.status === 200 ? await r.text() : "";
    const vazou = corpo.includes("SEGREDO-NAO-DEVE-SAIR");
    checar(`travessia-barrada-${indice + 1}`, !vazou && r.status !== 200, `status ${r.status}, vazou=${vazou}`);
}

// ------------------------------------------------------------------ HEAD
r = await fetch(BASE + "/", { method: "HEAD" });
checar("head-na-raiz", r.status === 200, `status ${r.status}`);

fim("estático");
