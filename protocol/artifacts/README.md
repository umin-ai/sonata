# Artifacts

Evidence written by the scripts in `scripts/`, all on Solana Devnet. HANDOFF.md cites most of these files; each transaction in them can be opened on https://explorer.solana.com with `?cluster=devnet`.

| File | What it records | Written by |
| --- | --- | --- |
| `build.json` | Source and binary hashes of the last local build | `scripts/build.mjs` |
| `deployed-bytes-check.json` | Deployed program bytes vs. the local build, and the upgrade authority | `scripts/verify-deployed-bytes.mjs` |
| `handoff-check.json` | Status of every transaction and account HANDOFF.md links | `scripts/verify-handoff.mjs` |
| `stockroom-treasury-deployment.json` | Treasury deployment on 17 September and the rebuild mismatch (HANDOFF.md §1) | `scripts/stockroom-treasury-deploy.mjs` |
| `stockroom-rewards-deployment.json` | Rewards deployment on 17 September and its byte proof. `deploySignature` was copied by hand from `holder-deployment-log.txt` (removed; at commit `0d9046a`); the script now keeps it on a rerun and replaces it only when it deploys. Later redeploys are in HANDOFF.md §6.1 | `scripts/rewards-deploy.mjs` |
| `stockroom-treasury-market.json` | Flagship ROOM/mSPY pool and treasury | `scripts/stockroom-treasury-demo.mjs` |
| `holder-rounds/` | Holder-reward snapshots, rounds and deliveries on the flagship market | `scripts/holder-operator.mjs` |
| `stockroom-rewards-lifecycle.json` | Reserve-funded reward campaign and recipient self-claim | `scripts/rewards-lifecycle.mjs` |
| `stockroom-rewards-browser-peer.json` | Second recipient's claim on a browser-created campaign | `scripts/claim-test-reward.mjs` |
| `stockroom-liquidity-market.json`, `stockroom-liquidity-lifecycle.json` | Separate DAMM v2 pool: creation, deposits, a swap, exits | `scripts/liquidity-lifecycle.mjs` |
| `stockroom-liquidity-verification.json` | Read-only re-check of that lifecycle | `scripts/verify-liquidity-lifecycle.mjs` |
| `stockroom-trader-funding.json` | Test grant to a trader wallet | `scripts/fund-stockroom-trader.mjs` |
| `configurable-launch-proof.json`, `configurable-launch-proof-post-upgrade.json` | Per-launch DBC configs and treasury registrations | `scripts/verify-configurable-launch.mjs` |
| `fee-path-proof.json` | Buy, claim, 50/50 split and creator withdrawal on the 3% pool | `scripts/verify-fee-path.mjs` |
| `refrain-launch-proof.json`, `refrain-fee-path.json` | Refrain launch and its 100% payout | `scripts/verify-configurable-launch.mjs`, `scripts/verify-fee-path.mjs` |
| `graduation-proof.json`, `graduated-trade-proof.json` | DBC to DAMM v2 graduation and a trade on the graduated pool | `scripts/verify-graduation.mjs`, `scripts/verify-graduated-trade.mjs` |
| `dollar-launch-mqqq.json`, `stock-floor-launch.json` | Dollar-priced launches | `scripts/verify-dollar-launch.mjs` |
| `stock-floor-proof.json` | Stock Floor: holder burn and the refused creator withdrawal | `scripts/verify-stock-floor.mjs` |
| `stock-floor-app-flow.json`, `app-launch-floor-profile.json`, `app-launch-s3-e2e.json` | Launches and trades driven through the Sonata app | Recorded from the app |
| `creator-position-proof.json` | 50/50 graduation and the creator's position claim | `scripts/verify-creator-position.mjs` |
| `graduated-claim-proof.json` | `claim_graduated` on the Vault's locked position | `scripts/verify-graduated-claim.mjs` |
| `standard-config-proof.json` | Registration refused with `NonStandardConfig` | `scripts/verify-standard-config.mjs` |
| `mock-quote-mints.json` | Mock stock quote mints | `scripts/create-mock-quote-mints.mjs` |
| `partner-metadata.json` | Meteora partner metadata naming Sonata | `scripts/create-partner-metadata.mjs` |

Evidence for the retired credit prototype was removed with its source on 26 September 2026 and remains at commit `0d9046a`.
