/**
 * Utilidades compartilhadas pelas suítes de teste do companheiro CDP.
 *
 * Duas coisas moram aqui e em nenhum outro lugar: rodar um cenário gerado num
 * processo filho (isolamento — cada cenário mexe em `globalThis`) e produzir uma
 * cópia MUTADA do fonte, que é o que prova que a suíte não é vacua.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "..");
/**
 * O fonte sob teste. `TESTE_FONTE` aponta para outra revisão — foi assim que a
 * suíte foi validada contra o código commitado (onde ela FALHA, que é o que se
 * espera de um teste que prova um defeito).
 */
export const FONTE = process.env.TESTE_FONTE
    ? path.resolve(process.env.TESTE_FONTE)
    : path.join(RAIZ, "session/kiosk-cdp.mjs");

export function tmp(prefixo) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

/**
 * Roda um cenário e devolve `{ nome, estado, ruins, saida, codigo }`.
 *
 * `estado` é "ok", "falhou" (asserção quebrada) ou "quebrou" (exit != 0 sem
 * linha de veredicto — crash, timeout, syntax error). As três são falha, mas a
 * diferença importa no diagnóstico: um crash com exit 1 e stdout vazio é um
 * defeito do próprio gerador, não do código sob teste.
 */
export function rodarCenario(arquivo, tempoLimite = 30000) {
    return new Promise((resolve) => {
        const filho = spawn(process.execPath, [arquivo], { stdio: ["ignore", "pipe", "pipe"] });
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
                ruins: ruins ? ruins[1].trim() : "",
                saida,
                codigo,
            });
        });
    });
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

/**
 * Copia o fonte aplicando trocas textuais e devolve o caminho da cópia.
 *
 * Cada troca precisa ocorrer pelo menos uma vez: uma mutação que não pegou
 * transformaria o teste de mutação em mais um teste vacuno — justamente o que
 * ele existe para impedir.
 */
export function fonteMutada(fonte, trocas, destino) {
    let texto = fs.readFileSync(fonte, "utf8");
    for (const [de, para] of trocas) {
        const n = texto.split(de).length - 1;
        if (n === 0) {
            throw new Error(`mutação não pegou: "${de}" não existe em ${fonte}`);
        }
        texto = texto.split(de).join(para);
    }
    const alvo = path.join(destino, "kiosk-mutado.mjs");
    fs.writeFileSync(alvo, texto);
    return alvo;
}

/** remove uma árvore sem reclamar (diretório temporário) */
export function limpar(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* temporário: se sobrar, o SO encarrega */
    }
}
