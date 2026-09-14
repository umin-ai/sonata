# Mock stock issuance and isolated markets

Research checked on 14 September 2026. All addresses in `artifacts/mock-markets.json` are Solana Devnet addresses. This work does not issue real equity or xStocks.

## What the real issuer does

[xStocks' developer documentation](https://docs.xstocks.fi/developers) describes Solana assets as Token-2022 mints with the Scaled UI extension. Issuance and redemption are distinct from secondary trading and lending. [Its product explanation](https://docs.xstocks.fi/docs/how-xstocks-work) describes 1:1 collateralization by underlying securities, custody, a primary issuance layer, and permissionless secondary transfers. Creating a mint alone supplies none of that backing or the right to issue the real product.

The [multiplier integration guide](https://docs.xstocks.fi/developers/multipliers) distinguishes raw transaction amounts from displayed balances adjusted for corporate actions. Stockroom's four mocks use multiplier 1, with no corporate-action simulation. The browser rejects a changed or scheduled multiplier rather than presenting a stale valuation as safe.

[Solana's metadata documentation](https://solana.com/docs/tokens/extensions/metadata) supplies the MetadataPointer/TokenMetadata initialization pattern: reserve rent for variable metadata, initialize extensions before the mint, then initialize metadata. [Scaled UI Amount documentation](https://solana.com/docs/tokens/extensions/scaled-ui-amount) explains the display multiplier. The issuance script uses the installed official SPL libraries for both.

## What we deployed

| Token | Test price in demo USD | Initial issuer inventory | Seed lending liquidity |
| --- | ---: | ---: | ---: |
| MockSPYx | 600 | 10,000 | 25,000 demo USD |
| MockNVDAx | 180 | 10,000 | 25,000 demo USD |
| MockQQQx | 500 | 10,000 | 25,000 demo USD |
| MockTSLAx | 350 | 10,000 | 25,000 demo USD |

Prices are chosen test fixtures, not market observations. The stocks have 8 decimals, onchain mock names/symbols and an explicit unbacked Devnet description. Metadata URI is intentionally empty: the name, symbol and description live in the mint account rather than relying on a private website for token identity. There is no freeze authority. A dedicated disposable authority controls minting, metadata, multiplier and mock oracle updates; it does not hold program upgrade authority.

All markets use the existing 6-decimal classic SPL demo USD mint. Each collateral/debt pair derives a different market PDA, lending vault, collateral vault, oracle and per-wallet position. A shared debt mint does not share liquidity or collateral between markets. Each has 5% borrower APR, 50% opening LTV, 65% liquidation LTV and a 5% liquidator bonus. Terms are test configuration, not a risk assessment of the named equities.

`node scripts/setup-mock-markets.mjs` reproduces the deployment using retained local test keys. It records signatures before broadcast and requires pending outcomes to be resolved before repeating issuance. It does not recreate or upgrade the credit program. Never commit `.keys/` or put these authorities in browser code.

## User flow and accounting

Select a market → create/connect a Devnet wallet → claim its starter pack → supply demo USD or deposit stocks and borrow → repay principal plus accrued interest → release collateral → redeem lending shares when cash is available.

A starter pack issues 25 selected mock stocks, 1,000 demo USD and 0.005 Devnet SOL. Atomic position creation prevents a second pack for the same wallet in the same market. This is not a per-person anti-Sybil limit. Site access remains owner-private, and the faucet has a finite Devnet SOL budget. Real-asset issuance/redemption, brokerage custody and compliance processes are not implemented; repaying a credit position is not redemption of the underlying stock.

The browser reads supply, cash, accrued debt and token issuance from Devnet. Its activity ledger queries market signatures for all wallets, paginates older results and decodes receipt token-balance deltas on demand. Credit event decoding checks the emitting program and market. Failed receipts are shown as failed, never as settled token movements. Issuance and market setup receipts are linked separately because mint creation precedes the market account. The feed is refreshed by the user; it is not an independently indexed or archival service.

## Verification

`node scripts/verify-mock-markets.mjs` completed 24 finalized transactions across the four markets. For each market: starter assets, atomic deposit/borrow, repayment, collateral release, supply and redemption. It asserted that each loan left the other three markets' user positions unchanged, that every final position had zero collateral/debt/shares, and that 25 stocks returned to the wallet. An attempted MockSPYx token account deposit into MockNVDAx was rejected in simulation. See `artifacts/mock-market-lifecycle.json`.

The browser shows the decoded borrow receipt as -8 MockSPYx from the user, +8 in the collateral vault, -500 demo USD from the lending vault, and +500 in the user cash account. Sponsor tests reject cross-market requests and arbitrary price updates. External extension-wallet acceptance testing and independent contract auditing remain outstanding.

A subsequent MockSPYx browser run completed all six actions with finalized receipts and verified zero final debt, collateral and lender shares. During the open loan, switching to MockNVDAx showed a separate empty position. Public browser evidence is in `artifacts/mock-browser-lifecycle.json`.
