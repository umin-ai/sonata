#!/usr/bin/env bash
# Sets up (or updates) a Lightsail Ubuntu 24.04 instance to serve Sonata on
# Solana Devnet. Run as root on the instance:
#   sudo bash setup.sh <public-hostname> [old-hostname ...]
# Old hostnames get their own certificate and redirect to the public one.
# Secrets are not in this repository: copy them to /opt/sonata/sonata.env
# (mode 600, owner sonata) before running. See web/deploy/lightsail/README.md.
# /opt/sonata/app is a checkout of the whole repository; the app is built and
# run from its web/ folder.
#
# An update never lets a payout pass run on half-updated code or on an old
# database schema: the crank's timer is stopped and disabled (and a running
# pass waited for) before anything changes, and enabled again only after the
# restarted indexer has migrated the database. If any step fails, the timer
# stays stopped and disabled (no passes, funds stay owed) until setup.sh
# completes, a reboot included: a disabled timer does not start at boot.
set -euo pipefail

# How long to wait for a running crank pass (systemd stops one after 10
# minutes) and for the indexer's migration.
CRANK_WAIT_SECONDS="${CRANK_WAIT_SECONDS:-660}"
MIGRATION_WAIT_SECONDS="${MIGRATION_WAIT_SECONDS:-300}"
# What indexer/index.mjs prints once every table and column is in place.
MIGRATED_LINE="indexer migrated"

# Stops and disables sonata-crank.timer (a stop alone lasts only until the
# next boot), then waits for a pass already running to finish. On a first
# install there is nothing to stop.
stop_crank() {
  if systemctl cat sonata-crank.timer >/dev/null 2>&1; then
    systemctl disable --now sonata-crank.timer
  fi
  local waited=0 state
  while :; do
    state="$(systemctl show -p ActiveState --value sonata-crank.service 2>/dev/null || true)"
    case "$state" in
      active | activating | deactivating | reloading) ;;
      *) return 0 ;;
    esac
    if [ "$waited" -eq 0 ]; then echo "Waiting for the running crank pass to finish..."; fi
    if [ "$waited" -ge "$CRANK_WAIT_SECONDS" ]; then
      echo "sonata-crank.service is still running after ${CRANK_WAIT_SECONDS}s; nothing updated." >&2
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# Waits until the sonata-indexer process started by the last restart has
# printed MIGRATED_LINE (its migrate() finished), read from that process's
# own journal entries.
wait_for_migration() {
  local waited=0 id log
  while :; do
    id="$(systemctl show -p InvocationID --value sonata-indexer.service 2>/dev/null || true)"
    if [ -n "$id" ]; then
      log="$(journalctl --no-pager -q -o cat "_SYSTEMD_INVOCATION_ID=$id" 2>/dev/null || true)"
      if grep -qxF "$MIGRATED_LINE" <<<"$log"; then return 0; fi
    fi
    if [ "$waited" -ge "$MIGRATION_WAIT_SECONDS" ]; then
      echo "sonata-indexer has not finished its database migration after ${MIGRATION_WAIT_SECONDS}s (see journalctl -u sonata-indexer)." >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# indexer/deploy.test.mjs loads the functions above without running anything.
if [ "${SONATA_SETUP_FUNCTIONS_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

HOST="${1:?usage: setup.sh <public-hostname> [old-hostname ...]}"
shift
ALIASES="$*"
REPO="${SONATA_REPO:-https://github.com/umin-ai/sonata}"
HOME_DIR=/opt/sonata
APP_DIR=$HOME_DIR/app
# The web app's folder in the repository: npm, the build and every service run here.
WEB_DIR=$APP_DIR/web
HERE="$(cd "$(dirname "$0")" && pwd)"

# No payout pass from here until the new code has migrated the database.
CRANK_HELD=1
trap 'if [ "$CRANK_HELD" = 1 ]; then echo "setup.sh did not finish: sonata-crank.timer is left stopped and disabled, so no payout pass runs, not even after a reboot (funds stay owed). Fix the error above and re-run setup.sh." >&2; fi' EXIT
stop_crank

# Building on a 2 GB instance needs swap.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git openssl postgresql debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22.13 or later in 22.x (NodeSource): package.json's engines, and the
# indexer's --experimental-strip-types (sonata-indexer.service) needs 22.6 or
# later. Caddy from its official repository.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a === 22 && b >= 13 ? 0 : 1)' 2>/dev/null; then
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
# The branch it pulls must already have the app in web/ (the monorepo layout).
if [ ! -f "$WEB_DIR/package.json" ]; then
  echo "$APP_DIR has no web/package.json after the pull: the branch it pulls (main of $REPO) does not have the app in web/ yet. Merge and push that first, then re-run setup.sh." >&2
  exit 1
fi
sudo -u sonata bash -c "cd $WEB_DIR && npm ci --no-audit --no-fund && npm run build"

# Server-only settings for the Workers runtime; rebuilt with every deploy.
install -o sonata -g sonata -m 600 $HOME_DIR/sonata.env $WEB_DIR/dist/server/.dev.vars
echo "DATABASE_URL=postgres://sonata:$(cat $PASS_FILE)@127.0.0.1:5432/sonata" >> $WEB_DIR/dist/server/.dev.vars
echo "INDEXER_URL=http://127.0.0.1:8790/api/index" >> $WEB_DIR/dist/server/.dev.vars
# The indexer needs the database, and takes a fallback Devnet RPC for its market
# accounts reader from sonata.env when there is one (MARKET_ACCOUNTS_FALLBACK_RPC_URL,
# else the relay's GETBLOCK_DEVNET_URL). Live push (new markets, curves and trades
# pushed to open pages, /api/index/stream) is on; to turn it off, put LIVE_PUSH=0
# in indexer-overrides.env and restart sonata-indexer (see README.md). Its own
# overrides live in indexer-overrides.env, which this script never rewrites.
install -o sonata -g sonata -m 600 /dev/null $HOME_DIR/indexer.env
echo "DATABASE_URL=postgres://sonata:$(cat $PASS_FILE)@127.0.0.1:5432/sonata" > $HOME_DIR/indexer.env
echo "LIVE_PUSH=1" >> $HOME_DIR/indexer.env
# CHAINSTACK_DEVNET_URL, when set, is the second RPC the live poll alternates with.
grep -E '^(MARKET_ACCOUNTS_FALLBACK_RPC_URL|GETBLOCK_DEVNET_URL|CHAINSTACK_DEVNET_URL)=' $HOME_DIR/sonata.env >> $HOME_DIR/indexer.env || true

# Creator payout crank: its own fee-payer key, generated here once and never
# printed. It can only pay network fees, so it needs a little Devnet SOL.
CRANK_KEY=$HOME_DIR/crank-keypair.json
if [ ! -f $CRANK_KEY ]; then
  CRANK_PUBKEY=$(cd $WEB_DIR && sudo -u sonata env CRANK_KEY=$CRANK_KEY node -e '
    const { Keypair } = require("@solana/web3.js");
    const key = Keypair.generate();
    require("node:fs").writeFileSync(process.env.CRANK_KEY, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600, flag: "wx" });
    console.log(key.publicKey.toBase58());')
  echo "Created the payout crank key. Public key: $CRANK_PUBKEY"
  echo "Fund it with a little Devnet SOL (about 0.5 SOL, e.g. from https://faucet.solana.com) so it can pay transaction fees."
fi
chown sonata:sonata $CRANK_KEY && chmod 600 $CRANK_KEY

sed "s/__HOST__/$HOST/g" "$HERE/sonata.service" > /etc/systemd/system/sonata.service
install -m 644 "$HERE/sonata-indexer.service" /etc/systemd/system/sonata-indexer.service
install -m 644 "$HERE/sonata-crank.service" /etc/systemd/system/sonata-crank.service
install -m 644 "$HERE/sonata-crank.timer" /etc/systemd/system/sonata-crank.timer
install -m 644 "$HERE/sonata-warm.service" /etc/systemd/system/sonata-warm.service
install -m 644 "$HERE/sonata-warm.timer" /etc/systemd/system/sonata-warm.timer
sed "s/__HOST__/$HOST/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
if [ -n "$ALIASES" ]; then
  printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' "${ALIASES// /, }" "$HOST" >> /etc/caddy/Caddyfile
fi
systemctl daemon-reload
# The crank's timer is enabled only once the database is migrated, below.
systemctl enable sonata sonata-indexer >/dev/null 2>&1
# The indexer's startup migrates the database (tables the crank reads).
systemctl restart sonata sonata-indexer
# Keeps the market snapshot warm between visitors (reads only).
systemctl enable --now sonata-warm.timer >/dev/null 2>&1
echo "Waiting for sonata-indexer to migrate the database..."
wait_for_migration
# The crank is started by its timer, never enabled on its own.
systemctl enable --now sonata-crank.timer
CRANK_HELD=0
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

# Before the repository became a monorepo the app was built at the root of
# $APP_DIR, and git leaves that build's untracked output behind when it moves
# the app into web/ (the new root .gitignore no longer hides it). Once the app
# has been built in web/ and the services run from there, remove it. Only when
# web/ is the app and the root is not.
if [ -f "$WEB_DIR/package.json" ] && [ ! -f "$APP_DIR/package.json" ]; then
  rm -rf -- "$APP_DIR/node_modules" "$APP_DIR/dist" "$APP_DIR/.next" "$APP_DIR/.wrangler" \
    "$APP_DIR/next-env.d.ts" "$APP_DIR/tsconfig.tsbuildinfo"
fi
if grep -qsx 'CRANK_DRY_RUN=1' $HOME_DIR/crank.env; then
  echo "CRANK_DRY_RUN=1 is set in $HOME_DIR/crank.env: crank passes only simulate and send nothing."
  echo "Run one (sudo systemctl start sonata-crank), read it (journalctl -u sonata-crank -n 200 --no-pager),"
  echo "then remove that line to pay for real: sudo sed -i '/^CRANK_DRY_RUN=/d' $HOME_DIR/crank.env"
fi
echo "Deployed $(sudo -u sonata git -C $APP_DIR rev-parse --short HEAD) to https://$HOST"
