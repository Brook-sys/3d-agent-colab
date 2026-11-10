#!/bin/sh
# Constrói as duas imagens localmente, com os MESMOS Dockerfiles que o workflow
# .github/workflows/imagens.yml usa.
#
# O caminho oficial de publicação é o GitHub Actions (push na main → GHCR); este
# script serve ao ciclo curto: buildar e subir a stack na mesma máquina, sem
# esperar o CI. Ele também é a forma de conferir que um Dockerfile quebrou
# antes de dar push — a falha aparece aqui em minutos, não só no Actions.
#
# Uso:
#   ./deploy/build-local.sh                    # 3d-agent-colab-<nome>:dev
#   TAG=sha-1a2b3c4 ./deploy/build-local.sh    # mesma tag que o GHCR publica
#
# Depois: docker compose -f docker-compose.yml -f deploy/compose.local.yml up -d
set -eu

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${TAG:-dev}"

for nome in core session; do
    echo "==> $nome (tag $TAG)"
    docker build \
        -t "3d-agent-colab-$nome:$TAG" \
        -f "$RAIZ/$nome/Dockerfile" \
        "$RAIZ"
done

echo "prontas:"
docker images | grep "^3d-agent-colab-" || true
