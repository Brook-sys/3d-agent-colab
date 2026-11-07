# Fluxo de Peças 3D

Um fluxo autônomo de criação de peças 3D paramétricas: uma instrução digitada
(no terminal do agente **ou** no navegador) se transforma numa peça modelada,
publicada, medida e validada para impressão — tudo dentro de containers
gerenciados por um Portainer.

O pipeline inteiro é verificável: a geometria que o agente mandou construir é a
geometria que foi arquivada (STEP real, exportado pelo kernel OCCT do
Chili3D), e as medições vêm de um portal independente em Python.

```
instrução ──▶ agente ──▶ ponte ──▶ página Chili3D (kiosk headless)
                │                        │  modela, paramétrico
                │                        ▼
                │                 export_nodes (.step)
                │                        │  download do navegador
                │                        ▼
                └──▶ núcleo (FastAPI) ◀─ captura /data/capturas
                        │  arquiva v000N + git
                        ▼
                validação FDM (build123d/OCP, processo isolado)
                        │  envelope, volume, topologia, massa
                        ▼
                registro /parts/<slug>/vN/  ──▶ painel web + fila de conversa
```

## O que está no repositório

| caminho | o que é |
|---|---|
| `core/` | Núcleo FastAPI: REST + MCP + arquivo de registro + validação FDM |
| `session/` | Ponte WebSocket/HTTP + kiosk Chromium + companheiro CDP |
| `web/` | nginx: serve o Chili3D buildado e o painel em `/flow/` |
| `plugin-flow/` | Painel colaborativo (plugin Chili3D puro, sem build) |
| `partes/` | Semente do registro: as peças de teste do conjunto mínimo |
| `deploy/` | Empacotamento, build das imagens e servidor de arquivos |
| `docker-compose.yml` | A stack (documentação; o deploy real é pelo Portainer) |

`chili3d-upstream/` **não** faz parte deste versionamento: é um clone do fork
do Chili3D, com o git dele. Compilar `dist/` lá dentro é o que alimenta
`deploy/pacotes/dist.tar.gz`.

## Pré-requisitos

- Um Portainer com um ambiente Docker local (id 3) e uma stack (id 65) já
  criada — o deploy é feito pelo MCP do Portainer, não pelo `docker` CLI.
- Uma máquina de desenvolvimento que sirva `http://SEU-IP:8099` com o conteúdo
  do projeto (`deploy/servidor-arquivos.mjs`). O host Docker **não** enxerga o
  diretório do projeto: o código entra nas imagens por HTTP, no build.
- Impressora de referência: **Elegoo Neptune 4**, bico 0,4 mm, volume
  220 × 220 × 250 mm, filamentos PLA/PETG.

## Subindo

```sh
# 1. servir o projeto para os containers (na máquina de desenvolvimento)
node deploy/servidor-arquivos.mjs "$PWD" 8099 &

# 2. empacotar
FONTE_URL=http://SEU-IP:8099 sh deploy/empacotar.sh

# 3. construir as imagens (pelo MCP do Portainer — ver a seção abaixo)
FONTE_URL=http://SEU-IP:8099 ./deploy/build-imagens.sh   # documenta o procedimento

# 4. subir a stack (ou StackUpdate com PullImage:false se as imagens já existem)
docker compose up -d
```

Imagem nova só entra em vigor **removendo o container** e refazendo o
`StackUpdate` — `restart` sozinho não troca a imagem.

### Portas

| porta | o que | exposição |
|---|---|---|
| 8080 | Chili3D + painel no navegador | host |
| 9001 | REST + MCP do núcleo | host |
| 17373 | ponte WebSocket | **só 127.0.0.1** |
| 17400 | relay HTTP da ponte | **só 127.0.0.1** |

O par 17373/17400 é controle remoto sem autenticação sobre a sessão do
navegador. Fica preso ao loopback por isso.

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

Abra `http://SEU-HOST:8080/?bridge=&plugin=http://web/flow/&part=suporte-l&painel=1&api=http://core:9001`.
O painel mostra as variáveis paramétricas com controles deslizantes, os
comentários ancorados na seleção atual, a fila de conversa e o botão de
publicar.

`?plugin=` **precisa** ser URL absoluta e do mesmo host da página: o
`PluginManager` faz `new URL(valor)` e compara o host — com caminho relativo
ele lança, e o `catch` do build chama `alert()`, que congela o renderer
headless (o kiosk não tem ninguém para clicar "OK").

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

## Notas de operação (o que quebra)

- **Trocar de peça exige recarregar a página** — não existe ferramenta de
  fechar documento, e `new_document` recusa se houver uma aberta. Use
  `POST /kiosk/recarregar` (o companheiro CDP executa `Page.reload`).
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
- **`docker commit` exige `body.Cmd`** — sem ele a imagem não sobe.
- **Stale `SingletonLock`**: um Chromium morto a golpe deixa o lock do perfil e
  o próximo morre sem abrir janela. O loop do kiosk limpa antes de cada launch.
- **`export_nodes` devolve só metadados** — os bytes do STEP são um download do
  navegador. O companheiro CDP os grava em `/data/capturas`, a ponte publica em
  `GET /capturas/<nome>` e o núcleo busca por nome único (com *nonce*) e apaga.
- **`HOME` do núcleo** aponta para um diretório gravável (`/tmp/fluxo-home`):
  o ezdxf, puxado pelo build123d, precisa escrever `~/.config`.
- **Logs Docker têm prefixo binário de 8 bytes** — filtre
  `[\x00-\x08\x0e-\x1f]` antes de ler.

### Conferindo o que está rodando

`/app/main.py` é atualizado no boot pelo `entrypoint.sh`. Um probe com
`NetworkMode: container:<id>` **compartilha apenas a rede**: o `/app` que ele
vê é o dele, não o do container alvo. Para conferir o arquivo real do
contêiner, use `POST /containers/<id>/exec` (foi assim que se descobriu que o
refresh estava funcionando e o defeito era do probe).

## Limitações conhecidas

Este repositório é um **protótipo**. Fragilidades reais, não teóricas:

- **Sem autenticação em lugar nenhum.** O REST, o MCP e o relay da ponte são
  abertos. As portas 17373/17400 ficam no loopback do host Docker, mas o 8080 e
  o 9001 são públicos: qualquer um que alcance o host pode publicar versões,
  escrever na fila de conversa e dirigir o navegador do kiosk.
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
  corrigido, mas a lição de fundo persiste: o fluxo confia no estado da RAM do
  kiosk, e a única defesa é conferir antes de escrever.
