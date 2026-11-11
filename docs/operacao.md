# Operação

Deploy, verificação, backup e a tabela de sintoma → causa → ação. O caminho oficial de mudança é **commit + CI + pull**: nada é compilado no host.

---

## Deploy

Pré-requisitos no host Docker:

```sh
mkdir -p /opt/3d-agent-colab/parts /opt/3d-agent-colab/session
chown 1000:1000 /opt/3d-agent-colab/parts      # o núcleo roda como uid 1000
```

Pelo Portainer (Stacks → Add stack) cole o [`docker-compose.yml`](../docker-compose.yml), ou por CLI:

```sh
docker compose up -d
```

O que acontece no primeiro boot:

1. o núcleo semeia `/parts` com as peças de exemplo — mas **só se o marcador `/parts/.semeadura` não existir**, e não "se o diretório estiver vazio". Um `/parts` restaurado de backup antigo, sem o marcador, recebe a semente por cima (`cp -a` sobrescreve os `spec.json` dos slugs coincidentes). Depois de um restore, confira o marcador;
2. a sessão sobe o Chromium em kiosk e o companheiro CDP;
3. o kiosk abre `KIOSK_URL` (`http://core:9001/?bridge=&plugin=…&part=espacador&painel=1`);
4. a página importa a IA (porque a URL tem `?bridge=`) e o companheiro a abre sozinha;
5. a ponte recebe o `hello` com as 30 ferramentas e grava `page-tools.json`.

O `pull_policy: always` garante que um `up -d` puxe a imagem nova; no Portainer use **Update the stack → Repull image and redeploy**, que é o equivalente.

### Variáveis que valem revisão antes do primeiro deploy

| variável | default | quando mexer |
|---|---|---|
| `KIOSK_URL` | `…&part=espacador&painel=1` | para abrir outra peça no kiosk |
| `PARTS_ROOT` | `/parts` | quase nunca; se mexer, mexa o bind junto |
| `PRINTER_MODEL` | `Elegoo Neptune 4` | muda `IMPRESSORA.modelo` e o volume **não** — o envelope segue 220×220×250 até você editar o código |
| `PUID`/`PGID` | `1000` | se o uid 1000 já existir no host com outro significado |

---

## Verificação pós-deploy

Cinco checagens, na ordem, cada uma pegando uma classe de falha diferente:

```sh
# 1. o núcleo está de pé e a ponte conectada?
curl -s http://SEU-HOST:9001/health
#    {"ok":true,"ponte":{"conectada":true,"ferramentas":30}}

# 2. o app serve?
curl -s -o /dev/null -w '%{http_code}\n' http://SEU-HOST:8080/
curl -s -o /dev/null -w '%{http_code}\n' http://SEU-HOST:8080/painel/manifest.json

# 3. o MCP responde com as 13 ferramentas?
curl -s -X POST http://SEU-HOST:9001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | wc -l

# 4. o painel carregou de fato? (a checagem que o CI NÃO faz)
#    NÃO está no docker logs: o start.sh redireciona o Chromium para chrome.log
grep -a "painel ativo" /opt/3d-agent-colab/session/chrome.log | tail -3

# 5. a IA embutida está na tela?
tail -20 /opt/3d-agent-colab/session/kiosk-cdp.log | grep -i "assistente"
```

A checagem 4 é a que importa: para o plugin, build verde **não** significa painel funcionando. Um erro de referência dentro do `buildPanel()` não derruba a página — só o console.

Para trocar de peça no kiosk (não existe ferramenta de fechar documento):

```sh
curl -s -X POST http://SEU-HOST:8080/kiosk/recarregar
```

---

## Backup

O que é durável está em dois diretórios do host — e em mais nada:

| caminho | contém | criticidade |
|---|---|---|
| `/opt/3d-agent-colab/parts` | registro, `_estado/`, `.git` **com as validações** | tudo que importa |
| `/opt/3d-agent-colab/session` | perfil do Chromium, capturas `.step`, pedidos do kiosk | cache; perdê-lo custa um recarregamento |

Backup do primeiro já protege o projeto:

```sh
tar czf partes-$(date +%F).tar.gz -C /opt/3d-agent-colab parts
```

O do segundo só vale se você quiser preservar o perfil do navegador (idioma, tema, config da IA **sem** a chave — a chave nunca é guardada).

### Começar limpo

```sh
docker compose down
rm -rf /opt/3d-agent-colab/parts/*          # apaga o histórico: é irreversível
docker compose up -d                        # /parts vazio → semeado de novo
```

---

## Logs

**O log do kiosk não está no `docker logs`.** O `start.sh` redireciona o Chromium e o companheiro CDP para arquivos dentro do bind de dados:

| o que | arquivo (no container) | no host |
|---|---|---|
| console da página, plugin, renderer | `/data/chrome.log` | `/opt/3d-agent-colab/session/chrome.log` |
| companheiro CDP (diálogos, download, recarga, IA) | `/data/kiosk-cdp.log` | `/opt/3d-agent-colab/session/kiosk-cdp.log` |
| núcleo (REST, MCP, publicação) | stdout do container | `docker logs 3d-agent-colab-core` |
| ponte WebSocket | stdout do container | `docker logs 3d-agent-colab-session` |

```sh
# o console da página: onde o `[painel] painel ativo` realmente mora
grep -a "painel ativo" /opt/3d-agent-colab/session/chrome.log | tail -5

# diálogos fechados, downloads, recargas e o assistente de IA
tail -30 /opt/3d-agent-colab/session/kiosk-cdp.log

# núcleo e ponte (prefixo binário de 8 bytes: filtre antes de ler)
docker logs 3d-agent-colab-core 2>&1 | tr -d '\000-\010\016-\037' | tail -50
docker logs 3d-agent-colab-session 2>&1 | tr -d '\000-\010\016-\037' | tail -50
```

O `chrome.log` **cresce sem limite** — eram 18 MB e ~108 mil linhas num kiosk de algumas semanas de vida, porque cada recarga reimprime o console inteiro. Para uso corriqueiro, corte com `tail`; se for acompanhar de perto, truncar o arquivo com o Chromium rodando é seguro (ele reabre no próximo `>>`).

Onde procurar o quê:

| sintoma | onde | o que grep |
|---|---|---|
| painel não aparece | `chrome.log` | `painel ativo`, `Plugin 3D Agent` |
| ponte não conecta | logs da sessão (stdout) | `bridge` |
| IA não abre no kiosk | `kiosk-cdp.log` | `assistente de IA` |
| `alert()` congelando | `kiosk-cdp.log` | `diálogo fechado` |
| download do STEP | `kiosk-cdp.log` | `download concluído` |
| publicação sem STEP | `v000N/params.json` → `diagnostico.step` | — |
| REST/MCP | logs do core | `POST /mcp`, `publicar` |

> `/proc/1/fd/1` dentro de um `docker exec` **trava** — use a API de logs.

---

## Sintoma → causa → ação

| sintoma | causa provável | ação |
|---|---|---|
| `/health` não responde | core caindo na subida | `docker logs 3d-agent-colab-core`; a causa clássica é rota com `dict \| Response` sem `response_model=None` (o import morre) |
| `ponte.conectada: false` | kiosk perdeu a aba, ou a URL não tem `?bridge=` | conferir `KIOSK_URL`; `POST /kiosk/recarregar`; logs da sessão |
| painel não aparece | erro de referência no `extension.js`, ou `?painel=0` | remover `painel=0` da URL; `grep -a "painel ativo" chrome.log` — **sem a linha, o plugin não rodou** |
| ribbon sem "AI Assistant" | URL sem `?bridge=` (o módulo de IA não é importado) | adicionar `&bridge=`; ou o botão do painel faz isso |
| chave da IA não cola / some | é o comportamento previsto: só memória da aba | colar de novo após F5; ver [uso com IA](uso-chili3d-ia.md) |
| IA não abre no kiosk | companheiro CDP não achou o botão nem o PubSub | `tail kiosk-cdp.log` → `assistente de IA:` diz qual caminho tentou |
| publicação sem STEP | kiosk recarregado (documento na RAM) ou download bloqueado | reconstruir o documento (`run_parametric`) e publicar de novo; `kiosk-cdp.log` → `download concluído` |
| `validar` dá "bloqueado" sempre | versão sem `model.step` | olhar `v000N/manifest.json` → `sem_step: true` |
| "outra aba assumiu a ponte" | duas abas com `?bridge=` | recarregar a aba que perdeu |
| diferença de massa entre caminhos | material resolvido de lugar diferente | conferir `params.json` da versão; a ordem é argumento → versão → spec → PLA |
| stack não atualiza | Portainer sem *Repull image and redeploy* | marcar a opção no Update |
| `/parts` sobrescrito após redeploy | não sobrescreve: a semente só entra quando falta o marcador `.semeadura` | conferir o marcador e o bind; se havia dados, eles estão lá |

---

## Limitações conhecidas

Este repositório é um **protótipo**. A lista abaixo é de fragilidades medidas, não teóricas.

### Segurança

- **Sem autenticação em lugar nenhum.** REST, MCP e relay da ponte são abertos, com CORS `*`. Quem alcança `SEU-HOST:8080`/`:9001` publica versões, escreve na fila de conversa, dirige o kiosk e conversa com a IA usando a chave que estiver na sessão.
- **A ponte é controle remoto sem autenticação sobre o navegador do kiosk.** Ela não é publicada no host — é a única contenção real que existe, e é por configuração, não por projeto.
- **A chave da API de IA não persiste**, o que é virtude de segurança e incômodo de uso.

### Durabilidade

- **O estado do documento vive na RAM do kiosk.** Reiniciar a sessão perde a geometria não publicada; o registro `/parts` é a única memória durável.
- **A fila de mensagens é um arquivo JSON** com as últimas 500 entradas (`_estado/mensagens/conversa.json`). Não é log: é quadro de avisos.
- **`run_program`/`run_parametric` criam formas, não features de corpo paramétrico.** O resultado é um nó de forma na árvore; a reavaliação paramétrica depois de um rebuild vem do `document_variables`, não de uma feature.

### Corretude

- **A validação FDM é métrica, não veredicto de manufaturabilidade.** Parede mínima, furo, overhang e ponte estão declarados no `PROCESSO` e **não** são medidos na geometria.
- **`PRINTER_MODEL` não muda o envelope.** O volume da impressora está fixo no código (220×220×250).
- **`pick_page_tool` descobre nomes por padrão.** Se duas ferramentas casarem com o padrão, a escolha pode não ser a que você quer.

### Operação

- **Build verde ≠ deploy funcionando.** O plugin entra por `COPY` e roda no navegador; só o console do kiosk testemunha um erro de referência.
- **Nada de orquestração.** Um `docker compose down` bem-sucedido é só isso: não há hook de drenagem, e o kiosk perde o que não foi publicado.
- **`exec` e logs têm arestas:** prefixo binário de 8 bytes, `/proc/1/fd/1` trava, endpoint `/containers/<id>/wait` estoura em *read timeout* de 120 s.

### O que não está feito

Autenticação, TLS, multi-usuário, controle de acesso por peça, medição de parede/overhang/furo na geometria, histórico de conversa durável, healthcheck real do kiosk (o do núcleo consulta a ponte, não o navegador), testes automatizados ponta a ponta no CI (hoje há `node --check`, import do `main.py` e um probe de build).

---

## Ver também

- [arquitetura](arquitetura.md) · [uso com IA no Chili3D](uso-chili3d-ia.md) · [uso pelo OpenCode](uso-opencode.md) · [painel](painel.md) · [AGENTS.md](../AGENTS.md)
