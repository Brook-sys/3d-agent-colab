#!/bin/sh
# Sessão persistente: ponte WebSocket + Chromium headless (kiosk).
#
# A imagem já traz /app e o node_modules — nada é instalado em runtime. Se
# FONTE_URL estiver acessível, o conteúdo é atualizado antes de subir.
set -u

LOG="[session]"
DATA_DIR="${BRIDGE_DATA_DIR:-/data}"
FONTE_URL="${FONTE_URL:-}"
KIOSK_URL="${KIOSK_URL:-http://web/?bridge=&plugin=http://web/flow/&part=espacador&painel=1&api=http://core:9001}"
mkdir -p "$DATA_DIR"

# ------------------------------------------------- 1. atualizar da fonte
if [ -n "$FONTE_URL" ]; then
    for arquivo in bridge-server.mjs package.json start.sh kiosk-cdp.mjs; do
        if curl -fsSL -m 20 -o "/app/$arquivo" "$FONTE_URL/session/$arquivo"; then
            echo "$LOG $arquivo atualizado da fonte"
        fi
    done
    if [ ! -d /app/node_modules/ws ]; then
        echo "$LOG instalando dependências do node"
        (cd /app && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3)
    fi
fi

# ------------------------------------------------- 2. ponte
echo "$LOG iniciando ponte (node $(node -v 2>/dev/null || echo '?'))"
node /app/bridge-server.mjs &
BRIDGE_PID=$!

shutdown() {
    echo "$LOG encerrando"
    kill "$BRIDGE_PID" 2>/dev/null
    [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null
    exit 0
}
trap shutdown TERM INT

# ------------------------------------------------- 3. chromium
CHROME_BIN=""
for candidato in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$candidato" >/dev/null 2>&1; then CHROME_BIN="$candidato"; break; fi
done
if [ -z "$CHROME_BIN" ]; then
    for candidato in /ms-playwright/*/chrome-linux/chrome /ms-playwright/*/chrome-linux headless_shell /root/.cache/ms-playwright/*/chrome-linux/chrome; do
        if [ -x "$candidato" ]; then CHROME_BIN="$candidato"; break; fi
    done
fi
echo "$LOG chromium: ${CHROME_BIN:-NENHUM}"

if [ -z "$CHROME_BIN" ]; then
    echo "$LOG sem chromium: ponte no ar, mas nenhuma página vai conectar"
    wait "$BRIDGE_PID"
    exit 0
fi

# ------------------------------------------------- 4. kiosk
# O companheiro CDP é um processo só para toda a sessão: ele mesmo se reconecta
# quando o Chromium reinicia, e é dele que saem os pedidos de recarga.
if [ -f /app/kiosk-cdp.mjs ]; then
    node /app/kiosk-cdp.mjs >> "$DATA_DIR/kiosk-cdp.log" 2>&1 &
    echo "$LOG companheiro CDP ativo (diálogos + capturas + recarga)"
fi

while :; do
    echo "$LOG abrindo kiosk em $KIOSK_URL"
    # Um Chromium morto a golpe (container recriado, SIGKILL) deixa o
    # SingletonLock do perfil para trás e o próximo morre sem nem abrir a
    # janela — o loop viraria uma saída eterna de 5 em 5 segundos. Aqui o
    # Chromium anterior já morreu (`wait` retornou), então limpar é seguro.
    rm -f "$DATA_DIR/profile/SingletonLock" "$DATA_DIR/profile/SingletonSocket" "$DATA_DIR/profile/SingletonCookie" 2>/dev/null
    "$CHROME_BIN" \
        --headless=new \
        --no-sandbox \
        --no-first-run \
        --disable-session-crashed-bubble \
        --disable-dev-shm-usage \
        --disable-gpu \
        --enable-unsafe-swiftshader \
        --use-angle=swiftshader \
        --enable-logging=stderr \
        --v=0 \
        --remote-debugging-port=9222 \
        --remote-debugging-address=127.0.0.1 \
        --remote-allow-origins='*' \
        --window-size=1600,1000 \
        --user-data-dir="$DATA_DIR/profile" \
        "$KIOSK_URL" >> "$DATA_DIR/chrome.log" 2>&1 &
    CHROME_PID=$!

    wait "$CHROME_PID"
    echo "$LOG kiosk saiu (código $?); reiniciando em 5s"
    sleep 5
done
