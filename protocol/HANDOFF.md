# Sonata — handoff and evidence

Updated 23 September 2026 (Asia/Kuching). Supersedes the 18 September handoff. Solana Devnet only. Mock tokens have no monetary value, and nothing here is an offer of securities.

**How to read this document.** Every factual statement points to one of three things: a source line (pinned permalink or `path:line`), a Devnet transaction or account on Solana Explorer, or an external page. Where a statement cannot be checked that way it is labelled as a limitation or a hypothesis. If a citation here does not support its claim, treat that as a defect in this document.

Source line links are pinned to these commits, so each keeps pointing at the code it cites even where the file has changed since.

- [`umin-ai/sonata-protocol` @ `019c688`](https://github.com/umin-ai/sonata-protocol/tree/019c688e4083cfc877fb8a8cb78c8519b92efd8e) — programs, scripts, artifacts
- [`umin-ai/sonata` @ `130b5e2`](https://github.com/umin-ai/sonata/tree/130b5e206e60800ac721b1dd59cd718d6cc5ab4e) — frontend

Explorer links use `?cluster=devnet`.

---

## 1. Three things a reviewer should know first

**1. The deployed treasury program now matches this repository's source, but did not until 23 September.** `stockroom_treasury` was deployed on 17 September; its source was later restored and rebuilt with a reconciled lockfile, and the rebuild did not reproduce the deployed bytes. This was recorded at the time in [`artifacts/stockroom-treasury-deployment.json`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/stockroom-treasury-deployment.json) (`"rebuiltMatchesDeployment": false`). On 23 September the program was upgraded to the tested rebuild in [`673Yrm9r…cf5w5qpY`](https://explorer.solana.com/tx/673Yrm9r9Hf7LfwZMmb1oRxf49D1cjpwEUgKB8LbZZmAoDkZzvHWwH4MXXXDaA3cyQREGZA8UfXaKc8Tcf5w5qpY?cluster=devnet). `scripts/verify-deployed-bytes.mjs` now reports all four programs matching their builds byte for byte. Every transaction in §4 dated before that upgrade ran against the earlier binary; the launch and fee-path transactions marked "post-upgrade" ran against the current one. See §6.1.

**2. All four programs are upgradeable by one key.** Anything this document calls immutable is immutable only in the sense that no instruction in the current program changes it. See §6.2.

**3. Sonata is not the first stock-paired launchpad on Meteora's Dynamic Bonding Curve.** StockLaunch is live on mainnet with Backpack-issued equities as quote assets. This document makes no first-mover claim. See §8.

---

## 2. What Sonata is

A Solana launchpad where a creator launches a community token that trades against a tokenized stock rather than against SOL or USDC. It uses Meteora's Dynamic Bonding Curve (DBC) for launch and price discovery, and graduates liquidity into a Meteora DAMM v2 pool when a curve completes. Trading fees accrue in the stock token. The target user is a memecoin-literate trader, not an issuer or enterprise.

A community token paired with a stock token is not backed equity and conveys no claim on the stock.

Product flow: **Launch → Trade → Earn.** Demand and sustainable returns are hypotheses. They are not demonstrated by the Devnet test traffic recorded here, and no APR, yield or TVL figure in this project is derived from real usage.

---

## 3. Status

| State | What |
|---|---|
| **Proven on Devnet** (transactions in §4) | Per-launch DBC config and pool, registered to a Sonata treasury, using settings the legacy shared config could not produce (2 → 18 market cap, 3% fee) |
| | Fee collection from DBC into program-owned custody, 50/50 allocation, creator withdrawal of the retained share (flagship market) |
| | Holder-reward policy, funded round and deliveries to holders (flagship market) |
| | Reserve-funded reward campaign with recipient self-claim |
| | Separate DAMM v2 pool: creation, deposits, an independent swap, partial and full exits |
| | **Post-upgrade:** a second per-launch config and registration, and the full fee path on the 3% pool — a buy charged at exactly 3%, Meteora's 20% protocol share, claim into custody, 50/50 allocation and a creator withdrawal |
| | **Graduation:** a per-launch pool's curve completed, its fees collected, then migrated to DAMM v2 with 100% of LP permanently locked under the Sonata vault; the graduated pool then accepted a trade |
| | **Graduation progress in the app:** each market card and market page reads its pool's quote reserve against its own config's threshold, from accounts `readTreasury` already fetches (flagship 23.0% of 3.47877538 mSPY; the 2 → 18 pools against 4.5 mSPY). Graduated markets show their DAMM v2 pool and replace the curve swap with a notice. Logic in `lib/treasury/graduation.ts`, tested in `graduation.test.ts` |
| **Implemented, not yet exercised on-chain** | A wallet-signed launch **through the UI** using a per-launch config. The UI path ([`runtime.ts:656`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L656)) typechecks and builds. The on-chain proof used the same SDK call from a script, not from the browser. |
| | **Dollar launch targets priced by Pyth Pro.** Presets are set in US dollars ($5,000 opening; $25K / $50K / $100K graduation) and converted to the quote token at a Pyth Pro price (`Equity.US.SPY/USD`, feed 1398) when chosen; the converted amounts are the on-chain curve inputs and do not move afterwards. A price is refused if its confidence interval exceeds ±1% or it is stale for its market session, and a closed-market price is labelled with its date. Logic in `lib/pricing/stock-price.ts` (tested); server route `app/api/stock-price/route.ts` keeps the key server-side. The screen was verified with a stand-in Pyth response in the browser; **the live Pyth call has not been exercised**, because it needs a `PYTH_PRO_API_KEY`. Without one, launches fall back to mSPY targets. |
| **Blocked by design** | Choosing holder rewards or liquidity allocation *at launch*. `canDeploy` requires the treasury policy ([`launch-settings.tsx:10`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/launch-settings.tsx#L10)). Holder policies can be enabled *after* registration on any market (§6.5); liquidity allocation to a new market is not wired. |
| | mNVDA, mQQQ and mTSLA as quote assets. No Devnet mint exists; the UI shows "No Devnet mint yet". |
| **Not built** | A claim path for fees earned by the locked post-graduation LP position (§5.4) |
| | Indexed per-market metrics and price history |
| | Mainnet deployment, and the Meteora token-badge path that real stock tokens require (§7) |

Tests, run on 23 September: frontend `npm test` 69/69; protocol `node --test tests/*.test.mjs` 29/29 (credit 12, rewards 11, treasury 5, treasury registration 1); `cargo test -p credit-math` 6/6. Neither repository has CI; these run locally.

---

## 4. Evidence

Every signature below was queried on 23 September with `getSignatureStatuses` and returned `finalized` with no error.

| Claim | Transaction or account | Where to check the detail |
|---|---|---|
| Per-launch config and pool created (2 → 18, 3%) | [`2VaYaRAC…ZzgGoYDz`](https://explorer.solana.com/tx/2VaYaRACsBdpmWDtyBvkg4e1HZt2qzR3nb2EJwAWZmzBxvLZZvyFkm62qsje594KDPAvFGCrhmanBcwuZzgGoYDz?cluster=devnet) | [`artifacts/configurable-launch-proof.json`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/configurable-launch-proof.json) |
| Treasury registered against that config | [`2gvdw2GR…xL6NZMGZ`](https://explorer.solana.com/tx/2gvdw2GRUHHEHt1rYK2Q1AgqtTsMsCtfp5JTbkR5ZGiQnN6ZjcrYKCtkKTUBYRyuTA41QMPLW3Mw5ZoNxL6NZMGZ?cluster=devnet) | [`scripts/verify-configurable-launch.mjs`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/scripts/verify-configurable-launch.mjs) reads the state back and asserts it |
| New config account | [`2jpLkQ21…Q9dms4Zb`](https://explorer.solana.com/address/2jpLkQ21ViZtx9ccfG9NJrgKhg45iVPFz8jiQ9dms4Zb?cluster=devnet) | Decodes to `migrationQuoteThreshold` 450,000,000 (4.5 mSPY) and base fee numerator 30,000,000 / 10⁹ = 3% |
| Legacy shared config | [`CUeJ6fgs…iAPJea5J`](https://explorer.solana.com/address/CUeJ6fgsw6wGXPCBchj9jxpkGVWzanXxYJFMiAPJea5J?cluster=devnet), created in [`2NyBV1Y2…ioiEdpiS`](https://explorer.solana.com/tx/2NyBV1Y2FsbTcheFqbo8JRUtFrLyAPzEt7sAMT7g6zY21ckKgfo7qAFV3S9RLPk2UMYambkeGiN1VfrrioiEdpiS?cluster=devnet) | Threshold 347,877,538 (3.47877538 mSPY), fee 1% |
| Flagship treasury registered | [`3djJU5TA…6H1Xgp58`](https://explorer.solana.com/tx/3djJU5TAXQBvjSp6hrogALDNarZSSwWeTvmCEp9Eiz9gbGmCq82g7tozJb5h3xMw1NqiV9Y6GYpZRXax6H1Xgp58?cluster=devnet) | Pool [`BZVxHsS8…n2QmeFSf`](https://explorer.solana.com/address/BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf?cluster=devnet) |
| DBC trading fees collected into custody | [`2prZJ66U…3obwvXZf`](https://explorer.solana.com/tx/2prZJ66Um1DNMUyhVkJros7grkrJmkE6TPhdPHZyMNbY1mrXRv6HLUutBgWHfjFi7yVBe33szkXHt4wZ3obwvXZf?cluster=devnet) | Custody account [`6xZKeq3b…WeMKxF7R`](https://explorer.solana.com/address/6xZKeq3bEwN5X3Tz9MApDnTRRL6MNp2gLcchWeMKxF7R?cluster=devnet), token authority = treasury PDA |
| 50/50 allocation | [`5zVYnu6F…TcWKsiGD`](https://explorer.solana.com/tx/5zVYnu6FUVuBpMrRjEZb52JMmkAS2viR3vsq8KBSNaYQFEdqovKz1paHef5tn6baxrVCvbSH73MTefVpTcWKsiGD?cluster=devnet) | |
| Creator withdraws retained share | [`3vEPjWQY…ibyH2pFQ`](https://explorer.solana.com/tx/3vEPjWQYSjMuAKeFJsft9QEQPZ8UBxQcwFLhRtC2dXGPAD55sFrTyqvJtWiT2kFENeUfb4UenXjpaXZYibyH2pFQ?cluster=devnet) | |
| Holder-reward policy enabled | [`5hetD5fC…RBJA867u`](https://explorer.solana.com/tx/5hetD5fC1u6RmGCtr3Yx5F8y2uFd9AineafP8zzeXe9Md22W3VJxQvjCVrpiQV8QXboTxP4hk21iRAkCRBJA867u?cluster=devnet) | [`artifacts/holder-rounds/`](https://github.com/umin-ai/sonata-protocol/tree/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/holder-rounds) |
| Holder round funded | [`Hi2xFBMB…KdEb3qMh`](https://explorer.solana.com/tx/Hi2xFBMB4Qy4oL15ub3Das6WW9LhsDqhMbMfrNDpFDEGwRynFbKyKjMxHhExedrxZAbrihTsULsYookKdEb3qMh?cluster=devnet) | Snapshot documents and hashes in the same artifact |
| Holder payout delivered | [`2buXzVaG…fCLaAc9p`](https://explorer.solana.com/tx/2buXzVaGPKotxi458fr1jR8s68kLd8jHUoygGmuRsk22c8RnSADqsf6R8B5t9ZM278SdXTgi5qWMHhCKfCLaAc9p?cluster=devnet) | |
| Reserve-funded reward campaign | [`2d5jPsta…htSHVPKN`](https://explorer.solana.com/tx/2d5jPstaBQyMGzhohJdkKahJ4VJT5jwFVVon5YqYXDy3jnihU5MHv1J9rxzB1YkW7caNYf4yQkSyeBzMhtSHVPKN?cluster=devnet) | [`artifacts/stockroom-rewards-lifecycle.json`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/stockroom-rewards-lifecycle.json) |
| Recipient self-claim | [`5Wu5ZFj1…bLygqAqz`](https://explorer.solana.com/tx/5Wu5ZFj1e5PqjUNadF3xvsy3yew68wk9ktaqgkrBNjyMV4WVK4GZd8LdX9Xd5Xsh1ALjPcPiY2Dna4kUbLygqAqz?cluster=devnet) | |
| DAMM v2 pool created | [`4Rem5wgo…X7bxgXLu`](https://explorer.solana.com/tx/4Rem5wgoJ3SBpLVZLA8Uh1G5ZmYtVAiACwgwFyvW43nMu3QAoQCrdWvp1Qu9xXdqFYzWMUHt1ia8yxMmX7bxgXLu?cluster=devnet) | Pool [`GHHFvUXd…fcYZuH9v`](https://explorer.solana.com/address/GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v?cluster=devnet); [`artifacts/stockroom-liquidity-lifecycle.json`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/stockroom-liquidity-lifecycle.json) |
| LP deposit | [`2HjdML6Q…MmSDEPLz`](https://explorer.solana.com/tx/2HjdML6QozfP6kMgjShURt5jMNitpbRtdG7r27MnCmdQyp38GWA8zwudrDbZHSmYcEqLMKEDLhdbVAu3MmSDEPLz?cluster=devnet) | |
| Independent swap through that pool | [`2BVoYvi5…KfNYKAsN`](https://explorer.solana.com/tx/2BVoYvi5X6Jc5FANRT2xQQxBRPCamD1mq483YsQj7akaWj9mNotR1rZJqAw2uW3r4FEnz2E6m2eTrBbWKfNYKAsN?cluster=devnet) | |
| LP partial and full exit | [`5YazqMQr…uvhTx5cE`](https://explorer.solana.com/tx/5YazqMQr6tERtnhCAmajWi12tV35hG7RYd3iJZmdrhfUwmNLTLtu8XEFRgFTp7KgxnEUhhnx3dvwLWUmuvhTx5cE?cluster=devnet), [`2r2k9nwU…hdan2qy6`](https://explorer.solana.com/tx/2r2k9nwUT7kTfzDqnBjH2ThdSgBPEkXpdXiGFMJYTxB7brzwfRRhtXEHekk1zWLiR5qv3MYH5SqqsSRWhdan2qy6?cluster=devnet) | |
| Treasury program upgraded to the published build | [`673Yrm9r…cf5w5qpY`](https://explorer.solana.com/tx/673Yrm9r9Hf7LfwZMmb1oRxf49D1cjpwEUgKB8LbZZmAoDkZzvHWwH4MXXXDaA3cyQREGZA8UfXaKc8Tcf5w5qpY?cluster=devnet) | `artifacts/deployed-bytes-check.json` |
| Post-upgrade: second per-launch config and pool (2 → 18, 3%) | [`5uowYWec…4ctzRjta`](https://explorer.solana.com/tx/5uowYWec2RdhocXWnaWHLxaEsyo2gAeZ4Jf2vSHPnQydDFtC2bGATSUj3UMExLaCMtTfdE41KbP5z1kV4ctzRjta?cluster=devnet) | `artifacts/configurable-launch-proof-post-upgrade.json`; pool [`3HL7AdmR…cap9JNUq`](https://explorer.solana.com/address/3HL7AdmRt8J4p25v61GSkBmkFX7i1SKN5xWbcap9JNUq?cluster=devnet) |
| Post-upgrade: treasury registered against it | [`2eeR8ASt…b85uCc9Q`](https://explorer.solana.com/tx/2eeR8AStzus18m7Lnus5x4PEM6spMxXk2q1Nb1Sg5ssUSjoGrKeseJAWfYfLH4wD8TJ8F61LhZCzmPVdb85uCc9Q?cluster=devnet) | same artifact |
| Post-upgrade: buy of 0.05 mSPY on the 3% pool `EhFL…` | [`5pVHQqds…ynuTt2ek`](https://explorer.solana.com/tx/5pVHQqdsqBdrFvCMrkYngrVi3GS8iQtEfHjDDfgGhrLgKXsZGSGQL2xQqAcbicjYAoNX5HD6txCsFFahynuTt2ek?cluster=devnet) | `artifacts/fee-path-proof.json`: fee 150,000 atoms = 3.00% of 5,000,000 in; Meteora protocol 30,000; partner 120,000 |
| Post-upgrade: claim into treasury custody | [`56h8GCW5…6DwaBUV6`](https://explorer.solana.com/tx/56h8GCW527wH1o9b3uj8439ViMiemiv2iDv5dWip8YQL4Fq61nqGfKkSNq6GDRyJEjFCf9b5r6Cerywb6DwaBUV6?cluster=devnet) | 120,000 claimed = the partner fee accrued on the pool |
| Post-upgrade: 50/50 allocation | [`2aDSaWaE…jx7gPH7C`](https://explorer.solana.com/tx/2aDSaWaEdJGBfRMjLLSPgxePY53drcdKzyayirGYPBwXEd9MFaaTdmmHPRFysD2GWMYqmYSUaXdn2LKWjx7gPH7C?cluster=devnet) | 60,000 paid out, 60,000 retained |
| Post-upgrade: creator withdraws half the retained share | [`KSxQrpaT…XVn6Ln6f`](https://explorer.solana.com/tx/KSxQrpaTejzuQhe1MxefwrFNbs7B7uEpwbPHmX6AiVrfU6679gpNsPzNPUnCdSor7QXW9gkjesuKNouXVn6Ln6f?cluster=devnet) | 30,000 withdrawn; recorded in the treasury ledger |
| Graduation: curve completed on pool [`3HL7AdmR…cap9JNUq`](https://explorer.solana.com/address/3HL7AdmRt8J4p25v61GSkBmkFX7i1SKN5xWbcap9JNUq?cluster=devnet) | [`67Em6AuL…fAvja4wx`](https://explorer.solana.com/tx/67Em6AuLwHT7YvGRMoWEgKZt7cPdBAdUVS7k5m3PbaV7oRDRDQnNvQnRuBkvtMzgJJKqpVZqdWPXVFdMfAvja4wx?cluster=devnet) | `artifacts/graduation-proof.json`: quote reserve 450,000,000 = threshold |
| Graduation: fees claimed before migration | [`37gU5ext…63kXodXy`](https://explorer.solana.com/tx/37gU5extw4qr6NknUgJ5kBVVmeATY6HNgkCiaADuKBxjaxYpS3b9rdRDaAErM6KE7Y175mFYykYgy4wW63kXodXy?cluster=devnet) | 11,134,021 claimed |
| Graduation: 50/50 allocation before migration | [`4ZHtEE2f…6KyTshzC`](https://explorer.solana.com/tx/4ZHtEE2fhuRnhNqPfDXxPvUGr89Vc7NbKDw7FECqDs2XqyTBDmXmMs5e8ogzYrc2HesZ3adMErZz9aVN6KyTshzC?cluster=devnet) | 5,567,010 paid out, 5,567,011 retained |
| Graduation: migrated to DAMM v2 | [`evacEVfU…mhNwjtN5`](https://explorer.solana.com/tx/evacEVfULVpH3hJLX4EaJZwJB6FLeayeZEZfWw9ECSwPhYcvf1P1RAr6wSZxWiUxcwjWQDc1YaxQvgEmhNwjtN5?cluster=devnet) | DAMM v2 pool [`2w3DJLxu…uhe7MSyq`](https://explorer.solana.com/address/2w3DJLxuRaDe75wV3wzdvGg5gdopoMFm7hQ1uhe7MSyq?cluster=devnet); position [`FkrcTbDj…Unoowp1H`](https://explorer.solana.com/address/FkrcTbDj8ysHjc81Fu1i3AdpxEJPn8eyTfBYUnoowp1H?cluster=devnet) |
| Trade on the graduated pool | [`A9LYT61x…j1cenjNj`](https://explorer.solana.com/tx/A9LYT61xXTYbGAtRbBeVhNkxNYrm7uVA3kbwmEuGC6soDPtMTNJfBFU9MFTbMH9yaWanx8CCpCfCw4Pj1cenjNj?cluster=devnet) | `artifacts/graduated-trade-proof.json` |
| Deployed bytes vs builds, upgrade authority | read-only | `scripts/verify-deployed-bytes.mjs` → `artifacts/deployed-bytes-check.json` (all four match) |

The separate DAMM v2 pool is directly seeded. It is **not** the graduated form of any DBC pool.

---

## 5. How a launch works, with Meteora references

### 5.1 One DBC config per launch

Meteora documents that configs are permissionless and that the config, not the pool, fixes who can claim: "Any payer can create a config account, but the config fixes the `fee_claimer` and `leftover_receiver`" ([Meteora — Accounts and permissions](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions)). It also states that "A launchpad or partner defines the quote mint, curve, fees, token type, migration target, and liquidity distribution" ([Meteora — What is DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc)). Graduation targets and fee tiers are therefore each launchpad's product choice, not Meteora requirements.

Until 22 September every Sonata launch reused the legacy config `CUeJ6fgs…`. Now `prepareLaunch` generates a fresh config keypair per launch ([`runtime.ts:693`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L693)) and sends Meteora's `partner.createConfigAndPool` in one transaction ([`runtime.ts:741`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L741)), naming the Sonata vault PDA as both `fee_claimer` and `leftover_receiver`. This uses a documented Meteora path; it is not a capability Sonata unlocked.

No program redeploy was needed. At registration the treasury program validates the config it is handed rather than pinning an address: `pool.creator == creator`, `pool.config == config`, `pool.base_mint == base_mint`, `config.quote_mint == quote_mint`, `config.fee_claimer == vault` ([`stockroom-treasury/src/lib.rs:83-107`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L83-L107)). The only hard-coded public key in that file is `declare_id!` at line 7. Since 23 September those lines are byte-verified against the deployed program (§6.1). The behavioural evidence agrees: the program accepted registration against a new config both before the upgrade, in [`2gvdw2GR…`](https://explorer.solana.com/tx/2gvdw2GRUHHEHt1rYK2Q1AgqtTsMsCtfp5JTbkR5ZGiQnN6ZjcrYKCtkKTUBYRyuTA41QMPLW3Mw5ZoNxL6NZMGZ?cluster=devnet), and after it, in [`2eeR8ASt…b85uCc9Q`](https://explorer.solana.com/tx/2eeR8AStzus18m7Lnus5x4PEM6spMxXk2q1Nb1Sg5ssUSjoGrKeseJAWfYfLH4wD8TJ8F61LhZCzmPVdb85uCc9Q?cluster=devnet).

`initialMarketCap` and `migrationMarketCap` are SDK inputs, not on-chain fields. Meteora's SDK reference describes `buildCurveWithMarketCap` as building a "config from market-cap targets" ([Meteora — TypeScript SDK reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference)). The quantity a reviewer can check on-chain is `migrationQuoteThreshold`, recorded in §4.

### 5.2 What a creator chooses, and what is fixed

**What the shipped UI offers** ([`launch-settings.tsx`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/launch-settings.tsx)): a stock quote asset (only mSPY is deployable), a graduation preset of 8, 12 or 18 quote units, and a trading fee of 1%, 2% or 3%. The opening market cap is fixed at 2 quote units. This is the same shape as Embercurve's launch studio — a fixed opening, three graduation presets, three fee tiers — and Ember additionally offers four curve shapes (§8). Sonata claims no more creator choice than Ember in the UI.

**What the runtime accepts.** `buildCurveParams` accepts any opening cap of at least 0.01, any graduation target above it up to 1,000,000, and a fee of 25, 50, 100, 200 or 300 bps ([`dbc-preview.ts:3-16`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/dbc-preview.ts#L3-L16)). That range is not exposed to creators. Passing that guard is necessary, not sufficient: some combinations it accepts, such as a very small cap with a very tight ratio, fail inside Meteora's `buildCurveWithMarketCap`. When that happens the preview has no result and the launch button stays disabled, so the failure is a disabled button rather than a failed transaction. Only 2 → 18 at 3% has been exercised on-chain.

**Fixed in every config** ([`dbc-preview.ts:35-81`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/dbc-preview.ts#L35-L81)): SPL base token; 6 base and 8 quote decimals; immutable token authority; 1,000,000,000 supply; a flat fee with no scheduler decay; dynamic fee off; fees collected in the quote token; creator trading fee 0%; migration to DAMM v2 with migrated-pool fee option `FixedBps100`; 100% of partner LP permanently locked; no vesting; timestamp activation.

### 5.3 Where trading fees go

1. Meteora charges the trading fee on each swap. Meteora's protocol "Receives 20% of the total trading fee" ([Meteora — DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview)).
2. Sonata sets `creatorTradingFeePercentage` to 0, and Meteora states that in that case "the partner receives the full partner and creator fee allocation" (same page). The partner is the config's `fee_claimer`: the Sonata vault PDA.
3. `stockroom_treasury::claim` moves that share into a token account owned by the per-pool treasury PDA (§6.4).
4. `distribute` pays 50% to the `payout_owner` fixed at registration and retains 50% for the creator reserve.

For a 3% fee that is 0.6% to Meteora's protocol and 2.4% to the Sonata vault, then 1.2% paid out and 1.2% retained.

Observed on the 3% pool after the upgrade (§4): a buy of 5,000,000 atoms (0.05 mSPY) was charged 150,000 in fees, exactly 3%. Meteora's protocol took 30,000 (20%) and 120,000 accrued to the vault. The treasury claimed all 120,000, paid 60,000 to the payout owner and retained 60,000, of which the creator then withdrew 30,000. `scripts/verify-fee-path.mjs` asserts each of these against on-chain state.

The program defines three payout ratios — 100%, 50% and 0% ([`lib.rs:14-32`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L14-L32)). The app registers and discovers only the 50/50 mode.

### 5.4 Graduation to DAMM v2

Meteora specifies that "New DBC configs and new pools must use DAMM v2", that "DBC requires at least 10% of liquidity to remain locked at day 1 after migration", and that it applies "a fixed 0.2% protocol liquidity migration fee during migration" ([Meteora — Migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity)).

Sonata configs lock 100% of partner LP permanently, well above that floor. Consequently no party, including the Sonata vault, can withdraw migrated LP principal.

**Migration has been executed once, on Devnet** (§4), on per-launch pool [`3HL7AdmR…cap9JNUq`](https://explorer.solana.com/address/3HL7AdmRt8J4p25v61GSkBmkFX7i1SKN5xWbcap9JNUq?cluster=devnet) rather than the flagship, whose curve stays open for the live trading demo. `scripts/verify-graduation.mjs` runs it in the order that matters:

1. A `PartialFill` buy completes the curve. Of 480,000,000 atoms offered, 463,917,526 were used: 450,000,000 into the curve, exactly the migration threshold, plus the 3% fee. The rest was returned. With no vesting configured, the completing swap moves the pool straight to the migration-ready state; there is no locker step ([Meteora DBC `process_swap.rs` at `f552f20`](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/swap/process_swap.rs)).
2. Partner fees are claimed and allocated while the pool is still a DBC pool.
3. `migrateToDammV2` is called with the DAMM v2 config for the pool's migration fee option, `FixedBps100`: [`Hv8Lmzmn…Xz8RXcjp`](https://explorer.solana.com/address/Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp?cluster=devnet), whose pool-creator authority is the DBC pool authority, as migration requires. Meteora's separate `migration_damm_v2_create_metadata` instruction is deprecated and does nothing at this revision, so it is not called ([source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migration_damm_v2_create_metadata.rs)).

`scripts/read-graduation.mjs` then verifies from chain, without keys: the DBC pool is marked migrated; the DAMM v2 pool [`2w3DJLxu…uhe7MSyq`](https://explorer.solana.com/address/2w3DJLxuRaDe75wV3wzdvGg5gdopoMFm7hQ1uhe7MSyq?cluster=devnet) exists under Meteora's DAMM v2 program and holds both mints; and exactly one LP position was created, owned by the Sonata vault PDA, with all of its liquidity permanently locked and none unlocked. Meteora creates the larger distribution's position first and assigns it to the config's `fee_claimer`; with a 0% creator share, no creator position is created ([source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs)). A later buy on the graduated pool, [`A9LYT61x…j1cenjNj`](https://explorer.solana.com/tx/A9LYT61xXTYbGAtRbBeVhNkxNYrm7uVA3kbwmEuGC6soDPtMTNJfBFU9MFTbMH9yaWanx8CCpCfCw4Pj1cenjNj?cluster=devnet), confirms it trades.

**Limit, stated plainly:** the locked position earns DAMM v2 trading fees, but it is owned by the vault PDA and `stockroom_treasury` has no instruction to claim DAMM v2 position fees. Measured after the one trade above, the position already held 7,999 atoms of unclaimed mSPY fees — 0.8% of the 1,000,000-atom input, consistent with the 1% `FixedBps100` pool fee less the protocol share — read with the DAMM v2 SDK's `getUnClaimLpFee`. Those fees accrue and cannot currently be collected. Closing that needs a treasury program change.

Solana Compass reports that Meteora confirmed its mainnet Migration Keepers for stock-token pairs on 16 September ([Solana Compass](https://solanacompass.com/news/meteora-opens-token-launches-paired-with-backpack-issued-stocks-via-stocklaunch)). Sonata's Devnet migration was triggered by our own script, not by a keeper.

---

## 6. Security model

### 6.1 Deployed programs vs. published source

| Program | Deployed matches local build | Upgrade authority |
|---|---|---|
| `stockroom_treasury` `GPANv5z…` | Yes, since 23 September — `8d7ad9a3…` (previously `b4111fe7…`) | `vb4pmin…` |
| `stockroom_rewards` `6u1nXj1…` | Yes — `6195ac38…` | `vb4pmin…` |
| `stockroom_credit` `4sS8MrfT…` | Yes — `fea21c47…` | `vb4pmin…` |
| `demo_oracle` `E45Bq8CU…` | Yes — `50d5e020…` | `vb4pmin…` |

Method: SHA-256 of the ProgramData bytes after the 45-byte header, over a window equal to the local build's length, with the remainder required to be zero. Reproduce with `node scripts/verify-deployed-bytes.mjs` after building.

History: the treasury's source was restored after its 17 September deployment, reformatted, and rebuilt with a reconciled lockfile. The rebuild passed the repository's tests but was not deployed, so the published source could not be shown to produce the deployed bytes, and no one can now prove which source produced the original binary.

The rebuild's IDL is identical to the IDL the frontend uses to decode the live treasury accounts (same instructions, discriminators and account types), so the account layout is compatible. **Remediated on 23 September.** The program was upgraded to the tested rebuild (treasury tests 6/6 on that binary) in [`673Yrm9r…cf5w5qpY`](https://explorer.solana.com/tx/673Yrm9r9Hf7LfwZMmb1oRxf49D1cjpwEUgKB8LbZZmAoDkZzvHWwH4MXXXDaA3cyQREGZA8UfXaKc8Tcf5w5qpY?cluster=devnet), at slot 502,628,696. Program ID and accounts were unchanged: all three existing treasuries decode under the upgraded program with their ledgers intact (the flagship still reads 648,829 claimed and 324,415 retained). The checker was re-run, followed by a fresh launch and the full fee path (§4).

### 6.2 Upgrade authority: what "immutable" means here

All four programs run under the BPF upgradeable loader with upgrade authority `vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF`, which is also the deployer and the flagship market's creator. Where this document says a payout recipient, an allocation or a binding cannot be changed, that is true of every instruction in the current program. The upgrade authority can replace the program. For production the authority would move to a multisig or be revoked; that has not been done.

### 6.3 Authority model

- **Register.** `init_treasury` requires the DBC pool's own creator to sign and binds the treasury to the pool through the five checks in §5.1 ([`lib.rs:76-128`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L76-L128)). The treasury PDA is seeded `["treasury", pool]`.
- **Claim and distribute are permissionless.** Neither `Claim` nor `Distribute` declares a signer ([`lib.rs:306-347`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L306-L347)), so anyone can crank them. That is safe because the destinations are pinned: claimed fees can only enter treasury-owned accounts, and `distribute` requires `payout_quote.owner == treasury.payout_owner` ([`lib.rs:343`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L343)).
- **Withdraw.** `withdraw_retained` requires the creator's signature and sends only to the creator ([`lib.rs:227`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L227), signer at `:268`).
- **Payout recipient.** Set once at registration ([`lib.rs:118`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L118)). No instruction changes it, subject to §6.2.

### 6.4 Fee custody

Partner fees are never held by a wallet. `claim` calls Meteora DBC's `claim_trading_fee` by CPI, passing the vault PDA as `fee_claimer` and signing with seeds `["stockroom"]` ([`lib.rs:133-155`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L133-L155)). DBC authorises that call only when `config.fee_claimer` equals the signing key ([Meteora DBC `access_control.rs` at the pinned revision `f552f20`](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/access_control.rs)). The vault's seeds exist only inside the treasury program, so no external key can produce that signature.

Proceeds land in accounts constrained `token::authority = treasury` ([`lib.rs:318-321`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L318-L321)). DBC itself does not constrain those destination accounts, so this guarantee rests on Sonata's constraint, not Meteora's.

On-chain: both configs decode to `fee_claimer = leftover_receiver = 5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5`, which is `PDA(["stockroom"], GPANv5z…)`. The flagship custody account `6xZKeq3b…` is a Token-2022 account whose token authority is the treasury PDA `QZJpgjyu…`.

"Not held by the creator" describes custody, not entitlement. The creator reaches the retained share through `withdraw_retained`, and names the payout recipient at registration.

### 6.5 Holder rewards: what is enforced on-chain, and what is trusted

The 18 September handoff called the snapshot "creator-attested/offchain". That understated the implementation. It also needs a sharper boundary than "not a production trustless distributor".

**Enforced by code:**

- Holder discovery is a full token-account scan, never a top-holders sample ([`holder-scan.ts:8-31`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/rewards/holder-scan.ts#L8-L31)). On an indexed RPC, completeness depends on the RPC returning every matching account.
- When public RPC has secondary indexes disabled, the fallback returns a holder set only if its balances sum exactly to the mint supply read in the same RPC response, and otherwise refuses: "Public RPC could not prove a complete holder snapshot" ([`holder-scan.ts:32-85`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/rewards/holder-scan.ts#L32-L85)).
- The snapshot document is SHA-256 hashed ([`holders.ts:172-184`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/rewards/holders.ts#L172-L184)).
- The eight-recipient cap is a protocol limit, not a UI guard: `MAX_MEMBERS = 8` ([`stockroom-rewards/src/lib.rs:12`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-rewards/src/lib.rs#L12)). Clients fail closed rather than truncate.
- `fund` draws only from the treasury's un-withdrawn retained fees, and allocations are written once into a PDA and never edited, cancelled or refunded ([`lib.rs:107-178`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-rewards/src/lib.rs#L107-L178)).
- Double claims are blocked by `claimed_mask` on both `deliver` and `claim`. `deliver` needs no recipient signature but pays only the recorded recipient's account ([`lib.rs:85-105`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-rewards/src/lib.rs#L85-L105)).
- **When the creator runs `record_round`**, it is strict: the preceding instruction in the same transaction must be this program's `fund` on the same campaign; the snapshot must be no more than 300 slots old; and the program recomputes the budget from the treasury's retained total and the policy, rejecting the round unless the funded amount matches exactly ([`lib.rs:58-83`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-rewards/src/lib.rs#L58-L83)).

**Trusted, stated plainly:**

- `record_round` is optional. Nothing downstream requires a round record to exist, so a creator can fund a campaign with no attestation at all.
- The per-recipient split is never checked on-chain. The program stores `snapshot_hash` as given and never recomputes it from the allocations. The hash makes a later substitution detectable; it does not make one impossible.
- The operator that computes rounds runs locally. It is not an always-on service.

Both the rewards and treasury programs' deployed bytes match their source (§6.1), so these citations are byte-verified.

Holder policies are keyed per market (`["holder-policy", treasury]`, [`holders.ts:30-33`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/rewards/holders.ts#L30-L33)), so a creator can enable one on any market they created, after registration. Liquidity allocation is not generalised: the liquidity runtime is bound to the single pool `GHHFvUXd…`.

### 6.6 Client-side checks are not the security boundary

`validateMarketIdentity` ([`runtime.ts:539-555`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L539-L555)) pins the program and vault to values bundled with the frontend and checks the quote mint against the bundled registry. A substituted frontend controls those inputs, so this is a usability guard. The binding checks are the program's registration constraints (§5.1) and `readTreasury`, which re-reads the treasury, pool and config from chain and rejects any mismatch before a transaction is offered for signing ([`runtime.ts:81-136`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L81-L136)).

### 6.7 Reliance on behaviour Meteora does not document

Meteora documents fee claims as well suited to CPI — "Account lists are smaller and signer roles are clear" ([Meteora — Rust CPI](https://docs.meteora.ag/developer-guides/dbc/rust-integration/cpi)) — and describes `fee_claimer` as the "Partner authority allowed to claim partner fees" ([Meteora — Program accounts](https://docs.meteora.ag/developer-guides/dbc/program/accounts)).

What Meteora does not state is that `fee_claimer` may be a PDA owned by a third-party program. Its docs are silent on that case, not prohibitive. Sonata's entire fee path depends on it. It works on Devnet by demonstration (§4), not by documented guarantee, so a future DBC release could tighten the signer check without that counting as a documented breaking change. Mitigation per Meteora's own guidance: pin the IDL and program versions. The treasury pins DBC at `f552f20` in `programs/stockroom-treasury/Cargo.toml`.

### 6.8 Unaudited surfaces

- No program has had a professional audit.
- **`POST /api/devnet` trusts caller-supplied headers.** It authenticates on `oai-authenticated-user-*` headers without signature or session verification ([`app/api/devnet/route.ts`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/api/devnet/route.ts), [`app/chatgpt-auth.ts`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/chatgpt-auth.ts)). The middleware that strips forged copies of those headers runs only in the development server and is absent from the production build. The endpoint co-signs with a disposable Devnet authority for the historical credit demo. This frontend is not deployed publicly, and it must not be deployed as-is: doing so would expose an unauthenticated signing endpoint.
- No CI runs the test suites.

---

## 7. Mainnet gap: stock tokens need a Meteora token badge

Meteora: "Token 2022 quote assets are permissionless only when the mint uses metadata-related extensions and has a zero transfer fee." Mints with other extensions need an operator-created token badge, and Meteora states: "This is the path used for Stock Tokens and other Token 2022 quote assets that need extra extensions" ([Meteora — Token 2022 support](https://docs.meteora.ag/core-products/dbc/token-2022-support)).

Devnet mSPY ([`6gat24pu…ZHtgNJqg`](https://explorer.solana.com/address/6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg?cluster=devnet)) is Token-2022 with 8 decimals, no freeze authority, and exactly two extensions: `MetadataPointer` and `TokenMetadata` (read from chain, 23 September). It therefore uses the permissionless path. **The Devnet proof does not demonstrate the token-badge path that real stock tokens use.** Sonata's `createConfigAndPool` call passes no badge.

---

## 8. Context: other products on Meteora DBC

Third-party figures below are point-in-time readings of public pages, not audited and not reconciled on-chain.

**StockLaunch.** Per Solana Compass, "StockLaunch is a launchpad built on top of Meteora's Dynamic Bonding Curve". Creators select one of twenty Backpack-issued equities as the quote asset instead of USDC or SOL, can configure trading fees from 0% to 50%, and fees accumulate in a reward vault in the chosen stock token, distributed to holders on a time-weighted basis ([Solana Compass](https://solanacompass.com/news/meteora-opens-token-launches-paired-with-backpack-issued-stocks-via-stocklaunch)). It is live on mainnet with real, redeemable stock tokens. Sonata is on Devnet with a mock stock token, and its holder distribution is creator-funded rounds capped at eight recipients rather than continuous time-weighted accrual. We have not inspected StockLaunch's contracts.

**Embercurve.** Read on 22–23 September ([embercurve.fun/launch](https://embercurve.fun/launch)): every coin opens at a fixed $4,000 market cap; creators choose one of three graduation presets ($25K, $35K, $40K), one of three fee tiers (1%, 2%, 3%) and one of four curve shapes. When read, Ember's aggregate metrics displayed no values and its pair registry was empty, which is one reason to treat all third-party numbers as point-in-time. Ember also gates quote assets at the platform level, as Sonata does with its registry.

**pump.fun.** Per its own documentation, its curve is "a constant-product AMM", it "charges a 1.25% total trading fee, split between the coin's creator and the protocol", and "Graduation is automatic and irreversible" ([pump.fun — Bonding curve](https://pump.fun/docs/bonding-curve)). Since 21 May 2026 creators can choose USDC instead of SOL as the paired token ([pump.fun — Fees](https://pump.fun/docs/fees)). Curve shape, fee schedule and graduation rule are set by the protocol.

What Sonata does differently: the quote asset is a stock token, and each launch deploys its own DBC config reflecting the creator's chosen graduation target and fee, with fees routed to program-owned custody (§6.4). It does not offer more UI choice than Ember, and it is not first to pair launches with stocks.

---

## 9. Not done

- A claim path for fees earned by the locked post-graduation position (§5.4)
- A wallet-signed launch through the UI with a per-launch config
- Moving or revoking the upgrade authority (§6.2)
- mNVDA, mQQQ and mTSLA Devnet mints
- Launch-time holder or liquidity policy; liquidity allocation for any market other than `GHHFvUXd…`
- On-chain verification of per-recipient reward splits
- The token-badge path for real stock tokens, and any mainnet deployment
- Authentication on `/api/devnet`, and CI
- Indexed per-market metrics and price history

---

## 10. Next steps, in order

1. Record one wallet-signed launch through the UI with a per-launch config.
2. Trading a graduated market from its page. The page links to the DAMM v2 pool; swapping on it from the app is not connected.

Do not spend mainnet funds. Do not deploy the frontend publicly until §6.8 is fixed.

---

## 11. Naming

The product is **Sonata**, renamed from the working name Stockroom on 22 September. On-chain identifiers keep the old name deliberately: the program crates `stockroom_treasury` and `stockroom_rewards`, and the vault seed `"stockroom"`. Renaming the seed would change the vault address and strand every registered treasury; renaming the programs would change their addresses and invalidate the evidence in §4. Two demo tokens also keep the Metaplex names written when they were minted, "Stockroom Treasury Demo" and "Stockroom Community", because the app displays what is on chain.

---

## 12. Reproduce, files and identities

**Frontend** (`umin-ai/sonata`): `npm ci`, `npm run dev`, `npm test`, `npx tsc --noEmit`, `npm run build`.
**Protocol** (`umin-ai/sonata-protocol`): `node --test tests/*.test.mjs`, `cargo test -p credit-math`, `node scripts/verify-deployed-bytes.mjs`, `node scripts/verify-configurable-launch.mjs [out.json]` and `node scripts/verify-fee-path.mjs [proof.json] [out.json]`, `node scripts/verify-graduation.mjs [proof.json] [out.json]` and `node scripts/verify-graduated-trade.mjs` (these send Devnet transactions and need the pool creator's funded key); `node scripts/read-graduation.mjs <proof.json> <out.json> <four signatures>` is read-only. Never run the graduation script against the flagship; it refuses to.

Key frontend files: `lib/treasury/runtime.ts` (launch, registration, discovery, on-chain reads), `lib/treasury/dbc-preview.ts` (curve parameters shared by preview and launch), `lib/treasury/quote-assets.json` (quote-mint registry), `app/launch-settings.tsx` (launch options and `canDeploy`), `lib/rewards/` (holder scan and rewards), `lib/liquidity/runtime.ts` (DAMM v2 pool).

Key protocol files: `programs/stockroom-treasury/src/lib.rs`, `programs/stockroom-rewards/src/lib.rs`, `scripts/`, `artifacts/`.

| Identity | Address |
|---|---|
| Treasury program | `GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj` |
| Rewards program | `6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L` |
| Vault PDA (`fee_claimer`) | `5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5` |
| Upgrade authority, all programs | `vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF` |
| Meteora DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| mSPY quote mint | `6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg` |
| Per-launch config / pool / treasury (proof) | `2jpLkQ21ViZtx9ccfG9NJrgKhg45iVPFz8jiQ9dms4Zb` / `EhFL2cKonHPERgLNPQReqUtJKHGhdJMaTrm7ZG3je6vY` / `5uNMGvBv5roC8wFFdRT51c91Tko7DJAzGheAcE5tiYTJ` |
| Legacy shared config | `CUeJ6fgsw6wGXPCBchj9jxpkGVWzanXxYJFMiAPJea5J` |
| Flagship ROOM/mSPY DBC pool / treasury | `BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf` / `QZJpgjyuQ7uWzySDaJThv4MWT98YesXNkaU25hcN4Rr` |
| Separate ROOM/mSPY DAMM v2 pool | `GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v` |
| Graduated per-launch DBC pool / its DAMM v2 pool | `3HL7AdmRt8J4p25v61GSkBmkFX7i1SKN5xWbcap9JNUq` / `2w3DJLxuRaDe75wV3wzdvGg5gdopoMFm7hQ1uhe7MSyq` |

Never copy private key files or credentials into logs. `.keys/` and `.env*` are git-ignored in both repositories.

---

## 13. References

Every external page below returned HTTP 200 on 23 September, and each quotation in this document was found verbatim on its cited page that day.

**Meteora**
- [What is DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc) — launchpads define quote mint, curve, fees and migration target
- [Accounts and permissions](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions) — configs are permissionless; the config fixes `fee_claimer` and `leftover_receiver`
- [DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview) — protocol share of 20%; partner allocation when the creator share is 0%
- [Migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity) — DAMM v2 required; 10% lock floor; 0.2% migration fee
- [Token 2022 support](https://docs.meteora.ag/core-products/dbc/token-2022-support) — permissionless allowlist; token badges for stock tokens
- [TypeScript SDK reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference) — `buildCurveWithMarketCap`
- [Rust CPI](https://docs.meteora.ag/developer-guides/dbc/rust-integration/cpi) — fee claims suited to CPI
- [Program accounts](https://docs.meteora.ag/developer-guides/dbc/program/accounts) — `fee_claimer` role
- [Program instructions](https://docs.meteora.ag/developer-guides/dbc/program/instructions)
- [DBC SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk) — version 1.5.12 used by the frontend
- [DBC program source at `f552f20`](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/access_control.rs) — the revision the treasury pins

**Pyth**
- [Pyth Pro: acquire an API key](https://docs.pyth.network/price-feeds/pro/acquire-api-key), [REST API](https://docs.pyth.network/price-feeds/pro/api/rest), [payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference) — `POST /v1/latest_price`, bearer key kept server-side, `marketSession` values

**Other products**
- [Solana Compass — StockLaunch on Meteora DBC](https://solanacompass.com/news/meteora-opens-token-launches-paired-with-backpack-issued-stocks-via-stocklaunch)
- [Embercurve launch studio](https://embercurve.fun/launch)
- [pump.fun — Bonding curve](https://pump.fun/docs/bonding-curve) and [Fees](https://pump.fun/docs/fees)

**Hackathon**
- [Stocklana](https://hackathons.solana.com/hackathons/stocklana) — submissions close 25 September 2026, 4:00pm ET
