# Espaçador — especificação

Peça de teste genérica, segunda do conjunto mínimo.

## Intenção

Bucha cilíndrica Ø8 × 10 mm com furo de passagem Ø3,2 mm, para separar duas
chapas aparafusadas. Serve para exercitar o fluxo numa geometria de revolução.

## Parâmetros

| nome | valor | fonte | nota |
|---|---|---|---|
| diametro | 8.0 | assumido | diâmetro externo (mm) |
| comprimento | 10.0 | assumido | comprimento axial (mm) |
| furo | 3.2 | FDM 0.4 | passagem M3 (mm) |

## Regras de processo conferidas na revisão

- parede: (8 − 3,2) / 2 = 2,4 mm (≥ 1,6 mm) — ok
- furo Ø3,2 mm (≥ 1,6 mm) — ok
- comprimento axial 10 mm: impresso em pé, overhang nulo
- envelope 8 × 8 × 10 mm — folga grande

## Material

PLA.
