# ---- build the SPA (SIP.js + socket.io-client + app code) -----------------------
# node:22.20.0-bookworm-slim (Node 22 LTS), pinned by digest
FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY build.js ./
COPY src ./src
RUN node build.js

# ---- serve with Nginx (TLS termination, /api, /socket.io and /ws proxying) ------
# nginx:1.28.0-alpine, pinned by digest
FROM nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/templates /etc/nginx/templates
# Substitute only our variables in the templates (nginx's own $variables stay intact).
ENV NGINX_ENVSUBST_FILTER="^(SERVER_|ASTERISK_)"
EXPOSE 80 443
