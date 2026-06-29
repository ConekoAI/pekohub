#!/usr/bin/env bash
# One-time setup script for AWS Lightsail instance (Ubuntu 24.04).
#
# This script is now idempotent — every step is guarded so it is safe
# to re-run. Two entry points:
#
#   1. Standalone, as documented in DEPLOYMENT.md §3.2:
#        curl -fsSL https://raw.githubusercontent.com/ConekoAI/pekohub/master/infra/lightsail/setup-instance.sh | bash
#      In this mode the script runs `main` at the bottom, which calls
#      every bootstrap function in order.
#
#   2. Sourced by `infra/lightsail/deploy.sh` with BOOTSTRAP_SOURCED=1.
#      The top-level `main` is skipped; the deploy script calls the
#      individual functions directly. This is the path used by the
#      GitHub Actions deploy workflow on fresh instances.
#
# Usage:
#   Standalone:   bash setup-instance.sh
#   From deploy:  source setup-instance.sh   # with BOOTSTRAP_SOURCED=1

set -euo pipefail

# ─── Logging ──────────────────────────────────────────────────
log() { echo "[setup] $*"; }

# ─── Step 1: apt update + base packages ──────────────────────
# Idempotent: each package is checked via dpkg first. apt update is
# left unconditional — it is cheap and the cache is short-lived.
install_base_packages() {
  log "Installing base packages (docker.io, docker-compose, curl, git)..."
  local pkg
  for pkg in docker.io docker-compose curl git; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
      log "  $pkg already installed"
    else
      sudo apt install -y "$pkg"
    fi
  done

  # Docker group membership — only add if missing.
  if id -nG "$USER" | grep -qw docker; then
    log "User $USER already in docker group"
  else
    log "Adding $USER to docker group"
    sudo usermod -aG docker "$USER"
  fi

  # systemd unit — enable/start are no-ops when already active.
  sudo systemctl enable docker
  sudo systemctl start docker
}

# ─── Step 2: Node.js 22 ───────────────────────────────────────
install_node() {
  if command -v node >/dev/null 2>&1 && node -v | grep -q '^v22'; then
    log "Node.js 22 already installed: $(node -v)"
    return
  fi
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
}

# ─── Step 3: pnpm 9 ───────────────────────────────────────────
install_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm already installed: $(pnpm --version)"
    return
  fi
  log "Installing pnpm@9..."
  sudo npm install -g pnpm@9
}

# ─── Step 4: App directory ────────────────────────────────────
setup_app_directory() {
  mkdir -p "$HOME/pekohub"
  mkdir -p "$HOME/backups"
}

# ─── Step 5: 2GB swap (prevents OOM on $5 plan) ───────────────
add_swap() {
  if [ -f /swapfile ]; then
    log "Swap file already present"
    return
  fi
  log "Adding 2GB swap file..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
}

# ─── Step 6: Automated daily pg_dump via cron ─────────────────
# Idempotent: dedupe on a stable marker string in the crontab. The
# previous version of this script appended blindly, which would
# double up on every re-run.
setup_backup_cron() {
  local marker="pekohub-db-daily-pg_dump"
  if crontab -l 2>/dev/null | grep -q "$marker"; then
    log "Backup cron already installed"
    return
  fi
  log "Installing daily pg_dump cron..."
  (crontab -l 2>/dev/null || true; echo "0 3 * * * mkdir -p /home/ubuntu/backups && docker exec pekohub-db pg_dump -U pekohub pekohub > /home/ubuntu/backups/pekohub-\$(date +\\%Y\\%m\\%d).sql 2>/dev/null && find /home/ubuntu/backups -name 'pekohub-*.sql' -mtime +7 -delete  # $marker") | crontab -
}

# ─── Entrypoint ───────────────────────────────────────────────
main() {
  local lightsail_ip
  lightsail_ip=$(curl -s ifconfig.me 2>/dev/null || echo "UNKNOWN")

  echo "========================================"
  echo "  PekoHub Lightsail Instance Setup"
  echo "  Public IP: $lightsail_ip"
  echo "========================================"
  echo ""

  install_base_packages
  install_node
  install_pnpm
  setup_app_directory
  add_swap
  setup_backup_cron

  echo ""
  echo "========================================"
  echo "  Setup Complete!"
  echo "========================================"
  echo ""
  echo "Docker version: $(docker --version)"
  echo "Docker Compose: $(docker-compose --version)"
  echo "Node.js: $(node --version)"
  echo "pnpm: $(pnpm --version)"
  echo ""
  echo "Next steps:"
  echo "  1. Log out and back in (or run 'newgrp docker')"
  echo "  2. Clone the repo: cd ~ && git clone https://github.com/ConekoAI/pekohub.git"
  echo "  3. Add GitHub deploy key for SSH-based deployments"
  echo "  4. Trigger first deploy via GitHub Actions"
  echo ""
  echo "Instance IP: $lightsail_ip"
  echo ""
}

# When sourced by deploy.sh, the top-level main is skipped. When run
# standalone (curl | bash, or `bash setup-instance.sh`), main runs.
if [ "${BOOTSTRAP_SOURCED:-0}" != "1" ]; then
  main "$@"
fi
