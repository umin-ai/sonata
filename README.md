# Stockroom

A stock-backed credit workspace for NVDAx holders on Solana. Start with a cash request, understand the debt and downside, and follow the position through repayment and collateral release.

This release is a product validation prototype. It has a complete interactive example and read-only mainnet integrations. Real transactions take place in Kamino. It does not establish product-market fit or a verified funded lending integration.

## Try it

1. Start in **Markets**, open the NVDAx / USDC pair, and review a loan using the supplied **Example** balances.
2. In **Portfolio**, advance time, repay part of the debt, or add collateral.
3. Repay the full balance and release the stock. Inspect or export the local activity receipt.
4. In **Live wallet**, refresh current reserve terms or connect a Wallet Standard wallet to read supported balances and a position. Continue in Kamino to transact; form inputs are not transferred automatically.

Example mode starts with 10 NVDAx and 100 USDC. It uses a fixed illustrative $218.31 stock price, 5.08% APY, 55% opening LTV and 65% liquidation threshold. No real funds are involved. Example data stays in localStorage on this device. Resetting affects only this example.

## Features and boundaries

- Market directory, selected-market terms and a compact borrow panel, with portfolio and activity navigation.
- Borrow request with collateral, USDC amount, repayment horizon and price-decline scenario.
- Explicit variable interest, opening limit, liquidation threshold and estimated repayment.
- Persistent example ledger: borrow, interest accrual, partial/full repayment, collateral top-up, release, and optional sale.
- Live Kamino reserve and Scope oracle reads with freshness checks, fees, borrow factor, and NVDAx scaled-UI conversion.
- Wallet connection is read-only. The active wallet hook has no transaction signing method. `POST /api/prepare` always returns 503; no environment variable enables it.
- The default public RPC reads primary associated NVDAx/USDC token accounts. Additional token accounts are not included; the UI labels this scope. A configured wallet RPC enables all token-account queries. Unavailable reads are shown as unavailable, not zero.
- Position reads support one standard NVDAx/USDC obligation in Kamino's xStocks market. Other assets, elevation groups, position types and ownership-transfer states are not modeled. Debt reflects the last reserve refresh.
- Optional live Jupiter sale quotes load independently of credit data. Provider errors and expired quotes remain visible.
- A configure-only WebMCP tool edits visible example inputs. It cannot connect a wallet or create a loan.
- No new token or lending smart contract, autonomous financial agent, yield strategy, liquidation keeper, or automatic repayment.

## Calculations

Estimated debt is opening debt × (1 + APY)^(days / 365). The origination fee is included in opening debt. Risk-adjusted LTV is debt × USDC oracle price × borrow factor / collateral value. Downside scenarios reduce the collateral price and include projected interest.

These calculations assume constant rates and oracle relationships. They are not executable lending offers. Reserve liquidity and the modeled opening limit do not account for every execution constraint. The example does not simulate actual liquidations, market gaps, changing rates, network fees or corporate actions.

## Development

Node 22.13 or later is required. Install locked dependencies with `npm ci`, then run `npm run dev`. The framework wrapper chooses an available local port. `npm run build` builds the app.

Optional server environment variables:

- `SOLANA_RPC_URL`: a production Solana mainnet RPC for reserve, oracle, position and wallet reads.
- `SOLANA_WALLET_RPC_URL`: a separate mainnet RPC supporting `getTokenAccountsByOwner`; otherwise the configured RPC above is used. Without either variable, the app reads associated token accounts through PublicNode.
- `JUPITER_API_KEY`: server-only Jupiter quote API key.

Never put wallet private keys or signing seeds in this application. Hosted credentials belong in server environment configuration, not source files. Public provider access is best effort and can be rate limited.

Read APIs: `/api/market`, `/api/wallet?address=…`, `/api/position?address=…`, and `/api/compare?cash=500&holding=10`. The retained `/api/receipt` route is read-only and is not used by the rebuilt interface.

## Validation

```sh
node --experimental-strip-types --test lib/finance.test.ts lib/credit.test.ts
npx tsc --noEmit
git diff --check
```

The 12 calculation/ledger tests cover scaled token units, rounding, interest accrual, partial repayment without double-counting, balance conservation, fees, debt risk factors, opening limits, collateral release, and invalid inputs. See [validation notes](docs/rebuild-validation.md) for browser checks, integration evidence and unresolved execution work.

## Unreleased execution work

`lib/server/transactions.ts` and `transaction-policy.ts` preserve an unfinished transaction-building experiment. They are not imported by the disabled preparation endpoint and are not validated for funded use. `experiments/cash-comparison-v2.tsx.txt` preserves the earlier interface for reference. Neither should be enabled without instruction-level review, transaction simulations, controlled funded lifecycle tests, reconciliation and production provider access.

Before an execution release: confirm issuer/user eligibility, value wallet-specific positions with current protocol constraints, verify transaction instructions and signers, test failures and retries, and complete borrowing, repayment and withdrawal with controlled funds. Before claiming demand: observe actual eligible holders completing a recurring task and returning to use it again.

The product name is provisional. No name or trademark availability check has been performed.
