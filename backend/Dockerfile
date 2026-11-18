# =============================================================================
# HostelGuard API — Multi-stage production Dockerfile
# =============================================================================
# Build:  docker build -t hostelguard-api .
# Run:    docker run --env-file .env -p 3001:3001 hostelguard-api
#
# The same image serves both API and Worker; override CMD for the worker:
#   docker run --env-file .env hostelguard-api node dist/workers/escalation.worker.js
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache: only re-runs when lock changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Prisma generate needs the schema
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for a leaner production image
RUN npm prune --production

# ---------------------------------------------------------------------------
# Stage 2: Production
# ---------------------------------------------------------------------------
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S hostelguard && \
    adduser  -u 1001 -S hostelguard -G hostelguard

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder --chown=hostelguard:hostelguard /app/dist          ./dist
COPY --from=builder --chown=hostelguard:hostelguard /app/node_modules  ./node_modules
COPY --from=builder --chown=hostelguard:hostelguard /app/prisma        ./prisma
COPY --from=builder --chown=hostelguard:hostelguard /app/package.json  ./package.json

USER hostelguard

# Default API port (overridden by PORT env or NODE_APP_INSTANCE)
EXPOSE 3001

# Health check — the /health endpoint is unauthenticated
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/health || exit 1

# Default: run the API server. Override CMD for worker.
CMD ["node", "dist/index.js"]
