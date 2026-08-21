# syntax=docker/dockerfile:1.7
#
# DataSphere API image.
#
# Build context is the repo root, not apps/api, because this is an npm
# workspaces monorepo and the API depends on @datasphere/core plus the root
# lockfile. Build it with:
#
#   docker build -f apps/api/Dockerfile .
#
# Four stages so the published image carries only production dependencies and
# compiled JavaScript - no TypeScript compiler, no source, no dev tooling.

# ---------------------------------------------------------------------------
# base - the common runtime, pinned to a digest-stable Alpine tag
# ---------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /app
# NODE_ENV is deliberately NOT set here: `npm ci` honours it and would skip the
# devDependencies the build stage needs. It is set in the runtime stage only.


# ---------------------------------------------------------------------------
# deps - install the full workspace dependency tree
#
# Only the manifests are copied before `npm ci`, so this layer is cached and
# reused across every source-only change. Copying source first would
# invalidate the install on every edit.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY scripts/package.json ./scripts/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root


# ---------------------------------------------------------------------------
# build - compile @datasphere/core, then the API
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/api ./apps/api
RUN npm run build -w @datasphere/core \
 && npm run build -w @datasphere/api


# ---------------------------------------------------------------------------
# prod-deps - the same install, minus devDependencies
#
# A second `npm ci` from the identical lockfile rather than `npm prune`:
# prune leaves the tree in a state that depends on what was there before,
# whereas this is reproducible from the lockfile alone.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY scripts/package.json ./scripts/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspaces --include-workspace-root


# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# The whole prod-deps tree, which carries the workspace symlink
# node_modules/@datasphere/core -> ../../packages/core. Copying the tree
# wholesale keeps that link valid without having to guess how npm hoisted it.
COPY --from=prod-deps --chown=node:node /app /app

# Compiled output overlaid onto the manifests already in place.
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist

# Migrations ship with the image so the API container can also be used to run
# them ad hoc against a live database.
COPY --chown=node:node apps/api/migrations ./apps/api/migrations

# `node` is a non-root uid 1000 that the base image already provides. The
# application never writes to disk, so nothing here needs to be writable.
USER node

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api

# Exec form, so node runs as PID 1 and receives SIGTERM directly. The process
# installs its own SIGTERM handler (see src/index.ts) to drain in-flight
# requests and close the pool before exiting.
CMD ["node", "dist/index.js"]
