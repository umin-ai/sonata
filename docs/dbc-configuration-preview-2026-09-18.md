# DBC configuration preview

Added Compare launch settings to /create. It runs buildCurveWithMarketCap from the installed Meteora DBC SDK 1.5.12 in the browser, avoiding a CommonJS dependency error in the worker server environment. No RPC, signature or deployment is involved.

Inputs: starting and graduation market caps in mSPY quote units, fixed fee selection. Outputs: actual SDK-calculated migration quote threshold, segment count and selected fee. Fixed assumptions match the existing demo builder: one billion supply, 6 base/8 quote decimals, immutable SPL base, quote fee collection, no dynamic fee, DAMM v2 migration, 100% partner permanently locked LP, no vesting.

Browser verified default 2 -> 12 mSPY market caps / 1% fee returns 347877538 quote atoms = 3.47877538 mSPY, two segments. TypeScript passed. Preview changes do not affect prepareLaunch or the deployed config allowlist. Invalid inputs are rejected; changing inputs clears the earlier result.

Bounty direction: issuer/creator configuration and monitoring tools for stock-paired launches, not a generic memecoin launch wrapper. Next engineering requirement is creating, validating and registering new configurations end to end with migration support. Preview alone is not that completion. A community token paired against a stock token is not issuance of backed equity.

Sources:
- https://docs.meteora.ag/core-products/dbc/what-is-dbc
- https://github.com/MeteoraAg/dynamic-bonding-curve-sdk
- Existing local stockroom-treasury-demo.mjs builder
