# node:22.20.0-bookworm-slim (Node 22 LTS), pinned by digest
FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

ENV NODE_ENV=production
WORKDIR /app

# Exact dependency versions come from package-lock.json (npm ci fails on any drift).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY migrations ./migrations

# Shared with Asterisk: the backend renders extensions/trunks here. Created before USER so the named volume
# inherits node ownership on first use.
RUN mkdir -p /pbx-generated /pbx-media/prompts && chown -R node:node /pbx-generated /pbx-media

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
