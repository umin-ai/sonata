# Stockroom holder rewards — 18 September 2026

## User-facing change

The manual address/amount form has been removed from Rewards and Community. The primary view is now holder-facing: paid to holders, funded awaiting delivery, personal received rewards, token/payout pair cards, policy share, latest round and distribution history. Creator settings are a separate tab: choose a market, share of newly retained fees, and minimum time between rounds. A preview derives recipient shares from actual balances, not typed addresses. The homepage, capital and portfolio links now describe holder rewards consistently. Existing one-off grants remain claimable under a secondary legacy section and are excluded from holder-reward totals.

## Interface research completed before design

Browsed the official StonkFun launch, Flywheel and DIVI/STRCX token-detail screens after browser access recovered. The token detail places paid-to-holders and waiting-to-distribute amounts, payout count and last payout beside the trading experience. It describes direct proportional holder payouts, with its own transfer-tax funding and minimum dollar holding. Its Flywheel is separately an ecosystem buyback-and-burn mechanism with ranked weights and transaction-linked history. These are distinct mechanisms. We adapted the holder-facing distribution pattern; Stockroom does not introduce StonkFun's transfer tax, dollar threshold, ranking system, burn program or advertised economics.

Sources:
- https://www.stonkfun.xyz/launch
- https://www.stonkfun.xyz/flywheel
- https://www.stonkfun.xyz/token/FjTfaSH861nVcbAxdFAHTvhoSL4kyR6wgTWynuJkapht
- https://www.stonkfun.xyz/rewards
- Earlier Clawpump browser study: ../../research/clawpump-product-study-2026-09-17.md

## Actual mechanism

1. Creator signs an onchain HolderPolicy: share in basis points and minimum interval. Zero share pauses new rounds. Only the registered treasury creator can configure it.
2. Policy checkpoint starts at current lifetime retained fees. Existing reserve is not swept. Updating policy starts a new checkpoint, explicitly disclosed before signing.
3. A creator-operated local process collects actual DBC fees, executes the treasury's existing split, and computes `(total retained - checkpoint) × share / 10,000`. The rest remains creator reserve. Fees already checkpointed do not generate another round. If reserve has been spent elsewhere and cannot cover the computed budget, distribution stops.
4. Holder discovery aggregates all token accounts per signing-wallet owner. Creator and program-owned accounts are excluded; frozen accounts are ineligible. Positive balances qualify. No staking or enrollment.
5. Integer proportional allocation uses largest remainders with address ordering as deterministic tie-break. Every atom is assigned; a very small balance may round to zero, retained in the audit snapshot.
6. Fund and record_round execute atomically. Instructions-sysvar validation requires fund immediately before the record. Onchain checks include correct creator/treasury, enabled policy, interval, budget, fresh snapshot slot, and unique round account. Checkpoint advances only with successful funding.
7. Anyone can pay transaction/rent costs to deliver an immutable allocation to the fixed recipient's associated token account. Holder signatures are unnecessary. Claimed bitmap prevents repeated payment; destination constraints prevent redirection. A holder can use Receive now if operator delivery has not happened.
8. Onchain round contains snapshot slot, hash, policy, sequence and timestamp. The operator saves the complete snapshot and transaction journal locally. The browser displays real campaign funded/claimed amounts and explorer links.

## Trust and limits

- This remains a Devnet mock-token prototype, not an audited/mainnet product. No real issuer asset, real return or organic activity is asserted.
- Snapshot completeness and proportional balances are calculated OFFCHAIN and attested by the creator's funding signature. The program enforces budget, cadence and immutable delivery, not an independently verified full holder census. The UI discloses this.
- The inherited campaign format supports at most eight payable wallets per round (also subject to transaction packet limits). More wallets causes a hard stop, never top-N distribution. Generalized batching/Merkle rounds are still needed for public scale.
- Public Devnet RPC disables full token-program indexing and repeatedly throttled getTokenLargestAccounts. The fallback discovers candidate accounts from up to 100 recent mint transactions, then accepts them ONLY if a single getMultipleAccounts response reconciles their entire balances to mint supply. Candidate history does not itself prove eligibility. Incomplete discovery stops and requires an indexed RPC. Larger account sets also stop.
- A policy does not magically start a hosted keeper. The included operator runs under the creator's explicit local signing key. `--watch` repeats cycles while the process runs; it is not a managed always-on service. No creator keys are sent to a frontend or external service.
- The operator journals a signed transaction before sending. Unresolved transactions block new writes; it does not blindly re-fund. Delivery resumes using the onchain claimed mask. A lock file prevents concurrent operator instances for the same treasury. Unexpected termination may require checking journal/process state before removing a stale lock.
- No APY is inferred from test activity. No buyback/burn mechanism is added under the holder-rewards label.

## Run locally

From `stockroom-protocol`:

```sh
node --experimental-strip-types scripts/holder-operator.mjs
node --experimental-strip-types scripts/holder-operator.mjs --watch
```

Defaults use the existing ROOM market and `.keys/deployer.json`. `STOCKROOM_OPERATOR_KEY` and `STOCKROOM_MARKET_FILE` can select a different authorized local creator/market. Do not put private keys into command arguments or frontend configuration. The script verifies the Devnet genesis and creator identity. `--enable-demo` creates a 50% / 60-second policy if absent; `--demo-trade` executes one journaled 0.01 mSPY proof trade with 50 bps slippage protection, once per journal. Neither flag belongs in production automation.

## Validation

- 11 compiled-program LiteSVM tests: legacy claims, authorization, overfunding rollback, duplicates, fixed-recipient permissionless delivery, policy bounds, snapshot freshness, exact budget, atomic rollback, paused policy and rejection of old-grant relabelling.
- Six holder math/discovery tests: account aggregation, exclusions, exact integer conservation, deterministic dust, fee checkpoints and incomplete-holder fail-closed behavior.
- TypeScript and frontend production build checked; browser inspected holder and creator tabs at narrow width.
- Program deployed on Devnet and byte-for-byte checked against the tested binary. Proof: `stockroom-protocol/artifacts/stockroom-rewards-deployment.json`.
- Live receipts/snapshots: `stockroom-protocol/artifacts/holder-rounds/QZJpgjyuQ7uWzySDaJThv4MWT98YesXNkaU25hcN4Rr.json`.
- First live round paid seven atomic mSPY units across three wallets. A fourth eligible wallet rounded to zero; it remains in the recorded snapshot. Second-round proof uses explicitly generated Devnet trading activity, not organic volume.


## Final live verification — 18 September 2026

Two ROOM holder rounds completed on Devnet: 7 and 2,000 mSPY atomic units, with seven successful deliveries in total. The Rewards UI reads 0.00002007 mSPY paid, zero awaiting delivery, and 0.00000068 mSPY received by the connected test wallet. The second round used an explicitly generated 0.01 mSPY Devnet proof trade; these are test economics, not organic demand or investment returns. The operator journal has no unresolved transaction.

Validation: 11 compiled-program tests and 14 frontend tests pass; production frontend build passes. The operator is a local executable, not a deployed always-on service. Current limits remain eight payable wallets per round and a creator-attested off-chain balance snapshot.
