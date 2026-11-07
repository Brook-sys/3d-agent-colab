#!/bin/sh
# Empacota o que vai para as imagens. Rode antes de cada deploy.
#
# O host Docker NÃO tem acesso ao diretório deste projeto (é outra máquina), então
# o caminho é: empacotar aqui → servir por HTTP → os containers baixam no build.
# Nada de caminho absoluto do host entra no Compose.
set -eu

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PAC="$RAIZ/deploy/pacotes"
rm -rf "$PAC"
mkdir -p "$PAC"

# 1. núcleo python
tar czf "$PAC/core.tar.gz" -C "$RAIZ/core" main.py entrypoint.sh requirements.txt

# 2. sessão (ponte + kiosk + companheiro CDP)
tar czf "$PAC/session.tar.gz" -C "$RAIZ/session" bridge-server.mjs start.sh package.json kiosk-cdp.mjs

# 2. site: chili3d buildado + plugin do painel
tar czf "$PAC/flow.tar.gz" -C "$RAIZ/plugin-flow" .
if [ -d "$RAIZ/chili3d-upstream/dist" ]; then
    tar czf "$PAC/dist.tar.gz" -C "$RAIZ/chili3d-upstream" dist
else
    echo "AVISO: chili3d-upstream/dist não existe — o site vai sem o app buildado"
    : > "$PAC/dist.tar.gz"
fi

# 2b. servidor web (config do nginx + script de boot)
tar czf "$PAC/web.tar.gz" -C "$RAIZ/web" default.conf start.sh

# 4. registro de peças inicial
tar czf "$PAC/partes.tar.gz" -C "$RAIZ" partes

ls -la "$PAC"
echo "pacotes prontos em $PAC"
