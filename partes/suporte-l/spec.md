# Suporte em L — especificação

Peça de teste genérica. Não é um produto: serve para exercitar o fluxo completo
(intenção → parâmetros → construção → validação → publicação).

## Intenção

Cantoneira pequena em L para fixar uma placa a uma parede, com quatro furos de
passagem na base e dois na aba vertical. Conjunto mínimo de duas peças para
testar o pipeline (a outra é o `espacador`).

## Parâmetros

| nome | valor | fonte | nota |
|---|---|---|---|
| largura | 40 | assumido | largura da chapa (mm) |
| profundidade | 35 | assumido | profundidade da base (mm) |
| altura | 35 | assumido | altura da aba vertical (mm) |
| espessura | 3.0 | FDM 0.4 | múltiplo de 0,4 — parede estrutural |
| furo | 3.2 | FDM 0.4 | folga para parafuso M3 |
| margem | 6.0 | assumido | distância do furo à borda (mm) |

## Regras de processo conferidas na revisão

- espessura de chapa 3,0 mm (≥ 1,6 mm) — ok
- furos Ø3,2 mm (≥ 1,6 mm) — ok
- overhang: peça impressa deitada, sem overhang > 45°
- envelope 40 × 35 × 35 mm — folga grande no volume de 220 × 220 × 250 mm

## Material

PLA, 100% infill nas abas (peça estrutural pequena).
