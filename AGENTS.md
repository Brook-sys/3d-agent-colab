# AGENTS.md — protocolo para agentes de IA neste repositório

Este arquivo é para qualquer agente (humano ou IA) que vá trabalhar no **3D Agent Colab**. Ele existe porque o projeto tem meia dúzia de armadilhas que não aparecem no código e já custaram tempo: um proxy de IA que responde 503, um chat que não abre sem documento, uma stack que não se recria, um endereço que não pode ir para o git.

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
core/      FastAPI + MCP (13 ferramentas) + registro /parts + portal FDM + serve o app + proxy /relay do relay de IA
session/   ponte WebSocket (protocolo do Chili3D) + Chromium headless + companheiro CDP
partes/    semente do registro, copiada no primeiro boot quando falta o marcador /parts/.semeadura
docs/      documentação (arquitetura, uso, operação)
deploy/    ciclo curto de desenvolvimento: build local + compose local
.github/   workflow que publica as imagens no GHCR
chili3d.ref  commit do Chili3D compilado dentro da imagem core
```

O caminho oficial de mudança é **commit → CI → pull**: o host Docker não compila nada. Imagens públicas em `ghcr.io/brook-sys/3d-agent-colab-{core,session}:main`.

Convenções: commits `<emoji> <tipo>: <descrição>` em português (`✨ feat` · `🐛 fix` · `♻️ refactor` · `📝 docs` · `🔧 chore`). Código e comentários em português, sem abreviação obscura.

---

## O que conferir antes de dizer "pronto"

Build verde **não** significa deploy funcionando. O `/relay/` e o chat da IA rodam no navegador: um erro de referência ou um preflight negado não derruba a página — só o console do kiosk e o log do companheiro testemunham.

Antes de declarar qualquer coisa pronta:

| checagem | como | o que esperar |
|---|---|---|
| sintaxe | `node --check session/bridge-server.mjs session/kiosk-cdp.mjs` | silêncio |
| proxy do relay | `curl -s -o /dev/null -w '%{http_code}' -X POST http://SEU-HOST:8080/relay/chat/completions -H 'content-type: application/json' -d '{"model":"flashmodel","messages":[{"role":"user","content":"oi"}],"max_tokens":8}'` | 200 do relay · 401 sem chave válida · 503 sem `RELAY_URL` |
| suíte do companheiro | `node teste/rodar.mjs` (também roda no CI, antes do buildx) | `VERDE: 16 cenários ok e 6 mutações acusadas` |
| import do núcleo | `python -c "import main"` dentro de `core/` (ou o probe do CI) | sem exceção |
| MCP | `curl -X POST http://SEU-HOST:9001/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize",…}'` | `protocolVersion: 2024-11-05` |
| health + ponte | `curl -s http://SEU-HOST:9001/health` | `conectada: true`, 30 ferramentas |
| app servido | `curl -s -o /dev/null -w %{http_code} http://SEU-HOST:8080/` | `200` (se der 404 ou página em branco, o `dist` não entrou na imagem) |
| documento do kiosk | `grep -a "documento do kiosk" /data/kiosk-cdp.log` no container da sessão | `criado "<parte>"` ou `já havia documento` |
| IA embutida | `grep -a "assistente de IA" /data/kiosk-cdp.log` no container da sessão | `ja-aberto · chat aberto` (o chat **começa** aberto: `editor.ts` chama `showChat()` no boot) |
| reconfiguração do companheiro | `grep -a "página navegou" /data/kiosk-cdp.log` no container da sessão | a linha só existe se a página navegou depois do boot; ausente no boot quieto é o normal |

Os dois primeiros logs **não** estão no `docker logs`: o `start.sh` redireciona o Chromium para `$DATA_DIR/chrome.log` e o companheiro CDP para `$DATA_DIR/kiosk-cdp.log`. Procurar no stdout do container não encontra nada — e o sintoma (página abre, o chat some) já é o pior possível.

Se uma dessas falhar, a tarefa **não** está pronta, por mais que o build tenha passado.

---

## Armadilhas que já custaram tempo

- **Rota com `dict | Response` sem `response_model=None`** mata o import do `main.py`: build verde, container em restart loop. O CI importa o `main.py` por isso.
- **`alert()` no kiosk headless congela o renderer** — e com ele o `open` do WebSocket da ponte. O companheiro CDP fecha diálogos; não teste caminhos que alertam sem ele.
- **`export_nodes` não devolve os bytes do STEP.** Devolve metadados e entrega como download; o núcleo busca em `GET /capturas/<nome>` e espera até 30 s. Não existe atalho.
- **Não há ferramenta de fechar documento.** `new_document` recusa com documento aberto; trocar de peça é pedir recarga (`POST /kiosk/recarregar`). Nenhum parâmetro de URL abre peça: `?part=` não carrega STEP nem registro. Quem ainda o lê é o companheiro CDP (`parteDaUrl`, `session/kiosk-cdp.mjs`), e só para dar **nome** ao documento que cria no boot — `new_document({ name: parte })`. O `KIOSK_URL` de produção não o usa, e o documento nasce `Untitled`.
- **`?bridge=` não tem relação com a IA.** MEDIDO: ele só liga o cliente da ponte WebSocket. O `ChatPanel` entra por import estático em `packages/ui/src/editor.ts` e já está no `main.js` do bundle — o assistente existe em qualquer URL, com ou sem o parâmetro. Num navegador sem ponte, o `?bridge=` faz a aba tentar `ws://127.0.0.1:17373` a cada 8 s para sempre: é ruído, não falha. (Afirmar o contrário faz o leitor caçar um problema que não existe — já houve docs errados aqui.)
- **A chave do relay evapora a cada F5.** `settings.ts` do pacote `ai` guarda a chave em memória; o assistente a perde ao recarregar a página. É decisão do Chili3D, não defeito nosso — mas significa que o kiosk precisa da chave de novo depois de qualquer recarga, e que não adianta procurá-la persistida em algum lugar.
- **CORS é do gateway, e o relay local não o tem.** MEDIDO: `OPTIONS /v1/chat/completions` no 9router responde 401 sem nenhum `Access-Control-Allow-*`; o Chrome nem envia o POST e o assistente acusa `Failed to fetch`. `api.anthropic.com`, por contraste, devolve `access-control-allow-origin: *`. Com chave pública o assistente nativo funciona sem deploy algum; com relay local, só pelo `/relay/` do núcleo. Medido hoje no container, com o código novo rodando: o preflight por `/relay/` **não chega ao relay** — o `CORSMiddleware` do próprio núcleo (`allow_origins=["*"]`, `core/main.py`) o responde com 200, `access-control-allow-origin: *` e `access-control-allow-headers: authorization,content-type`; e o POST de volta também sai com `access-control-allow-origin: *`. Same-origin continua sendo o caminho recomendado (aí não há preflight nenhum), mas cross-origin pelo `/relay/` também passa. Conferido também hoje: `GET /relay/models` lista os modelos do relay (200) — o `/relay/v1/models` também passa, porque este relay tolera o `/v1` duplicado, mas isso é sorte do gateway, não contrato.
- **O relay emite `reasoning`, o Chili3D lê `reasoning_content`.** MEDIDO com `flashmodel`: o stream traz `reasoning` e `reasoning_details`, campos que o parser do assistente ignora. Consequência: o bloco "pensando" fica vazio, mas o conteúdo strema normal. Não é falha de conexão — não procure uma.
- **Sem documento aberto, o app recusa comandos em silêncio.** `CommandService.checking()` (`packages/app/src/services/commandService.ts`, linha 133) derruba todo comando que não seja `isApplicationCommand` quando `activeView` é `undefined`, com um `Logger.error("No active document")` que ninguém vê. Foi medido aqui: sem documento, clicar no botão "AI Assistant" da ribbon, `dispatchEvent` e publicar `executeCommand` direto **nenhum dos três teve efeito**; só `PubSub.pub("toggleChatPanel")` funcionou, porque `editor.ts` assina esse tópico direto. **Com documento aberto o clique na ribbon funciona** (medido: `LOG: executing command ai.toggleChat` e o chat fecha — toggle de verdade). A ribbon saiu do nosso código por escolha de design (menos gancho no nativo), não porque esteja morta: ela só estava morta **sem** documento. É por isso que o kiosk cria um documento no boot (`new_document` pelo companheiro CDP).
- **Navegação no mesmo alvo não fecha o socket do CDP.** Medido neste deployment: depois de um `Page.navigate` na mesma aba, o companheiro seguiu com UM socket ESTABLISHED para o 9222, preso a uma sessão que nunca mais reconfigurava nada — `Page.setDownloadBehavior` não era reaplicado e pedido de recarga ficava sem resposta até o container reiniciar. A sessão antiga continuava entregando eventos (um download chegou por ela), então o sintoma não é "fica surdo". O companheiro agora fecha a sessão em `Page.frameNavigated` (quadro principal) + `Page.loadEventFired`, com rede de segurança de 12 s, e o laço externo reconfigura. Ver `vigiar` em `session/kiosk-cdp.mjs`.
- **Nenhum parâmetro de URL abre documento.** O app abre arquivo por `?url=`/`?model=` (`packages/web/src/startupParams.ts`) e ignora o resto; por isso a página nasce em `hasActiveDocument: false` e o kiosk cria o documento pela ponte (`new_document`, que chama `app.newDocument()` sem passar pelo `CommandService`). É idempotente — recusa se já houver um.
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

Quando presente, é um clone do fork do Chili3D (não versionado) e serve de **fonte autoritativo** para o comportamento do app: `packages/ai/` (assistente, skills, ponte, os três dialetos de LLM), `packages/builder/src/appBuilder.ts` (o gate do `?bridge=`), `packages/ui/src/editor.ts` (onde o chat é importado e onde `showChat()` é chamado no boot), `packages/app/src/pluginManager.ts` (como um plugin vira seção — nenhum é carregado no deploy atual).

O `AGENTS.md` daquele diretório **não** se aplica a este repositório: ele fala de Biome, cabeçalho AGPL e escopo de pacote do Chili3D. Aqui as convenções são as deste arquivo.

---

## Antes de pedir autorização para publicar

1. `git status` limpo do que não deve ir.
2. Diff revisado linha a linha, com a varredura acima.
3. CI verde (o workflow roda `node --check` da sessão, a suíte do companheiro, o import do `main.py` e o buildx).
4. Plano de verificação pós-deploy escrito — o que conferir, em qual container, e qual linha de log demonstra que funcionou.
5. Nomeação confirmada com o usuário.

Aí sim: peça o push. Depois do CI verde, o redeploy é *Repull image and redeploy* na stack — nunca recriar.
