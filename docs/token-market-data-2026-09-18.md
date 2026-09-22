# NVIDIA vault market context

Added live mainnet reference data to /vaults/nvda through the documented DEX Screener token-pairs API (https://docs.dexscreener.com/api/reference). Exact configured NVDAx mint and USDC quote are required; the highest reported liquidity matching pool is selected. Data is cached for 60 seconds with concurrent request deduplication and timeout. No wallet credentials or transactions are involved.

Displays price, 24h change, selected-pool volume and liquidity, provider-reported token market cap, source pool, fetch time and refresh. Market cap is not NVIDIA company capitalization; source liquidity is not Stockroom vault TVL. The existing vault remains a simulation. No synthetic price history is drawn. An external DEX Screener chart iframe and full-chart link are supplied; the iframe remained blank in the in-app browser verification, so embedded-chart availability is not verified.

Verified live API and rendered metrics; TypeScript and production build passed. This pass covers NVIDIA only; other assets need verified mint registries and data sources.

## Four-asset rollout

The shared panel now covers SPYx, NVDAx, QQQx and TSLAx. Registry: lib/vaults/market-assets.ts. SPYx/NVDAx/QQQx use the existing Jupiter-verified allowlist; TSLAx matches the retained Magpie registry and Solflare asset listing. Requests and cache entries are isolated by asset. Selection still requires exact Solana base mint and USDC quote, never ticker matches. Each panel retains loading, error and unavailable states; chart labels, logos and source links follow the asset.

All four local API calls returned distinct correct mints and pool addresses with price, 24h volume, liquidity and provider market-cap data. TypeScript and production build passed. Embedded-chart limitations documented above remain; a full-chart link is included for every source pool.
