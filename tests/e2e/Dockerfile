# Real-browser tests. Playwright's image ships Chromium; libnss3-tools lets us install the
# generated LAN CA into the browser trust store so HTTPS is verified, not bypassed.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/certs/LAN_CA.crt
WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN chmod +x entrypoint.sh
ENTRYPOINT ["/e2e/entrypoint.sh"]
