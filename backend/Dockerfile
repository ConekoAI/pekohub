# ── Build stage ──
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy workspace config and shared package first
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY backend/src backend/src
COPY backend/drizzle.config.ts backend/
COPY backend/tsconfig.json backend/

# Build shared + backend
RUN pnpm --filter @pekohub/shared build
RUN pnpm --filter @pekohub/backend build

# ── Production stage ──
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/backend/dist backend/dist
COPY --from=builder /app/backend/drizzle backend/drizzle

# Run migrations on startup via entrypoint
COPY backend/drizzle.config.ts backend/
COPY --chown=nodejs:nodejs backend/drizzle backend/drizzle

USER nodejs

WORKDIR /app/backend
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

CMD ["node", "dist/index.js"]
