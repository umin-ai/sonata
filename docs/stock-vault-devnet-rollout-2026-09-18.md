# Four stock liquidity pools — rollout status

Target: MockSPYx, MockNVDAx, MockQQQx and MockTSLAx paired with the existing SPL mock USD mint, on Meteora DAMM v2 Devnet. Token A is mock USD (6 decimals); token B is the existing Token-2022 mock stock (8 decimals). The seeding ratio is a test fixture, not an oracle-backed stock valuation. Net LP fees compound natively; users own position NFTs. This is direct LP integration, not a new pooled vault-share contract.

## Prepared

- `stockroom-protocol/scripts/stock-liquidity-lifecycle.mjs`: uses the existing disposable issuer, verifies Devnet genesis, issues test inventory, creates a full-range 1% compounding pool, tests two deposits, a swap, unauthorized/slippage rejection and partial/full exits. Signed transaction identity is journalled before broadcast; unresolved transactions block further writes. Run sequentially per asset, never concurrently.
- `lib/liquidity/stock-runtime.ts`: pool/mint/program/fee configuration verification, wallet balance reads, deposit/withdraw transaction preparation. No mainnet assets.
- `app/earn/stock-vault.tsx`: chain balances, position ownership, deposits and exits. Shared signing review supports per-pool symbols/decimals.
- Routes and Earn availability switch only after the lifecycle publishes a validated manifest into `lib/liquidity/stock-markets.json`. Registry is currently empty; existing previews remain available.

## Blocker

18 September: the public Devnet RPC returned HTTP 429 even for isolated getGenesisHash reads. Deployment stopped before issuance or pool creation. dRPC's Devnet endpoint also requires a paid plan. No new stock pools are claimed live. A usable Devnet RPC is required to execute and verify the rollout. TypeScript, production build and script syntax checks passed, but the new lifecycle has NOT executed on-chain.

## Resume

From stockroom-protocol, configure STOCKROOM_DEVNET_RPC privately if needed, then run `node scripts/stock-liquidity-lifecycle.mjs spy` (repeat sequentially for nvda, qqq, tsla). Review receipts and assertions; do not edit the registry manually to claim success. A dedicated RPC must also be configured for browser reads/transaction confirmation before the app can operate reliably under the current public endpoint restriction. Fund tester wallets with both mock assets before browser lifecycle validation. Mock tokens have no monetary value.

APR remains “Collecting data”; manually generated test trades must not be advertised as organic yields. External mainnet price panels are context only and do not price Devnet mock deposits.
