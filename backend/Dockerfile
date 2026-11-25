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
FROM node:24-alpine AS builder

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

# Migrations need the lockfile-pinned dev Prisma CLI, not a downloaded npx copy.
FROM builder AS migration
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# Keep the builder and migration stages intact; prune only this branch.
FROM builder AS production-deps
# npm can retain Prisma as @prisma/client's optional peer; the runtime only
# needs the generated client and its engine, not the CLI or migration engines.
RUN npm prune --omit=dev --ignore-scripts && \
    rm -rf node_modules/prisma node_modules/.bin/prisma node_modules/@prisma/engines \
      node_modules/@prisma/engines-version node_modules/@prisma/fetch-engine \
      node_modules/@prisma/get-platform

# ---------------------------------------------------------------------------
# Production runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S hostelguard && \
    adduser  -u 1001 -S hostelguard -G hostelguard

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder --chown=hostelguard:hostelguard /app/dist          ./dist
COPY --from=production-deps --chown=hostelguard:hostelguard /app/node_modules  ./node_modules
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
