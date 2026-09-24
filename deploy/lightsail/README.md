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
   50% Stock Floor; `distribute_split` does it for the modes with a Sonata
   share (standard 50% payout, 50% Sonata). If the payout wallet has no
   quote-token account yet, the same transaction creates it.
3. Reward token payouts (below), for markets whose payout wallet is the crank
   key itself.

Both instructions are permissionless and every destination is fixed onchain,
so for ordinary markets the crank's key can only pay fees: it cannot move,
redirect or withdraw any market's funds. It needs Devnet SOL for transaction
fees (5,000 lamports each) and the occasional payout token account rent (about
0.002 SOL). It refuses to send anything unless the RPC's genesis hash is
Devnet's.

**Key and funding.** `setup.sh` generates the key on the instance the first
time, at `/opt/sonata/crank-keypair.json` (owner `sonata`, mode 600), and prints
only its public key. Each run also logs it (`payer=...`). Send it about 0.5
Devnet SOL, for example from https://faucet.solana.com, or with
`solana airdrop 0.5 <public key> --url devnet`. Until it is funded, each run
exits with "fund it with Devnet SOL" and sends nothing. To replace it, delete
the file and re-run `setup.sh`, but not once Reward token markets exist (see
Custody below).

**Settings.** The service reads `DATABASE_URL` from `/opt/sonata/indexer.env`
(written by `setup.sh`, shared with the indexer) for the reward ledger. Optional
overrides, in `/opt/sonata/crank.env` (owner `sonata`, mode 600, read last):
`SOLANA_RPC_URL` (default public Devnet), `CRANK_MIN_ATOMS`,
`REWARD_MIN_ATOMS`, and `CRANK_DRY_RUN=1` to simulate without sending.

**Logs.** One line per market (pool, action, signature or reason) and a
summary line per run:

    journalctl -u sonata-crank -n 50 --no-pager
    systemctl list-timers sonata-crank.timer

A run exits with an error, and shows as failed in `systemctl status
sonata-crank`, when any market failed; skipped markets are normal.

### Reward token payouts

A Reward token is a Standard-mode market whose payout wallet is the crank key
(`Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz`); the app registers it that way.
`distribute_split` pays the creator's 50% into the crank key's Token-2022
quote-token account, and `indexer/rewards.mjs` passes it on to the token's
holders, pro rata, in the quote token, after every market's claim/distribute:

- **Owed**, per market: the treasury's onchain `total_distributed` (its
  lifetime payout to the crank key) minus what the ledger has paid for that
  pool. Every reward market with the same quote token shares one quote account,
  so the ledger keeps the markets apart.
- **Threshold**: nothing is paid until a market is owed at least
  `REWARD_MIN_ATOMS` (default 100000, 0.001 of an 8-decimal token).
- **Solvency**: the crank's quote balance must cover everything owed to all
  reward markets in that quote token, or none of them is paid and each run
  logs the shortfall. One market's holders are never paid with another's
  funds, and a lost or wrong ledger stops payouts instead of repeating them.
- **Holders**: a snapshot of the base mint's token accounts. Excluded: the DBC
  pool's base vault, the treasury's base account, anything the crank key owns,
  owners that are not signing wallets (PDAs: pool authorities, DAMM v2 pools,
  program vaults) and holders of less than 0.01% of supply. Balances are summed
  per wallet; the top 200 by balance are paid.
- **Shares**: owed × balance ÷ the top holders' total, rounded down; zero
  shares are dropped. Holders without a quote-token account are skipped (the
  crank never pays rent to create one), and so is an account that would reject
  the transfer (frozen, memo required). Skipped shares and rounding stay owed
  for a later pass, so nothing is paid twice and nothing is lost.
- **Transactions**: Token-2022 `transfer_checked` from the crank's quote
  account, 20 per transaction (1,210 of 1,232 bytes; about 60,000 compute
  units, so no compute budget instruction). Each batch is simulated first; a
  recipient whose transfer fails is dropped (up to five per market) and the
  rest retried.
- **Ledger**: PostgreSQL tables `reward_payouts` (one row per confirmed
  transaction: pool, signature, amount, recipients, paid_at) and
  `reward_pending`, both created by the indexer at startup. A signed payout is
  written to `reward_pending` before it is sent and counts as paid until the
  chain settles it: confirmed moves it to `reward_payouts`, a failed or expired
  one is dropped (its amount stays owed). A crash or timeout mid-payout is
  settled at the start of the next run, never paid again.
- A failing market is logged and counted and does not stop the others. A run
  starts no new payout after 8 minutes; the rest waits for the next run.

**Custody.** For these markets the crank key briefly holds the holders'
rewards: from the `distribute_split` that pays it until the payout transaction
a few seconds later, or until the next run when a market is under the threshold
or a holder was skipped. Reward tokens are custodial, as pump.fun and Ember
reward tokens are: whoever controls `/opt/sonata/crank-keypair.json` controls
those funds. Ordinary markets are unaffected. A market's payout wallet is fixed
onchain when it is registered, so losing or replacing the key strands every
Reward token market registered to it, and any rewards still in its account:
keep a secure offline backup of the key file.

**Without `DATABASE_URL`** (or before the indexer has created the tables) the
run logs `rewards action=skip` and pays nothing; claims and distributes still
run and the run does not fail.

**Check payouts.**

    journalctl -u sonata-crank --since today --no-pager | grep -E ' rewards? '
    curl -s 'https://sonata.umin.ai/api/index/rewards?pool=<pool address>'

Each payout transaction logs one line (`reward pool=… sig=… amount=…
recipients=… result=paid`), each reward market one summary (`rewards pool=…
owed=… action=pay holders=… payable=… noAta=… paidNow=… left=…`), and the run's
summary adds `rewardTxs` and `rewardAtoms`. The API answers from confirmed
payouts only: `{ pool, paid: "<atoms>", payouts, recipientsLast, lastPaidAt }`,
where `recipientsLast` is the recipient count of the most recent payout
transaction and `lastPaidAt` is in unix seconds (null before the first payout).
Amounts are quote atoms (8 decimals).

**Run once now:** `sudo systemctl start sonata-crank`.
**Stop it:** `sudo systemctl disable --now sonata-crank.timer` (re-running
`setup.sh` enables it again).
