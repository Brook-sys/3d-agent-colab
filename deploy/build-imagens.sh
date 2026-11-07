#!/bin/sh
# Constrói as três imagens locais usadas pelo docker-compose.yml.
#
# O host Docker não tem acesso ao diretório do projeto, então o conteúdo entra
# nas imagens por HTTP: este script serve os pacotes de deploy/pacotes e cria um
# builder por imagem, espera terminar e faz `docker commit`.
#
# Requisitos: docker CLI acessível (esta máquina de desenvolvimento NÃO tem —
# o deploy real é feito pelo agente pelo MCP do Portainer; este script documenta
# e reproduz o mesmo procedimento à mão).
#
#   FONTE_URL=http://SEU-IP-DE-DESENVOLVIMENTO:8099 ./deploy/build-imagens.sh
set -eu

FONTE_URL="${FONTE_URL:?defina FONTE_URL, ex. http://SEU-IP-DE-DESENVOLVIMENTO:8099}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> empacotando"
sh "$RAIZ/deploy/empacotar.sh"

build () {
    nome="$1"; base="$2"; script="$3"
    echo "==> $nome (base $base)"
    cid="$(docker create -e FONTE_URL="$FONTE_URL" "$base" /bin/sh -c "$script")"
    docker start -a "$cid" || { echo "FALHA em $nome"; docker logs "$cid" | tail -40; exit 1; }
    docker commit -c 'CMD ["/bin/sh","-c","echo imagem-pronta"]' "$cid" "$nome:dev" >/dev/null
    docker rm "$cid" >/dev/null
    echo "    imagem $nome:dev criada"
}

build fluxo-web nginx:alpine '
    set -e
    wget -qO /tmp/web.tar.gz "$FONTE_URL/deploy/pacotes/web.tar.gz"
    rm -rf /tmp/pac && mkdir -p /tmp/pac && tar xzf /tmp/web.tar.gz -C /tmp/pac
    cp /tmp/pac/default.conf /etc/nginx/conf.d/default.conf
    cp /tmp/pac/start.sh /usr/local/bin/web-start.sh && chmod +x /usr/local/bin/web-start.sh
    wget -qO /tmp/dist.tar.gz "$FONTE_URL/deploy/pacotes/dist.tar.gz"
    rm -rf /usr/share/nginx/html/dist /usr/share/nginx/html/flow
    mkdir -p /usr/share/nginx/html
    tar xzf /tmp/dist.tar.gz -C /usr/share/nginx/html
    mkdir -p /usr/share/nginx/html/flow
    wget -qO /tmp/flow.tar.gz "$FONTE_URL/deploy/pacotes/flow.tar.gz"
    tar xzf /tmp/flow.tar.gz -C /usr/share/nginx/html/flow
    test -f /usr/share/nginx/html/dist/index.html
    test -f /usr/share/nginx/html/flow/manifest.json
    echo BUILD_WEB_OK
'

build fluxo-core python:3.12-slim '
    set -e
    apt-get update -qq
    apt-get install -y -qq git ca-certificates >/dev/null 2>&1 || true
    python -c "import urllib.request as u; u.urlretrieve(\"$FONTE_URL/deploy/pacotes/core.tar.gz\", \"/tmp/core.tar.gz\")"
    mkdir -p /app && tar xzf /tmp/core.tar.gz -C /app
    python -c "import urllib.request as u; u.urlretrieve(\"$FONTE_URL/deploy/pacotes/partes.tar.gz\", \"/tmp/partes.tar.gz\")"
    mkdir -p /seed && tar xzf /tmp/partes.tar.gz -C /seed
    python -m venv /venv
    /venv/bin/pip install --quiet --upgrade pip
    /venv/bin/pip install -r /app/requirements.txt
    md5sum /app/requirements.txt | cut -d" " -f1 > /venv/.req-hash
    /venv/bin/python -c "import build123d, fastapi, uvicorn; print(\"BUILD_CORE_OK\")"
'

build fluxo-session mcr.microsoft.com/playwright:v1.49.1-jammy '
    set -e
    mkdir -p /app
    for f in bridge-server.mjs package.json start.sh kiosk-cdp.mjs; do
        curl -fsSL -o "/app/$f" "$FONTE_URL/session/$f"
    done
    cd /app && npm install --omit=dev --no-audit --no-fund
    test -f /app/node_modules/ws/index.js
    chmod +x /app/start.sh
    echo BUILD_SESSION_OK
'

echo "==> imagens prontas:"
docker images | grep fluxo-
