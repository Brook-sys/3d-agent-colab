#!/bin/sh
# Núcleo do fluxo de peças.
#
# A imagem já traz /app, /venv e /seed (cópia inicial do registro) — o container
# sobe sozinho, sem depender da máquina de desenvolvimento. Se FONTE_URL estiver
# acessível, o conteúdo é atualizado antes de subir: editar o núcleo e reiniciar
# o container é o suficiente para a mudança valer.
set -u

LOG="[core]"
VENV_DIR="${VENV_DIR:-/venv}"
VENV_PY="$VENV_DIR/bin/python"
SEED="${SEED_DIR:-/seed/partes}"
TARGET_UID="${PUID:-1000}"
TARGET_GID="${PGID:-1000}"
FONTE_URL="${FONTE_URL:-}"

echo "$LOG python $(python -V 2>&1) · uid $(id -u):$(id -g)"

# ------------------------------------------------- 1. atualizar da fonte
if [ -n "$FONTE_URL" ]; then
    python - "$FONTE_URL" <<'PY' || echo "$LOG fonte indisponível; usando a cópia da imagem"
import io, sys, tarfile, urllib.request

url, destino = sys.argv[1] + "/deploy/pacotes/core.tar.gz", "/app"
try:
    dados = urllib.request.urlopen(url, timeout=25).read()
    with tarfile.open(fileobj=io.BytesIO(dados), mode="r:gz") as tar:
        try:
            tar.extractall(destino, filter="data")
        except TypeError:  # python < 3.12
            tar.extractall(destino)
    print("[core] núcleo atualizado da fonte")
except Exception as err:
    raise SystemExit(err)
PY
fi

# ------------------------------------------------- 2. semear o registro
if [ -d "$SEED" ] && [ ! -e /parts/.semeadura ]; then
    echo "$LOG semeando /parts a partir da imagem"
    cp -a "$SEED"/. /parts/ 2>/dev/null || true
    mkdir -p /parts
    date -u +%Y-%m-%dT%H:%M:%SZ > /parts/.semeadura 2>/dev/null || true
fi
mkdir -p /parts/_estado/mensagens /parts/_estado/plugin /parts/_estado/ponte 2>/dev/null || true

# ------------------------------------------------- 3. dependências
if [ ! -x "$VENV_PY" ]; then
    echo "$LOG criando venv (a imagem deveria ter trazido um)"
    python -m venv "$VENV_DIR" || python -m venv --without-pip "$VENV_DIR"
fi

if [ -f /app/requirements.txt ]; then
    REQ_HASH="$(md5sum /app/requirements.txt | cut -d' ' -f1)"
    STAMP="$VENV_DIR/.req-hash"
    if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$REQ_HASH" ]; then
        echo "$LOG instalando dependências (primeira vez pode levar minutos)"
        "$VENV_PY" -m pip install --quiet --upgrade pip >/dev/null 2>&1
        if "$VENV_PY" -m pip install --quiet -r /app/requirements.txt 2>&1 | tail -15; then
            echo "$REQ_HASH" > "$STAMP" 2>/dev/null || true
            echo "$LOG dependências instaladas"
        else
            echo "$LOG AVISO: falha na instalação — a API sobe, validação geométrica fica limitada"
            "$VENV_PY" -m pip install --quiet fastapi uvicorn 2>&1 | tail -5
        fi
    fi
fi

if "$VENV_PY" -c "import build123d" 2>/dev/null; then
    echo "$LOG build123d disponível — validação geométrica ativa"
else
    echo "$LOG AVISO: build123d indisponível — validação só conferirá o envelope quando houver STEP"
fi

# ------------------------------------------------- 4. subir
ARGS="-m uvicorn main:app --host 0.0.0.0 --port ${PORT:-9001} --log-level info"
# O processo cai para uid 1000, mas HOME continua /root (do root): o ezdxf,
# puxado pelo build123d, tenta escrever ~/.config/ezdxf/ezdxf.ini e a validação
# geométrica morre com Permission denied. Um HOME gravável desempata isso.
export FLUXO_HOME="${FLUXO_HOME:-/tmp/fluxo-home}"
mkdir -p "$FLUXO_HOME/.config" 2>/dev/null || true
export HOME="$FLUXO_HOME"
export XDG_CONFIG_HOME="$FLUXO_HOME/.config"
if [ "$(id -u)" = "0" ] && command -v setpriv >/dev/null 2>&1; then
    chown -R "$TARGET_UID:$TARGET_GID" /parts "$VENV_DIR" /app "$FLUXO_HOME" 2>/dev/null || true
    echo "$LOG reexecutando como uid $TARGET_UID"
    exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --clear-groups "$VENV_PY" $ARGS
fi
exec "$VENV_PY" $ARGS
