/**
 * Entrada única dos testes do companheiro CDP: `node teste/rodar.mjs`.
 *
 * Três etapas, e a terceira é a que dá valor às duas primeiras:
 *
 *  1. suíte `vigiar` — a correção da navegação no mesmo alvo (o motivo deste
 *     arquivo existir) e o que estava ao redor dela;
 *  2. suíte `preparar o kiosk` — documento no boot + abertura do assistente;
 *  3. MUTAÇÃO — cada mutação quebra de propósito uma parte do código real e a
 *     suíte tem que acusar. Sem esta etapa, um verde significa apenas "rodou":
 *     uma suíte que passa no código certo e no código quebrado não testa nada.
 *
 * Saída não-zero em qualquer falha, para o CI parar o build.
 */
import { gerar as gerarVigiar } from "./gerar-vigiar.mjs";
import { gerar as gerarPreparar } from "./gerar-preparar.mjs";
import { FONTE, tmp, rodarVarios, fonteMutada, limpar } from "./comum.mjs";

/**
 * Cada mutação: trocas textuais no fonte real, e os cenários que OBRIGATORIAMENTE
 * têm que falhar contra o fonte mutado. Os demais têm que continuar passando —
 * uma mutação que derruba tudo não prova que o teste é seletivo, prova só que
 * ele é sensível a qualquer coisa.
 */
const MUTACOES = [
    {
        nome: "detectores de navegação mortos",
        trocas: [
            ['"Page.frameNavigated"', '"Page.desativadoFrame"'],
            ['"Page.loadEventFired"', '"Page.desativadoLoad"'],
        ],
        exigeFalha: ["2-navegacao-reconfigura", "7-seguranca-sem-load"],
    },
    {
        nome: "conexão nunca marcada como configurada",
        trocas: [["configurada = true;", "configurada = false;"]],
        exigeFalha: ["2-navegacao-reconfigura", "7-seguranca-sem-load"],
    },
    {
        nome: "sem a rede de segurança de 12 s",
        trocas: [["&& !seguranca", "&& false"]],
        exigeFalha: ["7-seguranca-sem-load"],
    },
    {
        nome: "reconfigurar travado em fechando",
        trocas: [["let fechando = false;", "let fechando = true;"]],
        exigeFalha: ["2-navegacao-reconfigura", "7-seguranca-sem-load"],
    },
    {
        nome: "diálogo sem tratamento",
        trocas: [['"Page.javascriptDialogOpening"', '"Page.desativadoDialogo"']],
        exigeFalha: ["4-dialogo-e-fechado"],
    },
    {
        nome: "download sem aviso",
        trocas: [['"Page.downloadProgress"', '"Page.desativadoDownload"']],
        exigeFalha: ["4-dialogo-e-fechado"],
    },
];

function veredicto(r) {
    const ruins = [];
    for (const c of r) {
        if (c.estado !== "ok") ruins.push(c);
    }
    return ruins;
}

function imprimir(titulo, resultados) {
    console.log(`\n${titulo}`);
    for (const c of resultados) {
        const marca = c.estado === "ok" ? "ok      " : c.estado === "falhou" ? "FALHOU  " : "QUEBROU ";
        console.log(`  ${marca}${c.nome}${c.ruins ? "  → " + c.ruins : ""}`);
        if (c.estado !== "ok" && c.saida.trim()) {
            console.log(
                c.saida
                    .trim()
                    .split("\n")
                    .map((l) => "      | " + l)
                    .join("\n")
            );
        }
    }
}

async function main() {
    const dir = tmp("kiosk-teste-");
    const manter = process.env.TESTE_MANTER === "1";
    const ruins = [];
    let rV = [];
    let rP = [];

    try {
        const vigiar = rodarVarios(gerarVigiar(FONTE, `${dir}/vigiar`));
        const preparar = rodarVarios(gerarPreparar(FONTE, `${dir}/preparar`));
        const [resV, resP] = await Promise.all([vigiar, preparar]);
        rV = resV;
        rP = resP;

        imprimir(`suíte vigiar + laço externo (${rV.length} cenários · ${FONTE})`, rV);
        imprimir(`suíte preparar o kiosk (${rP.length} cenários · ${FONTE})`, rP);
        ruins.push(...veredicto(rV), ...veredicto(rP));

        console.log(`\nmutações — a suíte tem que acusar cada uma`);
        for (const m of MUTACOES) {
            try {
                const mutado = fonteMutada(FONTE, m.trocas, dir);
                const arquivos = gerarVigiar(mutado, `${dir}/mut-${m.nome.replace(/\W+/g, "-")}`);
                const res = await rodarVarios(arquivos);
                const porNome = new Map(res.map((r) => [r.nome, r]));
                const faltaram = m.exigeFalha.filter((n) => {
                    const c = porNome.get(n);
                    return !c || c.estado === "ok";
                });
                // Quebrou onde não devia: a mutação errou o alvo e derrubou a
                // suíte inteira. Isso não prova seletividade, prova só
                // sensibilidade a qualquer coisa.
                const quebraramErrado = res.filter((c) => c.estado !== "ok" && !m.exigeFalha.includes(c.nome));
                const ruinsMutacao = veredicto(res).filter((c) => m.exigeFalha.includes(c.nome));
                if (faltaram.length > 0 || quebraramErrado.length > 0) {
                    ruins.push({ nome: `mutação "${m.nome}"`, estado: "falhou", ruins: "" });
                    console.log(
                        `  FALHOU  ${m.nome}` +
                            (faltaram.length ? `\n          deveria ter quebrado: ${faltaram.join(", ")}` : "") +
                            (quebraramErrado.length
                                ? `\n          quebrou onde não devia: ${quebraramErrado.map((c) => c.nome).join(", ")}`
                                : "")
                    );
                } else {
                    console.log(
                        `  ok      ${m.nome}: quebrou ${ruinsMutacao.map((c) => c.nome).join(", ")}` +
                            ` (${ruinsMutacao.map((c) => "→ " + c.ruins).join("; ")})`
                    );
                }
            } catch (err) {
                // Mutação que não se aplica ao fonte (acontece quando se roda a
                // suíte contra uma revisão antiga, com TESTE_FONTE) é falha da
                // mutação, não do resto: registra e segue.
                ruins.push({ nome: `mutação "${m.nome}"`, estado: "falhou", ruins: "" });
                console.log(`  FALHOU  ${m.nome}: ${err?.message || err}`);
            }
        }
    } catch (err) {
        console.error("\nERRO ao montar ou rodar os testes:", err?.message || err);
        ruins.push({ nome: "montagem", estado: "quebrou", ruins: "", saida: String(err?.stack || err) });
    } finally {
        if (manter) console.log(`\ncenários mantidos em ${dir} (TESTE_MANTER=1)`);
        else limpar(dir);
    }

    const total = rV.length + rP.length;
    console.log(
        ruins.length === 0
            ? `\nVERDE: ${total} cenários ok e ${MUTACOES.length} mutações acusadas.`
            : `\nVERMELHO: ${ruins.length} falha(s) — ${ruins.map((r) => r.nome).join(", ")}`
    );
    process.exit(ruins.length === 0 ? 0 : 1);
}

main();
