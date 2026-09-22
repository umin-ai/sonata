# Stockroom — Stocklana submission draft

Prepared 18 September 2026. Local draft only: not submitted, published or accepted for any bounty.

## One sentence

Stockroom connects stock-quoted community trading revenue to creator liquidity positions and funded member rewards, with every movement visible on Solana.

## Problem and user

For a community-token creator using stock tokens as a quote asset, trading, fee collection, treasury use and member payouts can become disconnected jobs. Stockroom gives that creator an explicit path from earned fees to a liquidity position or an already-funded reward budget, and gives each recipient a verifiable claim.

This is a product hypothesis, not established product-market fit. Growth in wallets receiving stock-token rewards does not by itself prove intentional stock investment demand. The first validation target is creators who actually repeat the collect → deploy or reward cycle, followed by members who claim and return.

## Working demonstration

The Devnet app launches community-token/mSPY DBC markets, collects fees into a Stockroom treasury and allocates its configured payout/reserve split. From the same wallet, creators can atomically deploy reserves plus matching wallet ROOM into a native Meteora LP position, or fund fixed mSPY allocations in a Stockroom reward escrow. Members sign to claim once. LP owners can withdraw, while Portfolio and Activity show balances, positions and transaction receipts.

Primary wedge: **Credit and yield**, focused on fee-backed liquidity and rewards. Trading and consumer claim flows support that single demonstration. This version does not lend against LP positions or combine all historical Stockroom prototypes into one live protocol.

## Why Solana

The asset accounts, treasury, campaign escrow and native liquidity positions live on the same network. Transactions compose reserve withdrawals and their destination operations atomically, with small token amounts accounted for exactly. There is no internal off-chain reward balance pretending to be funded on-chain.

## Contribution and attribution

Stockroom contributes its treasury and reward programs, connected creator/member workflow, ownership checks and transaction review/recovery layer. Meteora supplies DBC launch infrastructure and DAMM v2 position and compounding mechanics; Anchor and Solana libraries supply program/client infrastructure. Package manifests and lockfiles record exact dependencies. Preserve upstream licenses and notices when preparing the public repository. Stockroom's program source uses GPL-3.0-or-later notices; review the final repository's license coverage before publication.

## Proof, not projected economics

- Eight independently reconciled transactions for the latest connected milestone, in addition to earlier creator-market and liquidity lifecycle evidence.
- Reward program deployed bytes match the tested local binary.
- 24 compiled-program tests, six math tests, 27 frontend tests, TypeScript check and production build pass.
- Browser proof includes reserve-funded LP creation and full exit, reward funding, a claim, and a separate recipient's claim. Escrow reaches zero; the remaining reserve reconciles.

All tokens are valueless mocks. No organic volume, production TVL, profitable APY, mainnet readiness, issuer backing, independent audit or automatic holder snapshot is claimed. Creator-owned LP positions are not community-owned assets. The current LP is a separately seeded ROOM/mSPY strategy, not automatic graduation of each launch pool.

## Three-minute demo script

1. **0:00–0:25 — One user, one problem.** Introduce a creator earning stock-token-denominated trading fees. Show the market directory and the Devnet label.
2. **0:25–0:55 — Market revenue.** Open the CREW market, show the treasury and receipts for trade, fee collection and allocation. If replaying recorded transactions, label them as recorded evidence.
3. **0:55–1:30 — Put the reserve to work.** Open Creator capital, select the reserve and review the named ROOM/mSPY strategy. Explain that the creator supplies matching ROOM and owns the resulting position. Show its confirmed creation and exit receipts.
4. **1:30–2:15 — A funded community benefit.** Open Rewards, show the fixed recipients, campaign budget and both settled claims. Show escrow zero and the exact remaining reserve.
5. **2:15–2:45 — Follow the money.** Open Activity and an Explorer receipt. Explain atomic funding and rejection of duplicate/unauthorized claims.
6. **2:45–3:00 — What comes next.** State the need for real issuer assets, security review and recurring creator use. Do not conclude with projected APY or artificial TVL.

## Sponsor fit checked against the official page

Read 18 September 2026. The [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana) shows September 25 in its header but September 18, 4pm ET in its rules timeline. The cutoff remains inconsistent; no September 25 hour is verified. It lists a $100k main pool and $26k in cash bounties.

| Sponsor | Current requirement/fit |
| --- | --- |
| Meteora — $5k | DBC-focused. Actual DBC integration exists; Devnet mock eligibility and originality remain unconfirmed. DAMM integration alone does not establish this fit. |
| Clawpump — $5k | Requires Clawpump plus Meteora stock-paired launch. Stockroom has no Clawpump launch; not met. |
| PreStocks — $10k | Requires PreStocks integration, with a competing pre-IPO token exclusion. Not integrated. |
| Tessera — $6k | Requires specified T-Tokens. Not integrated. |
| Pyth — noncash | Requires meaningful live-data use. Not part of this core. |

The page accepts repository, live-product or video evidence and requires teammates on a single team entry. These are dated observations, not sponsor approval.

## Remaining submission fields

| Field | Status |
| --- | --- |
| Public code URL | Pending; no verified public remote available |
| Judge-accessible app or video URL | Pending; current app is local only |
| Team members and roles | To be entered by the team |
| Final deadline | Confirm the conflicting official page fields |
| Sponsor selections | Only claim requirements actually satisfied |
| Actual submission | Not sent |

## Local evidence

- [Connected implementation](stockroom-live-capital-rewards-2026-09-18.md)
- [Transaction audit](../evidence/connected-journey.json)
- [Frontend tests](../evidence/connected-ui-tests.txt)
- [Production build](../evidence/connected-build.txt)
- Protocol `artifacts/verification.json`, `artifacts/stockroom-rewards-deployment.json` and `artifacts/stockroom-rewards-lifecycle.json`
