FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund typescript@5 && npx tsc -p tsconfig.json && npm uninstall typescript

# Persistent session storage (Railway volume mounts here)
ENV SESSION_DIR=/data/sessions
RUN mkdir -p /data/sessions
VOLUME ["/data/sessions"]

CMD ["node", "dist/index.js"]
