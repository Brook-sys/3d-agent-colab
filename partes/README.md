# Arquivo de registro das peças

Cada peça é um diretório `<slug>/`. O núcleo (`core/main.py`) é o único que
escreve aqui; o `git` do diretório versiona cada publicação.

```
partes/
├── _estado/             fila de mensagens, estado da ponte, cache
├── README.md            este arquivo (é copiado para o volume na semeadura)
└── <slug>/
    ├── spec.json        intenção, material, parâmetros com procedência
    ├── spec.md          a mesma especificação em prosa (revisão humana)
    ├── modelo.py        script build123d de referência (caminho headless)
    ├── anotacoes.json   comentários ancorados (seleção + variáveis do momento)
    └── v0001/           uma publicação
        ├── model.step     geometria canônica exportada pela página
        ├── documento.json estado do documento Chili3D no momento
        ├── params.json    parâmetros + diagnóstico da publicação (e o material usado)
        ├── manifest.json  quando/como foi publicado; `completa`/`sem_step`
        └── validacao.json envelope, topologia, massa, veredicto
```

Cada publicação é um commit que já inclui o `validacao.json` — a medição
entra no histórico junto com a geometria, não como anexo posterior. A massa
é calculada com o material com que a versão foi **publicada**
(`params.json`), não com o do `spec.json`: publicar com PETG e validar
depois tem de dar o mesmo número.

`manifest.json` com `"completa": false` (ou `"sem_step": true`) marca uma
publicação sem geometria — o caminho headless (`construir_python`) grava
`model.py`, o caminho pela página não.

## O que `validacao.json` garante — e o que não garante

Medido no BREP importado: volume, área, caixa envolvente, centro, número de
sólidos/faces/arestas, massa (pela densidade do material) e metragem de
filamento.

**Não** medido: espessura de parede, ângulo de overhang, diâmetro mínimo de
furo, distância entre furos e borda. Esses ficam no `spec.md` como regras
declaradas e são conferidos pelo agente na revisão — o núcleo apenas avisa que
não os verificou. Tratar o `veredicto: ok` como "imprimível" seria erro.
