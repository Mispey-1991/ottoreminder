# ── Stage 1: Build PWA ────────────────────────────────
FROM node:20-alpine AS pwa-build
WORKDIR /build
COPY pwa/package.json pwa/package-lock.json* ./
RUN npm install
COPY pwa/ ./
RUN npm run build

# ── Stage 2: Relay + serve PWA ────────────────────────
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache curl

COPY relay/package.json relay/package-lock.json* ./
RUN npm install --production

COPY relay/ ./
COPY --from=pwa-build /build/dist ./public

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
