# syntax=docker/dockerfile:1.7

# Dev-only image for the patient dashboard SPA. Used by
# docker/development-easy/docker-compose.yml — production builds the
# bundle inside infra/deploy.sh's one-shot node:22-alpine container
# and never touches this image.
#
# Single stage (deps only): installs the full dependency tree and
# stops there. The compose service then bind-mounts the host's
# dashboard/ over /app and runs `vite build --watch` against the
# container-installed node_modules. No dist/ baked into the image —
# the build output writes back through the bind mount so the openemr
# container's docroot picks it up via the same bind mount.

ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev
