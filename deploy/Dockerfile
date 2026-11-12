# The client report server. The image holds code and the built viewer page only: no report, no registry, no key, no .env.
# Build from the project root (see apps/server/README.md, "Docker with a Cloudflare tunnel"):
#   docker build -f deploy/Dockerfile -t webobs-report:local .

# ---- 1. build the viewer page (one self-contained report.html) ----
# The base image is pinned by version AND digest, so a rebuild cannot silently pick up a different image. To bump it: docs/SETUP.md, "Updating the base image".
# Pinned on 2026-11-08: Node 24.22.2 on Alpine (the tag and the digest below named the same image when pinned).
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS viewer
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/viewer ./apps/viewer
COPY packages/contract/src ./packages/contract/src
# The vendored web-obs globe (MIT, see NOTICE and UPSTREAM.md). Only the viewer build uses it; it is not in the final image.
COPY vendor/web-obs ./vendor/web-obs
# An optional agency brand (apps/viewer/brand/brand.json and fonts/, see apps/viewer/brand/README.md) is picked up here. Without one the viewer keeps its
# current look. Pass --build-arg WEBOBS_BRAND_STRICT=1 so a brand that does not pass fails the build instead of silently falling back.
ARG WEBOBS_BRAND_STRICT=0
ENV WEBOBS_BRAND_STRICT=$WEBOBS_BRAND_STRICT
RUN npm run build

# ---- 2. the server: plain Node, no packages to install ----
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ARG VERSION=0.1.7
LABEL org.opencontainers.image.title="web-obs-client-report" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/OWNER/web-obs-client-report" \
      org.opencontainers.image.description="Token-gated client report viewer and optional HTTPS ingest (beta)"
ENV NODE_ENV=production \
    PORT=8080 \
    APP_FILE=/app/report.html \
    REPORTS_DIR=/data/reports \
    REGISTRY_DIR=/data/registry \
    OUTBOX_DIR=/data/outbox
WORKDIR /app
COPY apps/server/server.mjs apps/server/source.mjs apps/server/email.mjs apps/server/tokens.mjs apps/server/clientip.mjs apps/server/styles-inject.mjs ./
# A report can carry a look (its styles). The shared checker is plain Node with no packages; it sits at /viewer/brand so the same relative import works here and in the repository.
# The two fonts bundled by name (SIL Open Font License, notices beside them) are the only fonts a report can name.
COPY apps/viewer/brand/color.mjs apps/viewer/brand/styles.mjs apps/viewer/brand/styles-hash.mjs /viewer/brand/
COPY apps/server/fonts ./fonts
# The optional HTTPS ingest (off unless a container is started with the ingest command). Delete this line and apps/server/ingest/ to remove it.
COPY apps/server/ingest/ingest.mjs apps/server/ingest/contract-check.mjs apps/server/ingest/access-jwt.mjs apps/server/ingest/envelope.mjs ./ingest/
# The cleanup tool (plain Node, no imports outside node:), so expired reports can be removed with this same image:
#   docker run --rm ... -v webobs-data:/data IMAGE node tools/cleanup.mjs --reports /data/reports --registry /data/registry [--dry-run]
COPY apps/server/tools/cleanup.mjs ./tools/cleanup.mjs
# Checks a styles file (a report's look) without sending or storing anything: node tools/check-styles.mjs <styles.json> [report.html]
COPY apps/server/tools/check-styles.mjs ./tools/check-styles.mjs
COPY --from=viewer /src/dist-report/report.html ./report.html
# /data is where you mount reports and the registry (read-only). Nothing is stored there by the image.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
