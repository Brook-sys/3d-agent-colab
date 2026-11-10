# 3D Agent Colab

Criação autônoma de peças 3D paramétricas: uma instrução digitada
(no terminal do agente **ou** no navegador) se transforma numa peça modelada,
publicada, medida e validada para impressão — tudo dentro de containers
gerenciados por um Portainer.

O pipeline inteiro é verificável: a geometria que o agente mandou construir é a
geometria que foi arquivada (STEP real, exportado pelo kernel OCCT do
Chili3D), e as medições vêm de um portal independente em Python.

```
instrução ──▶ agente ──▶ ponte ──▶ kiosk Chromium headless (container session)
                 │          ▲          │  app e painel vêm do núcleo
                 │          └──────────┤  (mesmo host: satisfaz o PluginManager)
                 │                     ▼
                 │              export_nodes (.step) → download do navegador
                 │                     │
                 └──▶ núcleo (FastAPI) ◀┘ captura /data/capturas por nome único
                         │  arquiva v000N + valida + commita
                         ▼
                 validação FDM (build123d/OCP, processo isolado)
                         │  envelope, volume, topologia, massa
                         ▼
                 registro /parts/<slug>/vN/  ──▶ painel no navegador + fila de conversa
```

## O que está no repositório

| caminho | o que é |
|---|---|
| `core/` | Núcleo FastAPI: REST + MCP + arquivo de registro + validação FDM. Também serve o app Chili3D e o painel (estático) |
| `session/` | Ponte WebSocket/HTTP + kiosk Chromium + companheiro CDP |
| `painel/` | Painel colaborativo (plugin Chili3D puro, sem build) |
| `partes/` | Semente do registro: as peças de teste do conjunto mínimo |
| `deploy/` | Build local das imagens e servidor de arquivos (canal legado) |
| `.github/workflows/imagens.yml` | Constrói e publica as duas imagens no GHCR |
| `chili3d.ref` | Commit do Chili3D compilado dentro da imagem `core` |
| `docker-compose.yml` | A stack, apontando para as imagens do GHCR |

`chili3d-upstream/` **não** faz parte deste versionamento: é um clone do
Chili3D usado apenas para desenvolvimento. A imagem `core` **não** usa esse
clone — o Dockerfile baixa o commit fixado em `chili3d.ref` do repositório
oficial e compila dentro do build.

Havia um `web/` de nginx que servia os arquivos estáticos. Ele **não existe
mais**: o núcleo passou a servir o app e o painel no mesmo processo. O motivo
prático foi uma regra do `PluginManager` do Chili3D — `?plugin=` precisa ter o
mesmo host da página —, e o custo foi trocar o nginx por uvicorn. Ver "Notas de
operação".

## Pré-requisitos

- Um Portainer com um ambiente Docker local e uma stack (**nome**: `3d-agent-colab`).
  O deploy é feito pelo MCP do Portainer, não pelo `docker` CLI.
- Os diretórios de dados no host Docker:
  ```sh
  mkdir -p /opt/3d-agent-colab/parts /opt/3d-agent-colab/session
  chown 1000:1000 /opt/3d-agent-colab/parts   # o núcleo roda como uid 1000
  ```
- Impressora de referência: **Elegoo Neptune 4**, bico 0,4 mm, volume
  220 × 220 × 250 mm, filamentos PLA/PETG.
- Opcional, só para iterar sem rebuildar: uma máquina de desenvolvimento
  servindo `http://SEU-IP:8099` (`deploy/servidor-arquivos.mjs`).

## Imagens e deploy

As duas imagens são construídas pelo GitHub Actions e publicadas no GHCR:

```
ghcr.io/brook-sys/3d-agent-colab-core     Python 3.12 + build123d + API/MCP
                                          + app Chili3D e painel (estático)
ghcr.io/brook-sys/3d-agent-colab-session  Chromium headless + ponte WebSocket
```

Nada é compilado no host Docker: ele só faz o pull. O workflow dispara em push
na `main` que mexe em `core/`, `session/`, `painel/`, `partes/`,
`chili3d.ref` ou no próprio workflow — e também por disparo manual. Cada build
publica duas tags: `main` (a que o compose usa) e `sha-<curto>` (para voltar a
uma versão conhecida sem rebuildar). O cache é por imagem (`scope=core`,
`session`), então mudar o painel não repaga o build do Chili3D.

O pacote leva **hífen**, não barra (`3d-agent-colab-core`, e não
`3d-agent-colab/core`): é a convenção que o picofarm e o orca-slicer-api já
usam. Duas consequências que já queimaram nesta fase: a URL do `PATCH` de
visibilidade não leva percent-encode (o `%2F` é da variante com barra e dá 404),
e o nome no `docker-compose.yml` tem de ser escrito completo — apontar
`.../3d-agent-colab/web:main` no compose referencia uma imagem que nunca foi
publicada, o host não tem o que puxar e a stack não recria nada, em silêncio.

**Atualizar o Chili3D**: troque o SHA em `chili3d.ref` (e a nota de versão) e
dê push. O app é recompilado do commit novo no build da imagem `core`. Nenhum
binário entra neste repositório, e o fonte correspondente continua público no
repositório oficial do Chili3D — que é a obrigação da licença AGPL-3.0 dele.

**Subindo pelo Portainer**: com a stack apontando para o GHCR, um
`StackUpdate` com *Pull image* ligado baixa a `main` mais nova e recria os
containers. Imagem nova só entra em vigor **recreando o container** — o
`restart` sozinho não troca a imagem.

### Ciclo curto, sem CI

```sh
# builda as duas imagens localmente com os MESMOS Dockerfiles do workflow
./deploy/build-local.sh

# sobe a stack com as imagens locais em vez do GHCR
docker compose -f docker-compose.yml -f deploy/compose.local.yml up -d
```

Para aplicar uma mudança de código sem passar pelo CI, existe ainda o canal
`FONTE_URL` (legado): sirva o projeto com `node deploy/servidor-arquivos.mjs
"$PWD" 8099`, empacote com `sh deploy/empacotar.sh`, aponte `FONTE_URL` no
ambiente dos containers e reinicie. Os entrypoints atualizam o `/app` do núcleo
(`main.py`, `entrypoint.sh`, `requirements.txt`) e os arquivos da sessão por
cima do que está na imagem. **O app Chili3D e o painel NÃO entram nesse canal**:
eles são copiados/compilados durante o build da imagem, então mudar o painel
exige imagem nova — `./deploy/build-local.sh` no ciclo curto, ou commit + CI.
É útil para depurar, e é exatamente o modo de falha que o GHCR elimina: o que
está na imagem passa a ser a verdade.

### Portas

| porta | o que | exposição |
|---|---|---|
| 8080 | app Chili3D + painel, para o navegador | host |
| 9001 | REST + MCP do núcleo | host |
| 17373 | ponte WebSocket | **só a rede interna dos containers** |
| 17400 | relay HTTP da ponte | **só a rede interna dos containers** |

8080 e 9001 são **a mesma porta do container** (o núcleo escuta 9001), publicada
duas vezes: 8080 é o endereço "bonito" para quem abre o app, e 9001 existe
porque o painel precisa bater no núcleo pelo `location.hostname` — ver a seção
do navegador. Não é redundância, é o que faz o painel funcionar nos dois
acessos.

O par 17373/17400 **não é publicado no host** (não há `ports:` no serviço
`session`). É controle remoto sem autenticação sobre a sessão do navegador:
com porta no host, qualquer processo da máquina — inclusive uma página sua com
`?bridge=`, que assume a ponte e derruba o kiosk com código 4002 — alcança.
Sem `ports:`, só o que está na rede `3d-agent-colab` fala com a ponte, e hoje
isso é só o núcleo. Consequência: `POST /kiosk/recarregar` mudou de endereço —
ver "Notas de operação".

### Configuração

O `docker-compose.yml` traz todas as variáveis com `${VAR:-default}`, e o campo
**Env** da stack no Portainer sobrescreve o que for específico deste deploy. A
lista completa, com os defaults que o código aplica quando a variável não
existe:

| variável | serviço | default | para quê |
|---|---|---|---|
| `PARTS_ROOT` | core | `/parts` | raiz do registro de peças |
| `BRIDGE_URL` | core | `http://session:17400` | endereço da ponte na rede interna |
| `PORT` | core | `9001` | porta que o uvicorn escuta |
| `PRINTER_MODEL` | core | `Elegoo Neptune 4` | impressora usada no relatório |
| `PUID` / `PGID` | core | `1000` | uid/gid do processo (e do registro) |
| `BRIDGE_PORT` | session | `17373` | porta WebSocket da ponte |
| `BRIDGE_HTTP_PORT` | session | `17400` | porta HTTP da ponte |
| `BRIDGE_DATA_DIR` | session | `/data` | capturas, perfil do Chromium, pedidos |
| `KIOSK_URL` | session | `http://core:9001/?bridge=&plugin=http://core:9001/painel/&part=espacador&painel=1` | página que o kiosk abre |
| `FONTE_URL` | ambos | vazio | canal legado de atualização por HTTP |

Nenhuma dessas variáveis é segredo. O que **não** deve ir para o Env versionado
é endereço da sua máquina: `FONTE_URL` existe para isso e fica vazio por
padrão.

### Dados (bind mounts)

Os dois serviços escrevem em diretórios do host, não em volumes Docker:

| caminho no host | montado em | contém |
|---|---|---|
| `/opt/3d-agent-colab/parts` | `/parts` (core) | registro de peças, `_estado/`, `.git` |
| `/opt/3d-agent-colab/session` | `/data` (session) | perfil do Chromium, capturas `.step`, pedidos do kiosk |

Escolhas por trás disso, não por acaso: o caminho é visível e faz backup com o
resto do `/opt`; um volume Docker esconde os dados em `/var/lib/docker/volumes` e
copia o conteúdo inteiro quando alguém mexe no dono; e o registry do GHCR fica
só com o que é imagem — código e app —, nunca com estado.

A semeadura é automática: num `/parts` vazio (bind novo de montagem), o
`entrypoint.sh` copia a semente que a imagem traz em `/seed/partes` e grava
`.semeadura`. Um `/parts` que já tem conteúdo **não** é sobrescrito — é assim
que o histórico sobrevive a um redeploy. Para começar limpo de propósito,
esvazie o diretório antes de subir a stack.

O `/data` da sessão pode ser apagado à vontade quando o kiosk não está
rodando: ele é cache de navegador (perfil + IndexedDB) e área de transferência
do STEP. Perdê-lo custa um recarregamento de página, não uma versão publicada.

## Usando

### O agente (terminal)

Aponte o MCP do agente para `http://SEU-HOST:9001/mcp` (streamable-http). As
13 ferramentas:

| ferramenta | serve para |
|---|---|
| `partes`, `parte_criar` | arquivo de registro |
| `ponte_estado`, `ponte_ferramentas` | a ponte está viva? o que a página expõe? |
| `pagina_chamar` | chamar qualquer uma das 30 ferramentas da página |
| `variaveis` | ler/escrever as variáveis paramétricas do documento |
| `publicar` | exportar STEP pela ponte, arquivar e validar |
| `validar` | rodar o portal FDM numa versão |
| `construir_python` | caminho headless: script build123d → versão arquivada |
| `mensagens`, `enviar_mensagem` | fila de conversa compartilhada |
| `anotacoes`, `estado_plugin` | comentários ancorados e estado do painel |

Um turno típico:

```
parte_criar(slug="suporte-l", intencao="cantoneira 40x35…", material="PLA")
pagina_chamar("run_parametric", {ops: [...]})       # ou construir_python
variaveis(acao="set", variaveis=[…])                # ajuste paramétrico
publicar(slug="suporte-l")                          # STEP + validação + git
enviar_mensagem(texto="v0001 pronta: 10,24 g de PLA")
```

### O usuário (navegador)

Abra `http://SEU-HOST:8080/?plugin=http://SEU-HOST:8080/painel/&part=suporte-l&painel=1`.
O painel mostra as variáveis paramétricas com controles deslizantes, os
comentários ancorados na seleção atual, a fila de conversa e o botão de
publicar.

Dois parâmetros faltam nessa URL de propósito, e nenhum dos dois por esquecimento:

- **sem `bridge=`** — a página monta o endereço da ponte como
  `ws://127.0.0.1:17373/ws`, com o host fixo no código do app. No seu navegador
  isso aponta para a *sua* máquina, não para o container. Pior: se você abrir a
  página na própria máquina do Docker, a sua aba assume a ponte e o servidor
  derruba o kiosk com código 4002 ("outra aba assumiu a ponte") — a página do
  kiosk para de receber chamadas e a publicação morre. O painel não precisa da
  ponte no seu navegador: o estado dela vem de `GET /ponte/estado` no núcleo, e
  o "publicar" vai pelo núcleo, que fala com o kiosk pelo lado do servidor.
- **sem `api=`** — o painel cai no fallback `http://${location.hostname}:9001`
  (`painel/src/extension.js:16`), que na sua máquina vira
  `http://SEU-HOST:9001`. É por isso que o núcleo publica 9001 no host, e não
  apenas 8080 (ver "Portas").

`?plugin=` **precisa** ser URL absoluta e do mesmo host da página: o
`PluginManager` faz `new URL(valor)` e compara o host — com caminho relativo
ele lança, e o `catch` do build chama `alert()`, que congela o renderer
headless (o kiosk não tem ninguém para clicar "OK"). Antes do nginx sair, isso
era resolvido com `location ^~` e dois hosts; agora o app e o painel são
servidos pelo mesmo processo, e a regra fica satisfeita por construção.

## Registro de peças

```
/parts/<slug>/
├── spec.json, spec.md          # intenção e parâmetros
├── modelo.py                   # geometria de referência (build123d)
├── anotacoes.json              # comentários ancorados
└── v000N/
    ├── model.step              # geometria exportada pela página (ou pelo script)
    ├── documento.json          # estado do documento Chili3D no momento
    ├── params.json             # variáveis paramétricas (e o material usado)
    ├── validacao.json          # medições + veredicto
    ├── export-step.json        # diagnóstico da exportação, quando ela falha
    └── manifest.json           # quando/como; `completa`/`sem_step`
```

Tudo em cima de um repositório git interno (`/parts/.git`): cada publicação é
um commit que já contém o `validacao.json` — a medição entra no histórico
junto com a geometria (a ordem importa: validar antes do commit).

A massa do `validacao.json` usa o material com que a versão foi **publicada**
(`params.json`), não o do `spec.json`. Publicar com PETG e validar depois
devolve o mesmo número nos dois caminhos.

`manifest.json` com `"completa": false` (ou `"sem_step": true`) marca uma
publicação sem geometria — o registro da tentativa fica, mas não parece peça
pronta.

## Validação FDM

Portal em processo Python isolado (`build123d`/OCP) que mede do BREP:

- envelope (caixa) e volume;
- topologia: número de sólidos, faces, arestas;
- massa em gramas e metros de filamento Ø1,75 mm;
- delta de volume contra a versão anterior;
- densidades: PLA 1,24 · PETG 1,27 · ABS 1,04 · RESINA 1,10 g/cm³.

Veredito `ok` / `atencao` (avisos) / `bloqueado` (problemas). Hoje só o
envelope, o volume, a topologia e a massa são medidos de fato na geometria —
**parede mínima, espessura de topo, diâmetro mínimo de furo, overhang e ponte
NÃO são**: as regras ficam declaradas no spec e a conferência é do agente na
revisão. O `validacao.json` carrega essa limitação em `limitacoes`.

## Licenças

O app servido pela imagem `core` é o **Chili3D**, licenciado em **AGPL-3.0**
(repositório oficial: `xiangechen/chili3d`, commit fixado em `chili3d.ref`).
Ele é compilado do fonte a cada build — o binário que roda no kiosk é
derivado daquele commit, e o fonte correspondente está público lá.

O código **deste** repositório (`core/`, `session/`, `painel/`)
não tem licença declarada, e isso é uma escolha em aberto, não um esquecimento:
sem um arquivo `LICENSE`, o padrão legal é "todos os direitos reservados".
Definir uma é tarefa do dono do repositório.

## Notas de operação (o que quebra)

- **Trocar de peça exige recarregar a página** — não existe ferramenta de
  fechar documento, e `new_document` recusa se houver uma aberta. Use
  `POST /kiosk/recarregar`, que é do **núcleo** (`http://<host>:8080/kiosk/recarregar`):
  ele encaminha o pedido para a ponte pelo lado do servidor, e o companheiro
  CDP executa `Page.reload`. A rota no núcleo existe porque a ponte **não
  publica porta no host** — antes o endpoint era `http://<host>:17400/kiosk/recarregar`,
  da ponte, alcançável só pelo loopback da máquina do Docker.
- **`chown -R` em diretório de imagem dentro do entrypoint é dívida de startup
  garantida.** Foi real: o núcleo fazia `chown -R /parts /venv /app` antes de
  reexecutar como uid 1000, e no overlayfs cada arquivo precisa ser copiado
  para a camada superior antes de o dono poder ser trocado. Medido neste host:
  4 s de CPU e mais de 10 minutos de relógio, com o container em estado "Up",
  healthcheck vermelho e a porta 9001 recusando conexão — o pior modo de falha
  para diagnosticar, porque "Up" mente. A correção foi mover a conta para o
  build (`COPY --chown` e `chown` na camada do venv), onde ela vira cache. Fica
  a regra: qualquer permissão que o runtime precisa, a imagem já entrega.
- **O app restaura o documento do IndexedDB na recarga** (banco
  `chili3d-db`): por isso o documento sobrevive a um `Page.reload`, e o
  estado "sem documento" praticamente não ocorre sozinho. Para reproduzi-lo,
  apague o banco por CDP (`indexedDB.deleteDatabase`) e recarregue.
- **`publicar` sem documento aberto falha em ~13 ms** e não cria versão — a
  guarda confere o estado antes de criar o diretório. Antes, um kiosk
  recarregado arquivava um `vN/` sem STEP, 30 s de espera e um veredicto
  "bloqueado" sem explicação.
- **Mudança em `start.sh`/`entrypoint.sh` só vale no restart seguinte**: o `sh`
  já bufferizou o script. Conte **dois restarts**.
- **Stale `SingletonLock`**: um Chromium morto a golpe deixa o lock do perfil e
  o próximo morre sem abrir janela. O loop do kiosk limpa antes de cada launch.
- **`export_nodes` devolve só metadados** — os bytes do STEP são um download do
  navegador. O companheiro CDP os grava em `/data/capturas`, a ponte publica em
  `GET /capturas/<nome>` e o núcleo busca por nome único (com *nonce*) e apaga.
- **`HOME` do núcleo** aponta para um diretório gravável (`/tmp/colab-home`):
  o ezdxf, puxado pelo build123d, precisa escrever `~/.config`.
- **Logs Docker têm prefixo binário de 8 bytes** — filtre
  `[\x00-\x08\x0e-\x1f]` antes de ler.
- **`uvicorn` não é nginx, e agora ele serve o app.** O `web/` de nginx saiu e
  o núcleo passou a servir o dist do Chili3D e o painel. O que se perdeu de
  fato: **gzip inexistente** (o nginx também não tinha, então nada mudou aqui),
  `sendfile`, e uma configuração de cache que era testada há anos. O que se
  ganhou: uma origem só, sem `location ^~` e sem alias. A troca foi consciente e
  é a maior dívida desta mudança — se o app passar a servir muitos usuários, um
  proxy na frente volta a ser necessário.
- **A ordem dos `mount` em `main.py` é frágil, e o último é casado antes de
  qualquer rota registrada depois dele.** Os mounts são casados na ordem de
  registro, então `app.mount("/", StaticFiles(dist))` fica no fim e `/painel` vem
  antes. Se alguém mover uma rota da API para depois do bloco estático, ela fica
  inacessível — o mount é casado primeiro. O sintoma medido não é o que se
  supõe: GET em caminho inexistente continua dando 404 do FastAPI (não
  index.html com 200), mas **POST num caminho com barra final devolve 405 do
  mount**, não da API. Ou seja: o estrago é real, mas ele não grita sempre —
  um 405 ou uma rota que "não pega" sem explicação é o que se vê. No nginx isso
  era o `location ^~`, que não dependia de posição.
- **O núcleo e o registro de peças dividem o mesmo cgroup.** Antes o kernel
  geométrico e o servidor estático viviam em containers separados; hoje um
  estouro de memória no núcleo leva a validação junto. O inverso também: uma
  validação grande pode fazer o servidor parar de responder. **O limite de
  memória do container (2,5 GB no host) não foi medido contra um caso real** —
  é um número de configuração, não uma medição.
- **Por que não um container só.** Juntar o kiosk no núcleo foi considerado e
  descartado por dois motivos: um OOM do Chromium mataria a API por cgroup
  compartilhado, e o loop de restart do kiosk (a cada queda do navegador)
  levaria a API junto. Dois containers é o meio-termo; o preço é que o STEP
  continua dando volta pelo `GET /capturas`, em HTTP, dentro da rede do compose.

### Conferindo o que está rodando

`/app/main.py` é o que está na imagem (atualizado no boot pelo `entrypoint.sh`
só quando `FONTE_URL` está acessível). Um probe com
`NetworkMode: container:<id>` **compartilha apenas a rede**: o `/app` que ele
vê é o dele, não o do container alvo. Para conferir o arquivo real do
contêiner, use `POST /containers/<id>/exec` (foi assim que se descobriu que o
refresh estava funcionando e o defeito era do probe).

## Limitações conhecidas

Este repositório é um **protótipo**. Fragilidades reais, não teóricas:

- **Sem autenticação em lugar nenhum.** O REST, o MCP e o relay da ponte são
  abertos. As portas 8080 e 9001 são públicas: qualquer um que alcance o host
  pode publicar versões, escrever na fila de conversa e dirigir o navegador do
  kiosk. A ponte ficou fora do host (sem `ports:` no `session`), o que fecha o
  caminho mais direto — mas o núcleo, que fala com ela, continua aberto.
- **O kiosk é um único ponto de falha.** Um `alert()` em caminho de erro do app
  congela a thread principal da página; o companheiro CDP fecha o diálogo, mas
  a página continua no estado em que estava. Não há health-check do renderer.
- **Exportação depende de download do navegador.** Se o Chromium mudar o
  comportamento padrão de download, ou o CDP trocar de endereço, a publicação
  perde o STEP e arquiva só o diagnóstico.
- **Estado do documento vive na RAM do kiosk.** Reiniciar a sessão perde a
  geometria não publicada — o registro é a única memória durável.
- **Validação FDM é só métrica.** Nenhuma checagem de manufaturability real
  (parede, furo, overhang) está implementada; a conferência é humana/agente.
- **`git` dentro do volume** exige `safe.directory` quando rodado por root
  fora do núcleo, e a semente do registro (`/parts/.semeadura`) é copiada uma
  única vez.
- **Um agente por vez no kiosk.** Não há trava: dois agentes chamando
  `run_program` na mesma página disputam o documento sem aviso.
- **O registro não fica perpetuamente limpo.** O painel publica estado
  periodicamente em `_estado/` e uma `validar` avulsa reescreve o
  `validacao.json` com novo `gerado_em`: os dois aparecem como modificados até
  a próxima publicação commitar.
- **A versão zumbi aconteceu.** O defeito de arquivar sem documento foi real e
  corrigido, mas a lição de fundo persiste: o núcleo confia no estado da RAM do
  kiosk, e a única defesa é conferir antes de escrever.
