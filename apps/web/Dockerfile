# syntax=docker/dockerfile:1.7
#
# DataSphere web image.
#
# Build context is the repo root (workspace monorepo):
#
#   docker build -f apps/web/Dockerfile .
#
# The result is a static bundle served by nginx. Node is a build-time
# dependency only - it does not ship in the final image, which means no Node
# runtime CVEs to patch on the public-facing container.

# ---------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY scripts/package.json ./scripts/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# Baked into the bundle at build time. Empty means same-origin, which is what
# the compose stack wants because nginx proxies /api to the API service.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/web ./apps/web

# The web app imports types from @datasphere/core, and `tsc -b` needs the
# referenced project's declarations to exist before it can check them.
RUN npm run build -w @datasphere/core \
 && npm run build -w @datasphere/web


# ---------------------------------------------------------------------------
# runtime - nginx, unprivileged
#
# nginxinc/nginx-unprivileged runs as uid 101 and listens on 8080 out of the
# box, rather than the stock image's root master process on port 80.
# ---------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
