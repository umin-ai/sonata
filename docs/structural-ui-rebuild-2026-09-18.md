# Structural UI rebuild — 18 September 2026

Implemented a new top-navigation shell without the sidebar. Main navigation: Markets, Pools, Launch, Rewards, Portfolio. Secondary tools remain accessible in the footer. The header is sticky and wraps on smaller screens.

Launch now has Token details, Pair & fees, and Review steps with a persistent token preview. Required name/ticker gate forward navigation; Back preserves input. Disconnected review exposes the actual wallet-connect control. Saved onchain drafts retain the existing activation/recovery flow. Only mSPY and the actual fixed configuration are exposed; no fictitious configurable curves or unsupported stock quotes were added. Launch details are expandable and Meteora attribution stays secondary.

Market detail now separates Trade, Fees & treasury, and Transactions. Trade uses a two-column market-information/swap layout on desktop. A clearly labelled price-history empty state replaces any temptation to draw invented candles. Existing transaction preparation and signing functions remain unchanged.

Browser checked all three launch stages, preview updates and disconnected gating using a temporary name/ticker without signing. TypeScript passed. Production build was run after the changes. Live Devnet transaction verification is not included in this UI pass.

Remaining product work: historical market indexing; DBC migration adapter; four stock-pool deployments; observed fee APR. These are not completed by a UI change.
