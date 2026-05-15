# ── Build stage ──
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY frontend/package.json frontend/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY frontend/src frontend/src
COPY frontend/index.html frontend/
COPY frontend/vite.config.ts frontend/
COPY frontend/tailwind.config.js frontend/
COPY frontend/postcss.config.js frontend/
COPY frontend/tsconfig.json frontend/
COPY frontend/tsconfig.node.json frontend/

RUN pnpm --filter @pekohub/shared build
RUN pnpm --filter @pekohub/frontend build

# ── Serve stage (nginx) ──
FROM nginx:alpine AS runner
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
