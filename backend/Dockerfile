# node:22.20.0-bookworm-slim (Node 22 LTS), pinned by digest
FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

ENV NODE_ENV=production
WORKDIR /app

# Exact dependency versions come from package-lock.json (npm ci fails on any drift).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
