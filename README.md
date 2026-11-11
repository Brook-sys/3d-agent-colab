# 3D Agent Colab

> Criação assistida por IA de peças 3D paramétricas: uma instrução digitada — no terminal do agente **ou** dentro da interface do Chili3D — se transforma numa peça modelada, publicada, medida e validada para impressão. Tudo dentro de containers, sem build na máquina do Docker.

![CI](https://github.com/Brook-sys/3d-agent-colab/actions/workflows/imagens.yml/badge.svg)
![imagens](https://img.shields.io/badge/GHCR-ghcr.io%2Fbrook--sys%2F3d--agent--colab-2496ED?logo=docker&logoColor=white)
![status](https://img.shields.io/badge/status-prot%C3%B3tipo-orange)
![app](https://img.shields.io/badge/app-Chili3D%20AGPL--3.0-blueviolet)

---

## O que é

Um pipeline verificável de modelo → versão → medição → validação, com **dois caminhos de IA** que cooperam pela mesma fila de mensagens:

```
   ┌──────────────┐        ┌───────────────────────────────┐        ┌──────────────┐
   │  você        │        │  core  (FastAPI + MCP)        │        │  session     │
   │  navegador   │───────▶│  · registro /parts            │◀──────▶│  · ponte WS  │
   │  Chili3D +   │  8080  │  · validação FDM (build123d)  │  :9001 │  · kiosk     │
   │  painel + IA │◀───────│  · serve o app e o painel     │        │    Chromium  │
   └──────────────┘  9001  └───────────────┬───────────────┘        └──────────────┘
            ▲                             │  v000N/                    ▲
            │  mesma fila de conversa     ▼                            │ mesma ferramenta
   ┌──────────────┐              STEP real exportado pelo kernel OCCT   │ (30 ferramentas)
   │  agente      │───────────────▶  medida + veredicto + commit git ───┘
   │  OpenCode    │  MCP           (a medição entra no histórico)
   │  (13 tools)  │
   └──────────────┘
```

A geometria que o agente manda construir é a geometria que foi arquivada — **STEP real, exportado pelo kernel OCCT do Chili3D** — e as medições vêm de um portal independente em Python. Nada de malha "de verdade" e nada de número estimado: o `validacao.json` diz o que foi medido de fato e o que não foi.

## Diferenciais

| | |
|---|---|
| **Geometria real, não aproximada** | o STEP sai do kernel OCCT (WASM) do Chili3D, pelo mesmo caminho que um humano usaria |
| **Validação independente** | portal Python em processo separado mede o BREP: envelope, topologia, volume, massa, delta contra a versão anterior |
| **Dois caminhos de IA, um estado** | o assistente embutido do Chili3D (age no documento) e o agente externo por MCP (age pelo servidor) leem a **mesma** fila de mensagens e o mesmo registro |
| **Deploy sem build no host** | as imagens vêm do GHCR; o host Docker só faz pull. Nada de toolchain, nada de Node, nada de Python na máquina |
| **Registro versionado** | cada publicação é um commit git em `/parts/.git` **com a validação dentro** — a medição e a geometria nascem juntas no histórico |
| **Kiosk headless descartável** | a sessão do navegador é cache: perdê-la custa um recarregamento, não uma versão publicada |

## Começo rápido

**1. Crie os diretórios de dados no host Docker** (binds, não volumes — ver [Dados](#dados)):

```sh
mkdir -p /opt/3d-agent-colab/parts /opt/3d-agent-colab/session
chown 1000:1000 /opt/3d-agent-colab/parts      # o núcleo roda como uid 1000
```

**2. Suba a stack** (Portainer → Stacks → Add stack, ou `docker compose up -d`). O compose completo está em [`docker-compose.yml`](docker-compose.yml); o essencial:

```yaml
services:
  core:
    image: ghcr.io/brook-sys/3d-agent-colab-core:main
    container_name: 3d-agent-colab-core
    ports: ["8080:9001", "9001:9001"]     # 8080 = app · 9001 = REST + MCP
    volumes: ["/opt/3d-agent-colab/parts:/parts"]
  session:
    image: ghcr.io/brook-sys/3d-agent-colab-session:main
    container_name: 3d-agent-colab-session
    volumes: ["/opt/3d-agent-colab/session:/data"]
    # sem `ports:` de propósito — a ponte é controle remoto sem autenticação
networks:
  3d-agent-colab: { name: 3d-agent-colab }
```

**3. Abra o app**: `http://SEU-HOST:8080/?plugin=http://SEU-HOST:8080/painel/&part=espacador&painel=1&bridge=`

O `&bridge=` não é enfeite: é o que faz a página importar o pacote de IA. Sem ele o assistente **não existe** — nem ribbon, nem comando. No seu navegador não há ponte rodando, então a aba vai tentar `ws://127.0.0.1:17373` a cada 8 s e falhar: é ruído de console, não defeito. O kiosk já abre com esse parâmetro.

**4. Ligue a IA embutida**: clique em **Manager ▸ Other ▸ AI Assistant** (no kiosk ela já abre sozinha), cole a chave na engrenagem e escolha o provedor. Veja [uso com IA no Chili3D](docs/uso-chili3d-ia.md).

**5. Aponte o agente** para `http://SEU-HOST:9001/mcp`. Veja [uso pelo OpenCode](docs/uso-opencode.md).

## Duas formas de usar

| | **IA dentro do Chili3D** | **Agente externo (OpenCode)** |
|---|---|---|
| onde roda | dentro da aba do app | no seu terminal, com MCP |
| o que precisa | chave de API na engrenagem do chat | `opencode.json` apontando para `:9001/mcp` |
| age sobre | o documento aberto | o documento **e** o registro (publicar, validar, arquivar) |
| melhor para | modelar, ajustar variáveis, explorar | publicar versões, validar, registrar, conversar com você |
| persiste | conversa no documento (IndexedDB) | registro `/parts` + git |

Os dois **cooperam**: a fila de mensagens é a mesma (`GET/POST /mensagens` no núcleo), então você pode pedir no painel e deixar o agente executar, ou o contrário. Guia completo em [docs/uso-chili3d-ia.md](docs/uso-chili3d-ia.md) e [docs/uso-opencode.md](docs/uso-opencode.md).

## Arquitetura

Dois containers, um processo cada, e uma escolha que define o resto: **o núcleo também serve o app e o painel**. Antes havia um terceiro container de nginx só para os arquivos estáticos; ele saiu porque o `PluginManager` do Chili3D exige que `?plugin=` tenha o **mesmo host** da página, e servir os dois pelo mesmo processo satisfaz a regra por construção — sem `location ^~` e sem alias de nginx. O preço está anotado em [docs/arquitetura.md](docs/arquitetura.md): uvicorn não é nginx.

```
core (ghcr.io/brook-sys/3d-agent-colab-core:main)
  FastAPI + MCP (13 ferramentas) + registro /parts + portal FDM + estático
  porta do container: 9001  →  host: 8080 (app) e 9001 (REST/MCP)

session (ghcr.io/brook-sys/3d-agent-colab-session:main)
  ponte WebSocket (protocolo oficial do Chili3D) + Chromium headless (kiosk) + companheiro CDP
  porta 17373 (WS) e 17400 (HTTP)  →  NÃO publicadas no host
```

Detalhes, protocolo, trade-offs e os modos de falha medidos: [docs/arquitetura.md](docs/arquitetura.md).

## Documentação

| documento | conteúdo |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | containers, protocolo da ponte, fluxo do STEP, trade-offs e os modos de falha já medidos |
| [docs/uso-opencode.md](docs/uso-opencode.md) | configurar o MCP, as 13 ferramentas, um turno completo de trabalho |
| [docs/uso-chili3d-ia.md](docs/uso-chili3d-ia.md) | ligar e configurar a IA embutida, os 3 provedores, o que ela pode fazer, como ela aprende o projeto |
| [docs/operacao.md](docs/operacao.md) | deploy, redeploy, backup, logs e a tabela de sintoma → causa → ação |
| [docs/painel.md](docs/painel.md) | como o painel funciona e como estendê-lo |

## Estrutura do repositório

```
core/            FastAPI + MCP + registro + build123d + servidor do app/painel
session/         ponte WebSocket + kiosk Chromium + companheiro CDP
painel/          plugin do Chili3D (JS puro, sem build): variáveis, comentários, chat, IA
partes/          semente do registro (espacador, suporte-l) — copiada no primeiro boot
deploy/          ciclo curto de desenvolvimento (build local + compose local)
docs/            documentação (este índice)
.github/         workflow que publica as imagens no GHCR
chili3d.ref      commit do Chili3D compilado na imagem core
AGENTS.md        protocolo para agentes de IA que trabalham neste repo
```

## Configuração

Todas as variáveis têm default e o campo **Env** da stack no Portainer sobrescreve o que for específico:

| variável | serviço | default | para quê |
|---|---|---|---|
| `PARTS_ROOT` | core | `/parts` | raiz do registro de peças |
| `BRIDGE_URL` | core | `http://session:17400` | endereço da ponte na rede interna |
| `PORT` | core | `9001` | porta que o uvicorn escuta |
| `PRINTER_MODEL` | core | `Elegoo Neptune 4` | impressora usada no relatório |
| `PUID` / `PGID` | core | `1000` | uid/gid do processo |
| `BRIDGE_PORT` | session | `17373` | porta WebSocket da ponte |
| `BRIDGE_HTTP_PORT` | session | `17400` | porta HTTP da ponte |
| `BRIDGE_DATA_DIR` | session | `/data` | capturas, perfil do Chromium, pedidos |
| `KIOSK_URL` | session | `http://core:9001/?bridge=&plugin=http://core:9001/painel/&part=espacador&painel=1` | página que o kiosk abre |
| `FONTE_URL` | ambos | vazio | canal legado de atualização por HTTP |

Nenhuma é segredo. O que **não** deve ir para arquivo versionado é endereço da sua máquina — `FONTE_URL` existe para isso e fica vazio por padrão.

## Dados

| caminho no host | montado em | contém |
|---|---|---|
| `/opt/3d-agent-colab/parts` | `/parts` (core) | registro, `_estado/`, `.git` |
| `/opt/3d-agent-colab/session` | `/data` (session) | perfil do Chromium, capturas `.step`, pedidos do kiosk |

O caminho é visível e entra no backup do `/opt`. Um `/parts` sem o marcador `.semeadura` é **semeado** da imagem no primeiro boot — inclusive se tiver conteúdo, e `cp -a` sobrescreve os slugs coincidentes. Com o marcador presente, **nunca** é sobrescrito: é assim que o histórico sobrevive a um redeploy. Para começar limpo, esvazie o diretório antes de subir a stack.

## Operação

```sh
# redeploy: puxa a imagem nova e recria os dois containers
#   Portainer → stack 3d-agent-colab → Update → Repull image and redeploy
# os binds em /opt preservam os dados nos dois caminhos

# conferir o que está rodando (o healthcheck do núcleo consulta a ponte)
curl -s http://SEU-HOST:9001/health           # {"ok":true,"ponte":{"conectada":true,...}}

# trocar de peça no kiosk exige página limpa (não há como fechar documento)
curl -X POST http://SEU-HOST:8080/kiosk/recarregar

# as 13 ferramentas MCP
curl -X POST http://SEU-HOST:9001/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

O console do kiosk **não** está no `docker logs`: o `start.sh` redireciona o Chromium para `/data/chrome.log` e o companheiro CDP para `/data/kiosk-cdp.log`. Logs Docker têm prefixo binário de 8 bytes — filtre `[\x00-\x08\x0e-\x1f]` antes de ler. A tabela completa de sintoma → causa → ação está em [docs/operacao.md](docs/operacao.md).

## Limitações conhecidas

Este repositório é um **protótipo**. As fragilidades são reais, não teóricas, e a lista completa está em [docs/operacao.md](docs/operacao.md#limitações-conhecidas). As três que mais importam:

- **Sem autenticação em lugar nenhum.** `REST`, `MCP` e o relay da ponte são abertos; 8080 e 9001 são públicos. Quem alcança o host publica versões, escreve na fila de conversa e dirige o kiosk.
- **O estado do documento vive na RAM do kiosk.** Reiniciar a sessão perde a geometria não publicada — o registro é a única memória durável.
- **A validação FDM é métrica, não veredicto de manufaturabilidade.** O portal mede envelope, volume, topologia e massa. Parede mínima, furo, overhang e ponte estão **declarados** no `PROCESSO` do código, mas **não** são medidos na geometria — o `validacao.json` carrega um campo `limitacoes` dizendo isso.

## Licenças

O app servido pela imagem `core` é o **Chili3D**, **AGPL-3.0** (`xiangechen/chili3d`, commit fixado em [`chili3d.ref`](chili3d.ref)); ele é compilado do fonte a cada build.

O código **deste** repositório (`core/`, `session/`, `painel/`) não tem licença declarada — escolha em aberto, não esquecimento: sem `LICENSE`, o padrão legal é "todos os direitos reservados".

## Contribuindo

Commits no formato `<emoji> <tipo>: <descrição>` (`✨ feat` · `🐛 fix` · `♻️ refactor` · `📝 docs` · `🔧 chore`). O caminho oficial de mudança é **commit + CI**: o Portainer só faz pull. Para iterar sem CI, existe o ciclo curto em [`deploy/`](deploy/) (build local com os mesmos Dockerfiles).

Se você vai pedir trabalho a um agente de IA neste repositório, comece por [AGENTS.md](AGENTS.md): ele descreve o protocolo de colaboração, as regras que não se quebram e o que conferir antes de publicar.
