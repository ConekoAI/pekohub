# PekoHub Deployment Guide

> **Today:** the website on Cloudflare Pages, the API on one Lightsail box (Postgres in Docker
> beside it, backups on the same disk), staging on Fly.io + Neon.
> **For launch:** move the production API to the staging shape — Fly.io + Neon with
> point-in-time restore, plus a nightly encrypted dump to R2 —
> [Production: Fly.io + Neon](#production-flyio--neon-proposed). Then
> [Error tracking](#error-tracking), [Health and alerts](#health-and-alerts), and
> [Backups and the restore drill](#backups-and-the-restore-drill). Steps 1–7 below describe the
> Lightsail setup that runs until the move.

---

## Overview

This guide covers deploying PekoHub using **Cloudflare** (DNS, SSL, CDN, frontend hosting, blob storage) and **AWS Lightsail** (backend compute, database, search).

### Architecture

```
Cloudflare (pekohub.ai)
├─ Pages    → Website on pekohub.ai (React/Vite) — FREE, auto-deploy, global CDN
├─ R2       → Blob storage (OCI layers) — FREE 10GB, S3-compatible
├─ DNS      → api.pekohub.ai A record → Lightsail static IP
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

## Hostnames

PekoHub has two origins:

| Hostname | Serves | Hosted on |
|----------|--------|-----------|
| `pekohub.ai` | The website: directory, peko and seed pages, sign-in consent (`/authorize`, `/device`) | Cloudflare Pages |
| `api.pekohub.ai` | The backend: REST (`/v1/*`), OAuth (`/oauth/*`), the runtime tunnel (`wss://api.pekohub.ai/v1/tunnel`), JWKS, `/health`; `/metrics` with `METRICS_TOKEN`, `/docs` with `API_DOCS=true` | Lightsail (nginx → Fastify); Fly.io after the move |
| `pekohub.org` | 301 redirect to `pekohub.ai` (legacy) | Cloudflare redirect rule |

Clients discover both from `GET https://api.pekohub.ai/v1/meta`
(`{ apiOrigin, webOrigin, tunnelUrl }`). Runtimes and the desktop default to `api.pekohub.ai`;
runtimes registered against `pekohub.org` or `pekohub.ai` are migrated to it.

Backend environment for these hosts:

- `PUBLIC_ORIGIN=https://api.pekohub.ai`: the API origin. Runtimes derive the bridge-token
  issuer and `{origin}/v1/jwks.json` from their tunnel URL (scheme swapped to `https`), so a
  mismatch fails every hub-proxied chat at the runtime.
- `REGISTRY_BASE_URL=https://api.pekohub.ai`: the base for GitHub/Google OAuth callbacks.
- `FRONTEND_URL=https://pekohub.ai`: the website. Share links, the OAuth consent page, and the
  device page are built from it, and it is the CORS origin allowed with credentials.
- Pages build: `VITE_API_BASE_URL=https://api.pekohub.ai`.
- Pages Functions (`functions/`, deployed with the site): `/@<owner>` (a person),
  `/@<owner>/<name>` (a peko) and `/<owner>/<name>` (a seed) get their own title,
  description, OpenGraph and Twitter tags for link previews, looked up on the API. Pages
  routes every two-segment path, `/@…` included, to `functions/[owner]/[name].ts`, so
  `frontend/public/_routes.json` keeps `/assets/*` off Functions, and
  `frontend/public/_redirects` 301s the old `/peko/…`, `/p/…` and `/seeds/…` links. Optional Pages env var `PEKOHUB_API` (default
  `https://api.pekohub.ai`). When the API is down they serve the page unchanged.

`pekohub.ai` and `api.pekohub.ai` are the same site (`pekohub.ai`), so the website's
`SameSite=Lax` refresh cookie set by the API is sent on its credentialed requests.

## Staging: Fly.io + Neon (scale to zero)

Staging runs the API alone, sized to cost nothing while idle:

| Piece | Where | Idle cost |
|-------|-------|-----------|
| API + tunnel relay | Fly.io `pekohub-staging` (`fly.staging.toml`): one `shared-cpu-1x` / 256 MB machine that stops when nothing is connected and starts on the next request | ~$0 (a stopped machine bills only its image storage) |
| Postgres | Neon free tier (scales to zero after 5 minutes idle) | $0 |
| Search | Postgres (`MEILISEARCH_URL` unset) | — |
| Quotas, rate limits | In memory (`REDIS_URL` unset); fine on one machine | — |
| Blob storage | None (`S3_*` unset); seeds are text in Postgres | — |

A connected runtime's tunnel keeps the machine running, so it is idle only when no runtime
is connected. Keep exactly one machine: the relay holds runtime connections in process.

```bash
fly apps create pekohub-staging
fly secrets set -c fly.staging.toml \
  DATABASE_URL='<Neon pooled connection string>' \
  MIGRATION_DATABASE_URL='<Neon direct connection string>' \
  JWT_SECRET="$(openssl rand -hex 32)"
fly deploy -c fly.staging.toml --ha=false   # runs migrations as the release command
curl https://pekohub-staging.fly.dev/health
```

`.github/workflows/deploy-staging.yml` redeploys both after CI passes on `master` (or on
`gh workflow run deploy-staging.yml --ref master`), using the repo secrets `FLY_API_TOKEN`,
`CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`; a job whose
secret is missing is skipped. The commands below are the same steps by hand.

The staging website is its own Pages project, `pekohub-staging`
(`https://pekohub-staging.pages.dev`), uploaded directly rather than built from Git.
Production builds bake in `api.pekohub.ai`, and the API allows one website origin
(`FRONTEND_URL`), so staging needs a stable address of its own. Its Functions read
`PEKOHUB_API` (a Pages secret, set to the staging API). To update it from the repo root:

```bash
pnpm --filter @pekohub/shared build
(cd frontend && VITE_API_BASE_URL=https://pekohub-staging.fly.dev ./node_modules/.bin/vite build --outDir /tmp/pekohub-staging-dist --emptyOutDir)
npx wrangler pages deploy /tmp/pekohub-staging-dist --project-name pekohub-staging --branch main
```

Sign-in needs a GitHub OAuth app for staging (callback
`https://pekohub-staging.fly.dev/v1/auth/github/callback`), set with
`fly secrets set -c fly.staging.toml GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=…`; until then
the sign-in routes don't exist.

Point a runtime at it with `peko runtime register --hub https://pekohub-staging.fly.dev`
(or the desktop's hub setting). The first request after an idle spell waits a second or two
for the machine, and Neon's first query after its own idle spell adds about half a second.

---

## Production: Fly.io + Neon (proposed)

Production today is one Lightsail box: Postgres runs in Docker next to the API, and the daily
`pg_dump` lands in `~/backups` on the same disk, so losing the box loses the backups too.
Nothing restores to a point in time, and no restore has been tried. The proposal is to give
production the shape staging already runs (`fly.staging.toml`), with production settings
(`fly.production.toml`):

| Piece | Where | Notes |
|-------|-------|-------|
| API + tunnel relay | Fly.io app `pekohub`: one `shared-cpu-1x` / 512 MB machine that never stops | `min_machines_running = 1`; Fly checks `/health` every 30 s and holds a deploy until it passes |
| Postgres | Neon, paid plan, `aws-us-east-1` (next to Fly's `iad`) | Point-in-time restore over the plan's history window (choose 7 days or more); scale-to-zero off |
| Second copy | Cloudflare R2 bucket `pekohub-backups`, nightly, age-encrypted | `.github/workflows/backup-production.yml`; survives losing the Neon project or account |
| Search, quotas, blobs | As staging: Postgres search, in-memory quotas, no blob storage | Meilisearch and R2 blobs drop out with the box |
| Website | Unchanged (Cloudflare Pages) | |

Keep exactly one machine: the relay holds runtime connections in process, so a second
machine would split them (multi-node relay is gap map B1). `--ha=false` on every deploy stops
Fly from adding a standby. A deploy replaces the machine; connected runtimes reconnect within
seconds.

Neon's free plan keeps only hours of history and suspends after five idle minutes. Pick a paid
plan whose restore window is at least 7 days, set the window in the project settings, and turn
off scale-to-zero for the production branch (the 30-second health check would keep it awake
anyway).

### The move (manual; each step creates or changes cloud resources)

The production API is off during the dev stage, so there is no live traffic to drain. Run
these when launching:

1. **Neon** — create the project `pekohub-production` (Postgres 17, `aws-us-east-1`) on a paid
   plan; set the restore window; turn off scale-to-zero. Note the pooled and the direct
   connection strings. For backups, add a read-only role:
   ```sql
   CREATE ROLE backup LOGIN PASSWORD '…';
   GRANT pg_read_all_data TO backup;
   ```
2. **Data from Lightsail** (only if the old database holds anything worth keeping) — on the box,
   `docker exec pekohub-db pg_dump -U pekohub --format=custom --no-owner --no-privileges pekohub > pekohub.dump`,
   copy it off, and `pg_restore --no-owner --no-privileges --dbname="<Neon direct URL>" pekohub.dump`
   into the empty database. The dump carries `drizzle.__drizzle_migrations`, so the first
   deploy applies only newer migrations.
3. **Fly** —
   ```bash
   fly apps create pekohub
   fly secrets set -c fly.production.toml \
     DATABASE_URL='<Neon pooled connection string>' \
     MIGRATION_DATABASE_URL='<Neon direct connection string>' \
     JWT_SECRET='<the Lightsail value, or a new one: openssl rand -hex 32>' \
     GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… \
     SENTRY_DSN='<backend DSN>' METRICS_TOKEN="$(openssl rand -hex 32)"
   fly deploy -c fly.production.toml --ha=false --env SENTRY_RELEASE="$(git rev-parse HEAD)"
   node scripts/probe-uptime.mjs https://pekohub.fly.dev
   ```
   A new `JWT_SECRET` signs everyone out and changes the bridge-token key runtimes fetch from
   `/v1/jwks.json`; keeping the old one avoids both.
4. **Hostname** — `fly certs add api.pekohub.ai -c fly.production.toml` and add the records it
   prints in Cloudflare DNS. With the orange-cloud proxy on, the `_acme-challenge` CNAME is what
   validates the certificate. Then replace the `api` A record with a proxied CNAME to
   `pekohub.fly.dev`; SSL/TLS stays **Full (strict)**. Runtimes keep
   `wss://api.pekohub.ai/v1/tunnel`; the GitHub/Google OAuth callbacks don't change.
5. **Check** — `node scripts/probe-uptime.mjs https://api.pekohub.ai`, sign in on the website,
   connect a runtime.
6. **Retire Lightsail** — `docker compose -f docker-compose.lightsail.yml down` on the box and
   stop the instance (a stopped instance is the rollback: start it and point the A record
   back). After a week, take a final snapshot, delete the instance and release the static IP.
   `deploy-lightsail.yml` then has nothing to deploy to; delete it, or leave it (it deploys
   only on `[lightsail]` or a manual run).
7. **Backups and monitoring** — the sections below.

Later deploys: `fly deploy -c fly.production.toml --ha=false --env SENTRY_RELEASE="$(git rev-parse HEAD)"`
(a workflow like `deploy-staging.yml` can run it once launch settles).

**Rollback:** `fly releases -c fly.production.toml` lists releases; redeploy an earlier image
with `fly deploy -c fly.production.toml --ha=false --image <image ref from the list>`. A
migration that must be undone is a Neon point-in-time restore (below).

---

## Error tracking

Sentry, off unless configured. Make two projects in one Sentry organization: a Node.js one for
the API and a Browser JavaScript one for the website. Each has its own DSN.

**API** (`backend/src/services/error-reporting.ts`) — set `SENTRY_DSN` (a Fly secret, or in the
Lightsail `.env`). Optional: `SENTRY_ENVIRONMENT` (`fly.*.toml` sets `staging` / `production`)
and `SENTRY_RELEASE` (the deploy commands above pass the commit). It reports:

- requests that end in a 5xx (method, route pattern and status; never the URL, whose query
  can hold an OAuth code),
- tunnel faults: a handshake that fails for a reason other than a refused runtime, a message
  the hub fails to handle, a group registration error, failing to mark a runtime offline,
- scheduled-job failures, and uncaught exceptions / unhandled rejections (the process still
  exits on those, as before, after the report is sent).

The SDK loads only when `SENTRY_DSN` is set and runs with a short integration list: no request
data, headers, cookies, local variables or HTTP breadcrumbs.

**Website** (`frontend/src/lib/error-reporting.ts`) — set `VITE_SENTRY_DSN` as a Cloudflare
Pages environment variable. The build bakes it into the page, and the Pages middleware reads
the same variable to add the DSN's host to the CSP `connect-src`; set only one of the two and
reports are dropped (no DSN baked in) or blocked (CSP). Optional `VITE_SENTRY_ENVIRONMENT`
and `VITE_SENTRY_RELEASE`. The SDK is a separate ~33 KB (gzipped) chunk fetched only when the
DSN is set. It reports uncaught errors and errors a route shows instead of its page (API 4xx
answers excluded), with query strings stripped from every URL.

For staging, set the repository variable `STAGING_WEB_SENTRY_DSN` (read by
`deploy-staging.yml`'s build) and the same value as `VITE_SENTRY_DSN` on the
`pekohub-staging` Pages project.

Source maps: the website build emits them (`frontend/dist/assets/*.map`) and serves them
publicly. Uploading them to Sentry (`sentry-cli sourcemaps upload`) for readable stacks is
optional.

**Alerts** — in each Sentry project, an alert rule for a new issue and one for a spike (for
example more than 20 events in 5 minutes), sent to email or Slack.

---

## Health and alerts

- `GET /health` — `200 {"status":"ok","version":"0.1.0","database":"ok"}` when the API answers
  and `select 1` returns within 5 s; `503 {"status":"error",…,"database":"unreachable"}`
  otherwise. Unauthenticated and under the global rate limit.
- `GET /metrics` — the relay counters (`services/metrics.ts`) as JSON, only with
  `Authorization: Bearer $METRICS_TOKEN`. Without `METRICS_TOKEN` (32+ chars) the route
  doesn't exist.
- `/docs` — the Swagger UI exists only with `API_DOCS=true`. The routes carry no schemas, so it
  lists paths and little else.

Three checks cover the API:

1. **Fly health check** (`fly.production.toml`): `/health` every 30 s. It gates deploys and
   shows in `fly checks list -c fly.production.toml`, but Fly sends no alert.
2. **External HTTP monitor** — the alert. Any uptime service works (Better Stack, UptimeRobot,
   Checkly): `GET https://api.pekohub.ai/health` every 1–3 minutes, expect status 200 and the
   text `"database":"ok"`, alert after two failures, by email and phone or Slack. Don't point
   one at staging: it would keep the machine and Neon awake.
3. **Tunnel probe** — an HTTP monitor can't check the tunnel (without a WebSocket upgrade the
   route answers 404 either way). `scripts/probe-uptime.mjs <origin>` checks `/health` and
   opens and closes a tunnel WebSocket through Cloudflare and Fly. `.github/workflows/uptime.yml`
   runs it every 10 minutes once the repository variable `UPTIME_API_ORIGIN` is set
   (`https://api.pekohub.ai`). Make a heartbeat monitor in the uptime service (expected every
   10 minutes, grace 20) and put its URL in the secret `UPTIME_HEARTBEAT_URL`: each passing
   run pings it, so a failing or stalled probe alerts like the HTTP monitor.

A failed run of `uptime.yml` also emails whoever last changed its schedule; GitHub runs
schedules late at times and pauses them after 60 days without a commit, so the heartbeat is
what to rely on.

---

## Backups and the restore drill

Two independent copies once production is on Neon:

1. **Neon point-in-time restore** — the first line. Any moment in the restore window can
   become a new branch (to inspect or copy from) or replace the production branch
   (Neon console → the branch → **Restore**, or `neonctl branches restore`). Use it for a bad
   migration or a mistaken delete.
2. **Nightly dump to R2** — `.github/workflows/backup-production.yml` runs `pg_dump` (custom
   format) at 04:17 UTC, encrypts it to an [age](https://age-encryption.org) public key and
   stores `postgres/pekohub-<timestamp>.dump.age` in an R2 bucket. It survives losing the Neon
   project or account. Set up (manual, creates resources):
   - R2 bucket `pekohub-backups` with a lifecycle rule deleting objects after 35 days, and an
     R2 API token limited to that bucket (Object Read & Write).
   - `age-keygen -o pekohub-backup.key`: keep the file offline (a password manager), put the
     public key it prints in the repository variable `BACKUP_AGE_RECIPIENT`.
   - Secrets `BACKUP_DATABASE_URL` (the direct connection string for the read-only `backup`
     role), `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`; variables
     `BACKUP_R2_ENDPOINT`, `BACKUP_R2_BUCKET`, `BACKUP_PG_MAJOR` (17).
   - Run it once by hand (`gh workflow run backup-production.yml`) and check the object.

Until the move, the Lightsail box keeps 7 daily dumps in `~/backups` on its own disk. To get
them off the box in the meantime, add to the backup cron line a copy to R2, e.g.
`aws s3 cp ~/backups/pekohub-$(date +%Y%m%d).sql s3://pekohub-backups/lightsail/ --endpoint-url https://<account id>.r2.cloudflarestorage.com`
(with an R2 token in `~/.aws/credentials`), or take a weekly Lightsail snapshot (it lives
outside the instance).

### Restore drill (quarterly, and after any change to the backup setup)

Record each drill in [`docs/ops/restore-drills.md`](docs/ops/restore-drills.md): the date, how
long each part took, and anything that went wrong.

1. **Point in time** — make a branch of production as of an hour ago:
   `neonctl branches create --project-id <id> --name drill-$(date +%Y%m%d) --parent <ISO-8601 timestamp>`
   (check `neonctl branches create --help` for your version; Neon console → Branches → New
   branch → a past point does the same). Get its URL with
   `neonctl connection-string drill-$(date +%Y%m%d) --project-id <id>`.
2. **From the dump** — download the newest dump
   (`aws s3 cp s3://pekohub-backups/postgres/<name> . --endpoint-url …`) and make an empty
   database — a new Neon project, or
   `docker run -d --name drill -e POSTGRES_PASSWORD=drill -p 5440:5432 postgres:17-alpine` — then:
   ```bash
   scripts/restore-drill.sh pekohub-<timestamp>.dump.age \
     postgres://postgres:drill@localhost:5440/postgres pekohub-backup.key
   ```
   It refuses a database that has tables, prints how long the restore took, every table's row
   count and the number of migrations applied.
3. **Compare** with production (Neon SQL editor, read-only role):
   `select relname, n_live_tup from pg_stat_user_tables order by relname;` — counts close to
   the dump's (they drift by a day's writes), and the same number of migrations.
4. **Start the API on it** — `DATABASE_URL=<drill URL> JWT_SECRET=<any 32+ chars> NODE_ENV=production node backend/dist/index.js`
   (after `pnpm --filter @pekohub/backend build`), then `curl localhost:3000/health` and
   `curl "localhost:3000/v1/search?q="`.
5. **Clean up** — delete the drill branch (`neonctl branches delete …`) and the container, and
   delete the decrypted dump if you made one.

Restoring production for real: from the point in time, use Neon's **Restore** on the
production branch (the connection strings stay the same), then `fly machine restart`. From a
dump, restore into a new Neon project as in step 2 and point the `DATABASE_URL` and
`MIGRATION_DATABASE_URL` secrets at it (`fly secrets set` restarts the machine).

---

## Prerequisites

- [AWS account](https://aws.amazon.com)
- [Cloudflare account](https://dash.cloudflare.com) with the `pekohub.ai` domain
- [GitHub repository](https://github.com/ConekoAI/pekohub) with Actions enabled
- OAuth apps: [GitHub](https://github.com/settings/developers) + [Google](https://console.cloud.google.com/apis/credentials) (optional)

---

## Step 1: Configure OAuth Apps

### GitHub OAuth App

1. https://github.com/settings/developers → **New OAuth App**
2. Application name: `PekoHub`
3. Homepage URL: `https://pekohub.ai`
4. Authorization callback URL: `https://api.pekohub.ai/v1/auth/github/callback`
5. Save **Client ID** and **Client Secret**

### Google OAuth 2.0 (Optional)

1. https://console.cloud.google.com/apis/credentials
2. **Create Credentials** → **OAuth client ID** → **Web application**
3. Authorized redirect URIs: `https://api.pekohub.ai/v1/auth/google/callback`
4. Save **Client ID** and **Client Secret**

> **Note:** The callback lives on the API origin; after sign-in the backend redirects to `FRONTEND_URL`.

---

## Step 2: Cloudflare Infrastructure

### 2.1 R2 Blob Storage (Free Tier)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **R2**
2. **Create bucket**: `pekohub-blobs`
3. **Settings** → **CORS**: Allow `GET, PUT` from `https://pekohub.ai`
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
   - `VITE_API_BASE_URL`: `https://api.pekohub.ai`
   - `NODE_VERSION`: `22`
5. **Save and Deploy**

6. **Custom domain** (optional but recommended):
   - Pages project → **Custom domains** → Add `pekohub.ai`
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
   - **A record**: `api` → `YOUR_LIGHTSAIL_STATIC_IP` (the backend — see *Hostnames* above)
   - `pekohub.ai` (apex) → the Pages custom domain (Cloudflare adds the record)
   - `pekohub.org` → a redirect rule to `https://pekohub.ai` (path kept)
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
   - `api.pekohub.ai/*` → Cache Level: **Bypass** (the API sets its own cache headers)

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
| `REGISTRY_BASE_URL` | `https://api.pekohub.ai` | The API origin |
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
curl https://api.pekohub.ai/health

# Where things live
curl https://api.pekohub.ai/v1/meta

# Health and the tunnel, from outside
node scripts/probe-uptime.mjs https://api.pekohub.ai

# Search
curl "https://api.pekohub.ai/v1/search?q=test"
```

Visit your frontend URL:
- `https://pekohub.pages.dev` (default)
- or `https://pekohub.ai` (custom domain)

---

## One-Time Production Step: Migration Baseline (2026-09)

The Drizzle migration journal was **re-baselined** in the 2026-09
backend overhaul: the old chain (`0000`–`0014`, partially applied via
`drizzle-kit push`) was replaced by two migrations:

- `0000_baseline` — full current schema, for fresh databases
- `0001_bundle_publisher` — adds `bundles.publisher_id` + backfill

A **fresh** database (new staging environment, rebuilt volume) needs
nothing — `drizzle-kit migrate` applies both from scratch.

An **existing** production database already has the baseline schema,
so `drizzle-kit migrate` would fail trying to re-create tables. Mark
the baseline as applied **once**, before the first deploy of this
change:

```bash
# 1. Compute the baseline hash exactly the way drizzle-kit's migrator
#    does (sha256 of the raw SQL file), and read the journal timestamp.
cd ~/pekohub/backend
BASELINE_HASH=$(node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('drizzle/0000_baseline.sql','utf8')).digest('hex'))")
BASELINE_WHEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('drizzle/meta/_journal.json','utf8')).entries[0].when)")
echo "$BASELINE_HASH $BASELINE_WHEN"

# 2. Insert the bookkeeping row into the production DB.
docker compose -f docker-compose.lightsail.yml exec db \
  psql -U pekohub -d pekohub -c "
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('$BASELINE_HASH', $BASELINE_WHEN);
"

# 3. Deploy as usual — `drizzle-kit migrate` now applies only
#    0001_bundle_publisher (publisher_id column + namespace backfill).
```

Reference values for this release (verify against the files — they
change if the baseline is ever regenerated):

- `0000_baseline` hash `be46056b4f706c6b1d1ffb8c61a2af4a8cb022ec80320d5e54621f347d9499cc`, `when` `1789561390317`
- `0001_bundle_publisher` hash `f65b69a999f35ec9846a73dad4d18414222befce814915328704677af3ad5aff`, `when` `1789561400241`

If the production DB already has a `drizzle.__drizzle_migrations`
table with rows from the old journal, clear it first
(`TRUNCATE drizzle.__drizzle_migrations;`) before inserting the
baseline row — the old hashes no longer correspond to any migration
file in the repo.

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

Automated daily backups are configured by `setup-instance.sh`. They stay on the instance's
own disk; see [Backups and the restore drill](#backups-and-the-restore-drill) for getting a
copy off the box.

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
| `.github/workflows/ci.yml` | Typecheck and tests on every PR and push |
| `.github/workflows/deploy-lightsail.yml` | Backend deploy to Lightsail (only with `[lightsail]`) |
| `.github/workflows/deploy-staging.yml` | Staging API (Fly.io) and website (Pages) after CI passes on `master` |
| `.github/workflows/uptime.yml` | Production `/health` and tunnel probe every 10 minutes, once `UPTIME_API_ORIGIN` is set |
| `.github/workflows/backup-production.yml` | Nightly encrypted dump of production to R2, once its secrets are set |

The production website deploys through the Pages Git integration.

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
| Self-hosted Postgres | Neon (as staging) | Before launch — see [Production: Fly.io + Neon](#production-flyio--neon-proposed) |
| Cloudflare R2 | S3 (if leaving Cloudflare ecosystem) | Rarely needed — R2 scales well |
| Self-hosted Meilisearch | Meilisearch Cloud | Need managed search |
| Single Lightsail instance | Fly.io, one machine | Before launch; more than one machine needs a multi-node relay (gap map B1) |

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
