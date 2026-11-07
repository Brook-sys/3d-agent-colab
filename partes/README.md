# Arquivo de registro das peças

Cada peça é um diretório `<slug>/`. O núcleo (`core/main.py`) é o único que
escreve aqui; o `git` do diretório versiona cada publicação.

```
partes/
├── <slug>/
│   ├── spec.json        intenção, material, parâmetros com procedência
│   ├── spec.md          a mesma especificação em prosa (revisão humana)
│   ├── modelo.py        script build123d de referência (caminho headless)
│   ├── anotacoes.json   comentários ancorados (seleção + variáveis do momento)
│   └── v0001/           uma publicação
│       ├── model.py       script exato que gerou a versão (fonte python)
│       ├── model.step     geometria canônica
│       ├── model.stl      malha para fatiar
│       ├── documento.json estado do documento Chili3D (fonte pagina)
│       ├── params.json    parâmetros + diagnóstico da publicação
│       ├── manifest.json  quando/como foi publicado
│       └── validacao.json envelope, topologia, massa, veredicto
└── _estado/             fila de mensagens, estado do painel, cache da ponte
```

## O que `validacao.json` garante — e o que não garante

Medido no BREP importado: volume, área, caixa envolvente, centro, número de
sólidos/faces/arestas, massa (pela densidade do material) e metragem de
filamento.

**Não** medido: espessura de parede, ângulo de overhang, diâmetro mínimo de
furo, distância entre furos e borda. Esses ficam no `spec.md` como regras
declaradas e são conferidos pelo agente na revisão — o núcleo apenas avisa que
não os verificou. Tratar o `veredicto: ok` como "imprimível" seria erro.
