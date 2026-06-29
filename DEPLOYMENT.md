# PekoHub Deployment Guide

> **Recommended path: Cloudflare Pages + Lightsail + R2** — ~$5-10/month, 30 min setup, auto-deploy on git push.

---

## Overview

This guide covers deploying PekoHub using **Cloudflare** (DNS, SSL, CDN, frontend hosting, blob storage) and **AWS Lightsail** (backend compute, database, search).

### Architecture

```
Cloudflare (pekohub.org)
├─ Pages    → Frontend SPA (React/Vite) — FREE, auto-deploy, global CDN
├─ R2       → Blob storage (OCI layers) — FREE 10GB, S3-compatible
├─ DNS      → A record → Lightsail static IP
├─ SSL/TLS  → Full Strict, auto-renew — FREE
└─ Security → DDoS, rate limiting, bot fight

AWS Lightsail ($5-10/mo)
├─ Ubuntu 24.04, 2 vCPU, 2-4 GB RAM
├─ Docker + docker-compose
├─ Nginx (reverse proxy, port 80)
├─ Backend API (Node 22 / Fastify, port 3000)
├─ PostgreSQL 16 (internal)
└─ Meilisearch 1.9 (internal)
```

### Cost Breakdown

| Service | Monthly Cost |
|---------|-------------|
| AWS Lightsail (2 vCPU / 2 GB) | **$5** |
| AWS Lightsail (2 vCPU / 4 GB) | $10 |
| Cloudflare Pages | **$0** |
| Cloudflare R2 (≤10 GB) | **$0** |
| Cloudflare DNS + SSL | **$0** |
| GitHub Actions (public repo) | **$0** |
| **Total** | **$5-10** |

### Deployment Paths

| Path | Complexity | Cost | Best For |
|------|-----------|------|----------|
| **Cloudflare Pages + Lightsail + R2** ⭐ | Low | **$5-10/mo** | **Dev / staging / early production** |
| Cloudflare Pages + EC2 + R2 | Low | ~$22-25/mo | Full AWS, slightly more RAM |
| ECS Fargate (managed) | Medium | ~$80-150/mo | Production auto-scaling (future) |

---

## Prerequisites

- [AWS account](https://aws.amazon.com)
- [Cloudflare account](https://dash.cloudflare.com) with `pekohub.org` domain
- [GitHub repository](https://github.com/ConekoAI/pekohub) with Actions enabled
- OAuth apps: [GitHub](https://github.com/settings/developers) + [Google](https://console.cloud.google.com/apis/credentials) (optional)

---

## Step 1: Configure OAuth Apps

### GitHub OAuth App

1. https://github.com/settings/developers → **New OAuth App**
2. Application name: `PekoHub`
3. Homepage URL: `https://pekohub.org`
4. Authorization callback URL: `https://pekohub.org/api/v1/auth/github/callback`
5. Save **Client ID** and **Client Secret**

### Google OAuth 2.0 (Optional)

1. https://console.cloud.google.com/apis/credentials
2. **Create Credentials** → **OAuth client ID** → **Web application**
3. Authorized redirect URIs: `https://pekohub.org/api/v1/auth/google/callback`
4. Save **Client ID** and **Client Secret**

> **Note:** Use `https://pekohub.org` for single-domain, or `https://app.pekohub.org` if using a subdomain for the frontend.

---

## Step 2: Cloudflare Infrastructure

### 2.1 R2 Blob Storage (Free Tier)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **R2**
2. **Create bucket**: `pekohub-blobs`
3. **Settings** → **CORS**: Allow `GET, PUT` from `https://pekohub.org`
4. **Manage R2 API Tokens** → **Create API Token**
   - Permissions: **Object Read & Write**
   - Bucket: `pekohub-blobs`
5. Save:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (from dashboard right sidebar)
   - **Jurisdiction-specific endpoint** (e.g. `https://ACCOUNT_ID.r2.cloudflarestorage.com`)

### 2.2 Pages (Frontend — Free)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Pages**
2. **Create a project** → Connect to Git → Select `ConekoAI/pekohub`
3. **Build settings**:
   - Framework preset: **None**
   - Build command: `npm install -g pnpm && pnpm install && pnpm --filter @pekohub/shared build && pnpm --filter @pekohub/frontend build`
   - Build output directory: `frontend/dist`
   - Root directory: `/`
4. **Environment variables**:
   - `VITE_API_BASE_URL`: `https://pekohub.org`
   - `NODE_VERSION`: `22`
5. **Save and Deploy**

6. **Custom domain** (optional but recommended):
   - Pages project → **Custom domains** → Add `app.pekohub.org`
   - Or use the default `pekohub.pages.dev` for now

> **Alternative:** The GitHub Actions workflow (`.github/workflows/deploy-frontend.yml`) can deploy to Pages instead of direct Git integration. Use whichever you prefer.

---

## Step 3: AWS Lightsail Setup

### 3.1 Create Instance

1. Go to [AWS Lightsail Console](https://lightsail.aws.amazon.com)
2. **Create instance**
   - Platform: Linux/Unix
   - OS: **Ubuntu 24.04 LTS**
   - Plan: **$5/mo** (2 vCPU, 2 GB RAM, 80 GB SSD)
     - Upgrade to $10/mo if you hit memory limits later
3. **Attach a Static IP** (free, never changes)
   - Networking → Create static IP → Attach to instance
   - **Save this IP** for DNS and GitHub Secrets
4. **Open firewall ports**
   - Networking → IPv4 Firewall → Add rules:
     - HTTP (80) — from anywhere
     - HTTPS (443) — optional (Cloudflare handles SSL)
5. **Download SSH key** or use your own key pair

### 3.2 Run Setup Script

> **Optional since the deploy workflow is now self-bootstrapping.**
> The deploy workflow (`infra/lightsail/deploy.sh`, called from
> `.github/workflows/deploy-lightsail.yml`) will install Docker,
> Node.js, pnpm, swap, and the backup cron on the first run if
> they're missing — every step is guarded so it's safe to re-run.
>
> You only need to run `setup-instance.sh` manually if you want to
> prep the instance ahead of time, or if you're SSH-debugging a
> failed deploy.

SSH into your instance and run the one-time setup:

```bash
ssh -i ~/.ssh/lightsail-key.pem ubuntu@YOUR_STATIC_IP

curl -fsSL https://raw.githubusercontent.com/ConekoAI/pekohub/master/infra/lightsail/setup-instance.sh | bash

# Log out and back in (or run 'newgrp docker') for docker permissions
exit
ssh -i ~/.ssh/lightsail-key.pem ubuntu@YOUR_STATIC_IP
```

This installs Docker, Node.js, pnpm, adds swap (prevents OOM), and sets up automated database backups. The script is idempotent — re-running it is safe.

### 3.3 Clone Repo

> **Also optional.** The deploy workflow will clone the repo on
> the first run if `$HOME/pekohub/.git` doesn't exist. The manual
> `git clone` below is only needed if you want to inspect the
> code on the host before triggering a deploy.

```bash
cd ~ && git clone https://github.com/ConekoAI/pekohub.git
cd pekohub
```

---

## Step 4: Cloudflare DNS

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain
2. **DNS → Records**
   - **A record**: `pekohub.org` → `YOUR_LIGHTSAIL_STATIC_IP`
   - **A record**: `www` → `YOUR_LIGHTSAIL_STATIC_IP` (optional)
   - **CNAME**: `app` → `pekohub.pages.dev` (if using Pages custom domain)
3. **Proxy status**: Toggle to 🟠 **Proxied** (orange cloud)

### SSL/TLS

1. **SSL/TLS → Overview**
   - Encryption mode: **Full (strict)**
2. **SSL/TLS → Edge Certificates**
   - Always Use HTTPS: **On**
   - TLS 1.3: **On**
   - Automatic HTTPS Rewrites: **On**

### Page Rules (Free Tier: 3 Rules)

1. **Rules → Page Rules**
   - `pekohub.org/api/*` → Cache Level: **Bypass**
   - `pekohub.org/v2/*` → Cache Level: **Bypass**
   - `pekohub.org/docs` → Cache Level: **Bypass**

### Security

1. **Security → Settings**
   - Security Level: **Medium**
   - Bot Fight Mode: **On**

---

## Step 5: GitHub Secrets

Go to [Repository Settings → Secrets](https://github.com/ConekoAI/pekohub/settings/secrets/actions)

Add these **Repository secrets**:

| Secret | Value | How to Get |
|--------|-------|------------|
| `LIGHTSAIL_HOST` | Your static IP | Lightsail console |
| `LIGHTSAIL_USER` | `ubuntu` | Default for Ubuntu |
| `LIGHTSAIL_SSH_KEY` | Private key contents | `cat ~/.ssh/lightsail-key.pem` |
| `REGISTRY_BASE_URL` | `https://pekohub.org` | Your domain |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | GitHub Developer Settings |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | GitHub Developer Settings |
| `GOOGLE_CLIENT_ID` | (optional) | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | (optional) | Google Cloud Console |
| `JWT_SECRET` | Random 64-char string | `openssl rand -base64 48` |
| `POSTGRES_PASSWORD` | Strong password | Generate and save securely |
| `MEILISEARCH_API_KEY` | Meilisearch master key | Generate and save securely |
| `R2_ACCOUNT_ID` | Cloudflare Account ID | Cloudflare dashboard |
| `R2_ACCESS_KEY_ID` | R2 API token access key | R2 API Tokens page |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | R2 API Tokens page |
| `R2_BUCKET` | `pekohub-blobs` | Your bucket name |
| `R2_ENDPOINT` | `https://ACCOUNT_ID.r2.cloudflarestorage.com` | R2 bucket settings |

Optional (for Cloudflare Pages via Actions instead of direct Git):

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | With `Cloudflare Pages:Edit` permission |
| `CLOUDFLARE_ACCOUNT_ID` | From Cloudflare dashboard |
| `CLOUDFLARE_PROJECT_NAME` | `pekohub` |

---

## Step 6: First Deploy

### 6.1 Update Backend for R2

The backend currently uses S3/MinIO. For R2, update the storage config or set these environment variables (the S3 SDK is compatible with R2):

```bash
# In your Lightsail .env or GitHub Secrets:
S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY=your-r2-access-key
S3_SECRET_KEY=your-r2-secret-key
S3_BUCKET=pekohub-blobs
S3_FORCE_PATH_STYLE=false
```

> The existing `@aws-sdk/client-s3` code works with R2 out of the box. No code changes needed.

### 6.2 Trigger Deploy

> **Opt-in via `[lightsail]` keyword.** The deploy workflow is
> **skipped on everyday pushes**. To trigger a deploy, include
> the literal string `[lightsail]` (square brackets included)
> anywhere in the **headline commit message** — the commit at
> `HEAD` on the runner. Everyday commits that touch backend code
> run `ci.yml` (typecheck + tests) but do **not** touch Lightsail.
>
> ```bash
> # Real change that should deploy
> git commit -m "feat(api): add bundle stats endpoint [lightsail]"
>
> # Trigger-only / empty commit
> git commit --allow-empty -m "chore: redeploy [lightsail]"
>
> # PR merge — add [lightsail] to the merge / squash message
> # in the GitHub UI before clicking Merge
> ```
>
> Forgetting the keyword is **not** a failure — the deploy step
> is skipped with a clear notice in the Actions log, and the run
> is marked green. Add `[lightsail]` and push again (or re-run
> the failed/skipped job from the Actions UI after editing the
> message via `git commit --amend`).

Push to `master`:

```bash
git commit --allow-empty -m "trigger deploy [lightsail]"
git push origin master
```

GitHub Actions will:
1. Run tests (typecheck, unit tests) — see `ci.yml`
2. **Check the headline commit message for `[lightsail]`.** If absent, the deploy job is skipped (not failed).
3. SSH into Lightsail
4. Pull latest code (`git fetch && git reset --hard origin/master`)
5. Run `bash infra/lightsail/deploy.sh`, which:
   - Bootstraps the host (installs Docker/Node/pnpm/swap/backup-cron if missing — no-op otherwise)
   - Writes `.env` from secrets (`chmod 600`)
   - Pulls base images and brings up the stack with healthcheck-gated ordering
   - Runs `drizzle-kit migrate` (idempotent via `__drizzle_migrations`)
   - Waits for `/health` to return 200 (90s deadline)
   - Prunes old images
6. Verify the public endpoint

The deploy script is fully idempotent — re-running it on a fresh
instance, a running instance, or after a partial failure will
converge to the same healthy state. If the DB is in a bad state
and you need to rebuild from scratch, set
`FRESH_DB_VOLUME_RECREATE=1` in the `envs:` block of the workflow
— the script will drop and recreate the db volume before bring-up.

### 6.2.1 Manual deploy via Actions UI

You can also trigger a deploy without making a commit — useful for
one-off reruns or for re-deploying after a keyword mistake:

1. Go to **Actions → Deploy Backend to Lightsail**.
2. Click **Run workflow** → choose `master` → **Run workflow**.

(The `on: push` trigger gates the `paths:` filter, so this UI
entry point runs unconditionally, which is the whole point.)

### 6.3 Verify

```bash
# Backend health
curl https://pekohub.org/health

# API docs
curl https://pekohub.org/docs

# OCI catalog
curl https://pekohub.org/v2/_catalog

# Search
curl "https://pekohub.org/api/v1/search?q=test"
```

Visit your frontend URL:
- `https://pekohub.pages.dev` (default)
- or `https://app.pekohub.org` (if custom domain configured)

---

## Step 7: Instance Management

### SSH Access

```bash
ssh -i ~/.ssh/lightsail-key.pem ubuntu@YOUR_STATIC_IP
```

### Logs

```bash
# All services
docker compose -f docker-compose.lightsail.yml logs -f

# Specific service
docker compose -f docker-compose.lightsail.yml logs -f backend
docker compose -f docker-compose.lightsail.yml logs -f db
```

### Restart / Update

```bash
cd ~/pekohub

# Restart a service
docker compose -f docker-compose.lightsail.yml restart backend

# Pull latest and rebuild
git pull
docker compose -f docker-compose.lightsail.yml up -d --build

# Database shell
docker compose -f docker-compose.lightsail.yml exec db psql -U pekohub -d pekohub

# Manual migration
docker compose -f docker-compose.lightsail.yml exec backend npx drizzle-kit migrate
```

### Backups

Automated daily backups are configured by `setup-instance.sh`:

```bash
# Backups stored in ~/backups/
ls ~/backups/

# Manual backup
docker exec pekohub-db pg_dump -U pekohub pekohub > ~/backups/pekohub-manual.sql
```

### Upgrade Instance

1. Create snapshot in Lightsail console
2. Create new instance from snapshot with larger plan
3. Detach static IP from old, attach to new
4. Old instance remains as rollback option

---

## CI/CD: GitHub Actions Workflows

### What Runs on Every Push

| Workflow | Trigger | What It Does |
|----------|---------|-------------|
| `ci.yml` | Every PR + push | Test, typecheck, lint |
| `deploy-lightsail.yml` | Push to `master` (backend changes) | Test → SSH deploy → health check |
| `deploy-frontend.yml` | Push to `master` (frontend changes) | Build → deploy to Cloudflare Pages |

### Should You Care About CI/CD Now?

**Yes, absolutely.** Here's why:

| Without CI/CD | With CI/CD |
|---------------|-----------|
| SSH into server, run commands manually | Push to git, everything deploys automatically |
| Easy to forget steps, deploy broken code | Tests must pass before deploy |
| No rollback if deploy breaks | Previous Docker image is cached, instant rollback |
| Team members need server access | Anyone with git access can deploy |
| ~30 min per deploy | ~5 min per deploy, zero manual work |

**For a public registry, CI/CD is not optional.** You need:
- Tests passing before deploy
- Automated deploys so you can iterate fast
- Health checks to catch failures
- The ability to roll back

The workflows I've set up are **minimal but complete**:
- They run your existing test suite (59 tests passing)
- They deploy only on `master` pushes
- They verify health before marking deploy as successful
- They cost **$0** (GitHub Actions is free for public repos)

### Workflow Files

| File | Purpose |
|------|---------|
| `.github/workflows/deploy-lightsail.yml` | Backend deploy to Lightsail |
| `.github/workflows/deploy-frontend.yml` | Frontend deploy to Cloudflare Pages |
| `.github/workflows/deploy.yml` | ECS Fargate deploy (future use) |
| `.github/workflows/deploy-ec2.yml` | EC2 deploy (alternative path) |

**Recommendation:** Keep `deploy-lightsail.yml` and `deploy-frontend.yml`. The ECS/EC2 workflows are there for when you migrate later — they won't run unless triggered.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `Connection refused` on `/health` | Backend not started | Check `docker compose logs backend` |
| `502 Bad Gateway` | Nginx can't reach backend | Verify backend container is running: `docker ps` |
| OAuth callback fails | URL mismatch | Verify callback URL exactly matches GitHub/Google settings |
| Search returns empty | Meilisearch not indexed | Push a bundle — auto-index triggers on manifest PUT |
| Database connection error | Wrong password in `.env` | Re-run deploy to rewrite `.env` from secrets |
| Out of memory | $5 plan too small | Upgrade to $10 plan or add swap (already done by setup script) |
| R2 upload fails | Wrong credentials | Verify `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` |
| Frontend shows old version | Cloudflare cache | Purge cache from Cloudflare dashboard or wait 5 min |

---

## Migration Path to Production

When you're ready to scale:

| Current | Migrate To | When |
|---------|-----------|------|
| Lightsail $5 | Lightsail $10 or EC2 t3.medium | > 500 MAU |
| Self-hosted Postgres | RDS PostgreSQL | Need automated backups / HA |
| Cloudflare R2 | S3 (if leaving Cloudflare ecosystem) | Rarely needed — R2 scales well |
| Self-hosted Meilisearch | Meilisearch Cloud | Need managed search |
| Single Lightsail instance | ECS Fargate + ALB | Need auto-scaling, multi-AZ |

Everything runs in Docker. Migration = move containers, not rewrite code.

---

## Quick Reference

```bash
# SSH
ssh -i lightsail-key.pem ubuntu@YOUR_IP

# Logs
docker compose -f docker-compose.lightsail.yml logs -f

# Restart
docker compose -f docker-compose.lightsail.yml restart

# Update
cd ~/pekohub && git pull && docker compose -f docker-compose.lightsail.yml up -d --build

# Database shell
docker compose -f docker-compose.lightsail.yml exec db psql -U pekohub -d pekohub

# Manual migration
docker compose -f docker-compose.lightsail.yml exec backend npx drizzle-kit migrate

# Backup
docker exec pekohub-db pg_dump -U pekohub pekohub > ~/backups/pekohub-$(date +%Y%m%d).sql
```
