# Stockroom vault prototype — September 17, 2026

This revision supersedes the credit workspace at the homepage. The prior on-chain credit experiment remains at /devnet, /markets/:id, /credit/portfolio and /credit/activity. The new vault UI is a browser-local simulation, not a deployed vault protocol.

## Routes and working behavior

- `/`: vault discovery with four stock identities, filters, search and APY/TVL sorting.
- `/vaults/spy` (also nvda/qqq/tsla): deposit and withdrawal previews, illustrative performance chart, risk information, mock stale-price pause, generated trade batches, compounding and claims.
- `/portfolio`: positions and available fees from the local ledger.
- `/community`: a separate $500 fictional creator fee batch, editable treasury allocation, fixed 20% community reserve and residual operations allocation. No holder payouts are implemented.
- `/activity`: receipts for every action, including amount and calculation notes.
- `/ecosystem`: explicit sponsor integration status, pre-IPO research previews and non-executing stock-quoted launch configuration preview.

The user starts with $10,000 demo USDC. Monetary state uses integer cents. Deposits and withdrawals use fixed prices and zero execution costs. A sample trade batch generates $100,000 mock volume at a 0.30% pool fee; the user's portion is proportional to their capital over fixture pool capital plus user capital, less a 10% performance fee. Gross entitlement and protocol fees round down to whole cents. No swap, real liquidity position, price change or on-chain share issuance occurs. Display APYs, market volumes, TVLs and performance charts are deliberately labelled fixtures; APY does not drive ledger fees.

Demo state is stored under `stockroom-vault-demo-v1` in the user's browser, independent of old credit state. Reset is available through Demo wallet. Creator funds and user deposits are disjoint. The reserve is not a legal or on-chain holder entitlement. No wallet signing code is invoked by new vault routes.

## References examined in this implementation

- Superform current app, including vault discovery and NVIDIA product presentation: https://app.superform.xyz/ . Used as visual/interaction reference; no copied source or implied partnership.
- Beefy's official frontend (MIT): https://github.com/beefyfinance/beefy-v2 . Inspected `src/features/vault/components/Actions/Transact/DepositForm/DepositForm.tsx`, including balance/MAX, quote preview and transaction error separation. Independently implemented our smaller demo; no source copied.
- Meteora official DBC SDK: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk . Inspected `packages/dynamic-bonding-curve/tests/createConfigAndPool.test.ts` for separate config, creator, quote mint, fee claimer and migration-related integration planning. Not installed or executed here; review exact license/version before future reuse.
- Superform official GitHub organization: https://github.com/superform-xyz . Repository discovery only in this turn; no claim of contract audit or code portability to Solana.
- Prior Clanker and Flaunch live UI/revenue management observations inform clear recipient allocation and ownership.

Existing dependencies and token-logo assets are reused. New interface and demo ledger are original implementation.

## Bounty boundaries

Current event page: https://hackathons.solana.com/hackathons/stocklana . The main product remains a credit/yield candidate. Pyth, issuer assets and DBC/Clawpump are roadmap targets, not completed integrations or earned eligibility. Pyth has a mocked freshness scenario; issuer cards are previews; DBC form checks only inputs. Actual supported feeds, issuer mints and rights, DBC deployment/migration and the Clawpump route all need independent completion. No award stacking assumed.

## Validation

Ledger tests cover deposit/compound/exit conservation, separate claims, invalid amounts, creator fund separation and prevention of allocating the same creator batch twice. Browser review covers desktop/mobile layouts and core action flows. No production financial assurance is implied by prototype tests.
