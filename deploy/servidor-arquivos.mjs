// Servidor estático mínimo para transferir o projeto até os containers.
// Só para deploy: escuta em todas as interfaces e serve o diretório do projeto.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Raiz servida: o diretório do projeto. Placeholder — configure na sua máquina
// (variável de ambiente ou argumento), nunca fixe um caminho pessoal aqui.
const ROOT = process.argv[2] ?? process.env.PROJETO_RAIZ ?? "/caminho/do/projeto";
const PORT = Number(process.argv[3] ?? 8099);

const TIPOS = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".py": "text/x-python", ".sh": "text/x-shell", ".md": "text/markdown",
  ".yml": "text/yaml", ".conf": "text/plain", ".svg": "image/svg+xml",
  ".html": "text/html", ".css": "text/css", ".txt": "text/plain", ".step": "text/plain",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, root: ROOT, utc: new Date().toISOString() }));
  }
  if (rel.endsWith("/")) rel += "index.json";
  const alvo = path.join(ROOT, rel);
  if (!alvo.startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end("fora da raiz");
    return;
  }
  fs.stat(alvo, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`nao encontrado: ${rel}`);
    }
    res.writeHead(200, {
      "content-type": TIPOS[path.extname(alvo).toLowerCase()] ?? "application/octet-stream",
      "content-length": st.size,
    });
    fs.createReadStream(alvo).pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`servindo ${ROOT} em 0.0.0.0:${PORT}`));
