#!/bin/sh
# Constrói a imagem localmente, com o MESMO Dockerfile que o workflow
# .github/workflows/imagens.yml usa.
#
# O caminho oficial de publicação é o GitHub Actions (push na main → GHCR); este
# script serve ao ciclo curto: buildar e subir a stack na mesma máquina, sem
# esperar o CI. Ele também é a forma de conferir que um Dockerfile quebrou antes
# de dar push — a falha aparece aqui em minutos, não só no Actions.
#
# Uso:
#   ./deploy/build-local.sh                    # chili3d-dev:dev
#   TAG=sha-1a2b3c4 ./deploy/build-local.sh    # mesma tag que o GHCR publica
#
# Depois: docker compose -f docker-compose.yml -f deploy/compose.local.yml up -d
set -eu

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${TAG:-dev}"

echo "==> chili3d (tag $TAG)"
docker build -t "chili3d-dev:$TAG" -f "$RAIZ/chili3d/Dockerfile" "$RAIZ"

echo "pronta:"
docker images | grep "^chili3d-dev" || true
