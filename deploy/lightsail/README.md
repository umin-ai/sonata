# Deploying Sonata to AWS Lightsail (Solana Devnet)

One Ubuntu 24.04 instance runs everything: Caddy (HTTPS) → the app on
127.0.0.1:8787 (workerd via wrangler local mode) → PostgreSQL on localhost
(installed for the coming indexer; the app does not use it yet).

Images are served from S3 through CloudFront; the app needs only an
upload-only key. Nothing secret is stored in this repository.

## Deploy or update

1. Put the server-only settings in `/opt/sonata/sonata.env` on the instance
   (owner `sonata`, mode 600). Allowed keys: `PYTH_PRO_API_KEY`,
   `JUPITER_API_KEY`, `AWS_REGION`, `SONATA_ASSETS_BUCKET`, `SONATA_ASSETS_CDN`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Never add
   `STOCKROOM_DEMO_AUTHORITY` or `SONATA_ENABLE_DEVNET_SPONSOR` on a public host.
2. Copy this folder to the instance and run `sudo bash setup.sh <hostname>`.
   It is safe to re-run: it pulls the latest `main`, rebuilds and restarts.

Firewall (Lightsail): 80 and 443 open; 22 limited to the operator's address
and Lightsail's browser SSH.

Without a domain, `<ip-with-dashes>.sslip.io` resolves to the instance and
gets a normal certificate. It changes if the instance's public IP changes;
attach a static IP before pointing a real domain at it.
