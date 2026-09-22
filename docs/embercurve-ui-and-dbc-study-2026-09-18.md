# Embercurve UI and Meteora DBC study

Observed 18 September 2026. Read-only browser exploration; no wallet connected, token launched, or transaction signed. This is a product/UI study, not an audit or verification of reported traction.

## Sources and scope

- Official DBC explanation: https://docs.meteora.ag/core-products/dbc/what-is-dbc
- Markets: https://embercurve.fun/
- Launch studio: https://embercurve.fun/launch
- Inspected GPUCAT/NVDAx market: https://embercurve.fun/t/7XmaUUj2PQw2sQvPKkomKUQXFNtqzMo2DURHhrk7rnN2
- Platform treasury: https://embercurve.fun/vault
- Market's displayed external pool link: https://app.meteora.ag/dammv2/GNCR91v4bo6DG9ALVDUzNv5wMkawDMLPTA3JfFE95FA6

Visited markets, launch configuration, a graduated stock-quoted market, payout history, and the platform vault. Clicked curve and fee-module steps, DeepPool module, payout tab, and a hypothetical holding-size calculator. Visually inspected the loaded market screen. Portfolio, all reward modules, all transactions, and contracts were not exhaustively tested.

## What DBC actually provides

Meteora describes configurable virtual pools for initial price discovery. Buying accumulates quote assets; reaching a configured threshold permits migration into DAMM v2. Curves, fees and distribution settings are configurable. DBC is the launch phase; DAMM v2 is the subsequent liquidity venue. Neither inherently establishes stock backing or guarantees yield.

A website's USD market-cap graduation preset is not identical to the protocol's quote-asset threshold. Conversion assumptions must be explicit, particularly when the quote token itself changes price.

## Observed interface patterns

### Discovery

Markets expose stocks/memes/crypto categories, reward-mechanism filters, graduation states, sorting, watchlists and activity. Rows combine token identity, quote asset, market cap, volume, holders, fees and curve progress. A 'Cooking' section makes near-graduation launches discoverable. These are reasons to explore and return, beyond a static directory.

The homepage displayed aggregate launches, volume, fees and holders. These are website claims, not independently verified usage. Initial loading briefly showed zero metrics and older copy; hydrated content changed. Do not infer traction from the loading state.

### Launch studio

Five stages: token identity, pair, curve, fee module, review. A persistent summary shows economics while configuring. Observed graduation presets of $25k/$35k/$40k and 1%/2%/3% fees; these are their choices, not a recommendation for Stockroom.

Modules include holder rewards, DeepPool, Diamond Hands, milestone vault, conviction, booster, sistercoin, lottery, dip defender, buyer bounty, LP farm, buyback/burn, wallet split and keep fees. Availability in the interface does not prove implementation or reliability.

DeepPool's preview describes holder rewards during the curve followed by 70% pool depth / 30% LP rewards after graduation. This is a useful example of explaining phase-dependent behavior. Its contract behavior was not verified.

### A unified market detail

The GPUCAT/NVDAx page puts identity and mint, graduation badge, price, market cap, 24h volume, fees, holders and next payout above a candlestick chart and buy/sell panel. The trade panel exposes quote assets, amount presets, route, fees and slippage. Tabs expose trades, top holders, payouts and about information.

Reward information includes the pending pot, payout floor, eligible holders, paid versus carried-forward balances, and transaction links. A holding-size calculator illustrates a hypothetical share of recent fees. Its implied APR is an extrapolation, not a guaranteed return or evidence of sustainable demand.

This is the strongest lesson: trading activity, fees, recipients and receipts remain attached to one market. Users do not have to mentally connect several unrelated pages.

### Vault terminology

Ember's inspected Vault page is a public platform-wallet asset breakdown with quantities, values, composition and explorer links. It is not the same product as Stockroom's proposed depositor LP vaults. Do not copy the label while implying identical mechanics.

## Findings requiring caution

- Launch copy showed a 40% module / 40% platform / 20% Meteora allocation, while a preview showed $16 holders and $4 platform from $20 fees (80/20). Different screens contained inconsistent percentages. Confirm actual transaction accounting before implementing or publishing any analogous fee split.
- Explorer links and a DBC-to-DAMM-v2 footer support the site's claimed architecture but do not independently establish correct implementation, custody, automation or audits.
- Market cap, volume, holders, implied APR and payout counts were not independently reconciled onchain.
- A community token quoted in NVDAx is not NVDA stock ownership. Its price risk and reward source must remain distinct from the stock token.

## Stockroom gap and implementation priorities

1. Use one market identity across discovery, launch, trading, liquidity and rewards. Market routes must carry the same mint/pool/config identifiers, not substitute a global demo pool.
2. Build a complete market workspace: metrics, chart, buy/sell, lifecycle progress, fee allocation, liquidity, eligibility and payout receipts. Relevant actions should stay within that market context.
3. Make the launch studio preview actual configured economics before signing: quote mint, curve, quote threshold, fee split, migration destination and resulting LP ownership.
4. Finish and verify DBC graduation into DAMM v2. Track pre-graduation and post-graduation state explicitly; do not represent a separately seeded pool as a migrated one.
5. Show earned fees and historical fee APR with an expandable calculation. Keep LP fee yield distinct from holder rewards, token price appreciation and emissions. Insufficient observations should show unavailable or collecting data.
6. Present each wallet's positions, rewards received, pending eligibility and transaction history together. No manual recipient-and-amount form as the primary holder experience.
7. Verify one full lifecycle before expanding modules: launch, buy/sell, graduation, LP deposit, fees, compounding or payout, withdrawal, receipts.

## Current implementation limits

Stockroom has a Devnet ROOM/mSPY liquidity implementation and separate holder-reward work. The existing Earn pool was directly seeded; DBC migration is not yet the connecting path. Four stock liquidity markets were prepared but remain undeployed because the public Devnet RPC was rate-limited. Their preparation must not be presented as live markets. See stock-vault-devnet-rollout-2026-09-18.md.

No Stockroom code was changed as part of this UI study. This document supplies an implementation reference, not a completion claim.

## Bounty implication

The supplied Meteora bounty emphasizes original DBC configuration/use cases, technical soundness and utility after the hackathon. More screens alone do not satisfy that. A substantiated stock-quote launch configuration with a demonstrable migration and continuing liquidity lifecycle is stronger than a generic DBC wrapper. A stock-quoted community token must not be marketed as newly issued backed equity.
