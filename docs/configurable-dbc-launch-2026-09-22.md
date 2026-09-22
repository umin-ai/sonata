# Configurable DBC launches

22 September 2026. Each launch now deploys its own Meteora DBC configuration instead of pointing every market at one shared preset.

## What changed

Previously every launch reused config `CUeJ6fgsw6wGXPCBchj9jxpkGVWzanXxYJFMiAPJea5J` (mSPY, 2 → 12 market cap, 1% fee). The launch UI offered 36 combinations; one was deployable and the other 35 exported JSON.

The launch transaction now calls `partner.createConfigAndPool`, which creates the creator's config and opens its pool in a single transaction. The creator pays for their own config account. `feeClaimer` and `leftoverReceiver` are both the Stockroom vault PDA, so fee custody and unsold curve inventory still return to the protocol.

No program redeploy was required. `stockroom-treasury` never pinned a config address — it checks `pool.config == config`, `config.quote_mint == quote_mint` and `config.fee_claimer == vault`. Any config satisfying those is registrable.

## Files

- `lib/treasury/dbc-preview.ts`: curve parameters extracted into `buildCurveParams`, so the preview and the deployed config are computed once from the same inputs. `previewDbc` now wraps it.
- `lib/treasury/quote-assets.json` / `.ts`: registry of mock stock mints that exist on Devnet. Only listed mints can back a launch.
- `lib/treasury/runtime.ts`: `prepareLaunch` takes the creator's curve, builds the config, and derives the pool from it. `validateMarketIdentity` pins the program and vault but no longer the config; the binding check stays `readTreasury`, which verifies fee routing against onchain state. `discoverMarkets` filters on registered quote mints rather than the single config, and carries each treasury's own config and quote mint.
- `app/launch-settings.tsx`: `canDeploy` now requires a quote mint that exists and a reward policy the protocol enforces, not a specific curve.
- `app/onchain/live-workspace.tsx`: passes the chosen settings into `prepareLaunch`.

## Devnet proof

`stockroom-protocol/scripts/verify-configurable-launch.mjs` deploys settings that differ from the shared preset (2 → 18 market cap, 3% fee) so a pass cannot be explained by the old fixed configuration, then reads the deployed state back.

| Item | Value |
| --- | --- |
| Config | `2jpLkQ21ViZtx9ccfG9NJrgKhg45iVPFz8jiQ9dms4Zb` |
| Pool | `EhFL2cKonHPERgLNPQReqUtJKHGhdJMaTrm7ZG3je6vY` |
| Treasury | `5uNMGvBv5roC8wFFdRT51c91Tko7DJAzGheAcE5tiYTJ` |
| Create config and pool | `2VaYaRACsBdpmWDtyBvkg4e1HZt2qzR3nb2EJwAWZmzBxvLZZvyFkm62qsje594KDPAvFGCrhmanBcwuZzgGoYDz` |
| Register treasury | `2gvdw2GRUHHEHt1rYK2Q1AgqtTsMsCtfp5JTbkR5ZGiQnN6ZjcrYKCtkKTUBYRyuTA41QMPLW3Mw5ZoNxL6NZMGZ` |

Checks read back from chain: config differs from the shared one; `feeClaimer` and `leftoverReceiver` are the vault; quote mint matches; migration quote threshold equals the SDK preview (450000000 = 4.5 mSPY); the fee numerator is the chosen 3%; the treasury is bound to this config and pool. Evidence in `stockroom-protocol/artifacts/configurable-launch-proof.json`.

The app discovers the new market: `/` lists three community markets including pool `EhFL2cKon…`, which the previous config filter would have hidden.

`npx tsc --noEmit` and `npm run build` both pass.

## Still outstanding

- Only mSPY exists on Devnet. mNVDA, mQQQ and mTSLA are UI labels with no mint, so those pairs remain non-deployable and the step-1 card now says "No Devnet mint yet" rather than implying a preview of something real.
- Holder-reward and liquidity policies are still proposals. Selecting them blocks deployment, because the protocol does not yet wire them to a newly launched market. This is deliberate, not an oversight.
- DBC → DAMM v2 migration is still unexecuted, so graduation remains unproven for configs of any shape.
- No mainnet deployment.
