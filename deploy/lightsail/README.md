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
