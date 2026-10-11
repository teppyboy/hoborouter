# Multi-stage build: bun installs deps, builds apps/web, runtime serves
# apps/api/src/index.ts (bun runs TS directly) plus the prebuilt web dist.
FROM oven/bun:1.4.2 AS deps
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

FROM oven/bun:1.4.2 AS build
WORKDIR /app
# bun workspaces put per-package deps in each workspace's node_modules,
# which .dockerignore excludes — copy them from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/catalog/node_modules ./packages/catalog/node_modules
COPY --from=deps /app/packages/keys/node_modules ./packages/keys/node_modules
COPY --from=deps /app/packages/payments/node_modules ./packages/payments/node_modules
COPY --from=deps /app/packages/usage/node_modules ./packages/usage/node_modules
COPY --from=deps /app/packages/wallet/node_modules ./packages/wallet/node_modules
COPY . .
# Build metadata injected by CI (release.yml); local builds fall back to git
# via vite.config.ts (build-config time only — no .git in this context).
ARG HBR_APP_VERSION=""
ARG HBR_GIT_SHA=""
ENV HBR_APP_VERSION=${HBR_APP_VERSION} \
    HBR_GIT_SHA=${HBR_GIT_SHA}
RUN cd apps/web && bunx vp build

# Production-only deps for the runtime stage: same lockfile, dev deps stripped.
FROM oven/bun:1.4.2 AS prod-deps
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
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2
WORKDIR /app
# Re-declared in this exact stage's scope for OCI image labels only.
ARG HBR_APP_VERSION=""
ARG HBR_GIT_SHA=""
LABEL org.opencontainers.image.version=${HBR_APP_VERSION} \
      org.opencontainers.image.revision=${HBR_GIT_SHA}
ENV NODE_ENV=production \
    PORT=3000 \
    HBR_AVATAR_DIR=/data/avatars \
    HBR_WEB_DIST=/app/apps/web/dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/catalog/node_modules ./packages/catalog/node_modules
COPY --from=prod-deps /app/packages/keys/node_modules ./packages/keys/node_modules
COPY --from=prod-deps /app/packages/payments/node_modules ./packages/payments/node_modules
# packages/usage has only devDependencies and packages/shared none: after
# --production install neither has node_modules, so nothing to copy; their
# workspace resolution goes through apps/api/node_modules symlinks.
COPY --from=prod-deps /app/packages/wallet/node_modules ./packages/wallet/node_modules
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/api/package.json apps/api/
COPY apps/api/src ./apps/api/src
COPY apps/api/assets ./apps/api/assets
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
