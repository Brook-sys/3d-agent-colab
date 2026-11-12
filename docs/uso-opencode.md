# Usando pelo OpenCode (MCP)

O caminho "agente externo": o OpenCode (ou qualquer cliente MCP) fala com o núcleo por streamable-http e age **no servidor e na página** — publica versões, valida, registra peças, ajusta variáveis, conversa com você pela mesma fila do painel.

Endpoint: `http://SEU-HOST:9001/mcp` · protocolo **2024-11-05** · stateless.

---

## 1. Configurar

**O `opencode.json` deste projeto é arquivo local e não é versionado.** Ele
carrega o endereço real do host, e endereço real não vai para o repositório. O
que está versionado é o [`opencode.json.exemplo`](../opencode.json.exemplo), com
`SEU-HOST` no lugar do host.

```sh
cp opencode.json.exemplo opencode.json   # ou copie o bloco abaixo
# troque SEU-HOST pelo endereço do host que roda o núcleo
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "3d-agent-colab": {
        "type": "remote",
        "url": "http://SEU-HOST:9001/mcp",
        "oauth": false,
        "protocol": "legacy",
        "timeout": {
          "startup": 60000,
          "catalog": 60000,
          "execution": 600000
        }
      }
    }
  }
}
```

Os timeouts não são decoração: `execution: 600000` (10 min) acomoda uma publicação, que exporta STEP pelo kernel e ainda valida; `startup` cobre o boot do núcleo depois de um deploy.

> **Por que o arquivo é local.** O OpenCode lê o `opencode.json` do projeto como
> configuração **ativa**, não como sugestão. Com `SEU-HOST` dentro dele, o cliente
> MCP tenta resolver aquele nome em DNS e o servidor vive em
> `getaddrinfo ENOTFOUND seu-host` — foi assim que ele passou tempo demais. O
> `.gitignore` do projeto ignora o `opencode.json` justamente por isso.

### Conferir sem cliente nenhum

```sh
# 1. o núcleo está de pé e a ponte está conectada?
curl -s http://SEU-HOST:9001/health

# 2. o MCP responde?
curl -s -X POST http://SEU-HOST:9001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'

# 3. quais ferramentas?
curl -s -X POST http://SEU-HOST:9001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | head -40
```

`GET /mcp` responde de propósito com um erro dizendo para usar POST — o streamable-http é POST-only aqui.

---

## 2. As 13 ferramentas do servidor

| ferramenta | argumentos | o que faz |
|---|---|---|
| `partes` | — | lista as peças do registro com suas versões |
| `parte_criar` | `slug`, `intencao`, `material` (`PLA`/`PETG`/`ABS`/`RESINA`, default `PLA`) | cria peça: `spec.json`, `spec.md`, commit inicial |
| `ponte_estado` | — | a página está conectada? quantas ferramentas ela anuncia? |
| `ponte_ferramentas` | — | lista as ferramentas da página: nome, descrição, schema |
| `pagina_chamar` | `nome`, `args` | chama **qualquer** ferramenta da página pela ponte |
| `variaveis` | `acao` (`list`/`set`/`remove`), `variaveis`, `nomes` | lê/escreve as variáveis do documento (`document_variables`) |
| `publicar` | `slug`, `material` | exporta documento/STEP pela ponte, arquiva em `v000N/` e valida |
| `validar` | `slug`, `versao` (default: última) | roda o portal FDM numa versão |
| `construir_python` | `slug`, `codigo`, `material` | caminho headless: script build123d que define `result`; arquiva com STEP/STL |
| `mensagens` | — | lê a fila compartilhada (web + terminal) |
| `enviar_mensagem` | `texto`, `parte` | escreve na fila (`autor: "agente"`); aparece no chat da IA |
| `anotacoes` | `slug` | lista os comentários ancorados da peça |
| `estado_plugin` | — | último estado reportado por plugin, quando algum estiver carregado (nenhum no deploy atual) |

Regras de comportamento do endpoint, que valem para qualquer cliente:

- Erro de ferramenta **não** derruba o servidor: volta `isError: true` no conteúdo.
- Argumento inválido devolve `-32602` com a mensagem do `TypeError`.
- Método desconhecido devolve `-32601`; `notifications/initialized` devolve `202` sem corpo.

---

## 3. As 30 ferramentas da página (via `pagina_chamar`)

`ponte_ferramentas` é a fonte da verdade — a lista abaixo é o que a página anunciava no último `hello` (protocolo 1). Use-a para descobrir nomes sem adivinhar:

```text
get_document_state        há documento ativo? quais nós?
get_selection             o que está selecionado
get_ribbon                a ribbon inteira: abas, grupos, botões, comandos, atalhos
delete_node               apagar um nó por id
set_node_visible          mostrar/ocultar
transform_node            mover, rotacionar, escalar, espelhar
create_folder             criar pasta e mover nós para dentro
move_nodes                mover entre pastas ou de volta para a raiz
undo / redo               desfazer / refazer
get_node_properties       propriedades editáveis de um nó
set_node_properties       mudar propriedades de um nó
capture_screenshot       foto da viewport (volta como imagem)
set_material              cor e opacidade de um nó
fit_content               enquadrar o conteúdo
isolate_view              mostrar só os nós dados
rotate_view               girar a câmera em torno do alvo
set_camera_type           perspective / orthographic
click_view                clicar num ponto da viewport
select_nodes              selecionar (o usuário vê o destaque)
export_nodes              exportar para CAD (metadados + download no navegador)
run_program               sequência de modelagem/consulta numa chamada
load_skill                carregar um documento de referência
run_parametric           corpo paramétrico: sketch + features
document_variables       ler/escrever variáveis do documento
list_materials           materiais do documento
get_material              propriedades de um material
set_material_properties  mudar propriedades de material
capture_views             várias vistas padrão de uma vez
new_document             criar e ativar documento vazio
```

Descrição e schema de cada uma vêm de `ponte_ferramentas`; a página grava a lista em `/data/page-tools.json` no container da sessão a cada `hello`.

---

## 4. Um turno completo de trabalho

Exemplo: criar uma cantoneira e publicar a primeira versão.

```text
parte_criar(slug="cantoneira-40", intencao="cantoneira 40x35 L=120 com 4 furos", material="PLA")
  → cria /parts/cantoneira-40/{spec.json,spec.md} e o commit inicial

pagina_chamar("run_parametric", {...})        # ou construir_python para o caminho headless
  → geometria no documento do kiosk

variaveis(acao="set", variaveis=[{"name":"largura","value":40}])
  → ajuste paramétrico sem reconstruir

publicar(slug="cantoneira-40")
  → document_variables → export_nodes (STEP pelo kernel) → arquiva v0001 → valida → commit

validar(slug="cantoneira-40")                 # opcional: revalidar depois de um ajuste
enviar_mensagem(texto="v0001 publicada: envelope 120×40×35, 2 furos de 5,5", parte="cantoneira-40")
  → a mensagem aparece no chat da IA do Chili3D
```

A ordem importa: **sem `?bridge=` na página não há ponte, e sem ponte não há STEP**. Se `ponte_estado` disser `conectada: false`, provavelmente o kiosk perdeu a aba (veja [operação](operacao.md)).

### Rotas REST que valem a pena conhecer

| rota | método | para quê |
|---|---|---|
| `/health` | GET | núcleo de pé + estado da ponte |
| `/ponte/estado` | GET | ponte conectada? quantas ferramentas? |
| `/ponte/chamar` | POST | chamar ferramenta da página direto, sem MCP |
| `/kiosk/recarregar` | POST | recarrega a página do kiosk (para trocar de peça) |
| `/parts`, `/parts/{slug}` | GET | registro e detalhe da peça |
| `/parts/{slug}/publicar` | POST | publicar versão |
| `/parts/{slug}/versoes` | GET | versões publicadas |
| `/parts/{slug}/versoes/{n}/validar` | POST | validar uma versão |
| `/parts/{slug}/anotacoes` | GET/POST | comentários ancorados |
| `/mensagens` | GET/POST | fila compartilhada |
| `/estado-plugin` | POST | um plugin publica o estado por aqui (nenhum carregado) |
| `/arquivos/{caminho}` | GET | servir arquivo do registro |

---

## 5. Regras que não se quebram

- **Unidades em milímetros, ângulos em graus.** Nenhuma configuração muda isso.
- **Não existe ferramenta de fechar documento.** `new_document` recusa com documento aberto. Para trocar de peça: mude `?part=` na URL e peça o recarregamento (`POST /kiosk/recarregar`).
- **`export_nodes` não devolve os bytes:** devolve metadados e entrega o STEP como download do navegador. O kiosk permite o download em `$DATA_DIR/capturas`, a ponte publica em `GET /capturas/<nome>` e é assim que o núcleo recebe a geometria. Ignorar esse caminho e tentar ler o STEP do retorno da ferramenta não funciona.
- **`run_program`/`run_parametric` criam formas, não features de corpo paramétrico.**
- **4002 = outra aba assumiu a ponte.** Duas abas com `?bridge=` não dividem a ponte: a nova derruba a anterior.
- **Timeout de chamada da ponte: 240 s.** Chamada mais lenta que isso volta como `tempo esgotado`, e a fila de chamadas pendentes é resolvida com falha.

---

## 6. Limitações

- **Zero autenticação.** REST, MCP e relay da ponte são abertos, com CORS `*`. Quem alcança o host tem controle total: publica, valida, escreve na fila, dirige o kiosk.
- **O estado do documento vive na RAM do kiosk.** Reiniciar a sessão perde geometria não publicada; o registro `/parts` é a única memória durável.
- **MCP stateless.** Cada chamada precisa do `initialize` implícito do cliente; não há sessão de conversa no servidor.
- **A fila de mensagens é um arquivo JSON** (`_estado/mensagens/conversa.json`), com as últimas 500 guardadas. Não é log durável: é quadro de avisos.
- **`validar` mede métrica, não manufaturabilidade** — veja [arquitetura](arquitetura.md#validação-o-que-é-medido-de-fato).

---

## Ver também

- [uso com IA no Chili3D](uso-chili3d-ia.md) — o outro caminho, dentro da interface
- [arquitetura](arquitetura.md) — protocolo da ponte, caminho do STEP, modos de falha
- [operação](operacao.md) — deploy, logs e a tabela de sintoma → causa → ação
