# ── Build stage ──
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy workspace config and shared package first
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY frontend/package.json frontend/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY frontend/src frontend/src
COPY frontend/index.html frontend/
COPY frontend/vite.config.ts frontend/
COPY frontend/tsconfig.json frontend/
COPY frontend/postcss.config.js frontend/ 2>/dev/null || true
COPY frontend/tailwind.config.js frontend/ 2>/dev/null || true
COPY frontend/tailwind.config.ts frontend/ 2>/dev/null || true

# Build shared + frontend
RUN pnpm --filter @pekohub/shared build
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter @pekohub/frontend build

# ── Production stage ──
FROM nginx:alpine AS runner

# Copy built SPA
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# SPA fallback: all routes → index.html
RUN echo 'server { \
    listen 80; \
    server_name _; \
    root /usr/share/nginx/html; \
    index index.html; \
    gzip on; \
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
