# Sessão persistente: ponte WebSocket + Chromium headless (kiosk).
#
# A imagem base do Playwright já traz o Chromium em /ms-playwright e o curl —
# nada é instalado em runtime, o start.sh só sobe os processos.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# O lockfile é versionado (session/package-lock.json) para o build ser
# reproduzível: sem ele, `npm install` resolveria a cada build e uma versão
# nova do ws poderia mudar o comportamento da ponte sem ninguém perceber.
COPY session/package.json session/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && test -f node_modules/ws/index.js \
 && echo "BUILD_SESSION_OK"

COPY session/bridge-server.mjs session/kiosk-cdp.mjs session/start.sh /app/
RUN chmod +x /app/start.sh

ENTRYPOINT ["/app/start.sh"]
