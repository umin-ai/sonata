# Solana data integrations

Verified 14 September 2026. Stockroom now opens on live Jupiter xStock markets. This is a read integration; funded execution has not been validated.

## Selected stack

| Need | Official interface | Current use |
| --- | --- | --- |
| Vaults, rates, lending limits and borrowable amounts | [Jupiter Borrow API](https://developers.jup.ag/docs/lend/borrow/api), `GET /lend/v1/borrow/vaults?market=main` | Integrated through `/api/jupiter/markets` |
| Wallet position discovery | Same API, `GET /lend/v1/borrow/positions?market=main&users={address}` | Integrated through `/api/jupiter/positions`; identity and status only |
| Informational token prices and daily change | [Jupiter Price V3](https://developers.jup.ag/docs/price), `GET /price/v3?ids={mints}` | Integrated; never substitutes for a lending oracle |
| Mint metadata, decimals, token program and verification | [Jupiter Tokens V2](https://developers.jup.ag/docs/tokens/token-information), `GET /tokens/v2/search?query={mint}` | Successful discovery probe; canonical mints are explicitly allowlisted in code |
| Protocol valuations, wallet accounts and eventual simulation | [Jupiter read SDK](https://developers.jup.ag/docs/lend/borrow/read-vault-data) and [Solana RPC](https://solana.com/docs/rpc/http/simulatetransaction) | Existing Kamino RPC integration; Jupiter financial-position reconciliation remains pending |
| Future deposit, borrow, repay and withdraw | Borrow API `POST /operate` or `/operate-instructions` | Documented, but not enabled; probe failed as described below |

All vault requests pin `market=main`. Vault IDs are scoped to their market. All supported token records must identify Solana and match the expected mint and decimals. This release supports NVDAx, SPYx and QQQx against USDC or JupUSD; it does not automatically accept newly listed assets.

## Observed markets

| Collateral | USDC vault | JupUSD vault | Maximum opening LTV | Liquidation threshold |
| --- | --- | --- | --- | --- |
| NVDAx | 80 | 84 | 65% | 75% |
| QQQx | 79 | 83 | 75% | 85% |
| SPYx | 78 | 82 | 75% | 85% |

These are observations, not permanent terms. The 01:38 UTC local-server response returned all six markets and prices. At that moment, base borrow APR was 4.49% for USDC and 5.40% for JupUSD. Jupiter's NVDAx/USDC page displayed 4.59% APY during inspection, consistent with compounding its base APR. Stockroom explicitly labels APR and excludes incentives.

## Unit and valuation rules

- `borrowRate` and `supplyRate` use basis points: 449 becomes 0.0449 APR. Verified against published `@jup-ag/lend-read` 0.0.14 interest calculations and its APR-labelled documentation.
- `collateralFactor` and `liquidationThreshold` use per-mille: 650 becomes 65%. Borrow fee and liquidation penalty use basis points; the observed 300 penalty matches Jupiter's displayed 3%.
- REST `borrowable`, `totalBorrow` and `minimumBorrowing` are normalized using debt-token decimals. Minimum remaining debt retains six decimals in the interface. Borrowable describes the vault-wide limit, not a connected wallet's capacity; do not sum limits across vaults as independent liquidity.
- DEX price, underlying stock price and lending-oracle valuation are distinct. Price V3's returned USD price is displayed directly. No second scaled-UI multiplier is applied. Missing prices remain unavailable.
- Stock token balances and corporate-action multipliers require reconciliation before financial-position displays or transaction amounts are enabled. The current position integration exposes identity/status only, despite amount fields being present upstream.
- The API's protocol-oracle address and suspension flag are retained. No generic Pyth/DEX price is substituted into Jupiter's lending calculations.
- The server coalesces concurrent catalog reads and caches them for 15 seconds. UI snapshots request refresh after 45 seconds. Retrieval time is not a guarantee of an upstream oracle's freshness. Wallet reads are not cached across users; responses use `Cache-Control: no-store`.

## Evidence and remaining work

Successful HTTP 200 probes: vault catalog (80 total, six supported stock pairs), the positions endpoint with an unfunded test address (empty array), Price V3 for NVDAx, and Tokens V2 mint metadata. The local application routes also returned six normalized markets, all three prices, and an empty position list. An empty address test does not validate a populated position's balances or transferred-position ownership semantics.

The unsigned `/operate-instructions?market=main` probe for vault 80, new position 0, `colAmount="100000000"`, `debtAmount="100000000"`, returned HTTP 500: `No return data found in logs`. It used an unfunded test address. Root cause remains unresolved; the response does not establish a general API outage or a working transaction integration. No transaction was signed or submitted.

Jupiter's live vault page at `/lend/borrow/80/deposit` resolved to NVDAx/USDC and displayed 65% opening LTV, 75% liquidation threshold and 3% penalty. The generic Borrow page presented a terms acknowledgment; no terms were accepted and no wallet was connected during research.

Before in-app execution, reconcile a populated position with the official SDK and chain, validate scaled token amounts, inspect instructions and signers, simulate, and complete a controlled funded deposit/borrow/repay/withdraw lifecycle. Full repayment uses Jupiter's documented `MIN_I128` convention to clear accrued-interest dust; partial repayment must respect minimum remaining debt.

Read probes succeeded without an API key in this environment. This is not a production access or uptime guarantee. The server already accepts `JUPITER_API_KEY`; obtain production access with the required Lend, Price and Tokens scopes through the [Jupiter developer portal](https://developers.jup.ag/docs/portal/api-keys). A dedicated mainnet RPC can use the existing `SOLANA_RPC_URL` configuration. No credentials are exposed to the browser.

## Validation

The 16 calculation, ledger and adapter tests pass. New adapter tests cover rate/amount scales, changed chains and decimals, duplicate identifiers, invalid limits, unavailable prices and owner mismatches. Browser checks cover the six-row directory, collateral/debt filters and the vault terms panel. The interactive example remains separate and uses its own explicitly illustrative Kamino terms.

Jupiter already supplies the basic lending workflow. Stockroom's product work must therefore earn its place through a useful planning or management task. Connecting these APIs is infrastructure progress, not evidence of product-market fit.
