# teste — suíte do companheiro CDP

Testa `session/kiosk-cdp.mjs` **sem Chromium, sem Docker e sem rede**. O que ele
prova é exatamente o que o build do Docker não prova: o comportamento do laço de
vigilância e da preparação do kiosk.

```
node teste/rodar.mjs        # entrada única; saída não-zero em qualquer falha
```

Leva ~30 s. Depende só de Node 18+ e do próprio repositório.

## Por que o código testado é extraído, e não copiado

Os dois geradores (`gerar-vigiar.mjs`, `gerar-preparar.mjs`) leem
`session/kiosk-cdp.mjs` e recortam a seção que vai ser testada. Um teste com o
código copiado à mão passaria verde muito tempo depois de o código mudar — o
pior tipo de teste, porque ele não falha: ele mente. Se a seção mudar de forma,
o gerador **falha de propósito** ("não achei `function vigiar(`") em vez de gerar
um cenário que não exercita nada.

O que é mockado é o mundo do outro lado — WebSocket, ponte HTTP, `avaliar` do
CDP e o relógio. O relógio é encolhido por 100 (a rede de segurança de 12 s vira
120 ms), senão a suíte levaria minutos.

## O que está coberto

`gerar-vigiar.mjs` — `vigiar` + laço externo:

| cenário | o que segura |
|---|---|
| 1 boot quieto | uma sessão, uma preparação, `setDownloadBehavior` aplicado |
| 2 navegação reconfigura | **o defeito corrigido**: navegação no mesmo alvo fecha a sessão, reconfigura e reaplica o download |
| 3 iframe não reconfigura | iframe navegando não troca a página |
| 4 diálogo e fechado + download avisado | `alert()` não congela o renderer |
| 5 pedido de recarga | atende o pedido e devolve o laço, sem preparação interrompida |
| 6 socket fechado | o caminho que já funcionava (Chromium reiniciou) |
| 7 segurança sem load | sem `loadEventFired`, a rede de 12 s reconfigura mesmo assim |
| 8 evento malformado | JSON quebrado não derruba o handler |

`gerar-preparar.mjs` — a seção "preparar o kiosk":

| cenário | o que segura |
|---|---|
| 1 caminho feliz | cria documento, abre IA, publica uma vez só |
| 2 documento já existia | `new_document` recusa sem quebrar (idempotente) |
| 3 ponte não reconecta | sem ponte não há documento, mas a IA segue |
| 4 app não fica pronto | desiste com o motivo, e não tenta a IA |
| 5 IA já aberta | não publica de novo (fecharia o painel) |
| 6 PubSub quebrado | diagnostica, e o documento fica de pé |
| 7 sem `?part=` | chama a ferramenta sem argumentos |
| 8 envelope aguenta exceção | exceção no meio não derruba o processo |

## O teste de mutação, que é o que dá valor ao resto

Um verde sozinho não significa nada: uma suíte que passa no código certo **e** no
código quebrado não testa nada. Por isso a terceira etapa quebra de propósito o
fonte real e exige que a suíte acuse:

| mutação | espera que quebre |
|---|---|
| detectores de navegação mortos | cenários 2 e 7 |
| conexão nunca marcada como configurada | cenários 2 e 7 |
| sem a rede de segurança de 12 s | cenário 7 |
| `reconfigurar` travado em `fechando` | cenários 2 e 7 |
| diálogo sem tratamento | cenário 4 |
| download sem aviso | cenário 4 |

Uma mutação que não se aplica ao fonte ("não pegou") é falha, não silêncio.

## Para rodar contra outra revisão

```
TESTE_FONTE=/caminho/para/kiosk-cdp.mjs node teste/rodar.mjs
```

Foi assim que a suíte foi validada: contra o código commitado antes da correção
ela falha nos cenários 2 e 7 e **o processo morre** no 8 (evento malformado sem
tratamento). Nenhum desses três sintomas quebraria o build do Docker.

## O que esta suíte NÃO cobre

- o comportamento real do Chromium (a semântica do CDP foi medida à parte, no
  deployment: `Page.enable` novo em página carregada não reemite
  `loadEventFired`, e `Page.navigate` no mesmo alvo emite `frameNavigated` +
  `loadEventFired`);
- o kiosk de fato — painel no navegador, ribbon, documento visível. Isso é a
  verificação pós-deploy, no log do container (ver `AGENTS.md`);
- a ponte WebSocket (`bridge-server.mjs`), que segue sem teste automatizado.

`TESTE_MANTER=1` conserva os cenários gerados em vez de apagar o diretório
temporário — útil para depurar um cenário que quebrou.
