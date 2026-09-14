# Rebuild validation — 14 September 2026

## Interface reference

Inspected Morpho's live [variable-rate market directory](https://app.morpho.org/variable) and the selected USDC/cbBTC market on 14 September. Adopted the market-directory → selected-market → action-panel pattern, explicit loan/collateral assets, APY and LTV context, and separate portfolio navigation. Stockroom preserves its own visual design and supports one verified credit pair. No unsupported markets, historical series or lending yields were invented to fill the interface.

## Verified locally

- Twelve calculation and example-ledger tests passed. The full cycle conserves available cash and stock, charges accrued interest once, retains collateral during partial repayment, and releases collateral only after zero debt.
- Browser example: open an 8 NVDAx / 500 USDC loan; advance seven days; repay 100 USDC; add 1 NVDAx; repay the remaining debt; release all nine NVDAx. The final available stock returns to 10 NVDAx and cash reflects the interest paid. Five activity entries persist across reloads.
- A 1,100 USDC request against 8 NVDAx exceeds the illustrative opening limit and disables loan review. A 60% decline crosses the liquidation threshold and changes the warning and chart.
- Narrow mobile layout: 375px document width, no horizontal overflow. Desktop layout also inspected. These are browser checks, not a comprehensive accessibility audit.
- Live `/api/market` returned reserve/oracle-derived data and a timestamped expiry. UI distinguishes current and expired reads.
- PublicNode blocked owner-index queries; the official public endpoint also returned 403 in the Worker runtime. The default read now uses explicitly labeled primary associated token accounts. Full token-account enumeration requires a configured provider.
- `/api/wallet` returned a scoped empty balance for an unfunded generated test address; `/api/position` returned `exists: false`. Populated wallet/position responses and a real wallet connection have not been exercised in this rebuild.
- `POST /api/prepare` returns 503 with the read-only mainnet explanation. The active wallet hook exposes no signing function.

## Remaining limitations

The example is end-to-end only as a simulation. No real loan, sale, repayment or withdrawal has been submitted. Kamino is the execution destination. The app has no testnet lending deployment. Public API reliability and issuer eligibility remain deployment concerns for a financial execution release.

Live position estimates cover a deliberately narrow position type and the last reserve refresh. They do not certify current executable limits, a repayment amount or liquidation safety. No user-research result establishes recurring demand or willingness to pay.
