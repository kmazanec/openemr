# syntax=docker/dockerfile:1.7

# Multi-stage build for the Clinical Co-Pilot agent service.
# Final image runs the compiled output as the non-root `node` user.

ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

# ── Stage: deps ──────────────────────────────────────────────────────────────
# Install full dependency tree (incl. dev) for the build stage. Cached on
# package*.json so source-only changes don't invalidate the install layer.
#
# `poppler-utils` (pdftoppm + pdfinfo) ships in `deps` as well as `runtime`
# because the local-dev compose target uses this stage directly (`npm run dev`
# under tsx-watch). Without poppler here the §B.3 rasterizer fails with
# `spawn pdfinfo ENOENT` whenever a clinician uploads a PDF locally.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# `tesseract-ocr` + the english trained data are used by the §B.4b
# bbox-snap pass that runs after vision returns — the snapper re-OCRs
# each rasterized page and aligns every cited bbox to actual text.
# Without it the vision model's bboxes are systematically shifted by
# half a row on dense lab tables.
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-eng
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

# `poppler-utils` provides `pdftoppm` (PDF rasterization) and `pdfinfo`
# (page-count probe), which the §B.3 rasterizer shells out to. Replaces
# the previous pdfjs + node-canvas stack — that combination silently
# rendered some clinical PDFs as a solid-color wash with only fragments
# of text visible, producing useless inputs for the vision model.
# Poppler is the reference Linux PDF renderer and handles the modern
# PDF features (transparency groups, blend modes, gradients) that
# pdfjs-on-Node-canvas struggled with.
#
# `tesseract-ocr` is used by the §B.4b bbox-snap pass that aligns
# every cited bbox to the actual OCR'd text position on the page.
# Required at runtime — without it the snapper logs a per-page
# warning and the model's raw (often row-shifted) bboxes ship through.
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-eng

ENV NODE_ENV=production \
    PORT=8080

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# node-pg-migrate reads SQL files from disk at boot. The resolver in
# src/state/migrations.ts walks `dist/state/ → ../../migrations`, so
# migrations/ must land at /app/migrations. Glob limits the copy to
# `.sql` files — the directory's `README.md` would otherwise be picked
# up by the runner's loader (it iterates everything in the dir) and
# fail with `ERR_UNKNOWN_FILE_EXTENSION`.
COPY --chown=node:node migrations/*.sql ./migrations/
# `evidenceRetriever` fits BM25 stats at boot from the same corpus the
# reindex script upserted to Pinecone (see `src/retrievers/corpusLoader.ts`).
# Pinecone stores per-chunk sparse vectors but not the corpus-level stats
# (avgDocLength, docFreq), so we must re-derive them from the source
# files on the query side. Without this copy the stats are empty, every
# query produces an empty sparse vector, and Pinecone rejects the hybrid
# query → "Guideline evidence is temporarily unavailable." (Tracked for
# replacement by a hosted stats JSON in phase-G.9.)
COPY --chown=node:node data/corpus ./data/corpus

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --output-document=- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "--enable-source-maps", "dist/server/index.js"]
