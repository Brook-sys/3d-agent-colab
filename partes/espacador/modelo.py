"""Espaçador — peça de teste do 3D Agent Colab (geometria de revolução).

Uso pelo agente:  construir_python(slug="espacador", codigo=<conteúdo deste arquivo>)
"""

from build123d import Cylinder, Pos

# ---------------------------------------------------------------- parâmetros
diametro = 8.0      # diâmetro externo (mm)
comprimento = 10.0  # comprimento axial (mm)
furo = 3.2          # passagem M3 (mm)

# ------------------------------------------------------------------ geometria
# Impresso em pé (eixo Z): sem overhang.
externo = Pos(0, 0, comprimento / 2) * Cylinder(radius=diametro / 2, height=comprimento)
passagem = Cylinder(radius=furo / 2, height=comprimento * 4)

result = externo - passagem
