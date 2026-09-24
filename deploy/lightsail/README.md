# Deploying Sonata to AWS Lightsail (Solana Devnet)

One Ubuntu 24.04 instance runs everything: Caddy (HTTPS) → the app on
127.0.0.1:8787 (workerd via wrangler local mode), and `/api/index/*` → the
trade indexer on 127.0.0.1:8790 (`indexer/index.mjs`, service
`sonata-indexer`), which reads Devnet DBC swaps into PostgreSQL on localhost.

Images are served from S3 through CloudFront; the app needs only an
upload-only key. Nothing secret is stored in this repository.

## Deploy or update

1. Put the server-only settings in `/opt/sonata/sonata.env` on the instance
   (owner `sonata`, mode 600). Allowed keys: `PYTH_PRO_API_KEY`,
   `JUPITER_API_KEY`, `AWS_REGION`, `SONATA_ASSETS_BUCKET`, `SONATA_ASSETS_CDN`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Never add
   `STOCKROOM_DEMO_AUTHORITY` or `SONATA_ENABLE_DEVNET_SPONSOR` on a public host.
2. Copy this folder to the instance and run
   `sudo bash setup.sh sonata.umin.ai 34-255-123-10.sslip.io`.
   The first name is the public address (the app's same-origin checks use it);
   any others redirect to it. It is safe to re-run: it pulls the latest
   `main`, rebuilds and restarts.

DNS: `sonata.umin.ai` is an A record at Cloudflare pointing at the instance,
DNS only (not proxied), so Caddy obtains the certificate itself.

Firewall (Lightsail): 80 and 443 open; 22 limited to the operator's address
and Lightsail's browser SSH.

Before the domain existed the app was served at `34-255-123-10.sslip.io`,
which now redirects. Both names follow the instance's public IP: attach a
static IP (and update the A record) before relying on them long term.

## Creator payout crank

`indexer/crank.mjs` (service `sonata-crank`, started by `sonata-crank.timer`
2 minutes after boot and then every 15 minutes) moves accrued trading fees to
creators. Each run makes one pass over every Sonata treasury and exits:

1. `claim` pulls the pool's partner fees from Meteora DBC into the treasury,
   when the pool has at least `CRANK_MIN_ATOMS` (default 10000) quote atoms
   waiting.
2. `distribute` splits whatever is claimed but unallocated by the treasury's
   mode: refrain 100% to the payout wallet, duet 50/50, floor 50% payout and
   50% Stock Floor. If the payout wallet has no quote-token account yet, the
   same transaction creates it.

Both instructions are permissionless and every destination is fixed onchain,
so the crank's key can only pay fees: it cannot move, redirect or withdraw any
market's funds. It holds only Devnet SOL, for transaction fees (5,000 lamports
each) and the occasional payout token account rent (about 0.002 SOL). It
refuses to send anything unless the RPC's genesis hash is Devnet's.

**Key and funding.** `setup.sh` generates the key on the instance the first
time, at `/opt/sonata/crank-keypair.json` (owner `sonata`, mode 600), and prints
only its public key. Each run also logs it (`payer=...`). Send it about 0.5
Devnet SOL, for example from https://faucet.solana.com, or with
`solana airdrop 0.5 <public key> --url devnet`. Until it is funded, each run
exits with "fund it with Devnet SOL" and sends nothing. The key never needs to
leave the instance; to replace it, delete the file and re-run `setup.sh`.

**Settings.** Optional, in `/opt/sonata/crank.env` (owner `sonata`, mode 600):
`SOLANA_RPC_URL` (default public Devnet), `CRANK_MIN_ATOMS`, and
`CRANK_DRY_RUN=1` to simulate without sending.

**Logs.** One line per market (pool, action, signature or reason) and a
summary line per run:

    journalctl -u sonata-crank -n 50 --no-pager
    systemctl list-timers sonata-crank.timer

A run exits with an error, and shows as failed in `systemctl status
sonata-crank`, when any market failed; skipped markets are normal.

**Run once now:** `sudo systemctl start sonata-crank`.
**Stop it:** `sudo systemctl disable --now sonata-crank.timer` (re-running
`setup.sh` enables it again).
