# Holder rewards: UI-first study — 18 September 2026

## Scope and evidence

User asked to study the reference interfaces before contracts. No contract or app implementation changed during this study. Official StonkFun homepage and Rewards screen were inspected through the browser, including a screenshot. The unofficial stonk.fyi screen was identified as unofficial, not used as the official design. A guessed stonk.fun domain failed DNS; the saved research supplied the correct www.stonkfun.xyz address. Search surfaced similarly named airdrop sites; these were not treated as official references.

Browser control subsequently timed out repeatedly on Flywheel navigation and Chrome fallback. Therefore token-level, Flywheel and launch interactions were not freshly verified. Clawpump launch web retrieval exposed login only. Prior dated browser observations are explicitly separated below. No wallet connection, signing, launch or purchase occurred.

## Fresh observations: official StonkFun

Sources: https://www.stonkfun.xyz/ and https://www.stonkfun.xyz/rewards

Homepage navigation separates Rewards, Flywheel, Revenue and Launch token. Market cards associate a named token with its quote asset, issuer category, market cap and volume. Reward and ecosystem-buyback badges are separate: a holder distribution and a buyback are different benefits. Quote-asset provenance labels distinguish stocks from custom tokens.

Rewards is a public discovery/transparency page, accessible without wallet connection. Visual hierarchy: short heading and explanation, four equal summary cards, then a distribution area. Summary labels are total distributed, distributions, paying tokens and holder payouts. No campaign-application or recipient-entry workflow appears in this public view.

The explanation says holders receive the paired quote token pro-rata. It distinguishes newer v3 launches funded by an immutable 1% or 3% transfer tax from earlier launches funded by 85% of a 4% pool trading fee. This is publisher UI language, not a contract audit. It describes accumulating a sufficiently large reward pot before distribution, rather than promising a fixed interval. USD values are described as current-price valuations, not historical payout-time values.

The observed screen still had metric loading placeholders and an empty distribution message together. That is not evidence of zero distributions; do not copy this ambiguous loading/empty-state behavior. No APY headline was visible in the observed rewards screen. The screenshot supports a simple dark layout with consistent cards and explanatory text, not a complex campaign dashboard.

## Prior browser observations: Clawpump (17 September, not freshly replayed)

Source: ../../research/clawpump-product-study-2026-09-17.md

Launch flow: token identity → chain and venue → paired asset with issuer/mint/fee denomination → optional buybacks/holder rewards → review/payment. The earlier study saw optional perps functionality too; that is not necessary for the Stockroom holder-reward flow.

HANSEM detail connected the token pair with collected creator fees, earned/sent/strategy amounts, allocation policy and timestamped transaction-linked payout records. This is the useful UI pattern: show the policy beside its actual execution evidence. Strategy funding is not the same as an executed buyback or completed holder payout.

Prior observation: launch UI disclosed Clawpump-controlled creator wallet and fee collection. Do not inherit that custody model by merely imitating its visual controls. Current login-only retrieval did not reverify those controls.

## Correction to the proposed Stockroom flow

Previously described “hold or stake → claim” blended distinct products. StonkFun's observed UI describes proportional payouts to holders; staking was not established, and a claim step was not established by this screen. Our manual address/amount allocation form is therefore not a faithful holder-reward interface. It can remain an administrative grant tool, but should not define the normal holder journey.

## UI specification to guide implementation next

1. Discovery: token/logo, paired stock/logo, reward mode, payout asset, actual paid amount and last successful distribution. Link to the market and reward details. Distinguish holder rewards from LP fee yield.
2. Token reward detail: eligibility rule and minimum (only once verified/designed), holding balance, payout asset, current reward budget, distribution readiness and recent completed payouts. Explicit loading/error/empty states.
3. Personal view: wallet-specific received rewards and transaction history; pending/claimable only if the actual delivery mechanism supports those states. Never show an invented countdown or automatic-delivery promise.
4. Creator setup: choose a reward policy alongside token/pair creation or an existing market; preview percentages of the correct net fee base and destination amounts. Show which settings are mutable before confirmation.
5. Creator monitoring: collected → allocated → delivered accounting, last run and any actionable failure. Repeated recipient entry should not be the ordinary distribution process.
6. Flywheel explanation: real trading produces eligible fees → chosen share funds stock-token rewards → eligible holders receive proportional distributions → the UI shows receipts. Returning participation is a product hypothesis, not a guaranteed consequence.

## Next boundary

Complete live token-detail, Flywheel and creator-controls inspection when browser access recovers, then map the UI states to a specified eligibility/distribution mechanism and inspect contracts. Do not represent this partial UI study as full reference coverage or a working recurring distributor. Stockroom currently remains its previously implemented manual campaign/escrow model.

## Follow-up: browser recovered

The subsequent implementation turn successfully inspected official Launch, Flywheel and DIVI/STRCX token detail. DIVI's holder panel shows paid-to-holders, waiting-to-distribute, payout count and last payout next to its trading area. Its description specifies direct pro-rata payouts, a transfer tax, a distribution-cost deduction and a minimum dollar balance; these are publisher descriptions, not audited implementation claims. Flywheel separately shows ranked market-cap weights and buyback/burn history. Launch displayed fee-tier choices, quote selection and a launch summary; a holder-reward selector was not established in that observed state. See holder-rewards-implementation-2026-09-18.md for the implemented adaptation and explicit differences.
