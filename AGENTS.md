# AGENTS.md — protocolo para agentes de IA neste repositório

Este arquivo é para qualquer agente (humano ou IA) que vá trabalhar no **3D Agent Colab**. Ele existe porque o projeto tem meia dúzia de armadilhas que não aparecem no código e já custaram tempo: um plugin que some em silêncio, uma stack que não se recria, um endereço que não pode ir para o git.

Leia o [README](README.md) antes. Este arquivo trata do que **não** fazer e do que **conferir**.

---

## As cinco regras que não se quebram

1. **Push e publish só com autorização explícita.** `git push`, publicar imagem, `npm publish`: nunca sem o usuário pedir. Na dúvida, pergunte — não presuma que "terminar a tarefa" inclui publicar.
2. **Nada de dado do ambiente do usuário em arquivo versionado.** Endereço IP, hostname, username, caminho de home, topologia de rede, estado da infraestrutura, token, ID de stack. Em arquivo versionado usa-se `SEU-HOST`, `SEU-USUARIO`, `localhost`. O valor real do usuário fica na configuração local dele (`opencode.json`, `.env`), nunca no repositório.
3. **Chave de API de IA nunca em arquivo versionado.** Nem em `spec.json`, nem em documentação, nem em exemplo. Ela é colada na interface. Se um dia aparecer num arquivo, trate como vazamento e avise.
4. **Pergunte antes de nomear.** Nome de container, de rede, de imagem, de peça, de tag: pergunte. Neste projeto os nomes são fixos de propósito (`3d-agent-colab`, `3d-agent-colab-core`, `3d-agent-colab-session`) e uma "melhoria" de nomenclatura quebra o `BRIDGE_URL`, os binds e os scripts de verificação.
5. **A stack em produção não se recria sem pedir.** Atualizar é uma coisa; deletar e recriar é outra. Peça.

---

## Como este repositório funciona

```
core/      FastAPI + MCP (13 ferramentas) + registro /parts + portal FDM + serve o app e o painel
session/   ponte WebSocket (protocolo do Chili3D) + Chromium headless + companheiro CDP
painel/    plugin do Chili3D em JS puro, sem build (variáveis, comentários, chat, IA)
partes/    semente do registro, copiada no primeiro boot quando falta o marcador /parts/.semeadura
docs/      documentação (arquitetura, uso, operação, painel)
deploy/    ciclo curto de desenvolvimento: build local + compose local
.github/   workflow que publica as imagens no GHCR
chili3d.ref  commit do Chili3D compilado dentro da imagem core
```

O caminho oficial de mudança é **commit → CI → pull**: o host Docker não compila nada. Imagens públicas em `ghcr.io/brook-sys/3d-agent-colab-{core,session}:main`.

Convenções: commits `<emoji> <tipo>: <descrição>` em português (`✨ feat` · `🐛 fix` · `♻️ refactor` · `📝 docs` · `🔧 chore`). Código e comentários em português, sem abreviação obscura.

---

## O que conferir antes de dizer "pronto"

Build verde **não** significa deploy funcionando. O painel entra por `COPY` e roda no navegador: um erro de referência dentro do `buildPanel()` não derruba a página — só o console do kiosk testemunha.

Antes de declarar qualquer coisa pronta:

| checagem | como | o que esperar |
|---|---|---|
| sintaxe | `node --check painel/src/extension.js session/bridge-server.mjs session/kiosk-cdp.mjs` | silêncio |
| import do núcleo | `python -c "import main"` dentro de `core/` (ou o probe do CI) | sem exceção |
| MCP | `curl -X POST http://SEU-HOST:9001/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize",…}'` | `protocolVersion: 2024-11-05` |
| health + ponte | `curl -s http://SEU-HOST:9001/health` | `conectada: true`, 30 ferramentas |
| painel de fato | `grep -a "painel ativo" /data/chrome.log` no container da sessão | a linha do painel |
| IA embutida | `tail` de `/data/kiosk-cdp.log` no container da sessão | `assistente de IA` |

Os dois primeiros logs **não** estão no `docker logs`: o `start.sh` redireciona o Chromium para `$DATA_DIR/chrome.log` e o companheiro CDP para `$DATA_DIR/kiosk-cdp.log`. Procurar no stdout do container não encontra nada — e o sintoma (página abre, painel não) já é o pior possível.

Se uma dessas falhar, a tarefa **não** está pronta, por mais que o build tenha passado.

---

## Armadilhas que já custaram tempo

- **Rota com `dict | Response` sem `response_model=None`** mata o import do `main.py`: build verde, container em restart loop. O CI importa o `main.py` por isso.
- **Identificador válido, referência quebrada.** `node --check` passa; o `appendChild` morre em runtime. Aconteceu com `constbotaoIa`.
- **`alert()` no kiosk headless congela o renderer** — e com ele o `open` do WebSocket da ponte. O companheiro CDP fecha diálogos; não teste caminhos que alertam sem ele.
- **`export_nodes` não devolve os bytes do STEP.** Devolve metadados e entrega como download; o núcleo busca em `GET /capturas/<nome>` e espera até 30 s. Não existe atalho.
- **Não há ferramenta de fechar documento.** `new_document` recusa com documento aberto; trocar de peça é mudar `?part=` e recarregar.
- **`?bridge=` importa a IA.** Sem esse parâmetro na URL não existe painel de IA — e com ele, num navegador sem ponte, a aba tenta `ws://127.0.0.1:17373` a cada 8 s para sempre. É ruído, não falha.
- **Duas abas com `?bridge=` disputam a ponte** (4002, terminal): a nova derruba a anterior.
- **A semeadura do `/parts` é guardada por marcador, não por diretório vazio.** O `entrypoint.sh` copia a semente (`cp -a`) quando `/parts/.semeadura` **não existe** — um `/parts` com conteúdo mas sem o marcador (restore de backup antigo) é sobrescrito nos slugs coincidentes. Antes de restaurar backup, confira o marcador; para registro limpo, esvazie o diretório com a stack parada — e confirme com o usuário, porque é irreversível.
- **Logs Docker têm prefixo binário de 8 bytes**; `/proc/1/fd/1` num `exec` trava; `/containers/<id>/wait` estoura em timeout de 120 s.

---

## Onde os detalhes do ambiente do usuário ficam

**Fora do git.** Use `LOCAL.md` (ignorado) ou a configuração local do agente. Lá podem morar: endereço real do host, ID da stack e do ambiente, nomes de rede interna, procedimentos específicos da máquina, credenciais de teste.

Ao terminar uma tarefa, antes de propor commit, varra o diff por:

```
[0-9]{1,3}(\.[0-9]{1,3}){3}      # IP
/home/[a-z]                       # caminho de home
SEU-                              # placeholder que ficou no lugar de valor real (corrija)
sk-|ghp_|token|senha|password     # segredo
```

---

## Sobre o `chili3d-upstream/`

Quando presente, é um clone do fork do Chili3D (não versionado) e serve de **fonte autoritativo** para o comportamento do app: `packages/ai/` (assistente, skills, ponte), `packages/builder/src/appBuilder.ts` (o gate do `?bridge=`), `packages/app/src/pluginManager.ts` (como `guide` vira seção), `packages/ui/src/ribbon/` (como o botão da ribbon é renderizado).

O `AGENTS.md` daquele diretório **não** se aplica a este repositório: ele fala de Biome, cabeçalho AGPL e escopo de pacote do Chili3D. Aqui as convenções são as deste arquivo.

---

## Antes de pedir autorização para publicar

1. `git status` limpo do que não deve ir.
2. Diff revisado linha a linha, com a varredura acima.
3. CI verde (o workflow roda `node --check`, parse do manifest, import do `main.py`, buildx).
4. Plano de verificação pós-deploy escrito — o que conferir, em qual container, e qual linha de log demonstra que funcionou.
5. Nomeação confirmada com o usuário.

Aí sim: peça o push. Depois do CI verde, o redeploy é *Repull image and redeploy* na stack — nunca recriar.
