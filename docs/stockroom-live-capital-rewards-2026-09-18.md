# Stockroom — connected capital and rewards

Verified 18 September 2026, Asia/Kuching. This supersedes earlier implementation notes listing creator reserve deployment and funded community claims as unfinished. The connected Devnet core works; production readiness and submission are separate milestones.

## The connected product

A creator launches a community-token/mSPY market, generates trading fees, collects them into a Stockroom treasury and allocates its fixed payout/reserve split. The creator can then use the available reserve in two ways: deploy it into a native LP position, or irrevocably commit a budget to named reward recipients under the current program. Members claim their funded allocation once. Portfolio, activity and transaction review share one signing wallet.

| Page | Live behavior |
| --- | --- |
| `/` and `/create` | Discover registered markets; create a DBC market and activate its treasury |
| `/onchain?pool=…` | Trade, collect fees, allocate, withdraw reserve |
| `/capital` | Select an owned treasury; deploy available mSPY into ROOM/mSPY liquidity |
| `/earn` | Deposit, trade, inspect native compounding and withdraw LP liquidity |
| `/rewards` and `/community` | Fund a campaign, claim an allocation, inspect each member's claim status |
| `/portfolio` and `/activity` | Wallet assets, reserves, LP positions and transaction receipts |
| `/lab`, `/lab/community`, `/vaults/…` | Separate simulations, excluded from live implementation claims |

Local app: http://localhost:5173/ . All assets used here are valueless Devnet mocks. Rondo is not part of Stockroom.

## Capital ownership and economics

Reserve deployment places the treasury withdrawal, position creation and liquidity deposit in one Solana transaction. Failure rolls the state changes back together. Matching ROOM comes from the creator's wallet; mSPY comes from the selected reserve. The review shows both token amounts. Any unused mSPY buffer stays in the creator's wallet.

The creator owns the resulting Meteora position NFT and controls withdrawal. It is not a community-owned treasury position. At present there is one supported strategy: ROOM/mSPY, pool `GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v`. A different community's mSPY reserve can enter this explicitly named strategy; the UI does not create a corresponding LP pool for every community.

The pool uses a 1% trading fee and native 100% net-LP-fee compounding. Protocol deductions apply. DBC trading fees fund the creator reserve; DAMM pool trading fees grow LP reserves. These are separate venues, and only activity in the DAMM pool earns fees for its LPs. There is no automatic DBC graduation adapter, LP-profit harvesting to the reward escrow, guaranteed APY or real-dollar TVL claim. Price changes and liquidity-provision losses can exceed fee income.

## Funded reward program

New deployed program: `6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L`.

The creator chooses one to eight distinct on-curve recipient addresses and positive mSPY amounts. Funding authenticates the Stockroom treasury and creator, withdraws the available reserve through a CPI into the existing treasury program, then transfers the exact budget into the campaign's token account. Both operations are atomic. No principal is taken from the creator's pre-existing mSPY balance.

The campaign stores fixed allocations and a claim bitmask. A recipient signs for its own allocation; the program verifies destination ownership and mint. Each allocation can be claimed once. Transfer failure cannot consume a claim. The current program has no cancellation, allocation editing or creator recovery instruction. Devnet upgrade authority remains retained, so this is not a claim of permanently immutable code.

Recipients are explicitly selected by the creator. This is not a token-holder snapshot, proportional staking distribution, a dividend, an equity right or an automatic entitlement of every meme holder. Funding consumes the selected reserve budget and must not also be counted as LP capital.

## Deployment and verification

The reward binary is 242,808 bytes, SHA-256 `7d0bcc333e635bf16861236e2bc5840910cb42ad43c0152099ed982ad4ece2e9`. The deployment script compared the deployed bytes with this local tested binary. Evidence: `stockroom-protocol/artifacts/stockroom-rewards-deployment.json`.

No existing treasury or credit program was upgraded. The currently rebuilt treasury binary differs from its historical deployed artifact; do not describe the entire program suite as source-matched. Actual reward CPI integration with the existing treasury deployment was separately exercised and reconciled.

- Protocol verification passes: 24 compiled-program tests and six credit-math tests. Six of the compiled tests cover reward funding, independent claims, unauthorized recipients/destinations, replay, overfunding, allocation validation, failed transfers and rollback after a later instruction fails.
- Frontend verification passes: 27 tests covering existing treasury/liquidity/strategy helpers and new allocation parsing; TypeScript checking and production build pass.
- Two funded Devnet campaigns executed with independent recipient wallets. Wrong-recipient and repeat-claim simulations failed as intended.
- The browser completed reserve deployment, full LP exit, campaign funding and its own claim. A separate test key claimed the second allocation.
- Mobile checks at 390 × 844 showed settled claims and the correct remaining reserve, without horizontal document overflow. Temporary viewport sizing was reset.

The independent read-only audit in `stockroom-protocol/scripts/verify-connected-journey.mjs` reconciles eight successful transactions in `cash-access/evidence/connected-journey.json`.

### Exact browser journey

Creator: `ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft`.

CREW treasury: `8fTeNQk5x3FjuxEhc26PT7QgABr28tSQUU5WkZcL4xVW`.

Position: `3WTQthKRanYwZAaYUFBUqfvU7a19wpKLTLV7JawieWNB`.

Campaign: `DKxuabBy6yUHZ3nyQeuNR7WQnM8UzWfz2SV2sL8ddBT2`.

mSPY has eight decimals. Starting available reserve: 200 atoms. Deployment debited 100 atoms: 99 went into the LP and one remained in the creator wallet. Funding then debited 80 atoms into the campaign, with zero net mSPY movement in the creator wallet. Two recipients each claimed 40 atoms, leaving escrow zero, claim mask three and treasury reserve 20 atoms. Full LP exit left zero unlocked liquidity and returned 98 mSPY atoms plus ROOM; native rounding means this need not equal the original deposited atoms.

These tiny amounts deliberately test exact accounting. They are test traffic, not demand, meaningful returns or external TVL.

## What is still required

1. A public repository or judge-accessible demo/video and final submission. The local build has not been submitted or published by this milestone.
2. Real issuer-token validation, transfer restrictions, suitable liquidity, production wallet/RPC operations and security review before real funds.
3. A product decision on community-owned capital versus the current creator-owned positions; automated holder snapshots and multi-pool routing are not implemented.
4. User validation: whether creators fund rewards repeatedly and whether recipients retain or use stock exposure. Reward distribution alone does not establish demand for equity investment tools.

## References and evidence

- [Previous live liquidity implementation](stockroom-live-liquidity-2026-09-18.md)
- [Current submission draft](stocklana-submission-draft-2026-09-18.md)
- [Reconciled connected receipts](../evidence/connected-journey.json)
- [Anchor token-transfer documentation](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens)
- [Solana transaction atomicity](https://solana.com/docs/core/transactions)
- [Meteora DAMM v2](https://github.com/MeteoraAg/damm-v2) and [official SDK](https://github.com/MeteoraAg/damm-v2-sdk)

The inspected upstream source and mature native LP accounting informed the integration. Stockroom's contribution is its treasury/reward programs, connected transaction construction, ownership review, receipt reconciliation and product interface; it does not claim to have invented Meteora's compounding mechanism.
