# Stockroom wallet integration contract

The [published Stockroom Devnet app](https://stockroom-cash-access.morganlyk.chatgpt.site/devnet) now submits instructions to Stockroom's own deployed credit program. The root market-research screen remains separate. A temporary browser wallet completed faucet, deposit-and-borrow, full repayment, collateral release, supply and redemption on Devnet; all six receipts were independently checked as finalized. See `artifacts/devnet-browser-lifecycle.json` for evidence and `artifacts/app-demo.json` for the original interactive market addresses. Four named mock markets are now registered in `artifacts/mock-markets.json`; see `docs/mock-stock-issuance.md` for their issuance and isolated lifecycle verification.

## Keep the network and assets explicit

Use a separate **Stockroom Devnet** mode after deployment. Read the interactive market/mint/oracle addresses from `artifacts/app-demo.json`, not from placeholders or mainnet xStock lists. Confirm the RPC genesis hash against `DEVNET_GENESIS`, and require a wallet whose active chain is Solana Devnet. Actual issuer tokens and demo mints must never share an ambiguous label.

Show “Demo stock” and “Demo USD — no monetary value.” Publicly expose only addresses, IDLs and transaction signatures. Do not bundle `.keys/`, a mint authority, the demo oracle authority or deployment secrets into the browser. The private app uses a separate, budget-limited Devnet authority for a fixed demo faucet pack and fixed 200 demo-USD oracle updates accompanying collateral/borrowing actions. The authority stays server-side and cosigns only validated instruction shapes; the user signs locally. The deployer key is not used by the app. Browser RPC reads and submits transactions directly to Devnet. There is no continuously maintained live stock-price feed. A new wallet can claim once through atomic position initialization; this is not a durable per-person anti-abuse limit and needs strengthening before public access.

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

## Verification and remaining wallet checks

The temporary browser wallet completed the six-action cycle against the deployed program, ending with zero collateral, debt and lender shares; all 25 demo stocks returned to the wallet. The app build, type check, existing 16 tests, three amount/share-math tests and three sponsor mutation tests passed. The published Devnet page loads and reads the funded market.

An external wallet extension was unavailable for end-to-end testing. External-wallet cancellation, wrong-network handling, expired-blockhash recovery and reload recovery still need dedicated browser acceptance checks. The existing CLI and LiteSVM rejection tests support program behavior but do not substitute for those wallet UI checks. This validation is not an independent security audit.
