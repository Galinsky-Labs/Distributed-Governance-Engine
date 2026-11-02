# Public Quill governance runtime. TLS is terminated by this Node service;
# there is no plaintext sidecar or implicit trust of X-Forwarded-* headers.
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
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
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
