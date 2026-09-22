# Stockroom: connected product and full coverage register

Updated 17 September 2026. Local prototype at http://localhost:5173/. This iteration is not published.

## The product decision

Stockroom explores a connected capital lifecycle for tokenized-stock markets and creator communities: discover a market, supply liquidity, account for real sources of fees, decide where creator revenue goes, deploy treasury capital, reinvest earnings or publish funded member rewards, and exit with a readable receipt.

The principal submission story remains **credit and yield**, specifically productive liquidity and reinvestment. Trading infrastructure, creator distribution and investment controls support that story. Multiple screens or sponsor logos do not establish multiple working integrations or bounty eligibility.

A community token paired with a stock is one distinct, speculative strategy category. It is not automatically stock-backed and does not give its holders equity ownership or claims on the creator treasury. An LP position is not equivalent to owning a fixed share count.

## What now works together locally

- Four stock/USDC models: SPYx, NVDAx, QQQx, TSLAx.
- One fictional community/stock model: ROOM/NVDAx, with a Community filter, distinct pair display, speculative risk and no assumed APY.
- Personal deposits, fee earnings, optional manual reinvestment, claims, withdrawals and receipts.
- A creator revenue policy: 0–80% treasury cash, fixed 20% community reserve, remainder operations.
- Separate treasury positions in the same five markets. Allocating revenue creates cash, not imaginary stock purchases; a subsequent treasury deposit creates the LP position.
- A single simulated trade batch allocates LP fees proportionally to both personal and treasury capital alongside fixture external liquidity. It does not create one full fee pool per owner.
- Community-market activity creates a separate modeled creator fee that can fund another revenue allocation. Stock/USDC activity does not create that creator fee.
- Treasury earnings can be compounded, reclaimed as treasury cash or explicitly transferred to the reward reserve. Personal LP earnings cannot fund those rewards.
- Publishing rewards moves reserve into claimable balances against a clearly fictional member snapshot. Claiming moves an existing balance once; it does not mint another reward.
- The demo member's claim reaches their demo wallet. Other recipient balances are displayed separately; the model supports their claims for conservation tests.
- Treasury capital can be withdrawn without consuming separately unclaimed earnings.
- Stale-price flags are shared across both owners and enforced by the transition function. Simplified fixed-price withdrawals and claims remain available.
- Activity receipts cover each transition. The fee ledger separates pool inflow, external LPs, protocol fees, net managed LP earnings and creator fees.
- Older browser sessions migrate into the new ledgers without resetting saved balances. The new global fee ledger starts at upgrade; it does not reconstruct historical pool fees from v1 receipts.

## Example walkthrough

1. Open Community. The initial fixture provides $500 creator revenue, unless an earlier demo already allocated it.
2. Allocate revenue at 60 / 20 / 20: $300 treasury cash, $100 reward reserve, $100 operations.
3. Deposit $100 treasury cash into ROOM/NVDAx.
4. Simulate $100,000 trading volume from that treasury position.
5. The model creates $300 LP fees and a separate $100 creator fee. The treasury receives only its proportional net LP fee share, not the whole $300.
6. Send treasury earnings to rewards or compound them. Allocate the new creator revenue if desired.
7. Publish reserve against the 50 / 30 / 20 example membership snapshot. Claim the demo member's share.
8. Withdraw treasury capital, inspect personal Portfolio separately and follow all receipts in Activity.

Rates above are illustrative product assumptions, **not claimed Clawpump/Meteora economics**. All money is stored as integer cents. Current pool pricing is fixed; LP token inventory, slippage, price P&L and impermanent loss are not implemented.

## Every product layer and its actual status

| Layer | Present implementation | Next meaningful proof |
|---|---|---|
| Discovery and market identities | Five fixtures; pair-aware cards, categories, risk | Issuer/mint registry, verified pool addresses, decimals and token program compatibility |
| Liquidity and vault ownership | Local personal/treasury ledgers and proportional fee model | Real pool adapter, on-chain vault shares, bounded deposits and withdrawals |
| Treasury allocation | Local percentage policy; separate cash and LP positions | Authorized treasury accounts, policy enforcement and real execution |
| Creator revenue | Initial fixture and separate community-market fee model | Collect actual authorized creator fees with clear custody and destination rules |
| Community rewards | Reserve → snapshot allocation → claim accounting | Eligibility rules, live snapshot/proofs, distribution contract, replay protection |
| Compounding | Explicit manual reinvestment of earned fees | Harvest adapter, keeper, cost threshold, slippage bounds and failure handling |
| Analytics | Principal, unclaimed earnings, lifetime fees, volume, receipts | Mark-to-market NAV, net P&L vs holding, range exposure, realized costs, measured APY |
| Pricing | Persisted stale-price scenario | Supported live feeds, units, confidence, market session policy, deviation controls |
| Launch lifecycle | DBC configuration preview only | Verified creation → bonding activity → graduation → post-migration pool → strategy onboarding |
| Borrowing/lending | Earlier credit sandbox retained at /devnet | Separate review of existing deployment; new LPs are not integrated as collateral |
| Multi-issuer investing | Research retained | Issuer-aware asset identity, restrictions, recurring contribution and basket execution |
| Pre-IPO assets | Research cards | Exact rights/mints/eligibility and substantive executable integration |
| Yield separation | Pendle-inspired research retained | A genuine recurring yield source before PT/YT-style financial engineering |
| Ownership / permissions | Roles explained; all local actions available to demo user | Wallet authentication, signer checks, treasury authority and membership rights |
| Open source quality | Local implementation, tests, references | Readable public repository, licensing review, setup docs, deployment reproducibility and security review |

Keeping a layer in this register does not mean it is included in the current working protocol. The earlier credit sandbox is a separate experiment, not evidence that these new vault flows transact on Solana.

## Bounties remain accounted for

These statuses summarize the existing research, not a new eligibility ruling. Reconfirm current official requirements before submission.

| Opportunity | Actual current status | Required proof still missing |
|---|---|---|
| Stocklana main track | Product prototype and candidate narrative | Working Solana execution, documented user need, polished demo and submission |
| Meteora DBC | Configuration preview | Actual DBC use and launch/graduation evidence; DAMM-only LP use is insufficient |
| Clawpump | Route unresolved | Verified stock-paired launch satisfying both Clawpump and Meteora requirements; no spend until route is established |
| Pyth | Local stale-price scenario | Real supported feed integration and meaningful safeguards |
| PreStocks | Planned asset registry extension | Substantive use of an exact supported asset and issuer terms |
| Tessera | OpenAI/Kalshi research cards | Substantive supported T-Token integration |

No prize, eligibility, sponsor relationship or award stacking is assumed. No mainnet launch, payment, purchase or signature occurred in this iteration.

## Inspiration retained, with its purpose

- **Beefy:** understandable strategy actions, harvesting/compounding and transaction review. Official frontend inspected previously: https://github.com/beefyfinance/beefy-v2
- **Superform:** vault discovery, strategy presentation and deposit experience. https://github.com/superform-xyz
- **Meteora:** distinguish bonding curves, migration and post-launch liquidity. Official SDK previously inspected: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk
- **Clanker / Flaunch / Bags:** explicit creator revenue ownership and destinations. Their availability and economics must be verified per adapter.
- **StonkFun / stock reward distribution:** a potential acquisition channel, not proof of intentional stock-investor demand.
- **Fluid:** investigate productive liquidity and credit; its mechanics are not implemented here.
- **Pendle:** explicit principal/yield distinctions; tokenized equities do not automatically offer a transferable recurring yield stream.
- **Glider:** allocation and portfolio controls retained for future treasury policies.
- **Kamino / Jupiter lending / Morpho / Spout:** collateral and borrowing precedents behind the retained credit work. New vault collateral support is not presumed.

This is independently written prototype code. No audited contract has been ported merely by reproducing its interface.

## Research continuity

Prior material remains in the parent workspace and should be shared alongside this implementation register when handing work to another model:

- `../docs/stockroom-stocklana-product-decision-2026-09-17.md`
- `../docs/stockroom-bounty-expansion-plan-2026-09-17.md`
- `../docs/stockroom-tvl-first-pilot-2026-09-17.md`
- `../docs/stockroom-adapt-to-compete-2026-09-17.md`
- `../research/stockroom-path-pressure-test-2026-09-17.md`
- `../research/stockroom-solana-competitive-overlap-2026-09-17.md`
- `../research/creator-lifecycle-2026-09-17/README.md`
- `../research/claude-reward-routing-assessment-2026-09-17.md`
- `../research/clawpump-route-verification-2026-09-17.md`

Those paths are relative to the `cash-access` project root, not this document's directory. Keep the distinction between observation, user-supplied claims and verified source evidence in those records.

## Validation

Automated tests cover personal and treasury accounting, shared fee allocation, integer-cent conservation across the entire reward lifecycle, repeat-claim rejection, stale-price restrictions and previous-session migration. Browser testing covers treasury deposit, trade simulation, reward funding, publishing and claim, plus responsive layout. All eight tests passed. Type checking and the production build passed. Desktop (1440px) and phone (390px) layouts were checked without document overflow; no browser console errors were observed. The build retains the existing large-chunk warning from the combined application dependencies.
