# Sonata

## Current local app — 24 September 2026

**Live on Solana Devnet: https://sonata.umin.ai** (AWS Lightsail; setup in [deploy/lightsail/](deploy/lightsail/README.md)).

**Current status, on-chain evidence, security model and Meteora references are in the protocol repository's [HANDOFF.md](https://github.com/umin-ai/sonata-protocol/blob/main/HANDOFF.md).** Read it before relying on anything below.

Open http://localhost:5173/ . Sonata's connected Devnet core supports one-page market creation with a choice of fee model, an optional first buy and an optional token profile (image, description, links), signed in one wallet approval; trading with market-cap charts and recent trades from the trade indexer (`indexer/`); automatic payouts from the payout bot (`indexer/crank.mjs`, every 15 minutes on the server), including pro-rata payouts to Reward token holders (`indexer/rewards.mjs`); burning tokens for their share of a Stock Floor; the creator's fee claim on a graduated market's locked position; fee collection/allocation, creator reserve deployment, native LP compounding and withdrawal, holder-reward rounds and funded reward claims. One signing wallet connects Portfolio and Activity, and the chosen wallet reconnects silently after each page load. All assets are valueless test tokens.

- `/create` and `/onchain?pool=…`: Meteora DBC launch and Sonata treasury operations. Each launch creates its own DBC config. The launch is one page: only a name and ticker are required. It starts with the fee model; at the default 1.25% fee Meteora keeps 0.25% of each trade and Sonata 0.5%, and the rest goes by model:
  - **Standard token** (default, treasury mode Standard): 0.5% of each trade to the creator's payout wallet.
  - **Reward token** (Standard, with Sonata's payout bot as payout wallet): 0.5% to the token's holders, paid pro rata in the stock by the bot, with no transfer tax. The "Holder rewards" picker (None, 0.5%, 1.2%) switches to it; 1.2% uses the 3% fee. **Custody:** the bot's key holds holders' rewards between the fee split and the payout, and losing it would strand those markets' payouts ([deploy/lightsail/README.md](deploy/lightsail/README.md)).
  - **Backed token** (StandardFloor, the program's Stock Floor): 0.25% to the creator and 0.25% into a floor any holder can redeem by burning tokens and the creator can never withdraw.

  Then the token, the stock (mSPY by default, or the one picked on the home page, via `/create?quote=`), and an optional **first buy** of up to 75% of the supply, made in the same transaction that creates the pool. "More options" holds the fee (1.25%, 2% or 3%), the graduation target ($25K, $50K or $75K, default $75K) and the payout wallet. The config, the pool with the first buy, and the treasury are three transactions signed in one approval. At graduation the locked DAMM v2 liquidity is split 50/50, and the creator claims their position's fees from the market page. A launch costs about 0.032 SOL in rent. Markets launched before 24 September keep their modes (Refrain, Duet, Floor).
- `/capital`: atomically deploy a creator reserve into the supported ROOM/mSPY strategy, with matching ROOM from the creator wallet.
- `/earn`: native Meteora LP positions, swaps, compounding and partial/full withdrawal.
- `/rewards` (also `/community`): holder-reward policies and rounds, and funded fixed-recipient campaigns with one-time claims.
- `/portfolio` and `/activity`: chain balances, positions and receipts.

Earlier notes, kept for history: [connected implementation and boundaries](docs/stockroom-live-capital-rewards-2026-09-18.md), [reconciled transactions](evidence/connected-journey.json), [liquidity evidence](docs/stockroom-live-liquidity-2026-09-18.md), [configurable launches](docs/configurable-dbc-launch-2026-09-22.md).

The connected Devnet demonstration is verified. Production issuer integration, user-demand validation and bounty eligibility remain outstanding. LP positions are creator-owned. Reserve-funded campaigns pay explicitly chosen recipients; holder-reward rounds pay up to eight holders from a complete token-account snapshot, with the per-recipient split computed off-chain rather than checked by the program. No real-dollar TVL, guaranteed APY or mainnet readiness is claimed.

Separate simulations remain at `/lab`, `/lab/create`, `/lab/portfolio`, `/lab/activity`, `/lab/community` and `/vaults/...`; the earlier credit sandbox remains at `/devnet`. Do not combine those features with the live implementation claims.

Current checks: 100 frontend tests (`npm test`) and 40 indexer tests (`npm run test:indexer`: trade parser 3, payout crank 27, Reward token payouts 10) and TypeScript checking pass. The protocol suite passes 56 compiled-program tests and six math tests. New wallets need Devnet SOL and the project's mock assets; public faucet SOL alone does not supply mSPY or ROOM.

## Historical credit implementation

The documentation below describes the earlier credit application, not the current homepage or treasury signing flow.

A stock-backed credit workspace for tokenized-stock holders on Solana. Start with a cash request, understand the debt and downside, and follow the position through repayment and collateral release.

This release is a product validation prototype. It has a complete interactive example and read-only mainnet integrations. Real transactions take place in the selected protocol, Jupiter or Kamino. It does not establish product-market fit or a verified funded lending integration.

## Try it

1. Start in **Markets** with live Jupiter data. Filter NVDAx, SPYx or QQQx against USDC or JupUSD and inspect the vault terms.
2. Connect a Wallet Standard wallet to discover Jupiter xStock position identities. Open Jupiter for current financial balances and transactions.
3. Choose **Try the example** to review a loan with supplied illustrative balances, then advance time, repay, top up collateral and release the stock in **Portfolio**.
4. Select **Kamino** in live mode for the existing NVDAx/USDC reserve and supported-position integration. Form inputs are not transferred automatically between applications.

Example mode starts with 10 NVDAx and 100 USDC. It uses a fixed illustrative $218.31 stock price, 5.08% APY, 55% opening LTV and 65% liquidation threshold. No real funds are involved. Example data stays in localStorage on this device. Resetting affects only this example.

## Features and boundaries

- Live Jupiter vault directory with collateral/debt filters, base APR, lending limits, informational DEX prices and position discovery. See [Solana integration evidence](docs/solana-data-integrations.md).
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
- `PYTH_PRO_API_KEY`: optional server-only Pyth Pro key. Dollar launch targets are always priced from the real xStock on Solana via Jupiter. With a key entitled to the stock's feed, Pyth acts as a guard: a gap above 1% between Pyth and the Solana market blocks the launch. Free keys from https://pythdata.app include some US stocks (QQQ, TSLA) but not all (SPY, NVDA).
- `JUPITER_API_KEY`: server-only Jupiter key for Lend, Price and quote API access. Public reads worked during testing; production access is not guaranteed.

Never put wallet private keys or signing seeds in this application. Hosted credentials belong in server environment configuration, not source files. Public provider access is best effort and can be rate limited.

Read APIs: `/api/jupiter/markets`, `/api/jupiter/positions?address=…`, `/api/market`, `/api/wallet?address=…`, `/api/position?address=…`, and `/api/compare?cash=500&holding=10`. The retained `/api/receipt` route is read-only and is not used by the rebuilt interface.

## Validation

```sh
npm test
npx tsc --noEmit
git diff --check
```

`npm test` runs 100 tests across 22 files. `lib/server/stockroom.test.ts` is excluded and the file says why. The 16 calculation, ledger and adapter tests in `finance`, `credit` and `jupiter-data` cover API rate/amount normalization, strict mint and owner checks, unavailable prices, scaled token units, rounding, interest accrual, partial repayment without double-counting, balance conservation, fees, debt risk factors, opening limits, collateral release, and invalid inputs. See [validation notes](docs/rebuild-validation.md) for browser checks, integration evidence and unresolved execution work.

## Unreleased execution work

`lib/server/transactions.ts` and `transaction-policy.ts` preserve an unfinished transaction-building experiment. They are not imported by the disabled preparation endpoint and are not validated for funded use. `experiments/cash-comparison-v2.tsx.txt` preserves the earlier interface for reference. Neither should be enabled without instruction-level review, transaction simulations, controlled funded lifecycle tests, reconciliation and production provider access.

Before an execution release: confirm issuer/user eligibility, value wallet-specific positions with current protocol constraints, verify transaction instructions and signers, test failures and retries, and complete borrowing, repayment and withdrawal with controlled funds. Before claiming demand: observe actual eligible holders completing a recurring task and returning to use it again.

The product name is provisional. No name or trademark availability check has been performed.
