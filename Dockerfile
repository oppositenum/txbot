ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="txbot" \
      org.opencontainers.image.source="https://github.com/oppositenum/txbot" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TZ=Asia/Shanghai
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const h={};if(process.env.TXBOT_USER&&process.env.TXBOT_PASS)h.Authorization='Basic '+Buffer.from(process.env.TXBOT_USER+':'+process.env.TXBOT_PASS).toString('base64');fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/',{headers:h,signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.js"]
