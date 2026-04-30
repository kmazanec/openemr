# syntax=docker/dockerfile:1.7

# Multi-stage build for the Clinical Co-Pilot agent service.
# Final image runs the compiled output as the non-root `node` user.

ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

# ── Stage: deps ──────────────────────────────────────────────────────────────
# Install full dependency tree (incl. dev) for the build stage. Cached on
# package*.json so source-only changes don't invalidate the install layer.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# ── Stage: build ─────────────────────────────────────────────────────────────
# Compile TypeScript to dist/.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ── Stage: prod-deps ─────────────────────────────────────────────────────────
# Production-only dependency tree for the runtime image. Separate from `deps`
# so dev-only packages don't ship in the final layer.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ── Stage: runtime ───────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --output-document=- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "--enable-source-maps", "dist/server/index.js"]
