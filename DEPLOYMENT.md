# PekoHub Deployment Guide

## Overview

This document covers deploying PekoHub to production using **Cloudflare** (DNS + SSL + Frontend + Storage) and **AWS** (backend compute + database + search).

Three deployment paths provided:

| Path | Complexity | Monthly Cost | Best For |
|------|-----------|--------------|----------|
| **Cloudflare Pages + EC2** | Low | ~$20-25/mo | Getting started, < 1000 users |
| **EC2 (docker-compose)** | Low | ~$45/mo | Full AWS, simple ops |
| **ECS Fargate (managed)** | Medium | ~$80-150/mo | Production, auto-scaling |

**Recommended for most users: Cloudflare Pages + Single EC2** — uses Cloudflare's generous free tiers for frontend and blob storage, keeping only the stateful backend on a small EC2 instance.

---

## Prerequisites

- AWS account with CLI access
- Cloudflare account with `pekohub.org` domain
- GitHub repository with Actions enabled
- OAuth apps registered (GitHub + Google)

---

## Step 1: Configure OAuth Apps

### GitHub OAuth App

1. Go to https://github.com/settings/developers
2. New OAuth App → Name: "PekoHub"
3. Homepage URL: `https://pekohub.org`
4. Authorization callback URL: `https://pekohub.org/api/v1/auth/github/callback`
5. Save Client ID and Client Secret

### Google OAuth 2.0

1. Go to https://console.cloud.google.com/apis/credentials
2. Create Credentials → OAuth client ID → Web application
3. Authorized redirect URIs: `https://pekohub.org/api/v1/auth/google/callback`
4. Save Client ID and Client Secret

---

## Step 2: Cloudflare Infrastructure Setup

### Cloudflare Pages (Frontend — Free)

1. Go to https://pages.cloudflare.com/
2. Create a project → Connect to GitHub
3. Select your `pekohub` repository
4. Configure build:
   - **Build command:** `pnpm build`
   - **Build output directory:** `frontend/dist`
5. Add environment variables:
   - `CI=true`
   - `VITE_API_BASE_URL=https://pekohub.org/api/v1`
   - `VITE_REGISTRY_BASE_URL=https://pekohub.org`
6. Deploy

### Cloudflare R2 (Blob Storage — Free Tier)

1. Go to R2 → Create bucket: `pekohub-blobs`
2. Create an R2 API token (Object Admin scope)
3. Save the token and bucket URL for later

### Cloudflare Workers (Optional)

If you want rate limiting or simple edge caching, create a Worker at Workers & Pages → Create Worker.

---

## Step 3: AWS EC2 Setup (Backend)

### Option A: Single EC2 + Cloudflare (Recommended — Low Cost)

1. **Launch EC2 instance**
   - AMI: Ubuntu 24.04 LTS
   - Instance type: `t3.small` (1 vCPU, 2 GB RAM) — sufficient for < 1000 users
   - Storage: 20 GB gp3
   - Security group: Allow 22 (SSH), 80 (HTTP), 443 (HTTPS)

2. **Install Docker & docker-compose**
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   sudo apt install docker-compose-plugin
   ```

3. **Clone repo & configure**
   ```bash
   git clone https://github.com/YOUR_ORG/pekohub.git
   cd pekohub
   cp backend/.env.example backend/.env
   # Edit backend/.env with production values
   ```

4. **Update storage config** to use R2:
   ```
   BLOB_PROVIDER=r2
   R2_ACCOUNT_ID=your-account-id
   R2_ACCESS_KEY_ID=your-key
   R2_SECRET_ACCESS_KEY=your-secret
   R2_BUCKET=pekohub-blobs
   ```

5. **Update backend/.env** with:
   ```
   NODE_ENV=production
   DATABASE_URL=postgres://user:pass@localhost:5432/pekohub
   MEILISEARCH_HOST=http://localhost:7700
   FRONTEND_URL=https://pekohub.org
   ```

6. **Start services**:
   ```bash
   docker compose up -d
   ```

7. **Point Cloudflare DNS** to EC2 public IP:
   - A record: `pekohub.org` → EC2 public IP

8. **Run migrations**:
   ```bash
   docker compose exec backend npx drizzle-kit migrate
   ```

### Option B: EC2 (docker-compose) — Full AWS

1. **Launch EC2 instance**
   - AMI: Ubuntu 24.04 LTS
   - Instance type: `t3.medium` (2 vCPU, 4 GB RAM)
   - Storage: 30 GB gp3
   - Security group: Allow 22 (SSH), 80 (HTTP), 443 (HTTPS)

2. **Install Docker & docker-compose**
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   sudo apt install docker-compose-plugin
   ```

3. **Clone repo & configure**
   ```bash
   git clone https://github.com/YOUR_ORG/pekohub.git
   cd pekohub
   cp backend/.env.example backend/.env
   # Edit backend/.env with production values
   ```

4. **Start services**
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```

### Option C: ECS Fargate (Managed)

1. **Run setup script**
   ```bash
   cd pekohub/infra/aws
   chmod +x setup.sh
   AWS_REGION=us-east-1 ./setup.sh
   ```

2. **Update Secrets Manager** with real values:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id pekohub/database-url \
     --secret-string "postgres://user:pass@host:5432/pekohub"
   # ... repeat for all secrets
   ```

3. **Register task definitions**
   ```bash
   # Replace AWS_ACCOUNT_ID and AWS_REGION in the JSON files, then:
   aws ecs register-task-definition --cli-input-json file://ecs-task-definition-backend.json
   aws ecs register-task-definition --cli-input-json file://ecs-task-definition-frontend.json
   ```

4. **Create Application Load Balancer** with target groups:
   - TG `/api/*, /v2/*, /docs, /health` → backend:3000
   - TG `/*` → frontend:80

5. **Create ECS services** using the ALB target groups

---

## Step 4: Cloudflare DNS Configuration

1. **DNS Records**
   - A record: `pekohub.org` → EC2 public IP (Option A/B) / ALB DNS name (Option C)
   - AAAA record: (optional, for IPv6)

2. **SSL/TLS**
   - Encryption mode: **Full (strict)**
   - TLS 1.3: Enabled
   - Always Use HTTPS: On

3. **Page Rules** (free tier: 3 rules)
   - `pekohub.org/api/*` → Cache Level: Bypass
   - `pekohub.org/v2/*` → Cache Level: Bypass
   - `pekohub.org/*.js` / `*.css` → Cache Level: Cache Everything, Edge TTL: 1 month

4. **Security**
   - Security Level: Medium
   - Bot Fight Mode: On
   - Rate limiting: 100 requests / 10 seconds (adjust as needed)

---

## Step 5: GitHub Actions Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM user with ECR push + ECS deploy permissions |
| `AWS_SECRET_ACCESS_KEY` | Matching secret key |
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |
| `REGISTRY_BASE_URL` | `https://pekohub.org` |
| `CLOUDFLARE_API_TOKEN` | With `Zone:Edit` permission |
| `CLOUDFLARE_ZONE_ID` | From Cloudflare dashboard |
| `EC2_HOST` | (EC2 path only) Public IP or DNS |
| `EC2_USER` | (EC2 path only) Usually `ubuntu` |
| `EC2_SSH_KEY` | (EC2 path only) Private key contents |

### IAM Policy for GitHub Actions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeServices",
        "ecs:UpdateService"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/ecsTaskExecutionRole"
    }
  ]
}
```

---

## Step 6: Database Migrations

Run migrations manually on first deploy:

```bash
# Option A/B (EC2)
docker compose exec backend npx drizzle-kit migrate

# Option C (ECS) — run a one-off task
aws ecs run-task \
  --cluster pekohub \
  --task-definition pekohub-backend \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides": [{"name": "backend", "command": ["npx", "drizzle-kit", "migrate"]}]}'
```

---

## Step 7: Verify Deployment

```bash
# Health check
curl https://pekohub.org/health

# API docs
curl https://pekohub.org/docs

# Search
curl "https://pekohub.org/api/v1/search?q=test"

# OCI catalog
curl https://pekohub.org/v2/_catalog
```

---

## Architecture Diagrams

### Recommended: Cloudflare Pages + EC2 (Low Cost)

```
Cloudflare                                           AWS EC2 (~$17/mo)
┌──────────────────────────────────┐                ┌─────────────────────────┐
│ pekohub.org                      │                │ t3.small                │
│ ├── Pages (Frontend - FREE)       │   requests     │ ┌─────────────────────┐│
│ │   └── React static builds      │ ─────────────> │ │ Backend :3000       ││
│ ├── R2 (Blobs - FREE 10GB)       │                │ │ PostgreSQL           ││
│ │   └── OCI blobs, extensions    │                │ │ Meilisearch          ││
│ └── DNS → EC2 public IP          │                │ └─────────────────────┘│
└──────────────────────────────────┘                └─────────────────────────┘
```

### Full AWS: ECS Fargate

```
Cloudflare                                    AWS ECS Fargate
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ pekohub.org                  │             │ ALB                          │
│ ├── DNS → ALB                │             │ ├── /api/* → Backend :3000   │
│ ├── SSL (Full Strict)       │             │ └── /* → Frontend :80        │
│ └── CDN caching              │             └──────────────┬───────────────┘
└──────────────────────────────┘                            │
                                                            ├─ ECS Backend (Node 22)
                                                            ├─ ECS Frontend (Nginx)
                                                            ├─ RDS PostgreSQL
                                                            └─ S3 (Blobs)
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `UNAUTHORIZED` on push | Check OAuth callback URLs match exactly |
| `BLOB_UNKNOWN` | Verify R2/S3 credentials and bucket permissions |
| Search returns empty | Check Meilisearch URL and API key |
| Frontend 404s on refresh | Cloudflare Pages: enable "Serve static assets" |
| ECS tasks won't start | Check CloudWatch logs at `/ecs/pekohub-backend` |

---

## Cost Estimate (Monthly)

| Service | Cloudflare Pages + EC2 | Full AWS EC2 | ECS Fargate |
|---------|----------------------|--------------|-------------|
| Compute | $17 (t3.small) | $30 (t3.medium) | $50 (Fargate) |
| PostgreSQL | — (self-hosted) | — (self-hosted) | $15 (RDS) |
| Blob Storage | Free (R2) | $5 (S3) | $5 (S3) |
| Data Transfer | $5 | $10 | $10 |
| Cloudflare Pages | Free | — | — |
| Meilisearch | Self-hosted | Self-hosted | $15 (Cloud) |
| **Total** | **~$22-25** | **~$45** | **~$95** |

---

## Next Steps After Deploy

1. Set up monitoring (CloudWatch / Datadog / UptimeRobot)
2. Configure automated backups for PostgreSQL
3. Set up log aggregation
4. Run load tests against staging
5. Publish the first official bundles