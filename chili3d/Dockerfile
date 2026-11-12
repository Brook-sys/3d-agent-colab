# Container `chili3d`: o app Chili3D original, servido por um processo Node que
# também encaminha /v1/ para o relay de IA.
#
# ANTES era outra coisa: esta imagem se chamava `core` (Python + build123d + API
# + MCP + registro de peças) e havia uma segunda imagem, `session`, com Chromium
# headless, ponte WebSocket e companheiro CDP. As duas saíram. O que fica é o que
# o pedido original pedia — o Chili3D como vem do commit fixado — mais um único
# adicional, o proxy de /v1/, que é a correção do "Erro: Connection error."
# (ver chili3d/servidor.mjs e docs/assistente-relay.md).
#
# Nada de Python, nada de Chromium, nada de sistema de arquivos persistente: o
# container é stateless, e o app é estático. Reiniciar não perde nada.
#
# O build tem duas partes por um motivo de cache: a compilação do Chili3D leva
# minutos e só muda quando chili3d.ref muda. Esta camada não tem COPY antes
# dela, então o cache a acerta enquanto o SHA não mudar — nem um push no
# chili3d/ a invalida.

ARG CHILI3D_REPO=xiangechen/chili3d
ARG CHILI3D_REF=4600206f9b354421f4de288e853efcde926da080

# ------------------------------------------------------------ app compilado
#
# O Chili3D é software de terceiros (AGPL-3.0): baixado do repositório oficial
# no commit fixado e compilado aqui dentro. Nenhum binário entra no repositório
# e o fonte correspondente continua público no oficial — que é a obrigação da
# licença. Atualizar o app é trocar o SHA em chili3d.ref (o workflow confere que
# os dois batem antes de buildar).
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

# ------------------------------------------------------------------ runtime
#
# node:20-bookworm-slim, e não alpine: o build do app usa toolchain glibc e as
# fontes do sistema fazem falta para o renderizador de texto do app. A imagem
# final tem Node de sobra para o que precisa — servir arquivo e encaminhar HTTP.
FROM node:20-bookworm-slim

# O `dist` já vem com os assets com hash no nome; o servidor manda cache longo
# neles e `no-cache` só no index.html.
COPY --from=builder /src/dist /app/dist
COPY chili3d/servidor.mjs /app/servidor.mjs

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DIST_DIR=/app/dist \
    RELAY_URL=""

EXPOSE 8080

# Healthcheck em Node puro: a imagem não tem curl e Silverstone não instala
# programa só por isso. Node 20 tem `fetch` global.
#
# start-period curto de propósito: não há semeadura de registro nem Chromium para
# esperar — o servidor está pronto quando o socket abre. O que este check NÃO
# cobre é se o relay responde; isso é a verificação pós-deploy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sem entrypoint de root, sem gosu, sem chown: o processo roda como o usuário
# `node` que a imagem já traz, e não escreve nada no disco.
USER node

CMD ["node", "/app/servidor.mjs"]
