#!/bin/sh
# Empacota o que o canal FONTE_URL baixa nos containers. Rode antes de cada deploy.
#
# O host Docker NÃO tem acesso ao diretório deste projeto (é outra máquina), então
# o caminho é: empacotar aqui → servir por HTTP → os containers baixam no build.
# Nada de caminho absoluto do host entra no Compose.
#
# O que ENTRA aqui é só o que algum entrypoint realmente busca:
#   core.tar.gz     → core/entrypoint.sh extrai em /app (main.py, entrypoint.sh,
#                     requirements.txt)
#   session/<arquivo> → session/start.sh copia para /app
#
# O que NÃO entra, e por quê:
#   O app Chili3D (árvore estática) entra DURANTE o build da imagem — o
#   core/Dockerfile busca o dist do commit fixado em chili3d.ref. Não existe
#   canal HTTP para atualizá-lo: mudar exige imagem nova (commit + workflow,
#   ou ./deploy/build-local.sh).
#   Havia pacotes do app e do nginx que nenhum entrypoint consumia — saíram.
#   consumia — saíram. Também havia um web/ de nginx, que não existe mais.
set -eu

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PAC="$RAIZ/deploy/pacotes"
rm -rf "$PAC"
mkdir -p "$PAC"

# 1. núcleo python
tar czf "$PAC/core.tar.gz" -C "$RAIZ/core" main.py entrypoint.sh requirements.txt

# 2. sessão (ponte + kiosk + companheiro CDP)
tar czf "$PAC/session.tar.gz" -C "$RAIZ/session" bridge-server.mjs start.sh package.json kiosk-cdp.mjs

# 3. registro de peças inicial
#    Nenhum entrypoint busca este arquivo: a imagem core já semeia /parts da
#    cópia que leva em /seed/partes. Ele existe para semear à mão um volume
#    novo a partir de outro container (docker cp).
tar czf "$PAC/partes.tar.gz" -C "$RAIZ" partes

ls -la "$PAC"
echo "pacotes prontos em $PAC"
