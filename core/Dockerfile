# Núcleo do fluxo: API + MCP + registro de peças + validação FDM.
#
# A imagem carrega tudo que o container precisa: /app (código), /venv
# (dependências) e /seed/partes (cópia inicial do registro). O entrypoint só
# semeia /parts na primeira subida e executa o uvicorn; nada é buscado na rede.
#
# Duas coisas entram por apt e não podem faltar:
#
#   git          o núcleo versiona o registro /parts em runtime (`git_commit`);
#                sem ele a publicação perde o histórico.
#   libgl1 + X11 o wheel do OCP (cad-query) linka libGL/libGLX/libGLdispatch,
#                libX11/libxcb e libXext/libSM/libICE. Sem essas, `import
#                build123d` morre com "libGL.so.1: cannot open shared object
#                file" e a validação geométrica fica muda — foi assim que o
#                primeiro build deste Dockerfile falhou. Os drivers mesa
#                (libgl1-mesa-dri, mesa-libgallium, mesa-vulkan-drivers) NÃO
#                são necessários: medição de BREP não abre contexto GL.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        libgl1 \
        libx11-6 \
        libxext6 \
        libsm6 \
        libice6 \
 && rm -rf /var/lib/apt/lists/*

# As dependências vêm ANTES do código: a camada do venv só é refeita quando
# requirements.txt muda de verdade, não a cada edição do main.py.
COPY core/requirements.txt /app/requirements.txt
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --upgrade pip \
 && /venv/bin/pip install --no-cache-dir -r /app/requirements.txt \
 && md5sum /app/requirements.txt | cut -d' ' -f1 > /venv/.req-hash

# A verificação exercita o kernel, não só o import: exporta um STEP e relê.
# Uma imagem que importa mas não mede passaria por um teste frouxo e quebraria
# na primeira publicação. O probe é apagado no mesmo passo — não fica na imagem.
COPY core/ /app/
COPY partes/ /seed/partes/
RUN /venv/bin/python /app/probe-build.py && rm -f /app/probe-build.py

WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]
