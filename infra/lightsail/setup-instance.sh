#!/usr/bin/env bash
# One-time setup script for AWS Lightsail instance (Ubuntu 24.04)
# Run this after creating a fresh Lightsail instance
#
# Usage: ssh into instance, then:
#   curl -fsSL https://raw.githubusercontent.com/ConekoAI/pekohub/master/infra/lightsail/setup-instance.sh | bash

set -euo pipefail

LIGHTSAIL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "UNKNOWN")

echo "========================================"
echo "  PekoHub Lightsail Instance Setup"
echo "  Public IP: $LIGHTSAIL_IP"
echo "========================================"
echo ""

# ── System Update ────────────────────────────────────────────
echo "[1/7] Updating system packages..."
sudo apt update && sudo apt upgrade -y

# ── Install Docker ───────────────────────────────────────────
echo "[2/7] Installing Docker..."
# Ubuntu 24.04: docker-compose-plugin is not in default repos,
# so we install docker.io + docker-compose (v1) which works fine.
sudo apt install -y docker.io docker-compose curl git

# Add current user to docker group
sudo usermod -aG docker "$USER"

# Start Docker
sudo systemctl enable docker
sudo systemctl start docker

# ── Install Node.js 22 ───────────────────────────────────────
echo "[3/7] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# ── Install pnpm ─────────────────────────────────────────────
echo "[4/7] Installing pnpm..."
sudo npm install -g pnpm@9

# ── Create app directory ─────────────────────────────────────
echo "[5/7] Setting up app directory..."
mkdir -p "$HOME/pekohub"
mkdir -p "$HOME/backups"

# ── Add swap (prevents OOM on $5 plan) ───────────────────────
echo "[6/7] Adding 2GB swap file..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap enabled."
else
    echo "Swap already exists."
fi

# ── Setup automated database backups ─────────────────────────
echo "[7/7] Setting up automated backups..."
(crontab -l 2>/dev/null || true; echo "0 3 * * * mkdir -p /home/ubuntu/backups && docker exec pekohub-db pg_dump -U pekohub pekohub > /home/ubuntu/backups/pekohub-\$(date +\\%Y\\%m\\%d).sql 2>/dev/null && find /home/ubuntu/backups -name 'pekohub-*.sql' -mtime +7 -delete") | crontab -

# ── Summary ──────────────────────────────────────────────────
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
echo "Instance IP: $LIGHTSAIL_IP"
echo ""
