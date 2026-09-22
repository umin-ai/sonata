# Stockroom connected lifecycle implementation

18 September 2026. Local-only delivery at http://localhost:5173/. This supersedes the earlier disconnected UI descriptions, not the underlying research or planned protocol architecture.

## Implemented in this pass

- Shared market identity and lifecycle navigation across discovery, positions, creator treasury, rewards and activity.
- `/create`: configure one fictional ROOM/stock market with SPYx, NVDAx, QQQx or TSLAx as quote; fund a seed position from personal demo cash; choose 0%, 50% or 100% fee reinvestment and an optional 7- or 30-demo-day seed lock. Creation terms persist and cannot be silently changed once funded.
- New sessions start with zero creator income. A simulated trade is required before creator revenue can be allocated. Existing sessions retain their original balances and fixture pool.
- Integer-cent accounting allocates LP fees by pre-trade capital, separates protocol and creator income, and splits net LP income between reinvested capital and claimable fees. Reinvested amounts cannot be paid twice. Rounding does not invent an external LP when none exists.
- A creator can allocate earned income to treasury cash, a member reserve and operations. Treasury positions have separate ownership and can reinvest, retain income, fund rewards or exit.
- A funded reserve becomes claimable member allocations, and the demo member can claim once into the same personal wallet used elsewhere.
- The creator seed lock is enforced by the local transition engine, not merely a disabled button. Additional capital and claimable income are not locked. Advancing the demo clock creates no earnings.
- Market receipts show before/after account balances. Reward receipts link to publication, reserve funding and fee-source receipts. References establish related funding operations, not a fungible-token lot attribution engine.
- Replaced the fabricated performance graph and headline fixture APYs with a fee scenario calculator. It takes capital, volume, duration, reinvestment and execution-cost inputs and plots lower/base/higher volume outcomes. It can show a loss when costs exceed fees.
- Local session schema migrated to version 3. A fresh-demo action saves a backup, with a visible restore action. Mutating controls wait for the saved state to load.
- Preserved the earlier credit sandbox and integration/bounty register. No publication or mainnet action occurred.

## End-to-end verification

15 model tests pass, covering conservation, separate ownership, duplicate claims, invalid inputs, stale pricing, prior-session migration, funded market creation, fee reinvestment, exact lock release and forecast arithmetic. TypeScript validation and the production build pass.

Browser verification followed this chain:

1. Back up the previous local session.
2. Seed ROOM/SPYx with $1,000, 50% reinvestment and a seven-day seed lock.
3. Verify withdrawal is unavailable before release.
4. Simulate $10,000 volume: $30 LP fees, $3 protocol fees, $27 personal LP earnings split into $13.50 reinvested and $13.50 claimable; $10 additional creator revenue.
5. Allocate the $10 into $6 treasury, $2 reward reserve and $2 operations.
6. Deposit treasury capital into its own position, generate another trade, and move only treasury claimable earnings into the reward reserve.
7. Publish and claim a funded member reward; verify another claim is disabled. Follow the receipt to its publication and reserve funding references.
8. Set forecast volume to zero and observe costs produce a negative result rather than fictional yield.
9. Advance to the lock-release day, fully withdraw personal capital, then claim its remaining income separately.
10. Reload and verify persistence. Restore the original session: personal wallet $10,050.76 and existing treasury state retained.

Responsive geometry checked at 320px across market details, community, portfolio, activity, integrations and creation summary; home checked at 390px and 1440px. No horizontal overflow. Visual inspection retained the existing dark glass identity. No new browser errors in the final verification window; transient HMR errors occurred while modules were being authored and resolved before final QA.

## Explicit implementation limits

This is a connected local simulation, not a deployed Solana vault. Market creation does not mint tokens, execute a bonding curve, graduate a DBC pool or create a real LP NFT. Positions are fixed-price capital records, not issued vault shares. The creator lock is a model rule, not an onchain restriction. Creator fees and other fee rates are example economics, not claims about Meteora or Clawpump configurations.

The forecast assumes full-range participation and fixed prices, holds other liquidity constant and rounds fee amounts to cents. It does not predict future demand or model slippage, price moves, impermanent loss, issuer corporate actions or eligibility. Reinvestment occurs on user-triggered simulated trades or manual actions; no keeper runs. Live APR/APY is not measured.

There is one configurable community market per local session. Existing stock-market fixtures remain separate from that creation flow. The earlier devnet credit program is not collateralized by these modeled positions. Sponsor integrations, real mint validation, share accounting, test-network venue execution, automation and live member distributions remain outstanding. No bounty eligibility is claimed.

## Reference and next protocol boundary

The [connected mechanics blueprint](../../docs/stockroom-connected-mechanics-blueprint-2026-09-17.md) records the source-derived architecture. Pinned source snapshots remain in the parent research directory. The app code is an independent model, not a claimed audited port of those contracts.

The next protocol milestone is the same complete lifecycle with real test-token movements: verified venue/configuration, two depositor accounts, shares, a separate trader, actual fee accrual, permitted reinvestment and partial/full exit. Creator and reward accounts must preserve the ownership boundaries demonstrated here. DBC launch/migration is a separate integration milestone and cannot be claimed from this local creation screen alone.
