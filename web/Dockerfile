# Site: Chili3D compilado na raiz + painel colaborativo em /flow/.
#
# O Chili3D é software de terceiros (AGPL-3.0) e NÃO é código deste
# repositório. Ele é baixado do repositório oficial na versão fixada em
# chili3d.ref e compilado aqui dentro. Consequências deliberadas:
#
#   · nenhum binário de 18 MB entra no histórico git deste repo;
#   · atualizar o app é trocar o SHA em chili3d.ref e rodar o workflow;
#   · o fonte correspondente continua público no repositório oficial do
#     Chili3D, que é o que a AGPL-3.0 exige de quem redistribui o binário.
#
# O custo é o tempo de build: este estágio baixa ~40 MB de fonte, instala as
# dependências de node e roda o rspack. Fica cacheado (scope=web) enquanto o
# SHA não mudar — um push que só mexe no painel não repaga esse preço.
ARG CHILI3D_REPO=xiangechen/chili3d
ARG CHILI3D_REF=4600206f9b354421f4de288e853efcde926da080

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
 && echo "BUILD_WEB_OK"

FROM nginx:alpine

COPY web/default.conf /etc/nginx/conf.d/default.conf
COPY web/start.sh /usr/local/bin/web-start.sh
COPY plugin-flow/ /usr/share/nginx/html/flow/
COPY --from=builder /src/dist /usr/share/nginx/html/dist

# Falha cima e explícita: uma imagem sem o app compilado ou sem o painel sobe
# o nginx numa página em branco, que é o pior modo de falha para diagnosticar.
RUN chmod +x /usr/local/bin/web-start.sh \
 && test -f /usr/share/nginx/html/dist/index.html \
 && test -f /usr/share/nginx/html/flow/manifest.json \
 && echo "BUILD_WEB_FINAL_OK"

ENTRYPOINT ["/usr/local/bin/web-start.sh"]
