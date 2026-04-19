# Build stage
FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM node:20-alpine
RUN addgroup -g 10001 switchbot && adduser -D -u 10001 -G switchbot switchbot
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package*.json ./
RUN npm ci --omit=dev
RUN chown -R switchbot:switchbot /app
USER switchbot
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3030/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
ENTRYPOINT ["node", "dist/index.js"]
