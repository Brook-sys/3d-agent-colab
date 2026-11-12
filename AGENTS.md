# AGENTS.md — protocolo para agentes de IA neste repositório

Este arquivo é para qualquer agente (humano ou IA) que vá trabalhar no **3D Agent
Colab**. Ele existe porque o projeto tem meia dúzia de armadilhas que não aparecem
no código e já custaram tempo: um proxy de IA que respondia 503, um assistente que
não abria sem documento, uma stack que não se recria, um endereço que não pode ir
para o git. Leia o [README](README.md) antes. Este arquivo trata do que **não**
fazer e do que **conferir**.

---

## As cinco regras que não se quebram

1. **Push e publish só com autorização explícita.** `git push`, publicar imagem,
   `npm publish`: nunca sem o usuário pedir. Na dúvia, pergunte — não presuma que
   "terminar a tarefa" inclui publicar.
2. **Nada de dado do ambiente do usuário em arquivo versionado.** Endereço IP,
   hostname, username, caminho de home, topologia de rede, estado da
   infraestrutura, token, ID de stack. Em arquivo versionado usa-se `SEU-HOST`,
   `SEU-RELAY`, `localhost`. O valor real do usuário fica na configuração local
   dele (`opencode.json`, `.env`), nunca no repositório.
3. **Chave de API de IA nunca em arquivo versionado.** Nem em `docker-compose.yml`,
   nem em documentação, nem em exemplo. Ela é colada na interface. Se um dia
   aparecer num arquivo, trate como vazamento e avise.
4. **Pergunte antes de nomear.** Nome de container, de rede, de imagem, de tag:
   pergunte. Neste projeto os nomes são fixos de propósito (`chili3d`,
   `chili3d-dev`, `aiNetwork`, `ghcr.io/brook-sys/chili3d`) e uma "melhoria" de
   nomenclatura quebra o compose, os binds e os scripts de verificação.
5. **A stack em produção não se recria sem pedir.** Atualizar é uma coisa; deletar
   e recriar é outra. Peça.

---

## Como este repositório funciona

```
chili3d/   Dockerfile (build do app + runtime Node) + servidor.mjs (estático + /v1/)
teste/     suíte do servidor, com teste de mutação
deploy/    ciclo curto de desenvolvimento: build local + compose local
docs/      documentação (o diagnóstico do assistente e do relay)
chili3d.ref  commit do Chili3D compilado dentro da imagem
```

O caminho oficial de mudança é **commit → CI → pull**: o host Docker não compila
nada. Imagem pública em `ghcr.io/brook-sys/chili3d:main`.

Convenções: commits `<emoji> <tipo>: <descrição>` em português (`✨ feat` ·
`🐛 fix` · `♻️ refactor` · `📝 docs` · `🔧 chore`). Código e comentários em
português, sem abreviação obscura.

---

## O que conferir antes de dizer "pronto"

Build verde **não** significa deploy funcionando. E, neste repositório em
particular, suíte verde também não: a suíte prova o servidor contra um **relay
falso**. A última milha — assistente apontado, chave colada, modelo respondendo —
só se mede em deploy, com chave válida.

| checagem | como | o que esperar |
|---|---|---|
| sintaxe | `node --check chili3d/servidor.mjs teste/*.mjs` | silêncio |
| suíte completa | `node teste/rodar.mjs` | `VERDE: 2 suítes ok e 8 de 8 mutações provadas` |
| trava da versão | `sed -n 's/^CHILI3D_REF=//p' chili3d.ref` e conferir o `ARG` no Dockerfile | os dois batem (o CI também confere) |
| coerência do relay | `RELAY_URL` no compose sem `/v1` no fim | `http://9router:20128` |
| imagem builda | `./deploy/build-local.sh` | termina sem erro e lista `chili3d-dev` |
| healthcheck | `curl -s http://SEU-HOST:8080/healthz` | `{"ok":true,...}` — e isso **não** prova o relay |
| app servido | `curl -s -o /dev/null -w %{http_code} http://SEU-HOST:8080/` | `200` |
| preflight | `curl -s -o /dev/null -w %{http_code} -X OPTIONS http://SEU-HOST:8080/v1/chat/completions` | `204` — respondido por nós |
| proxy | `curl -s -H 'authorization: Bearer ...' http://SEU-HOST:8080/v1/models` | a lista de modelos do **relay real** |
| assistente | abrir o app, colar a chave, mandar "oi" | resposta do modelo, não "Connection error." |

Se uma dessas falhar, a tarefa **não** está pronta, por mais que o build tenha
passado.

---

## Armadilhas que já custaram tempo

- **A suíte passa com cenário vaculo se ninguém medir o que o cliente manda.**
  MEDIDO, duas vezes, nesta suíte: (1) o `fetch` do Node **não põe `Origin`**
  sozinho, então um cenário "o relay não recebe origin" passava verde com o proxy
  repassando tidy o que nunca veio; (2) medir o primeiro byte **depois** do
  `await fetch` não mede nada — num proxy que bufferiza, os cabeçalhos só são
  escritos no fim. As duas correções estão nos cenários, com a medição que as
  justifica. Ao acrescentar cenário aqui, pergunte primeiro o que o cliente
  realmente envia.
- **Caminho de travessia que o cliente normaliza não testa nada.** MEDIDO:
  `/%2e%2e/` chega ao servidor como `/segredo.txt`. E `/..%2f..%2fsegredo.txt`,
  medido contra o servidor com a proteção removida, dá 404 — sobe dois níveis e
  aponta para `/tmp`. Só entram no teste caminhos que, medidos, furam.
- **`RELAY_URL` não leva `/v1`.** O `/v1` é este servidor que põe (`/v1${resto}`),
  e um default com `/v1` pediria `/v1/v1/...` no relay. O sintoma é 404 do relay,
  que não aponta para o compose.
- **A rede do relay é externa.** `aiNetwork` é criada pela stack do relay; o
  compose a declara `external: true`. Entrar nela é o que permite falar com o
  relay pelo nome. Sem ela, a stack sobe e o `/v1/` devolve 502 explicativo.
- **O build da imagem baixa o app do GitHub.** O `curl` para
  `codeload.github.com` roda dentro do builder. Se o runner não alcançar o
  GitHub, o build falha no `builder`, não no runtime.
- **`PORTA_APP` existe por um motivo de transição.** Durante a troca da stack
  antiga pela nova, as duas coexistem e a 8080 fica ocupada. Sobe com
  `PORTA_APP=8081`; volta a 8080 quando a antiga sair.
- **O `dist` não entra no repositório.** Ele é compilido no builder. O
  Dockerfile falha de propósito se `/src/dist/index.html` não aparecer (`test -f`),
  porque uma imagem sem dist sobe e serve 404 — sintoma que não aponta para o
  build.
- **Logs Docker têm prefixo binário de 8 bytes**; `/proc/1/fd/1` num `exec` trava;
  `/containers/<id>/wait` estoura em *timeout* de 120 s.
- **O sandbox de desenvolvimento não alcança o host Docker.** Toda verificação de
  rede roda por dentro dos containers, via proxy do Portainer. `curl` daqui para
  `SEU-HOST` dá conexão recusada, e isso **não** é defeito do deploy.

---

## Onde os detalhes do ambiente do usuário ficam

**Fora do git.** Use `LOCAL.md` (ignorado) ou a configuração local do agente. Lá
podem morar: endereço real do host, ID da stack e do ambiente, nomes de rede
interna, procedimentos específicos da máquina, credenciais de teste.

Ao terminar uma tarefa, antes de propor commit, varra o diff por:

```
[0-9]{1,3}(\.[0-9]{1,3}){3}      # IP
/home/[a-z]                       # caminho de home
SEU-                              # placeholder que ficou no lugar de valor real (corrija)
sk-|ghp_|token|senha|password     # segredo
```

---

## Sobre o `chili3d-upstream/`

Quando presente, é um clone do Chili3D original (não versionado) e serve de
**fonte autoritativo** para o comportamento do app: `packages/ai/` (assistente,
skills, ponte, os três dialetos de LLM), `packages/ui/src/editor.ts` (onde o chat
é importado e onde `showChat()` é chamado no boot), `packages/app/src/services/commandService.ts`
(o gate que derruba comandos sem documento ativo).

O `AGENTS.md` daquele diretório **não** se aplica a este repositório: ele fala de
Biome, cabeçalho AGPL e escopo de pacote do Chili3D. Aqui as convenções são das
deste arquivo.

---

## Antes de pedir autorização para publicar

1. `git status` limpo do que não deve ir.
2. Diff revisado linha a linha, com a varredura acima.
3. CI verde (o workflow roda `node --check`, a suíte com teste de mutação, a
   trava do SHA contra `chili3d.ref` e o buildx).
4. Plano de verificação pós-deploy escrito — o que conferir, e qual linha de log
   ou resposta HTTP demonstra que funcionou.
5. Nomeação confirmada com o usuário.
6. **Se for publicar imagem nova**: conferir antes que o nome do pacote
   (`ghcr.io/brook-sys/chili3d`) está livre ou já é o nosso — publicar sob nome
   existente de outrem sobrescreve.

Aí sim: peça o push. Depois do CI verde, o redeploy é *Repull image and redeploy*
na stack — nunca recriar.
