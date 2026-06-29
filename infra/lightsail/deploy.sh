#!/usr/bin/env bash
# PekoHub Lightsail deploy — single idempotent entrypoint.
#
# Safe to run on:
#   - a brand-new instance (no Docker, no repo, no DB)
#   - a running instance (patch update)
#   - a half-deployed instance (re-run after a failed deploy)
#
# The DB schema is converged by `drizzle-kit migrate`, which is
# idempotent via the `__drizzle_migrations` journal. No "fresh vs
# update" branching — every step is guarded.
#
# ─────────────────────────────────────────────────────────────
# Required env (passed by the GitHub Actions deploy workflow, which
# writes $APP_DIR/.env from ${{ secrets.* }} via a single-quoted
# heredoc and sources it before invoking this script):
#
#   POSTGRES_PASSWORD, MEILISEARCH_API_KEY, JWT_SECRET,
#   GH_CLIENT_ID, GH_CLIENT_SECRET,
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#   REGISTRY_BASE_URL,
#   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#
# Optional:
#   APP_DIR       (default: $HOME/pekohub)
#   COMPOSE_FILE  (default: docker-compose.lightsail.yml)
#   REPO_URL      (default: https://github.com/ConekoAI/pekohub.git)
#   BRANCH        (default: master)
#   SKIP_PULL=1     (debug: don't fetch/reset the repo)
#   SKIP_MIGRATE=1  (debug: don't run drizzle-kit migrate)
#   FRESH_DB_VOLUME_RECREATE=1  (recovery: drop & recreate db volume)
#   HEALTH_DEADLINE_SECS=90     (override health-check timeout)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────
APP_DIR="${APP_DIR:-$HOME/pekohub}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.lightsail.yml}"
REPO_URL="${REPO_URL:-https://github.com/ConekoAI/pekohub.git}"
BRANCH="${BRANCH:-master}"
HEALTH_DEADLINE_SECS="${HEALTH_DEADLINE_SECS:-90}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Logging ──────────────────────────────────────────────────
log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ─── 1. Bootstrap the host ────────────────────────────────────
# Sources setup-instance.sh with BOOTSTRAP_SOURCED=1 so its top-level
# main() is skipped; we call each guarded function directly. Every
# function is a no-op when the work is already done.
bootstrap_host() {
  log "Bootstrapping host (idempotent)..."
  # shellcheck source=setup-instance.sh
  BOOTSTRAP_SOURCED=1 source "$SCRIPT_DIR/setup-instance.sh"

  install_base_packages
  install_node
  install_pnpm
  setup_app_directory
  add_swap
  setup_backup_cron
}

# ─── 2. Ensure the repo is present and on the right commit ────
ensure_repo() {
  if [ "${SKIP_PULL:-0}" = "1" ]; then
    log "SKIP_PULL=1 — skipping repo sync"
    [ -d "$APP_DIR/.git" ] || die "SKIP_PULL=1 but $APP_DIR does not exist"
    return
  fi

  if [ ! -d "$APP_DIR/.git" ]; then
    log "Cloning $REPO_URL into $APP_DIR..."
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  else
    log "Fetching latest from origin/$BRANCH..."
    cd "$APP_DIR"
    git fetch origin
    git reset --hard "origin/$BRANCH"
  fi
}

# ─── 3. Write .env from caller-provided env vars ──────────────
# The GitHub Actions workflow is the source of truth for secrets —
# it writes $APP_DIR/.env from ${{ secrets.* }} and sources it
# into the shell before calling us. So in the workflow path,
# POSTGRES_PASSWORD (and friends) are already set in the shell
# and this function rewrites .env idempotently.
#
# In the standalone path (someone SSH'd in and ran deploy.sh
# directly), the user has either already sourced .env or set
# the env vars. If they haven't, we trust the existing .env
# and skip the rewrite — re-running a deploy should not require
# the user to paste secrets into their shell.
write_env_file() {
  local env_path="$APP_DIR/.env"

  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    if [ -f "$env_path" ]; then
      log "Required env vars not set in shell — trusting existing $env_path (skipping rewrite)."
      return
    fi
    die "Required env vars are not set and $env_path does not exist. Source an existing .env or set POSTGRES_PASSWORD etc. before running deploy.sh."
  fi

  log "Writing $env_path (chmod 600)..."

  # Required vars — fail loudly if any are missing. Listing them
  # here (rather than reading them silently) means a missing secret
  # surfaces as a deploy error, not a runtime 500.
  #
  # The .env file uses the `GITHUB_*` prefix to match
  # docker-compose.lightsail.yml and the backend's process.env
  # references; the GitHub Actions secret is named `GH_*` (without
  # the GITHUB_ prefix) because Actions reserves the GITHUB_ namespace.
  # The deploy workflow's heredoc does the translation:
  #   GITHUB_CLIENT_ID=${{ secrets.GH_CLIENT_ID }}
  # so when this script sources .env, the shell var is
  # GITHUB_CLIENT_ID — which is what we check for here.
  local required=(
    POSTGRES_PASSWORD MEILISEARCH_API_KEY JWT_SECRET
    GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
    REGISTRY_BASE_URL
    R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  )
  for v in "${required[@]}"; do
    if [ -z "${!v:-}" ]; then
      die "Required env var $v is not set"
    fi
  done

  umask 077
  cat > "$env_path" <<EOF
POSTGRES_USER=pekohub
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=pekohub
MEILISEARCH_API_KEY=${MEILISEARCH_API_KEY}
JWT_SECRET=${JWT_SECRET}
GITHUB_CLIENT_ID=${GH_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GH_CLIENT_SECRET}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
REGISTRY_BASE_URL=${REGISTRY_BASE_URL}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_ACCESS_KEY=${R2_ACCESS_KEY_ID}
S3_SECRET_KEY=${R2_SECRET_ACCESS_KEY}
S3_BUCKET=${R2_BUCKET}
S3_FORCE_PATH_STYLE=false
RATE_LIMIT_MAX=1000
RATE_LIMIT_WINDOW_MS=60000
GC_ENABLED=true
GC_INTERVAL_MS=86400000
GC_RETENTION_DAYS=7
GC_BATCH_SIZE=1000
EOF
  chmod 600 "$env_path"
}

# ─── 4. Pull base images ──────────────────────────────────────
# No-op when up to date. Pulls in parallel by default.
compose_pull() {
  log "Pulling base images..."
  (cd "$APP_DIR" && docker-compose -f "$COMPOSE_FILE" pull)
}

# ─── 4b. Optional: wipe the db volume (recovery) ───────────────
maybe_recreate_db_volume() {
  if [ "${FRESH_DB_VOLUME_RECREATE:-0}" != "1" ]; then
    return
  fi
  log "FRESH_DB_VOLUME_RECREATE=1 — dropping and recreating the db volume..."
  (cd "$APP_DIR" && docker-compose -f "$COMPOSE_FILE" down -v db)
}

# ─── 5. Bring up the full stack ───────────────────────────────
# No `--no-deps` — compose gates startup ordering via healthchecks.
# The stop/rm-backend workaround from the old inline script is no
# longer needed because backend + meilisearch now have healthchecks
# and nginx depends on backend being healthy.
compose_up() {
  log "Bringing up services (healthcheck-gated)..."
  (cd "$APP_DIR" && docker-compose -f "$COMPOSE_FILE" up -d)
}

# ─── 6. Run database migrations ───────────────────────────────
# drizzle-kit migrate is the idempotency layer for the schema. It
# tracks applied migrations in `__drizzle_migrations` and skips
# already-applied ones, so re-running on a converged DB is a no-op.
run_migrations() {
  if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
    log "SKIP_MIGRATE=1 — skipping migrations"
    return
  fi
  log "Running database migrations..."
  (cd "$APP_DIR" && docker-compose -f "$COMPOSE_FILE" exec -T backend npx drizzle-kit migrate --config=drizzle.config.ts)
}

# ─── 7. Wait for /health to return 200 ────────────────────────
# Retry loop with a deadline, rather than `sleep 15 && curl once`.
health_check_retry() {
  log "Health-checking backend (deadline: ${HEALTH_DEADLINE_SECS}s)..."
  local deadline=$((SECONDS + HEALTH_DEADLINE_SECS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      log "Backend is healthy."
      return 0
    fi
    sleep 2
  done

  log "Health check did not pass within ${HEALTH_DEADLINE_SECS}s. Recent backend logs:"
  (cd "$APP_DIR" && docker-compose -f "$COMPOSE_FILE" logs --tail=200 backend) || true
  die "Backend failed health check"
}

# ─── 8. Prune dangling images older than 7 days ───────────────
# Frees disk on long-running instances. Idempotent — no-op when
# there is nothing to prune.
prune_images() {
  log "Pruning old Docker images (>=168h)..."
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
}

# ─── main ─────────────────────────────────────────────────────
main() {
  log "=== PekoHub Deploy Started ==="
  log "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "APP_DIR=$APP_DIR  COMPOSE_FILE=$COMPOSE_FILE  BRANCH=$BRANCH"

  bootstrap_host
  ensure_repo
  write_env_file
  maybe_recreate_db_volume
  compose_pull
  compose_up
  run_migrations
  health_check_retry
  prune_images

  log "=== PekoHub Deploy Complete ==="
  log "Backend: ${REGISTRY_BASE_URL:-http://localhost:3000}"
}

main "$@"
