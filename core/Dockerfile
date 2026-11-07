# Núcleo do fluxo: API + MCP + registro de peças + validação FDM.
#
# A imagem carrega tudo que o container precisa: /app (código), /venv
# (dependências) e /seed/partes (cópia inicial do registro). O entrypoint só
# semeia /parts na primeira subida e executa o uvicorn; nada é buscado na rede.
#
# git entra na imagem porque o núcleo versiona o registro /parts em runtime
# (`git_commit`), e não há como instalá-lo depois sem a rede.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# As dependências vêm ANTES do código: a camada do venv só é refeita quando
# requirements.txt muda de verdade, não a cada edição do main.py.
COPY core/requirements.txt /app/requirements.txt
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --upgrade pip \
 && /venv/bin/pip install --no-cache-dir -r /app/requirements.txt \
 && md5sum /app/requirements.txt | cut -d' ' -f1 > /venv/.req-hash \
 && /venv/bin/python -c "import build123d, fastapi, uvicorn; print('BUILD_CORE_OK')"

COPY core/ /app/
COPY partes/ /seed/partes/

WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]
