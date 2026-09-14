# Stockroom credit market v0.1

An isolated **test-asset** lending market on Solana. One Token-2022 collateral mint backs borrowing of one six-decimal SPL quote mint. Lenders contribute the quote tokens that borrowers actually receive. No stablecoin or stock issuer backing is implied by the demo mints.

## Custody and authorization

The credit program owns market and position accounts. Market PDAs derive from `market`, administrator, collateral mint and quote mint. Two separate PDA token accounts hold quote liquidity and stock collateral; their token authority is the market PDA. Only instructions in this program can sign for them. A position derives from `position`, market and owner. User cash/collateral accounts must have the bound mint and signing owner. Liquidators can affect an unhealthy borrower's position only through the liquidation instruction and must pay from their own quote-token account.

The market configuration binds one account owned by the separate demo-oracle program. Substituting a different program, feed account, mint, vault or position owner fails. Market terms and oracle address are immutable after initialization. An administrator can pause new borrowing and collateral withdrawals from indebted positions; repayment, top-ups, liquidation and debt-free collateral withdrawals remain possible. On Devnet, program upgrade authority is still an administrator trust assumption.

## Accounting

All persisted financial amounts are integers. Quote tokens have six decimals; collateral tokens have eight. U256 intermediates protect multiplication before division. Checked narrowing and checked account updates fail atomically on overflow.

| Operation                   | Conversion                                                     | Rounding |
| --------------------------- | -------------------------------------------------------------- | -------- |
| Supply quote assets         | assets → supply shares                                         | Down     |
| Redeem supply shares        | shares → quote assets                                          | Down     |
| Borrow quote assets         | assets → debt shares                                           | Up       |
| Repay debt shares           | shares → quote assets                                          | Up       |
| Value collateral for health | raw atoms × conservative price ÷ 10^8                          | Down     |
| Liquidation payment         | collateral value → discounted quote → debt shares → quote paid | Up       |

Both share conversions include one virtual quote atom and one million virtual shares, following the attributed Morpho math. Supply shares and debt shares are non-transferable program accounting fields, not SPL receipt tokens. A supply position earns the interest collected by this market; it cannot itself be posted as collateral here.

Recorded NAV is accounted cash plus outstanding debt assets. Unsolicited token donations do not change NAV or share prices, and cannot be claimed through a privileged sweep. Such donations remain locked excess balances. Deposits, redemptions, borrowing, repayment, collateral withdrawal and liquidation accrue interest before calculations that depend on debt/NAV. Deposit-only collateral top-ups need no accrual.

The fixed annual rate uses a per-second continuous-rate, third-order approximation. Fractional quote-atom interest carries forward. It is not a fixed APY: compounding makes effective annual yield differ from the configured APR, and liquidity utilization determines supplier yield. Default demo terms are 5% borrower APR, 50% opening LTV, 65% liquidation LTV, 5% liquidation bonus and 120-second maximum quote age. These are **illustrative test parameters**, not empirically calibrated terms for real equities.

The final debt-share exit clears virtual debt dust. Lender redemptions may leave virtual-share quote dust. There is no fee, reserve factor, insurance fund or guaranteed redemption liquidity.

## Price and stock units

The demo oracle publishes quote atoms per 10^8 **raw** collateral atoms. The conservative price is `price - confidence`. Confidence must not exceed 1%; timestamps must be no more than the configured age and must not be in the future. New borrowing and collateral withdrawal with debt also require an open trading flag. Liquidation still needs a fresh quote but can operate during a closed trading flag. No stale quote is accepted for liquidation.

Changing a Scaled UI Amount multiplier does not create collateral or additional borrowing power. A production adapter would need a verified mapping from the vendor's price denomination and corporate-action convention to raw token units. Simply multiplying both a share count and its price would double-count a split.

Collateral must be Token-2022 with eight decimals, no freeze authority and only these optional extensions: Scaled UI Amount, Metadata Pointer, Token Metadata. This excludes transfer fees, permanent delegates, hooks and other unsupported behavior. It intentionally means **many real issuer tokens may not qualify**. The demo does not claim compatibility with all xStocks or other issuer assets.

## Liquidation and losses

A position becomes eligible only when debt exceeds collateral value times its liquidation threshold. A liquidator chooses raw collateral to seize and a maximum quote payment. The program calculates rounded-up debt shares/payment from that collateral and the bounded bonus. It rejects excess repayment, slippage and healthy positions. Both transfers and every accounting update commit atomically.

Partial liquidation is permitted; there is no arbitrary 50% close factor. Once all collateral is exhausted, remaining debt is explicitly written off against lender NAV. Lenders bear this loss. Cash withdrawal cannot exceed actually available accounted liquidity, even when NAV includes collectible debt.

## Deliberately unfinished production requirements

This is an independently implemented, unaudited prototype—not mature or audited merely because its references are mature. The administrator controls the demo price and test-asset minting. There is no production oracle adapter, issuer onboarding/transfer policy integration, corporate-action attestation, rate controller, liquidation keeper, empirical liquidity stress calibration, governance timelock or independent security review. No mainnet deployment is authorized by the scripts. The frontend must show the test network and assets explicitly and must never portray these demo mints as redeemable equities or USDC.

`tests/credit.test.mjs` verifies compiled SBF behavior in LiteSVM. That is distinct from network deployment, a real wallet UI test and an external audit. `artifacts/` records the evidence that was actually produced.
