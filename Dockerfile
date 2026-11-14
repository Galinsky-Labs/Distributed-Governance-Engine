# Public Quill governance runtime. TLS is terminated by this Node service;
# there is no plaintext sidecar or implicit trust of X-Forwarded-* headers.

# Endpoint-only MLS module for private workspaces: OpenMLS at the pinned
# upstream revision compiled to Wasm with Rust 1.94.0 and the checksum-verified
# wasm-bindgen 0.2.130 CLI (scripts/install-mls-tools.py). The server runtime
# never links or executes it; it is only served to browsers as a static asset.
FROM rust:1.94.0-slim-bookworm AS mls
WORKDIR /app
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/* \
  && rustup target add --toolchain 1.94.0 wasm32-unknown-unknown
COPY scripts/install-mls-tools.py ./scripts/install-mls-tools.py
RUN python3 scripts/install-mls-tools.py /opt/quill-mls-tools
ENV PATH=/opt/quill-mls-tools:$PATH
COPY scripts/verify-mls-build.mjs scripts/build-mls.mjs ./scripts/
COPY crypto/mls-endpoint/Cargo.toml crypto/mls-endpoint/Cargo.lock ./crypto/mls-endpoint/
COPY crypto/mls-endpoint/src ./crypto/mls-endpoint/src
RUN node scripts/build-mls.mjs

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web ./web
COPY editor ./editor
COPY src ./src
COPY server ./server
COPY migrations ./migrations
COPY scripts/build-editor.mjs ./scripts/build-editor.mjs
COPY scripts/build-private-workspace.mjs ./scripts/build-private-workspace.mjs
RUN npm run build && node scripts/build-private-workspace.mjs
COPY --from=mls /app/dist/mls ./dist/mls

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# The image ships the private workspace page and MLS Wasm module, so the
# end-to-end encrypted workspace path is enabled; set PRIVATE_WORKSPACES=disabled
# at deploy time to turn it off.
ENV PRIVATE_WORKSPACES=enabled
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/web ./web
COPY --from=build /app/editor ./editor
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/dist ./dist
COPY scripts/migrate-identity.mjs ./scripts/migrate-identity.mjs
# The deployment operator mounts TLS certificates and injects secrets.
# Never bake real credentials into an image or use demo credentials.
RUN chown -R node:node /app
USER node
EXPOSE 8443
CMD ["node","server/start.mjs"]
