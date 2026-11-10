"""Verificação de build do núcleo: o kernel importa, exporta e mede?

Roda dentro do build da imagem core (`RUN /venv/bin/python /app/probe-build.py`)
e é apagado no mesmo passo — ele não faz parte da imagem final.

Um `import build123d` que passa não garante nada: foi assim que o primeiro
build passou no import e quebrou na operação real, por falta de biblioteca do
OCP. Aqui exporta um STEP e relê, com as mesmas chamadas que `core/main.py`
usa para publicar (`export_step` / `import_step` / `volume` / `solids`), e
confere os números. Se o kernel não medir direito, a imagem não existe.

A segunda metade importa o `main.py` de verdade. Não basta `compileall`:
sintaxe válida não impede erro de import — a rota `POST /kiosk/recarregar`
nasceu com `-> dict | Response` e o FastAPI só reclama quando monta o modelo
de resposta, durante o import. Resultado: build verde, container em restart
loop, healthcheck vermelho, API muda. Importar aqui transforma esse modo de
falha em build quebrado, onde ele é visível.
"""
import os
import sys

sys.path.insert(0, "/app")
# /parts não existe no build; sem isto o import cria o diretório na imagem.
os.environ.setdefault("PARTS_ROOT", "/tmp/probe-parts")

try:
    from build123d import Box, export_step, import_step
except ImportError as err:
    sys.exit(f"build123d nao importa: {err}")

caixa = Box(10, 20, 5)
export_step(caixa, "/tmp/probe.step")
volta = import_step("/tmp/probe.step")

esperado = 10.0 * 20.0 * 5.0
if abs(caixa.volume - esperado) > 1e-6:
    sys.exit(f"volume errado: {caixa.volume} em vez de {esperado}")

solidos = len(volta.solids())
if solidos != 1:
    sys.exit(f"STEP nao voltou como um solido: {solidos}")

try:
    import main  # noqa: F401  (importar já é o teste: monta as rotas)
except Exception as err:
    sys.exit(f"main.py nao importa: {type(err).__name__}: {err}")

print(f"BUILD_CORE_OK volume={caixa.volume} solidos={solidos}")
