"""Suporte em L — peça de teste do 3D Agent Colab.

Caminho headless (Opção A): o núcleo executa este arquivo com build123d dentro do
container `core` e arquiva a versão com STEP + STL. `result` é o contrato: sem ele
o script falha com mensagem explícita.

Uso pelo agente:  construir_python(slug="suporte-l", codigo=<conteúdo deste arquivo>)
Uso manual:      /venv/bin/python modelo.py
"""

from build123d import Align, Box, Cylinder, Pos

# ---------------------------------------------------------------- parâmetros
largura = 40.0       # largura da chapa (mm)
profundidade = 35.0  # profundidade da base (mm)
altura = 35.0        # altura da aba vertical (mm)
espessura = 3.0      # espessura da chapa (mm) — 7,5 camadas de 0,4
furo = 3.2           # diâmetro dos furos de passagem (mm)
margem = 6.0         # distância do centro do furo à borda (mm)
furos_aba = 2        # quantidade de furos na aba vertical

# ------------------------------------------------------------------ geometria
# Canto da chapa na origem: `align=MIN` faz a caixa crescer para +X/+Y/+Z.
chapa_base = Box(largura, profundidade, espessura, align=(Align.MIN, Align.MIN, Align.MIN))
aba = Box(largura, espessura, altura, align=(Align.MIN, Align.MIN, Align.MIN))

result = chapa_base + Pos(0, 0, espessura) * aba

# Furos da base, eixo Z: cilindros centrados no meio da espessura e bem mais
# altos, para o corte atravessar em vez de tangenciar.
for centro_x in (margem, largura - margem):
    for centro_y in (margem, profundidade - margem):
        result -= Pos(centro_x, centro_y, espessura / 2) * Cylinder(
            radius=furo / 2, height=espessura * 3
        )

# Furos da aba vertical, eixo Y (a chapa fina corre no sentido Y): rotation=(90,0,0)
# deita o cilindro. Ficam na metade traseira da peça, onde a aba está.
recuo_aba = espessura / 2
passo = (largura - 2 * margem) / max(furos_aba - 1, 1)
for indice in range(furos_aba):
    centro_x = margem + passo * indice
    centro_z = espessura + altura / 2
    result -= Pos(centro_x, recuo_aba, centro_z) * Cylinder(
        radius=furo / 2, height=espessura * 3, rotation=(90, 0, 0)
    )
