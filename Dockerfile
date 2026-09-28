FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall swaps in the vendored WAProto — needs these dirs BEFORE npm ci
COPY scripts/install-waproto.js scripts/
COPY vendor/waproto vendor/waproto
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Persistent session storage (Railway volume mounts here)
ENV SESSION_DIR=/data/sessions
RUN mkdir -p /data/sessions

CMD ["node", "dist/index.js"]
