# Stockroom wallet integration contract

The SDK now builds instructions for Stockroom's own program. The existing published website still reads external markets and does not submit these instructions. Do not label it as an active Stockroom lending protocol until this integration and a wallet flow have been exercised.

## Keep the network and assets explicit

Use a separate **Stockroom Devnet** mode after deployment. Read the market/mint/oracle addresses from a completed `artifacts/devnet-*.json` run, not from placeholders or mainnet xStock lists. Confirm the RPC genesis hash against `DEVNET_GENESIS`, and require a wallet whose active chain is Solana Devnet. Actual issuer tokens and demo mints must never share an ambiguous label.

Show “Demo stock” and “Demo USD — no monetary value.” Publicly expose only addresses, IDLs and transaction signatures. Do not bundle `.keys/`, a mint authority, the demo oracle authority or deployment secrets into the browser. The CLI currently funds test users; there is no public automated test-token faucet or continuously maintained oracle feed.

## Transaction flow

1. Fetch the market, bound mint accounts, bound oracle and wallet position from RPC. Decode with the generated IDL. Fetch wallet balances for the exact mint/token-program pair. Create associated token accounts and initialize a position when absent.
2. Parse input as a decimal string into integer token atoms. Do not use floating-point math for transaction amounts. Use BN/bigint for all share values.
3. Construct the intended instruction with `createClient` from `sdk/client.mjs`. Market account keys come from the immutable market config and PDA derivation. The SDK helpers use associated token accounts; the program additionally enforces signer, mint, owner and vault constraints.
4. Supply meaningful `minShares`, `minAssets`, `maxDebtShares`, or `maxAssets` bounds based on a refreshed quote, with a clearly displayed tolerance. SDK maxima are convenient CLI defaults, not suitable hidden browser slippage settings.
5. Set fee payer and a recent blockhash, simulate with the exact accounts, and present network, assets, amount, maximum payment, debt effect and expiry to the user. A successful simulation can still become stale before confirmation.
6. Request the wallet signature, submit, confirm with the corresponding blockhash expiry, then refetch both position and token balances. Never show a successful loan from an API response alone. Record and link the confirmed Devnet signature.

| App action           | Program operation                                      |
| -------------------- | ------------------------------------------------------ |
| Supply liquidity     | `supply(owner, assets, minShares)`                     |
| Withdraw liquidity   | `redeem(owner, shares, minAssets)`                     |
| Add stock collateral | `depositCollateral(owner, rawAmount)`                  |
| Borrow demo USD      | `borrow(owner, assets, maxDebtShares)`                 |
| Repay part/all debt  | `repay(owner, debtShares, maxAssets)`                  |
| Release collateral   | `withdrawCollateral(owner, rawAmount)`                 |
| Liquidator action    | `liquidate(liquidator, borrower, seizedRaw, maxRepay)` |

Each helper returns an unsigned instruction. A browser wallet signs the transaction; the server must not sign for the user. `initializePosition` plus the first action can be bundled in one atomic transaction, after simulation. Program events provide action data but account state and confirmed token balances remain the settlement evidence.

## State the economic outcome accurately

Display available cash separately from NAV: lent-out assets cannot be instantly withdrawn. Lender return depends on utilization, accrued/collected interest and losses. Report opening LTV and liquidation threshold as separate boundaries. Health calculations use the conservative price and raw collateral atoms. Do not multiply both price and collateral by the token's display multiplier.

Repayment does not require a fresh price; top-up also remains available during a stale/closed/paused state. Debt-free collateral release remains available with a stale oracle. Liquidation requires a fresh price and an unhealthy position. A price crash can reduce lender NAV; the protocol does not promise a backstop.

## Wallet acceptance tests still required

Before publishing this transaction flow, exercise a Devnet wallet end to end: reject wrong network, reject signature cancellation, handle expired blockhash, confirm a real borrow/repay, refetch on reload, and verify a rejected unhealthy withdrawal leaves balances unchanged. CLI and LiteSVM tests in this repository do not substitute for those browser-wallet checks.
