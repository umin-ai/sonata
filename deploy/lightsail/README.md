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
   waiting. After graduation DBC partner fees stop and the Sonata Vault's
   permanently locked DAMM v2 position earns the market's fees instead:
   `claim_graduated` pulls them into the treasury. Each pass simulates it
   first and only sends it when at least `CRANK_MIN_ATOMS` would arrive; it
   shares the transaction with the distribute below (975 bytes at most). The
   Vault's position in each graduated pool is found once (every position NFT
   the Vault holds, two RPC calls for all new graduates) and cached in the
   `graduated_positions` table.
2. `distribute` splits whatever is claimed but unallocated by the treasury's
   mode: refrain 100% to the payout wallet, duet 50/50, floor 50% payout and
   50% Stock Floor; `distribute_split` does it for the modes with a Sonata
   share (standard 50% payout, 50% Sonata). If the payout wallet has no
   quote-token account yet, the same transaction creates it.
3. Reward token payouts (below), for markets whose payout wallet is the crank
   key itself, by each market's fee module.
4. Graduation airdrops (below), for markets whose DBC config names the crank
   key as leftover receiver.

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
quote-token account, and `indexer/rewards.mjs` passes it on by the market's
fee module (see Fee modules below), after every market's claim/distribute.
The default module, `holders`, pays the token's holders pro rata in the quote
token:

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

### Fee modules

Each Reward token names its module in its metadata JSON (the Metaplex `uri`
of the base mint), written once at launch: `"sonata": { "feeModel": ... }`.
The crank reads it once per pool (only from
`https://d3lwm4c3ge2mv2.cloudfront.net/tokens/`, `https://devnet.irys.xyz/` or
`https://gateway.irys.xyz/`, at most 20 KB, redirects only within those) and
caches it in `market_fee_models`. No metadata, no `sonata` key, invalid JSON
or an unknown model means `holders`, cached like any answer. A transient
failure (network, timeout, HTTP 5xx/408/429, RPC) is not cached: that market
is skipped with `reason="fee model not read (…)"` and read again next pass,
its funds still owed, so a network blip never pays a pot to the wrong module.
To have a pool read again, delete its row:
`delete from market_fee_models where pool = '<pool>';`

Every module uses the same ledger (owed = `total_distributed` − paid, the
`REWARD_MIN_ATOMS` threshold, the solvency check across markets sharing a
quote token, and per-market isolation); `reward_payouts.module` and `detail`
say what each transaction did.

- **holders**: as above.
- **buyback** (Buyback & burn): buys the token with what is owed and burns
  every token bought. On the curve it swaps on the market's DBC pool, after
  graduation on the graduated DAMM v2 pool; exact-in, never more than owed,
  minimum out 2% below the SDK quote. Near the end of the curve the buy stops
  just short of the migration price and the rest stays owed. The exact amount
  the swap delivers is read from a simulation, and the classic SPL
  `burn_checked` of that amount goes in the same transaction (about 720
  bytes). If the price moves before it lands, a worse price fails the whole
  transaction (nothing spent) and a better one leaves a surplus that is burned
  right after. The first buyback of a market creates the crank's base-token
  account (about 0.002 SOL).
- **topBuyers** (Top Buyer Bounty): each pass is a round, from the end of the
  last paid round to a minute ago, but never more than 60 minutes back. From
  the indexer's `trades` table, net = quote spent on buys − quote received from
  sells per trader; the treasury's creator, the crank key, the Vault, its admin
  and non-wallet addresses are excluded. The top three with net > 0 get 50% /
  30% / 20% of what is owed, rounded down, to their existing quote account.
  A missing winner or quote account rolls that share over; with no net buyer
  nothing is paid and the round does not end.
- **lpFarm** (LP Farm): holders while on the curve (exactly as `holders`).
  After graduation it pays the DAMM v2 pool's liquidity providers pro rata to
  each position's unlocked liquidity, to the holder of the position NFT (DBC's
  two locked graduation positions have none); the crank key, the Vault, its
  admin and non-wallets are excluded, existing quote accounts only. With no
  eligible position it pays holders instead.
- **split**: up to five wallets from the metadata
  (`"split": [{ "wallet", "weight" }]`, weights 1-100), paid owed × weight ÷
  total, creating a missing quote account (the crank pays about 0.002 SOL of
  rent). A split that fails validation (not a wallet, a duplicate, a Sonata or
  program address, a bad weight, 0 or more than 5 entries) pays nobody, logs
  `invalid split`, and its funds stay owed.
- **diamond** (Diamond Hands): `holders`, with each balance weighted by how
  long the wallet has held: 1x under 24 hours, 1.5x from 24 hours, 2x from 3
  days, 3x from 7 days. The clock starts at the later of the wallet's first
  indexed buy and its last indexed sell (a sell restarts it); a holder without
  indexed trades is 1x.

### Graduation airdrop

A launch with the airdrop sets its DBC config's leftover receiver to the crank
key and leftover to 5% of supply. Once such a market has graduated, the crank:

1. withdraws the leftover (`withdraw_leftover`, permissionless; the tokens land
   in the crank's base-token account) and records exactly what that
   transaction moved, from its token balances. A withdrawal someone else sent
   is found among the crank base account's transactions;
2. snapshots the holders once (holders rules: wallets only, not the crank, the
   Vault or its admin, at least 0.01% of supply, top 200) into
   `airdrop_payouts`, withdrawn × balance ÷ total each, rounded down, to the
   token account the holder already holds the token in;
3. sends the unpaid rows (classic SPL `transfer_checked`, 20 per transaction).
   Rows are marked pending with their signature before sending, so a crash
   resumes without paying anyone twice. Never more than was withdrawn; if the
   crank holds less than is still to send, nothing is sent.

`airdrop_state` has one row per such pool (withdrawn amount, snapshot time,
done). A buyback never burns what the airdrop still holds for its pool.

**Custody.** For these markets the crank key briefly holds the holders'
rewards: from the `distribute_split` that pays it until the payout transaction
a few seconds later, or until the next run when a market is under the threshold
or a holder was skipped. Reward tokens are custodial, as pump.fun and Ember
reward tokens are: whoever controls `/opt/sonata/crank-keypair.json` controls
those funds. Ordinary markets are unaffected. A market's payout wallet is fixed
onchain when it is registered, so losing or replacing the key strands every
Reward token market registered to it, and any rewards still in its account:
keep a secure offline backup of the key file.

Buyback tokens are held only inside their transaction (bought and burned
together); airdrop tokens from the withdrawal until they are sent.

**Without `DATABASE_URL`** (or before the indexer has created the tables) the
run logs `rewards action=skip` (and `airdrop action=skip`) and pays nothing;
claims and distributes still run and the run does not fail.

**Check payouts.**

    journalctl -u sonata-crank --since today --no-pager | grep -E ' (rewards?|feemodel|airdrop|graduated) '
    curl -s 'https://sonata.umin.ai/api/index/rewards?pool=<pool address>'

Each payout transaction logs one line (`reward pool=… sig=… amount=…
recipients=… result=paid`), each reward market one summary (`rewards pool=…
owed=… action=pay holders=… payable=… noAta=… paidNow=… left=…`), and the run's
summary adds `rewardTxs` and `rewardAtoms`. The API answers from confirmed
payouts only: `{ pool, paid: "<atoms>", payouts, recipientsLast, lastPaidAt }`,
where `recipientsLast` is the recipient count of the most recent payout
transaction and `lastPaidAt` is in unix seconds (null before the first payout).
Amounts are quote atoms (8 decimals). It also returns `feeModel` (null until
the crank has read the metadata) and, by module:

- buyback: `burned` (base atoms, 6 decimals, all confirmed burns) and
  `lastBuyAt`;
- topBuyers: `winners` of the last paid round (`[{ trader, amount }]`) and
  `lastRoundAt` (that round's end);
- lpFarm: `status`, `"holders"` or `"lps"` (who the last pass paid);
- split: `recipients` (`[{ wallet, weight, paid }]`);
- diamond: `multipliers`, the count of holders at each multiplier in the last
  payout (`{ "1": n, "1.5": n, "2": n, "3": n }`);
- any market with the graduation airdrop: `airdrop: { status: "waiting" |
  "sent", amount, recipients, sentAt }` (amount in base atoms, null until
  withdrawn).

Burn-only buyback transactions move no quote and are not counted in `payouts`.

**Deploying this version.** Re-run `setup.sh` as above: it pulls `main`,
installs, and restarts `sonata-indexer`, whose `migrate()` adds the new
columns (`reward_payouts.module/detail`, `reward_pending.module/detail`) and
tables (`market_fee_models`, `airdrop_state`, `airdrop_payouts`,
`graduated_positions`); existing rows are kept and read as `holders`. Until
the indexer has run it, the crank logs `rewards action=skip reason="reward
ledger tables missing or out of date…"` and pays nothing. No new settings.
The first pass reads each Reward token's metadata once (one batched RPC call
plus one HTTPS request per token). A safe first look:
`CRANK_DRY_RUN=1` in `/opt/sonata/crank.env`, then
`sudo systemctl start sonata-crank` and read the log.

**Run once now:** `sudo systemctl start sonata-crank`.
**Stop it:** `sudo systemctl disable --now sonata-crank.timer` (re-running
`setup.sh` enables it again).
