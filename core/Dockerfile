# Núcleo do 3D Agent Colab — servidor do app: API + MCP + registro de peças +
# validação FDM + estático (Chili3D).
#
# ANTES disto eram duas imagens: esta e uma de nginx que servia os arquivos.
# O nginx saiu porque o app passou a ser servido por este mesmo processo
# (ver o bloco "estático" no fim de core/main.py) — o que também resolve de
# graça a regra do PluginManager, que exige que `?plugin=` tenha o mesmo host
# da página.
#
# Duas coisas entram por apt e não podem faltar:
#
#   git          o núcleo versiona o registro /parts em runtime (`git_commit`);
#                sem ele a publicação perde o histórico.
#   libgl1 + X11 o wheel do OCP linka libGL/libGLX/libGLdispatch, libX11/libxcb,
#                libXext, libSM e libICE. Sem elas `import build123d` morre com
#                "libGL.so.1: cannot open shared object file" e a validação
#                geométrica fica muda. Os drivers mesa NÃO são necessários:
#                medição de BREP não abre contexto GL.
ARG CHILI3D_REPO=xiangechen/chili3d
ARG CHILI3D_REF=4600206f9b354421f4de288e853efcde926da080

# ------------------------------------------------------------ app compilado
#
# O Chili3D é software de terceiros (AGPL-3.0): baixado do repositório oficial
# no commit fixado e compilado aqui dentro. Nenhum binário entra no repositório
# e o fonte correspondente continua público no oficial — que é a obrigação da
# licença. Atualizar o app é trocar o SHA em chili3d.ref.
#
# Esta camada não tem COPY antes dela, então o cache a acerta enquanto o SHA
# não mudar — nem um push no core/ a invalida. É o que mantém o build curto.
FROM node:20-bookworm AS builder

ARG CHILI3D_REPO
ARG CHILI3D_REF

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl -fsSL "https://codeload.github.com/${CHILI3D_REPO}/tar.gz/${CHILI3D_REF}" \
        -o /tmp/chili3d.tar.gz \
 && mkdir -p /src \
 && tar xzf /tmp/chili3d.tar.gz -C /src --strip-components=1 \
 && rm -f /tmp/chili3d.tar.gz \
 && npm install --no-audit --no-fund \
 && npm run build \
 && test -f /src/dist/index.html \
 && echo "BUILD_CHILI3D_OK"

# ------------------------------------------------------------------- núcleo
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
#
# O `chown` no fim NÃO é enfeite. O entrypoint precisa reexecutar como uid 1000
# (serviço de rede não deve rodar como root) e, se /venv nascer com dono root,
# ele precisa de um `chown -R /venv` em CADA boot. No overlayfs um chown
# recursivo copia cada arquivo para a camada superior antes de trocar o dono —
# medição real neste host: mais de 10 minutos e a stack ficou sem API nesse
# tempo todo (healthcheck vermelho, porta 9000 recusando). Feito no build, é
# cache e não aparece no boot.
COPY core/requirements.txt /app/requirements.txt
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --upgrade pip \
 && /venv/bin/pip install --no-cache-dir -r /app/requirements.txt \
 && chown -R 1000:1000 /venv \
 && md5sum /app/requirements.txt | cut -d' ' -f1 > /venv/.req-hash

# `--chown` em todos os COPY pela mesma razão: sem ele, /app e /seed nascem
# root-owned e o chown volta a ser problema de boot.
COPY --chown=1000:1000 core/ /app/
COPY --chown=1000:1000 partes/ /seed/partes/
COPY --chown=1000:1000 --from=builder /src/dist /app/static/dist

# 1. sintaxe: `compileall` falha (e o build junto) em erro de sintaxe, o que a
#    máquina de desenvolvimento não pega — ela não tem python. Sem este passo,
#    um erro de digitação no main.py só apareceria como container em restart
#    loop, no meio de uma publicação.
# 2. kernel: exercita export/import de STEP, não só o import. Uma imagem que
#    importa mas não mede passaria por um teste frouxo.
RUN /venv/bin/python -m compileall -q /app \
 && /venv/bin/python /app/probe-build.py \
 && rm -f /app/probe-build.py \
 && rm -rf /app/__pycache__

# Healthcheck em Python puro: a imagem não tem curl e não vou instalá-lo só
# por isso. /health já consulta a ponte, então o check cobre API e ponte — mas
# só a partir do start-period, que precisa cobrir a semeadura de /parts e o
# primeiro contato com a sessão.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD /venv/bin/python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','9001'), timeout=5).status==200 else 1)"

WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]
