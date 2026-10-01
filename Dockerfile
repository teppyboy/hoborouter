# Multi-stage build: bun installs deps, builds apps/web, runtime serves
# apps/api/src/index.ts (bun runs TS directly) plus the prebuilt web dist.
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/catalog/package.json packages/catalog/
COPY packages/keys/package.json packages/keys/
COPY packages/payments/package.json packages/payments/
COPY packages/wallet/package.json packages/wallet/
COPY packages/shared/package.json packages/shared/
COPY packages/usage/package.json packages/usage/
COPY tests/package.json tests/
RUN bun install --frozen-lockfile

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN cd apps/web && bunx vp build

FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HBR_DB_PATH=/data/hoborouter.db \
    HBR_WEB_DIST=/app/apps/web/dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/api/package.json apps/api/
COPY apps/api/src ./apps/api/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
