# PekoHub Deployment Guide: Lightsail + Cloudflare Pages

> **Cost: ~$5-10/month** | **Setup time: ~30 minutes** | **Best for: dev/staging/early production**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare (pekohub.org)                                   │
│  ├── DNS A record → Lightsail Static IP                     │
│  ├── SSL/TLS (Full Strict) — free                           │
│  ├── Page Rules: cache static assets                        │
│  └── DDoS protection + rate limiting                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│  AWS Lightsail Instance ($5-10/mo)                          │
│  Ubuntu 24.04 LTS | 2 vCPU | 2-4 GB RAM | 80 GB SSD        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Docker + docker-compose                            │   │
│  │  ├── Nginx (reverse proxy, port 80)                 │   │
│  │  ├── Backend API (Node 22 / Fastify, port 3000)     │   │
│  │  ├── PostgreSQL 16 (port 5432, internal)            │   │
│  │  ├── Meilisearch 1.9 (port 7700, internal)          │   │
│  │  └── MinIO (S3-compatible blobs, port 9000, int.)   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Pages (FREE)                                    │
│  ├── Frontend SPA (React + Vite)                            │
│  ├── Auto-deploy on every git push                          │
│  └── Global edge CDN (200+ locations)                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Why This Architecture?

| Component | Choice | Reason |
|-----------|--------|--------|
| **Compute** | Lightsail $5-10/mo | Predictable pricing, enough for staging + early prod |
| **Frontend hosting** | Cloudflare Pages | **Free**, auto-deploy, global CDN, handles SPA routing |
| **SSL** | Cloudflare | **Free**, auto-renew, no certbot needed |
| **Database** | Self-hosted Postgres | Included in Lightsail cost, no RDS fees |
| **Search** | Self-hosted Meilisearch | Included in Lightsail cost |
| **Blob storage** | Self-hosted MinIO | Included in Lightsail cost, S3-compatible |
| **CI/CD** | GitHub Actions | Free for public repos, 2000 minutes/mo |

**Total monthly cost: $5-10** (Lightsail only). Everything else is free tier.

---

## Step 1: Create Lightsail Instance

1. Go to [AWS Lightsail Console](https://lightsail.aws.amazon.com)
2. **Create instance**
   - Platform: Linux/Unix
   - OS: Ubuntu 24.04 LTS
   - Plan: **$5/mo** (2 vCPU, 2 GB RAM, 80 GB SSD) — sufficient for staging
     - Upgrade to $10/mo (2 vCPU, 4 GB RAM) if you hit memory limits
3. **Attach a Static IP** (free, never changes)
   - Networking → Create static IP → Attach to instance
   - **Save this IP** — you'll need it for DNS and GitHub Secrets
4. **Open firewall ports**
   - Networking → IPv4 Firewall
   - Add rules:
     - SSH (22) — already open
     - HTTP (80) — from anywhere
     - HTTPS (443) — optional, Cloudflare handles SSL
5. **Download SSH key** or use your own key pair

---

## Step 2: Install Docker on Lightsail

SSH into your instance and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
sudo apt install -y docker.io docker-compose-plugin

# Add user to docker group (logout/login required after)
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

---

## Step 3: Configure Cloudflare

### 3.1 DNS Records

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain
2. **DNS → Records**
   - Add **A record**: `pekohub.org` → `YOUR_LIGHTSAIL_STATIC_IP`
   - Add **A record**: `www` → `YOUR_LIGHTSAIL_STATIC_IP` (optional)
   - Add **A record**: `api.pekohub.org` → `YOUR_LIGHTSAIL_STATIC_IP` (optional, for future use)
3. **Proxy status**: 🟡 DNS only (gray cloud) during setup, then toggle to 🟠 Proxied (orange cloud)

### 3.2 SSL/TLS

1. **SSL/TLS → Overview**
   - Encryption mode: **Full (strict)**
2. **SSL/TLS → Edge Certificates**
   - Always Use HTTPS: **On**
   - TLS 1.3: **On**
   - Automatic HTTPS Rewrites: **On**

### 3.3 Page Rules (free tier: 3 rules)

1. **Rules → Page Rules**
   - Rule 1: `pekohub.org/api/*` → Cache Level: **Bypass**
   - Rule 2: `pekohub.org/v2/*` → Cache Level: **Bypass**
   - Rule 3: `pekohub.org/docs` → Cache Level: **Bypass**

### 3.4 Security

1. **Security → Settings**
   - Security Level: **Medium**
   - Bot Fight Mode: **On**

---

## Step 4: Set Up Cloudflare Pages (Frontend)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Pages**
2. **Create a project**
   - Connect to Git → Authorize GitHub → Select `ConekoAI/pekohub`
3. **Build settings**
   - Framework preset: **None**
   - Build command: `npm install -g pnpm && pnpm install && pnpm --filter @pekohub/shared build && pnpm --filter @pekohub/frontend build`
   - Build output directory: `frontend/dist`
   - Root directory: `/` (repo root)
4. **Environment variables**
   - `VITE_API_BASE_URL`: `https://pekohub.org`
5. **Save and Deploy**

> **Note:** The GitHub Actions workflow (`.github/workflows/deploy-frontend.yml`) is an alternative to the direct Git integration. Use whichever you prefer.

### Custom Domain for Pages

1. In Pages project → **Custom domains**
2. Add `app.pekohub.org` or keep the default `pekohub.pages.dev`
3. For now, we use the main domain `pekohub.org` → Lightsail, and Pages serves via `pekohub.pages.dev` or a subdomain

**Alternative:** You can serve the frontend from the same domain by:
- Using Cloudflare Workers to route `/api/*` and `/v2/*` to Lightsail, everything else to Pages
- Or: Use a subdomain like `app.pekohub.org` for the frontend

For simplicity, this guide uses:
- `pekohub.org` → Lightsail (backend API + docs)
- `app.pekohub.org` → Cloudflare Pages (frontend)

Update `REGISTRY_BASE_URL` and OAuth callbacks to match.

---

## Step 5: Configure OAuth Apps

### GitHub OAuth

1. https://github.com/settings/developers → **New OAuth App**
2. Application name: `PekoHub`
3. Homepage URL: `https://pekohub.org` (or your frontend URL)
4. Authorization callback URL: `https://pekohub.org/api/v1/auth/github/callback`
5. Save **Client ID** and **Client Secret**

### Google OAuth (optional)

1. https://console.cloud.google.com/apis/credentials
2. **Create Credentials** → **OAuth client ID** → **Web application**
3. Authorized redirect URIs: `https://pekohub.org/api/v1/auth/google/callback`
4. Save **Client ID** and **Client Secret**

---

## Step 6: Add GitHub Secrets

Go to https://github.com/ConekoAI/pekohub/settings/secrets/actions

Add these **Repository secrets**:

| Secret | Value | How to get |
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
| `POSTGRES_PASSWORD` | Strong password | Generate and save |
| `S3_SECRET_KEY` | MinIO root password | Generate and save |
| `MEILISEARCH_API_KEY` | Meilisearch master key | Generate and save |

Optional (for Cloudflare Pages via Actions):

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with `Cloudflare Pages:Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | From Cloudflare dashboard right sidebar |
| `CLOUDFLARE_PROJECT_NAME` | `pekohub` |

---

## Step 7: First Deploy

### 7.1 Trigger Backend Deploy

Push any change to `master`, or manually trigger:

```bash
git commit --allow-empty -m "trigger deploy"
git push origin master
```

GitHub Actions will:
1. Run tests
2. SSH into Lightsail
3. Pull latest code
4. Write `.env` file
5. Build and restart Docker containers
6. Run database migrations
7. Health check

### 7.2 Verify Backend

```bash
# From your local machine
curl https://pekohub.org/health
curl https://pekohub.org/docs
curl https://pekohub.org/v2/_catalog
```

### 7.3 Verify Frontend

Visit your Cloudflare Pages URL (e.g. `https://pekohub.pages.dev` or `https://app.pekohub.org`)

---

## Step 8: Lightsail Instance Management

### SSH Access

```bash
ssh -i ~/.ssh/lightsail-key.pem ubuntu@YOUR_STATIC_IP
```

### View Logs

```bash
# All services
docker compose -f docker-compose.lightsail.yml logs -f

# Specific service
docker compose -f docker-compose.lightsail.yml logs -f backend
docker compose -f docker-compose.lightsail.yml logs -f db
```

### Restart Services

```bash
cd ~/pekohub
docker compose -f docker-compose.lightsail.yml restart backend
```

### Database Migrations (manual)

```bash
cd ~/pekohub
docker compose -f docker-compose.lightsail.yml exec backend npx drizzle-kit migrate
```

### Backup Database

```bash
# Automated daily backup via cron (add to crontab)
0 3 * * * docker exec pekohub-db pg_dump -U pekohub pekohub > /home/ubuntu/backups/pekohub-$(date +\%Y\%m\%d).sql
```

### Upgrade Instance

1. Create snapshot in Lightsail console
2. Create new instance from snapshot with larger plan
3. Detach static IP from old, attach to new
4. Old instance is untouched as rollback option

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `Connection refused` on `/health` | Backend not started | Check `docker compose logs backend` |
| `502 Bad Gateway` | Nginx can't reach backend | Verify backend container is running |
| OAuth callback fails | URL mismatch | Verify callback URL exactly matches GitHub/Google settings |
| Search returns empty | Meilisearch not indexed | Push a bundle — auto-index triggers on manifest PUT |
| Database connection error | Wrong password in `.env` | Re-run deploy to rewrite `.env` |
| Out of memory | $5 plan too small | Upgrade to $10 plan or add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |

---

## Cost Breakdown

| Service | Monthly Cost |
|---------|-------------|
| Lightsail (2 vCPU / 2 GB) | **$5** |
| Lightsail (2 vCPU / 4 GB) | $10 |
| Cloudflare Pages | **$0** |
| Cloudflare DNS + SSL | **$0** |
| GitHub Actions (public repo) | **$0** |
| **Total** | **$5-10** |

---

## Migration Path to Production

When you're ready to scale:

| Current | Migration Target | When |
|---------|-----------------|------|
| Lightsail $5 | Lightsail $10 or EC2 t3.medium | > 500 MAU |
| Self-hosted Postgres | RDS PostgreSQL | Need automated backups / HA |
| Self-hosted MinIO | S3 or R2 | > 100 GB storage |
| Self-hosted Meilisearch | Meilisearch Cloud | Need managed search |
| Single instance | ECS Fargate + ALB | Need auto-scaling |

The beauty of this setup: **everything is in Docker**. Migration means moving containers, not rewriting code.

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
```
