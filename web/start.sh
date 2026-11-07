#!/bin/sh
# Sobe o nginx depois de tentar atualizar o painel colaborativo da fonte.
# A imagem já traz o Chili3D buildado e o painel; a atualização é melhor-esforço.
set -u
LOG="[web]"
HTML=/usr/share/nginx/html

if [ -n "${FONTE_URL:-}" ]; then
    rm -rf /tmp/flow
    mkdir -p /tmp/flow
    if wget -q -T 20 -O /tmp/flow.tar.gz "$FONTE_URL/deploy/pacotes/flow.tar.gz"; then
        rm -rf "$HTML/flow"
        mkdir -p "$HTML/flow"
        tar xzf /tmp/flow.tar.gz -C "$HTML/flow" \
            && echo "$LOG painel atualizado da fonte" \
            || echo "$LOG AVISO: fluxo corrompido, mantendo o da imagem"
        rm -rf /tmp/flow.tar.gz
    else
        echo "$LOG fonte indisponível; mantendo o painel da imagem"
    fi
else
    echo "$LOG FONTE_URL vazio; usando o que está na imagem"
fi

test -f "$HTML/dist/index.html" && echo "$LOG chili3d servido de $HTML/dist" \
    || echo "$LOG AVISO: $HTML/dist/index.html ausente — o app não vai carregar"
test -f "$HTML/flow/manifest.json" && echo "$LOG painel em $HTML/flow" \
    || echo "$LOG AVISO: $HTML/flow/manifest.json ausente — o painel não vai carregar"

exec nginx -g 'daemon off;'
