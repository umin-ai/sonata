# Stockroom: live creator flow

Updated 18 September 2026 (Asia/Kuching). Local application: http://localhost:5173/ . No publication or mainnet transactions.

## What changed

The homepage now discovers real Stockroom markets from its deployed Devnet treasury program. `/create`, `/onchain?pool=...`, `/portfolio` and `/activity` share one signing wallet, transaction review, pending receipt recovery and confirmed-transaction refresh cycle. Neither headline balances nor these routes use the simulation ledger.

Creators can create a community-token/mSPY Meteora DBC pool from the browser. Creation uses the existing verified Stockroom configuration and the official Meteora DBC SDK 1.5.12. It requires two reviewed transactions: create the pool/mint, then initialize its Stockroom treasury and custody token accounts. The public launch draft persists locally so a refresh resumes activation rather than silently creating a second token. The mint signer is generated in the browser and is never sent to an application server. Creation and registration reviews estimate network fees and account rent using simulation.

Markets are scoped by their own pool, creator, recipient, mint and treasury PDA. Symbols and names come from onchain mint metadata; symbols do not determine identity. Only Stockroom's pinned program/config and mSPY mint are accepted. Wallet balances are read from verified token accounts. Portfolio reports the shared stock wallet balance once and reports creator reserves separately.

Trading, collection, allocation and creator withdrawal use the existing deployed contract and Meteora pool. This change did not upgrade any program or change the contract's ownership model. A retained reserve belongs under creator control; community-token holders have no redemption right.

## Verified example

- Browser wallet / creator / chosen recipient: `ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft`
- Market: CREW / mSPY, Stockroom Community
- Pool: `HhyKUtF8jZoMbmKD39Qo4DadrPCAdaF8KyrXT4LAMQbp`
- Treasury: `8fTeNQk5x3FjuxEhc26PT7QgABr28tSQUU5WkZcL4xVW`
- Program: `GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj`

Seven browser-signed operations confirmed: creation, treasury registration, buy, fee collection, allocation, creator withdrawal and sell. A refresh between creation and registration resumed the same pool.

The first buy spent 0.001 mSPY for 494,795.601663 CREW. Collection moved 0.000008 mSPY into custody. Allocation paid 0.000004 mSPY to the fixed recipient and retained 0.000004. The creator withdrew 0.000002, leaving 0.000002 in custody. Selling 10,000 CREW returned 0.00001980 mSPY and earned the next uncollected fee batch.

At verification, the browser portfolio correctly displayed 484,795.601663 CREW, its existing 269,748.064691 ROOM, 0.04902580 wallet mSPY, and the separate 0.000002 mSPY creator reserve. These are test assets, not dollar-valued TVL or real stock exposure.

`evidence/creator-market-lifecycle.json` contains independent RPC receipts and exact balance deltas. `../stockroom-protocol/scripts/verify-creator-lifecycle.mjs` verifies the seven receipts, mint conservation, initial issuance, fixed creator/recipient, custody reconciliation, and rejection of withdrawal by a different funded wallet. The script describes this fixed test case; later activity can legitimately change its expected current balances.

## Validation

TypeScript and the production build passed. All 20 existing unit/model tests passed; simulation tests are not evidence of deployed vault functionality. The new RPC audit independently verified seven browser-signed transactions and the deployed program's creator restriction. UI testing covered launch resume after refresh, wallet persistence across routes, portfolio reconciliation, an excessive-withdrawal rejection before signature, mobile navigation and 390px overflow checks on Markets and Activity. An intermediate development hot-reload context error was corrected by separating the stable wallet context from the provider; the app was reloaded and the affected routes retested.

## Prototype preserved

The former strategy workspace remains available at `/lab`, `/lab/create`, `/lab/portfolio`, `/lab/activity`, `/community` and `/vaults/...`. Its actions and figures remain explicitly simulated. Its own links use prototype routes. No saved simulation state or Rondo test assets were deleted or moved. Rondo is not a source of active Stockroom market data.

## Remaining work — not complete or submission-ready

- Real user LP deposits, share/position ownership and partial/full redemption.
- Verified DAMM v2 migration and post-migration trade/fee adapter. The shared DBC configuration permanently locks migrated liquidity; it is not a liquid LP vault.
- Actual reinvestment/compounding, costs and failure recovery; no keeper or measured live APY exists.
- Onchain public community reward funding, allocation and claims. Current allocation is a fixed recipient, not a public reward distributor.
- A self-service mock-stock faucet for new visitors. The test browser wallet was funded using the existing bounded Devnet funding script; the UI does not have an unrestricted mint or a server signing key.
- Broader issuer-backed token support, oracle/market-session policies, production protections and operational review.
- Bounty-specific Clawpump path and eligibility verification. Direct Meteora creation alone does not establish Clawpump bounty eligibility.

The earlier credit sandbox remains separate. These community token positions are not accepted as collateral there. Existing unit/model tests cover the simulation separately from this new onchain evidence. No mainnet readiness or profitability is claimed.
