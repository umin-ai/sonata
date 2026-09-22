# Stockroom — resume here

Updated: 18 September 2026, Asia/Kuching. Concise current-state handoff for another developer/LLM. This supersedes older direction statements; historical evidence remains in the linked logs. Never equate UI completion with protocol completion.

## 1. Product decision and hackathon mission

Stockroom is a Solana **Launch → Trade → Earn** product for traders and creators, using stock-quoted community markets. Keep the audience familiar with memecoin trading; do not pivot to issuer-only enterprise tooling. A community token paired with a stock token is not itself backed equity.

Stocklana asks for better ownership/use of tokenized stocks. Meteora's DBC bounty specifically values original launch configurations/use cases, technical soundness and post-hackathon utility. A generic launchpad or pretty UI alone does not satisfy it. The intended contribution is configurable stock-paired launches, transparent fee economics and continuing liquidity after graduation.

**Latest correction:** Ember offers $25k/$35k/$40k graduation presets because Meteora permits configurable curves and thresholds. Those are Ember's product choices, not Meteora requirements. Stockroom must ultimately turn selected presets into real DBC configurations. Relabelling a fixed test configuration or showing an independent calculator is insufficient.

Do not introduce another new product direction on the next turn. Finish the accepted flow and mechanics.

## 2. Intended flywheel versus working mechanics

Intended: creator chooses token + stock pair + curve + fee/reward policy → traders buy/sell → trading fees accumulate in the quote asset → chosen allocation supports creator revenue, holder rewards or liquidity → transparent results encourage continued participation. DBC graduation transitions to DAMM v2 liquidity. Demand and sustainable returns are hypotheses, not demonstrated by test traffic.

Working Devnet pieces:

- DBC launches use a shared fixed mSPY configuration; create pool, then activate Stockroom treasury (two transactions).
- Collected fees split 50% to an immutable recipient and 50% to creator-controlled reserve. Protocol deductions are separate.
- Creator capital can deploy mSPY reserve plus wallet ROOM into the existing ROOM/mSPY DAMM v2 pool. Creator owns the resulting LP position NFT and withdrawal rights.
- The **separate, directly seeded** DAMM pool supports deposits, swaps, native net-LP-fee compounding and withdrawals. It is NOT the graduated DBC pool.
- Holder reward policy/snapshot/round funding/delivery was implemented and exercised on Devnet. Current snapshot is creator-attested/offchain with a maximum eight payable recipients; not a production trustless distributor. Local operator is not an always-running service.
- LP fees remain in pool reserves; redeeming the position realizes the user's share. LP principal is not automatically taken out for holder rewards. Holding ROOM and depositing ROOM as liquidity are different eligibility/ownership mechanisms.

Missing connections: configurable launches; DBC graduation execution/adapter; automatic per-market liquidity/reward policy setup; universal portfolio/reward linkage for every new pool. Do not claim the flywheel is fully automated.

## 3. Current app and UI state

Local: http://localhost:5173/ . Prefer local; do not publish unless asked.

| Route | Current function / boundary |
|---|---|
| `/` | Stock entry cards and registered community market discovery |
| `/create` | Token → Pair → Curve → Rewards → Review, shared state and persistent preview |
| `/onchain?pool=…` | Registered market, Trade / Fees & treasury / Transactions tabs; chart history unavailable |
| `/earn` | Four stock preview rows plus working separate ROOM/mSPY Devnet pool |
| `/vaults/spy`, `/nvda`, `/qqq`, `/tsla` | External mainnet market reference plus simulated vault unless a validated deployment manifest exists |
| `/rewards` | Holder policy, eligibility/rounds and distribution history; supersedes old manual recipient form |
| `/capital` | Creator treasury reserve deployment into explicitly named ROOM/mSPY strategy |
| `/portfolio`, `/activity` | Wallet positions / receipts |
| `/ecosystem`, `/lab` | Integration status / separate simulations |

Recent UI changes: sidebar replaced by top navigation; sticky header; graphite/violet surfaces; compact launch cards; clickable curve/fee presets. All stock names bold with adjacent logos; minimum 13px; gains green, losses red, missing/zero neutral. Common DeFi labels only. Protocol attribution is secondary, below forms/details. No Rondo in this project.

Launch specifics:

- Pair choices mSPY/mNVDA/mQQQ/mTSLA update all preview denominations.
- Fixed opening market cap 2 quote units; graduation presets 8/12/18 quote units; fees 1/2/3%.
- USD primary labels currently multiply these quote-unit values by the corresponding real mainnet stock-token reference price. **These are still tiny test presets, not USD-first configurable production targets.** Do not claim they match Ember's configuration flow completely.
- Reserve threshold uses actual Meteora SDK `buildCurveWithMarketCap`, not invented arithmetic. At 2 → 12 quote-unit market caps, default preview returned 3.47877538 quote units; at 2 → 18 returned 4.5.
- Only mSPY + 2/12 + 1% + treasury split can enter existing `prepareLaunch`.
- Other combinations explicitly show preview/non-deployable and export JSON. No silent fallback to the old configuration.
- Holder rewards and liquidity choices in launch are proposed policy selections; existing standalone mechanisms are not automatically wired to a newly launched custom market.

## 4. Sources of inspiration — scope of evidence

**Read [STOCKROOM-RESEARCH-REFERENCES.md](STOCKROOM-RESEARCH-REFERENCES.md) for the full cross-project lineage and evidence matrix.** The short table below is only a selection. The project combines discovery, compounding, capital efficiency, ownership/exit, creator-revenue and launch research across dozens of references; Embercurve is only the latest launch UI example.


| Reference | What to reuse / what not to assume |
|---|---|
| Embercurve | Direct UI inspection: five-step launch; asset picker; clickable curve/fee presets; persistent economics preview; chart beside swap; holders/payouts/receipts in same market. Some displayed fee splits conflict; contracts/traction not audited. |
| Meteora DBC official docs + SDK | Authoritative curve/configuration, quote reserve threshold and DAMM migration mechanics. Installed SDK 1.5.12. |
| Pump.fun | Familiar launch/trade layout, bonding progress, market cap versus quote amount required. Inspected linked coin; displayed thresholds are point-in-time, not universal constants. |
| PancakeSwap | Direct pool/APR UI inspection: comparable rows, clickable APR and ROI calculator. Adopt usability, never fabricate APR. |
| StonkFun / Clawpump | Stock-denominated fee/holder reward pattern. Distribution into wallets is not proof of intentional stock-investor demand. Clawpump bounty is separate from direct Meteora usage. |
| Beefy, Superform, Glider | Earlier inspiration: compounding, earn discovery, allocation and portfolio UX; not contracts integrated into Stockroom. |
| Pendle, Fluid | Earlier inspiration: capital efficiency and clear yield/liquidity mechanics; no claim Stockroom implements their systems. |
| Kamino, Jupiter, Morpho, Spout | Earlier lending/stock-credit research. Stockroom later moved beyond lending-only; these are references, not the present primary product. |

Primary links:
- https://hackathons.solana.com/hackathons/stocklana
- https://docs.meteora.ag/core-products/dbc/what-is-dbc
- https://github.com/MeteoraAg/dynamic-bonding-curve-sdk
- https://embercurve.fun/launch
- https://embercurve.fun/t/FWxzTKdFW1gmdEEP64KJHobaVmFKQP9UuWPh8zAbbAud
- https://pancakeswap.finance/liquidity/pools

Recheck current bounty rules/deadline before submission. Mainnet execution has been preferred in the quoted bounty; this project is presently Devnet. No eligibility/award guarantee.

## 5. Files to inspect first

Frontend: `cash-access/` (React, TypeScript, shadcn, vinext/Vite).

- `app/onchain/live-workspace.tsx`: discovery, launch state/UI, saved draft handling, portfolio/activity.
- `app/launch-settings.tsx`: stock pair, curve presets, rewards selections and `canDeploy` guard.
- `lib/treasury/dbc-preview.ts`: SDK-backed offline configuration calculation.
- `lib/treasury/runtime.ts`: existing launch/config validation, trade and treasury transactions; allowlist currently fixed.
- `app/onchain/treasury-workspace.tsx`: market detail and transaction tabs.
- `app/onchain/live-session.tsx`, `wallet-connect.tsx`: shared wallet/signing/review.
- `app/stockroom-shell.tsx`, `exchange.css`: top navigation and latest structural styles. Older theme layers still exist; avoid accumulating contradictory overrides.
- `app/earn/workspace.tsx`, `lib/liquidity/runtime.ts`: current ROOM/mSPY LP flow.
- `app/rewards/page.tsx`: holder rewards UI.
- `app/api/token-market/route.ts`: exact-mint DEX Screener lookup, USDC pairs, 60s cache, request deduplication.
- `lib/liquidity/stock-markets.json`: currently **empty**. Do not populate without successful lifecycle proof.

Protocol: `stockroom-protocol/`, especially programs, scripts, and `artifacts/`.

Key public Devnet identities:
- Treasury program: `GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj`
- Rewards program: `6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L`
- Shared DBC config: `CUeJ6fgsw6wGXPCBchj9jxpkGVWzanXxYJFMiAPJea5J`
- ROOM/mSPY DBC pool: `BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf`
- Separate ROOM/mSPY DAMM pool: `GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v`

Read manifests for other addresses; never copy private key files or credentials into logs.

## 6. Verification and blockers

- Prior Devnet lifecycle evidence exists for treasury, direct LP deposits/trades/exits, reserve deployment and reward rounds. Read artifacts; do not call these fresh tests.
- Latest unified launch production build passed (`/tmp/stockroom-unified-launch-build.log`, ephemeral). Subsequent compact presets and USD-label changes passed TypeScript; full build was not rerun after the latest USD change.
- Browser tested multi-step navigation, preview currency propagation, reward selection/export-only guard, clickable graduation/fee changes and SDK result updates. No transaction signatures in these UI passes.
- External chart embed was blank in the in-app browser previously; fallback link exists. Market candles are not indexed for the Devnet DBC market.
- Public Devnet RPC has returned HTTP 429 even on isolated reads. Four stock LP deployment script stopped before issuance/pool creation. Need reliable Devnet RPC, then actual sequential lifecycle validation.
- No production audit; deployed/source mismatch for historical treasury build was noted in old evidence. Verify program bytes before claiming source-matched deployment.
- Mainnet market cap/volume reference data is not Stockroom TVL, organic demand or Devnet asset valuation. No verified live APR yet.

## 7. Next execution order

1. Inspect current launch/runtime/config validation and official SDK. Preserve existing working markets.
2. Define USD-first presets deliberately; resolve quote price with source/time, freeze the conversion for review, and generate the corresponding config. Do not merely convert old test caps for display.
3. Implement validated custom-config creation and registration end to end. Check quote token program, decimals, issuer transfer restrictions/extensions and authority model. Keep unsupported options blocked.
4. Wire each chosen reward/liquidity policy to the actual new market, with explicit fee ownership and recipient accounting.
5. Complete and prove DBC → DAMM v2 migration; distinguish curve completion, migration pending and migrated. Connect correct post-migration pool/trading/fees.
6. Finish market-level indexed metrics, candle history, holder/reward receipts and graduation progress. No filler data passed off as live.
7. Deploy/validate four direct stock LP pools once RPC works; these are separate from the DBC path.
8. Run a complete wallet journey, then record receipts and update this log before claiming submission readiness.

User expects autonomous continuation of authorized work, not repeated acknowledgments or cosmetic passes described as a full rebuild. Explain real blockers precisely. Never spend mainnet funds or publish external messages without relevant authorization.

## 8. Resume commands and evidence index

From `cash-access/`: `npm run dev` (wrapper selects port 5173), `npx tsc --noEmit`, `npm run build`. Check existing listener before starting another server. Repository has extensive pre-existing untracked content; do not reset/clean it. Claude's separate project/Rondo must remain separate.

Read these for deeper evidence, in order:
1. `cash-access/docs/unified-launch-flow-2026-09-18.md`
2. `cash-access/docs/holder-rewards-implementation-2026-09-18.md` (supersedes manual reward-recipient UX)
3. `cash-access/docs/stockroom-live-capital-rewards-2026-09-18.md` (historical capital receipts; reward section is older)
4. `cash-access/docs/stock-vault-devnet-rollout-2026-09-18.md`
5. `cash-access/docs/embercurve-ui-and-dbc-study-2026-09-18.md`
6. `cash-access/docs/token-market-data-2026-09-18.md`
7. Root `chatgpt-astra-stockroom-complete-research-and-build-log-2026-09-18.md`
8. Root `chatgpt-astra-stocklana-full-research-archive-2026-09-16.md` (historical exploration, not current decisions)

Suggested next-session prompt: “Read STOCKROOM-HANDOFF.md first. Continue Stockroom from the current implementation, preserving working transactions. Prioritize real configurable DBC launches and the migration lifecycle behind the accepted UI. Verify current code and evidence; do not restart idea selection or mix in Rondo.”
