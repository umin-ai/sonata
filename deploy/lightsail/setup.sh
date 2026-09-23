#!/usr/bin/env bash
# Sets up (or updates) a Lightsail Ubuntu 24.04 instance to serve Sonata on
# Solana Devnet. Run as root on the instance:
#   sudo bash setup.sh <public-hostname> [old-hostname ...]
# Old hostnames get their own certificate and redirect to the public one.
# Secrets are not in this repository: copy them to /opt/sonata/sonata.env
# (mode 600, owner sonata) before running. See deploy/lightsail/README.md.
set -euo pipefail
HOST="${1:?usage: setup.sh <public-hostname> [old-hostname ...]}"
shift
ALIASES="$*"
REPO="${SONATA_REPO:-https://github.com/umin-ai/sonata}"
HOME_DIR=/opt/sonata
APP_DIR=$HOME_DIR/app
HERE="$(cd "$(dirname "$0")" && pwd)"

# Building on a 2 GB instance needs swap.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git openssl postgresql debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22 (NodeSource) and Caddy (official repository).
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

id sonata >/dev/null 2>&1 || useradd --system --create-home --home-dir $HOME_DIR --shell /usr/sbin/nologin sonata
chown sonata:sonata $HOME_DIR
test -f $HOME_DIR/sonata.env || { echo "Missing $HOME_DIR/sonata.env"; exit 1; }
chown sonata:sonata $HOME_DIR/sonata.env && chmod 600 $HOME_DIR/sonata.env

# PostgreSQL, local connections only (Ubuntu's default). Not used by the app yet.
PASS_FILE=$HOME_DIR/.db-password
test -f $PASS_FILE || { openssl rand -hex 24 > $PASS_FILE; chown sonata:sonata $PASS_FILE; chmod 600 $PASS_FILE; }
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sonata'" | grep -q 1 \
  || sudo -u postgres psql -q -c "CREATE ROLE sonata LOGIN PASSWORD '$(cat $PASS_FILE)'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='sonata'" | grep -q 1 \
  || sudo -u postgres createdb -O sonata sonata

# App: clone or fast-forward, install, build.
if [ -d $APP_DIR/.git ]; then sudo -u sonata git -C $APP_DIR pull --ff-only
else sudo -u sonata git clone "$REPO" $APP_DIR; fi
sudo -u sonata bash -c "cd $APP_DIR && npm ci --no-audit --no-fund && npm run build"

# Server-only settings for the Workers runtime; rebuilt with every deploy.
install -o sonata -g sonata -m 600 $HOME_DIR/sonata.env $APP_DIR/dist/server/.dev.vars
echo "DATABASE_URL=postgres://sonata:$(cat $PASS_FILE)@127.0.0.1:5432/sonata" >> $APP_DIR/dist/server/.dev.vars

sed "s/__HOST__/$HOST/g" "$HERE/sonata.service" > /etc/systemd/system/sonata.service
sed "s/__HOST__/$HOST/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
if [ -n "$ALIASES" ]; then
  printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' "${ALIASES// /, }" "$HOST" >> /etc/caddy/Caddyfile
fi
systemctl daemon-reload
systemctl enable sonata >/dev/null
systemctl restart sonata
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy
echo "Deployed $(sudo -u sonata git -C $APP_DIR rev-parse --short HEAD) to https://$HOST"
