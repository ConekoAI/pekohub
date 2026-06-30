# PekoHub

Public registry for [Pekobot](https://github.com/coneko/pekobot) principals and extensions.

## Architecture

```
pekohub/
├── backend/          # Fastify API — OCI Distribution Spec + custom APIs
├── frontend/         # React SPA — Vite + Tailwind + TanStack Router
├── packages/shared/  # Zod schemas, OCI types, shared constants
└── docker-compose.yml
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 22, Fastify, Drizzle ORM, PostgreSQL |
| Frontend | React 18, Vite, Tailwind CSS, TanStack Router/Query |
| Search | Meilisearch |
| Storage | S3-compatible (MinIO locally, R2/S3 in prod) |
| Auth | OAuth 2.0 (GitHub, Google) via Arctic |
| Monorepo | pnpm workspaces + Turborepo |

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker + Docker Compose

### 1. Install dependencies

```bash
cd pekohub
pnpm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
```

This starts PostgreSQL, MinIO (S3), and Meilisearch.

### 3. Configure environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your OAuth credentials (optional for local dev)
```

### 4. Run database migrations

```bash
cd backend
pnpm db:push
```

### 5. Start dev servers

```bash
# Terminal 1 — backend
cd backend
pnpm dev

# Terminal 2 — frontend
cd frontend
pnpm dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173
- API docs: http://localhost:3000/docs

## API Overview

### OCI Distribution Spec v1.1

| Endpoint | Description |
|----------|-------------|
| `GET /v2/_catalog` | List all bundle namespaces |
| `GET /v2/{ns}/{name}/tags/list` | List tags |
| `GET /v2/{ns}/{name}/manifests/{ref}` | Pull manifest |
| `PUT /v2/{ns}/{name}/manifests/{ref}` | Push manifest |
| `GET /v2/{ns}/{name}/blobs/{digest}` | Pull blob |
| `POST /v2/{ns}/{name}/blobs/uploads/` | Initiate blob upload |
| `PUT /v2/{ns}/{name}/blobs/uploads/{uuid}` | Complete blob upload |

### Custom APIs

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/search?q=...` | Full-text search |
| `GET /api/v1/bundles/{ns}/{name}` | Bundle detail |
| `GET /api/v1/bundles/{ns}/{name}/versions` | Version history |
| `GET /api/v1/auth/{provider}/authorize` | OAuth login |
| `GET /api/v1/auth/{provider}/callback` | OAuth callback |

## Deployment

### Frontend → Cloudflare Pages / S3 + CloudFront

The frontend is a static SPA. Build and deploy:

```bash
cd frontend
pnpm build
# Upload dist/ to your CDN
```

### Backend → AWS App Runner / ECS / Fly.io

```bash
cd backend
docker build -t pekohub-backend -f Dockerfile ..
```

Environment variables required in production:
- `DATABASE_URL`
- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
- `MEILISEARCH_URL`, `MEILISEARCH_API_KEY`
- `JWT_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

## Scripts

```bash
pnpm dev      # Start all dev servers (via turbo)
pnpm build    # Build all packages
pnpm lint     # Lint all packages
pnpm test     # Run all tests
```

## License

MIT
