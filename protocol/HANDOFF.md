# Sonata — handoff and evidence

Updated 23 September 2026 (Asia/Kuching). Supersedes the 18 September handoff. Solana Devnet only. Mock tokens have no monetary value, and nothing here is an offer of securities.

**How to read this document.** Every factual statement points to one of three things: a source line (pinned permalink or `path:line`), a Devnet transaction or account on Solana Explorer, or an external page. Where a statement cannot be checked that way it is labelled as a limitation or a hypothesis. If a citation here does not support its claim, treat that as a defect in this document.

Source line links are pinned to these commits, so each keeps pointing at the code it cites even where the file has changed since.

- [`umin-ai/sonata-protocol` @ `019c688`](https://github.com/umin-ai/sonata-protocol/tree/019c688e4083cfc877fb8a8cb78c8519b92efd8e) — programs, scripts, artifacts
- [`umin-ai/sonata` @ `130b5e2`](https://github.com/umin-ai/sonata/tree/130b5e206e60800ac721b1dd59cd718d6cc5ab4e) — frontend
- [`umin-ai/sonata-protocol` @ `3988345`](https://github.com/umin-ai/sonata-protocol/tree/39883450bb2f2e5c0d068c3e478b3c506e3e6717) — Stock Floor (treasury Floor mode), its tests, scripts and evidence
- [`umin-ai/sonata` @ `e4059bf`](https://github.com/umin-ai/sonata/tree/e4059bf5f4d4b5e95d5dcf82f5d1085c3ec82abb) — public-exposure fixes and the Lightsail deployment
- [`umin-ai/sonata` @ `ca12d2d`](https://github.com/umin-ai/sonata/tree/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4) — Stock Floor switch, floor panel and token profiles

Explorer links use `?cluster=devnet`.

---

## 1. Three things a reviewer should know first

**1. The deployed treasury program now matches this repository's source, but did not until 23 September.** `stockroom_treasury` was deployed on 17 September; its source was later restored and rebuilt with a reconciled lockfile, and the rebuild did not reproduce the deployed bytes. This was recorded at the time in [`artifacts/stockroom-treasury-deployment.json`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/artifacts/stockroom-treasury-deployment.json) (`"rebuiltMatchesDeployment": false`). On 23 September the program was upgraded to the tested rebuild in [`673Yrm9r…cf5w5qpY`](https://explorer.solana.com/tx/673Yrm9r9Hf7LfwZMmb1oRxf49D1cjpwEUgKB8LbZZmAoDkZzvHWwH4MXXXDaA3cyQREGZA8UfXaKc8Tcf5w5qpY?cluster=devnet), and later the same day upgraded again to add the Stock Floor mode (§5.5) in [`3rFz2suT…hWhCRdKm`](https://explorer.solana.com/tx/3rFz2suTrLCGa7LqUppXVe81z1JJF32rqXPvefzQu4UmnfeNpgT4FcLwsffeBAKU26dJin62MRA7E4myhWhCRdKm?cluster=devnet). The rewards program, whose logic did not change but which compiles in the treasury's account types, was redeployed from its rebuild in [`3Ta1ZmML…uuYcDRYz`](https://explorer.solana.com/tx/3Ta1ZmMLSaSsonkNshjgZHpxy2xMP8Z3FnUGyA9eJqsEpJwh1V2fxytYeEVh9csWVw2AYJETyH49pYtuuYcDRYz?cluster=devnet). `scripts/verify-deployed-bytes.mjs` reports all four programs matching their builds byte for byte. Transactions in §4 ran against whichever binary was live at the time: the "post-upgrade" and graduation rows against the first upgrade, the Stock Floor and app rows against the second. See §6.1 for every program's status.

**2. All four programs are upgradeable by one key.** Anything this document calls immutable is immutable only in the sense that no instruction in the current program changes it. See §6.2.

**3. Sonata is not the first stock-paired launchpad on Meteora's Dynamic Bonding Curve.** StockLaunch is live on mainnet with Backpack-issued equities as quote assets. This document makes no first-mover claim. See §8.

---

## 2. What Sonata is

A Solana launchpad where a creator launches a community token that trades against a tokenized stock rather than against SOL or USDC. It uses Meteora's Dynamic Bonding Curve (DBC) for launch and price discovery, and graduates liquidity into a Meteora DAMM v2 pool when a curve completes. Trading fees accrue in the stock token. The target user is a memecoin-literate trader, not an issuer or enterprise.

A community token paired with a stock token is not backed equity and conveys no claim on the stock.

A creator can also switch on a **Stock Floor** at launch: half of net trading fees is held by the treasury program as a floor that any holder can redeem by burning tokens, and that the creator can never withdraw (§5.5).

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
| | **Stock Floor:** on a Floor-mode launch, a holder who is not the creator bought, fees were split 50/50, the holder burned half their tokens for exactly floor × burned ÷ supply of mQQQ, and the creator's withdrawal attempt failed on-chain with `FloorLocked` (§5.5). The same buy → add to floor → burn path was then run through the app |
| | **Launch through the app:** a dollar-priced mQQQ launch with Stock Floor on and a token profile (image, description, website) was built by the app's own launch flow and signed in two transactions by the app's built-in Devnet test wallet; its metadata URI, profile JSON and image resolve (§5.6) |
| | **Dollar launch targets priced from the Solana market, guarded by Pyth.** Presets are set in US dollars ($5,000 opening; $25K / $50K / $100K graduation) and converted to the quote token when chosen; the converted amounts are the on-chain curve inputs and do not move afterwards. The price always comes from the real xStock (e.g. QQQx) priced by Jupiter across Solana DEX liquidity, used only with at least $250K liquidity, under 1% price impact on a $1,000 quote, and under 1% gap between Jupiter's price and that executable quote; the xStock scaled-UI dividend multiplier is applied so the price is per share. Pyth never sets the price: when a server-side Pyth Pro key covers the feed, a gap above 1% between Pyth and the Solana market blocks the launch. **Proven on Devnet** with a dollar-priced mQQQ launch (§4): $25,000 converted at $746.96 from QQQx on Solana, Pyth `Equity.US.QQQ/USD` $748.07, 0.147% apart. The free Pyth plan covers QQQ and TSLA but not SPY or NVDA, so SPY launches are priced from Solana with no Pyth guard. Logic in `lib/pricing/stock-price.ts` (tested); route `app/api/stock-price/route.ts`. |
| **Implemented, not yet exercised on-chain** | A launch signed by an **extension wallet** such as Phantom. It uses the same launch flow and `execute` path as the built-in test wallet above; only the signer differs, and no extension-wallet launch has been recorded |
| **Blocked by design** | Choosing holder rewards or liquidity allocation *at launch*. `canDeploy` requires the treasury policy ([`launch-settings.tsx:10`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/launch-settings.tsx#L10)). Holder policies can be enabled *after* registration on any market (§6.5); liquidity allocation to a new market is not wired. |
| | mNVDA as a quote asset: no Devnet mint exists, and the UI shows "No Devnet mint yet". mQQQ and mTSLA exist (§4). |
| | Holder and funded rewards on markets not quoted in mSPY. The rewards program pins its funding mint to mSPY ([`stockroom-rewards/src/lib.rs:13`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-rewards/src/lib.rs#L13), enforced at `:233`), so the Rewards page hides other markets and says why. |
| **Not built** | A claim path for fees earned by the locked post-graduation LP position (§5.4) |
| | Indexed per-market metrics and price history |
| | Mainnet deployment, and the Meteora token-badge path that real stock tokens require (§7) |

Tests, run on 23 September: frontend `npm test` 85/85 (including Stock Floor maths 5, token profile validation 6, Irys encoding 2); protocol `node --test tests/*.test.mjs` 37/37 (credit 12, rewards 11, treasury 5, treasury Stock Floor 8, treasury registration 1); `cargo test -p credit-math` 6/6. Neither repository has CI; these run locally.

---

## 4. Evidence

Every signature below was queried on 23 September with `getSignatureStatuses` and returned `finalized` with no error, except the one row marked *expected refusal*, which failed as intended. `node scripts/verify-handoff.mjs` repeats these checks.

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
| mQQQ Devnet quote token created (mSPY profile) | [`39Mvt2hY…arY2zDB4`](https://explorer.solana.com/tx/39Mvt2hYXm4EXwQf6GV98LViVanV1aMaKydLz651HAYUTb3Hpq9MUdAJCUjHujCRErF1CvXvTk7bw2yRarY2zDB4?cluster=devnet) | Mint [`dXrPEzAY…q33LNTJh`](https://explorer.solana.com/address/dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh?cluster=devnet); `artifacts/mock-quote-mints.json`, `scripts/create-mock-quote-mints.mjs` |
| mTSLA Devnet quote token created (mSPY profile) | [`3n26HoKW…i8ZyeNjC`](https://explorer.solana.com/tx/3n26HoKWXwPVMHLKPaAG5H4sKwpYvaaZxGweBm9L7ReegwMuAMHFrrvtizCqbxAgxzGKaiXZWUXeTFmmi8ZyeNjC?cluster=devnet) | Mint [`4UK6qbvz…Ff8MTBaH`](https://explorer.solana.com/address/4UK6qbvzW4zuUfK7mXeJbkVh7ByrPcJMmHB4Ff8MTBaH?cluster=devnet) |
| Dollar-priced mQQQ launch: config and pool | [`35AvZwRY…pX9xgNGj`](https://explorer.solana.com/tx/35AvZwRYjTzcWQeEQQqxGsRMbM7HD8PcDDgBDxn3PXBdoFqpo2xEKaksxszvnhnAVT1NjfGf3mz1bnDzpX9xgNGj?cluster=devnet) | `artifacts/dollar-launch-mqqq.json`: $5,000 → $25,000 at $746.96 = 6.693769 → 33.468847 mQQQ; threshold 1,034,244,229 (10.34 mQQQ); Pyth guard 0.147%. Pool [`C77RCDfK…n5Fy69gq`](https://explorer.solana.com/address/C77RCDfKaCwt9LPEuWdLSHo7ZsgvvUdtgqsxn5Fy69gq?cluster=devnet) |
| Dollar-priced mQQQ launch: treasury registered | [`3YTz8WJR…N4disUEj`](https://explorer.solana.com/tx/3YTz8WJRP7z6axrnvtg2Xv5hppdAMCBAsteUwFrGeNCJR1mc7tUh2JStAwpP8X5ezhBBgc96Tntwkw1nN4disUEj?cluster=devnet) | `scripts/verify-dollar-launch.mjs` |
| Treasury ProgramData extended by 36,000 bytes for the Stock Floor build | [`2GKSLrW9…ApfB6cfU`](https://explorer.solana.com/tx/2GKSLrW9mAgH15JQCpR7PPpTUjs5fpwzqPdaygZ262jiSLfkPEokmP41sj4cNwp7jvpmUMdQhnjRhuZQApfB6cfU?cluster=devnet) | |
| Treasury program upgraded to add Stock Floor | [`3rFz2suT…hWhCRdKm`](https://explorer.solana.com/tx/3rFz2suTrLCGa7LqUppXVe81z1JJF32rqXPvefzQu4UmnfeNpgT4FcLwsffeBAKU26dJin62MRA7E4myhWhCRdKm?cluster=devnet) | `artifacts/deployed-bytes-check.json` |
| Stock Floor launch: config and pool (dollar-priced mQQQ, 3%) | [`5mcdfCdf…TsjqLSX8`](https://explorer.solana.com/tx/5mcdfCdfq6gF7WzbUCRX7rGtbxFdWvJwvJCpqYXg33BmtL7K3VWmVYcR1tNk9AZS5RibuGv7ayz73Q4dTsjqLSX8?cluster=devnet) | `artifacts/stock-floor-launch.json`: $25,000 at $746.68 from QQQx, Pyth 0.085% apart. Pool [`9iuQLtqQ…t2dfxong`](https://explorer.solana.com/address/9iuQLtqQETzEjGrPVycWFoANL22W9s3MoNfTt2dfxong?cluster=devnet) |
| Stock Floor launch: treasury registered in Floor mode | [`2hZhmYC1…rxFXGxvE`](https://explorer.solana.com/tx/2hZhmYC1Fy8K7soBxF7MuLjEyo33ycChf3jFHmbDzqcq3jB8Jed8RpkSncDYYhs3x1MbMH1S5QG4qTXjrxFXGxvE?cluster=devnet) | Treasury [`6J9Yjaok…EZnnTVfm`](https://explorer.solana.com/address/6J9Yjaokx5b4S3o2a4eNXHTUs1qchNvFQ2wUEZnnTVfm?cluster=devnet); `treasuryModeMatches: true` |
| Stock Floor: separate holder funded with test SOL and 2 mQQQ | [`31cZ1rTj…Zm2wXyoC`](https://explorer.solana.com/tx/31cZ1rTj2AjDREWJbVUebgir4i6dcb3skQ4DYDfTzXzK7kwzERtWyyMnnm1w6cKS1bmfYmJzobKdSDGoZm2wXyoC?cluster=devnet) | `artifacts/stock-floor-proof.json`, `scripts/verify-stock-floor.mjs` |
| Stock Floor: holder buys with 2 mQQQ | [`iBMjoh36…Y6YTA6U9`](https://explorer.solana.com/tx/iBMjoh36tCoMNfCn1bSmErbexXRt5nSEV4iWqBDt6DxkdcrqdAyGdKvpFUSiLLzkBby31zPGihrPC3mY6YTA6U9?cluster=devnet) | 235,200,536.533905 tokens bought |
| Stock Floor: fees claimed into the treasury | [`PtRRHvMT…LsmzSfth`](https://explorer.solana.com/tx/PtRRHvMTVYK5s2341njPnUGfB1Q1jKabDCmEphRCPnPCSjBH9ohi13jYC2JrENdz9D3q4TejCPLGBw6LsmzSfth?cluster=devnet) | 4,800,000 claimed (0.048 mQQQ) |
| Stock Floor: 50% to the payout wallet, 50% to the floor | [`2qcx7r4J…6G8vKbRC`](https://explorer.solana.com/tx/2qcx7r4Jeukm4hnUsVoNBF8JLL3oZWMDrrbwkeW5JSTo3HkFGgEvw5UpUd8VWiHh1GVkT1Dfiuc8cE3Q6G8vKbRC?cluster=devnet) | 2,400,000 paid out, 2,400,000 into the floor |
| Stock Floor: holder burns half their tokens | [`4LnByi8r…K7ECECmk`](https://explorer.solana.com/tx/4LnByi8rupBQAsHt859n8Tuteb6jw11dCmMk37MqbHidgnE3DpuHAURUCPVjouV2Ge5vUx2sd7SZ3cpdK7ECECmk?cluster=devnet) | 117,600,268.266952 burned; received 282,240 = 2,400,000 × 117,600,268,266,952 ÷ 10¹⁵ supply, exactly |
| Stock Floor: creator tries to withdraw the floor — *expected refusal* | [`gXTrvNkz…2Mft7acU`](https://explorer.solana.com/tx/gXTrvNkzP5TnhG7h9zd3PJmoDmc4yk8onAYeieM2FCz2fqoRnxBfi2jVGwsVVgqZTT6bq3YxhhAzuDC2Mft7acU?cluster=devnet) | Failed with `FloorLocked` (error 6007); nothing moved |
| App: buy on the Stock Floor market | [`2kjcad7q…iibvaunG`](https://explorer.solana.com/tx/2kjcad7quyU2Ygdxj2pc2524hneTVT4MDUSJrArhW2ucbr6PbujV17tPnj6yzqpTBzFqFuj6zGHAK6mNiibvaunG?cluster=devnet) | `artifacts/stock-floor-app-flow.json` |
| App: "Add to floor" (claim and split in one transaction) | [`2RAdtYbR…A6j3GbN2`](https://explorer.solana.com/tx/2RAdtYbRiHkduRnypncNbF9Wn3jc5SSfqHK1arZC1ZUZDJPK7W6S51EhndaQpJhecJVuLUkarxaAs8hHA6j3GbN2?cluster=devnet) | Floor 0.0211776 → 0.0214176 mQQQ |
| App: burn for stock | [`4GGL4wnz…NekPLjve`](https://explorer.solana.com/tx/4GGL4wnz8U4zxhgdidk8Hv2Zvzex8qXy48uNMgqYVjjnby5drJLznRZfNDJf2sA2e5c4FTsWuWPRNpfuNekPLjve?cluster=devnet) | 1,905,864.930164 burned → 0.00004625 mQQQ; floor per 1M tokens unchanged at 0.00002427 mQQQ |
| App launch: config and pool, token profile in metadata | [`4FtV1tKs…fTLvwvx4`](https://explorer.solana.com/tx/4FtV1tKsfDhQdsQWQWducZC55fDTfDJ1FR8g8LsQak7mYhLkgyWJ5SgtXvEAfCvcj46yQ1Z16RyaTyvvfTLvwvx4?cluster=devnet) | `artifacts/app-launch-floor-profile.json`; pool [`EFMUmeNJ…GJtMHUwQ`](https://explorer.solana.com/address/EFMUmeNJcz8Z49c74sTrmKcPq3qQsdchjzjGGJtMHUwQ?cluster=devnet) |
| App launch: treasury activated in Floor mode | [`453GAncg…rsaiwuEm`](https://explorer.solana.com/tx/453GAncgMe12nqcMHnpU3aNi8m8hCBVcn7sB2bKUHvX3bsKBND6xNp1ohgMSJb3LzWSxN9mARTmC3iprrsaiwuEm?cluster=devnet) | Treasury [`4AVWEKpr…bLpFyDB4`](https://explorer.solana.com/address/4AVWEKpru9kMcytR3Yb9vL6jUegEqD7bh1BpbLpFyDB4?cluster=devnet) |
| Rewards program redeployed from its rebuild (logic unchanged) | [`3Ta1ZmML…uuYcDRYz`](https://explorer.solana.com/tx/3Ta1ZmMLSaSsonkNshjgZHpxy2xMP8Z3FnUGyA9eJqsEpJwh1V2fxytYeEVh9csWVw2AYJETyH49pYtuuYcDRYz?cluster=devnet) | §6.1 |
| Deployed bytes vs builds, upgrade authority | read-only | `scripts/verify-deployed-bytes.mjs` → `artifacts/deployed-bytes-check.json` (all four match) |

The separate DAMM v2 pool is directly seeded. It is **not** the graduated form of any DBC pool.

---

## 5. How a launch works, with Meteora references

### 5.1 One DBC config per launch

Meteora documents that configs are permissionless and that the config, not the pool, fixes who can claim: "Any payer can create a config account, but the config fixes the `fee_claimer` and `leftover_receiver`" ([Meteora — Accounts and permissions](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions)). It also states that "A launchpad or partner defines the quote mint, curve, fees, token type, migration target, and liquidity distribution" ([Meteora — What is DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc)). Graduation targets and fee tiers are therefore each launchpad's product choice, not Meteora requirements.

Until 22 September every Sonata launch reused the legacy config `CUeJ6fgs…`. Now `prepareLaunch` generates a fresh config keypair per launch ([`runtime.ts:693`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L693)) and sends Meteora's `partner.createConfigAndPool` in one transaction ([`runtime.ts:741`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/runtime.ts#L741)), naming the Sonata vault PDA as both `fee_claimer` and `leftover_receiver`. This uses a documented Meteora path; it is not a capability Sonata unlocked.

No program redeploy was needed. At registration the treasury program validates the config it is handed rather than pinning an address: `pool.creator == creator`, `pool.config == config`, `pool.base_mint == base_mint`, `config.quote_mint == quote_mint`, `config.fee_claimer == vault` ([`stockroom-treasury/src/lib.rs:83-107`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L83-L107)). The only hard-coded public key in that file is `declare_id!` at line 7. Since 23 September those lines are byte-verified against the deployed program (§6.1). The behavioural evidence agrees: the program accepted registration against a new config both before the upgrade, in [`2gvdw2GR…xL6NZMGZ`](https://explorer.solana.com/tx/2gvdw2GRUHHEHt1rYK2Q1AgqtTsMsCtfp5JTbkR5ZGiQnN6ZjcrYKCtkKTUBYRyuTA41QMPLW3Mw5ZoNxL6NZMGZ?cluster=devnet), and after it, in [`2eeR8ASt…b85uCc9Q`](https://explorer.solana.com/tx/2eeR8AStzus18m7Lnus5x4PEM6spMxXk2q1Nb1Sg5ssUSjoGrKeseJAWfYfLH4wD8TJ8F61LhZCzmPVdb85uCc9Q?cluster=devnet).

`initialMarketCap` and `migrationMarketCap` are SDK inputs, not on-chain fields. Meteora's SDK reference describes `buildCurveWithMarketCap` as building a "config from market-cap targets" ([Meteora — TypeScript SDK reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference)). The quantity a reviewer can check on-chain is `migrationQuoteThreshold`, recorded in §4.

### 5.2 What a creator chooses, and what is fixed

**What the shipped UI offers** ([`launch-settings.tsx`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/app/launch-settings.tsx)): a stock quote asset (mSPY, mQQQ or mTSLA); a graduation target of $25K, $50K or $100K from a fixed $5,000 opening, converted to the quote token at the Solana market price (falling back to 8, 12 or 18 quote units from a 2-unit opening when no usable price is available); a trading fee of 1%, 2% or 3%; the Stock Floor switch, on by default (§5.5); and an optional token profile (§5.6). The curve choices have the same shape as Embercurve's launch studio — a fixed opening, three graduation presets, three fee tiers — and Ember additionally offers four curve shapes (§8). Sonata claims no more curve choice than Ember.

**What the runtime accepts.** `buildCurveParams` accepts any opening cap of at least 0.01, any graduation target above it up to 1,000,000, and a fee of 25, 50, 100, 200 or 300 bps ([`dbc-preview.ts:3-16`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/dbc-preview.ts#L3-L16)). That range is not exposed to creators. Passing that guard is necessary, not sufficient: some combinations it accepts, such as a very small cap with a very tight ratio, fail inside Meteora's `buildCurveWithMarketCap`. When that happens the preview has no result and the launch button stays disabled, so the failure is a disabled button rather than a failed transaction. Exercised on-chain: 2 → 18 mSPY at 3%, and dollar-priced mQQQ curves ($5,000 → $25,000) at 3%.

**Fixed in every config** ([`dbc-preview.ts:35-81`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/lib/treasury/dbc-preview.ts#L35-L81)): SPL base token; 6 base and 8 quote decimals; immutable token authority; 1,000,000,000 supply; a flat fee with no scheduler decay; dynamic fee off; fees collected in the quote token; creator trading fee 0%; migration to DAMM v2 with migrated-pool fee option `FixedBps100`; 100% of partner LP permanently locked; no vesting; timestamp activation.

### 5.3 Where trading fees go

1. Meteora charges the trading fee on each swap. Meteora's protocol "Receives 20% of the total trading fee" ([Meteora — DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview)).
2. Sonata sets `creatorTradingFeePercentage` to 0, and Meteora states that in that case "the partner receives the full partner and creator fee allocation" (same page). The partner is the config's `fee_claimer`: the Sonata vault PDA.
3. `stockroom_treasury::claim` moves that share into a token account owned by the per-pool treasury PDA (§6.4).
4. `distribute` pays 50% to the `payout_owner` fixed at registration and retains 50%: in Duet mode as a creator reserve the creator can withdraw, in Floor mode as the Stock Floor, which only holders can redeem (§5.5).

For a 3% fee that is 0.6% to Meteora's protocol and 2.4% to the Sonata vault, then 1.2% paid out and 1.2% retained.

Observed on the 3% pool after the upgrade (§4): a buy of 5,000,000 atoms (0.05 mSPY) was charged 150,000 in fees, exactly 3%. Meteora's protocol took 30,000 (20%) and 120,000 accrued to the vault. The treasury claimed all 120,000, paid 60,000 to the payout owner and retained 60,000, of which the creator then withdrew 30,000. `scripts/verify-fee-path.mjs` asserts each of these against on-chain state.

The program defines four modes ([`lib.rs:13-35`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L13-L35)): Refrain (100% paid out), Duet (50/50, creator reserve), Sustain (0% paid out) and Floor (50/50, holder-redeemable floor). The app registers Duet or Floor and discovers both.

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

### 5.5 Stock Floor

A creator can switch on the Stock Floor at launch. It is fixed at registration: `init_treasury` writes the mode once and no instruction changes it (subject to §6.2).

- **What goes in.** In Floor mode `distribute` pays 50% of each claimed batch to the payout owner and retains 50%, as Duet does ([`lib.rs:32`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L32)). With a 3% fee that is 1.2% of every trade into the floor, after Meteora's 20% share.
- **Who can take it out: holders, by burning.** `redeem(amount)` burns `amount` of the community token from the signer's own account and pays `floor × amount ÷ supply` of the quote stock, rounded down, to the signer's own account ([`lib.rs:274-334`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L274-L334)). `floor` is the treasury's retained balance not yet paid out; `supply` is the base mint's supply read in the same instruction.
- **The creator cannot.** `withdraw_retained` fails with `FloorLocked` on a Floor treasury ([`lib.rs:234`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L234)). The rewards program funds campaigns through that same instruction, so it cannot draw from a floor either.
- **Nobody else's share goes down.** The payout rounds down, so a redemption never lowers the floor per remaining token: (F − p) ÷ (S − a) ≥ F ÷ S whenever p ≤ F·a ÷ S. The Devnet proof checks this after a real redemption (`floorPerTokenNotReduced`), and the app flow shows the floor per 1M tokens unchanged after a burn (§4).
- **Conservative by construction.** `supply` counts every token in existence, including unsold tokens still on the curve and, after graduation, tokens inside the locked DAMM v2 position. Their share stays in the treasury: tokens on the curve carry it to whoever buys them, and the locked position's share can never be redeemed. The floor per token a holder sees is therefore a lower bound.
- **Why it holds.** If the market price falls below the floor per token, buying and burning is profitable, which pushes the price back up. That is a mechanism, not a price guarantee: the floor per token starts small and grows with trading volume.

**Limit:** the floor grows only from DBC trading fees, so it stops growing at graduation, because the locked DAMM v2 position's fees are not claimable (§5.4). Redemption keeps working after graduation.

Proven on Devnet (§4) by `scripts/verify-stock-floor.mjs`, which asserts eleven checks against chain state, then again through the app. In the app every Floor market shows the floor, what new trades will add, and a burn action ([`stock-floor.tsx`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/app/onchain/stock-floor.tsx)); "Add to floor" sends `claim` and `distribute` in one transaction ([`runtime.ts:360`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/treasury/runtime.ts#L360)), and the burn is built at [`runtime.ts:371`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/treasury/runtime.ts#L371) using the program's rounding ([`floor.ts:7`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/treasury/floor.ts#L7)).

This is a Sonata mechanism in the treasury program. Meteora's documentation is not a source for it; the only Meteora behaviour it relies on is the existing fee path (§5.3, §6.4).

### 5.6 Token profile

Like pump.fun's create form, a launch can carry an image, a short description and Website, X and Telegram links. They go into a Metaplex-style metadata JSON, with the links both under `extensions` and as top-level `website`, `twitter` and `telegram`, and its URI is passed as `uri` in `createConfigAndPool`'s `preCreatePoolParam`. It is written into the token's metadata account at creation, and the token's authority is immutable (§5.2), so the profile cannot be changed afterwards.

- **Storage.** Irys devnet, Arweave's test network. Uploads under about 100 KB are free, so the server signs each upload with a throwaway key and holds no secret. The uploader builds ANS-104 data items with WebCrypto ([`irys-upload.ts:104`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/server/irys-upload.ts#L104)); its output was compared byte for byte with the official `@irys/bundles` library, and `irys-upload.test.ts` pins that result. **Devnet uploads are temporary;** production would use permanent Arweave storage.
- **Validation.** Links must be `https`, with no credentials; X links must be on x.com or twitter.com and Telegram links on t.me or telegram.me ([`token-profile.ts:24`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/token-profile.ts#L24)). Images are checked by their first bytes (PNG, JPEG, WebP or GIF only), square-cropped and re-encoded under 95 KB in the browser. When a profile is read back, only URIs on Irys hosts are fetched and every link is validated again before display ([`token-profile.ts:119`](https://github.com/umin-ai/sonata/blob/ca12d2d489f85f0a7eb8341d3b2c6d94ec8323a4/lib/token-profile.ts#L119)); a token whose metadata points elsewhere shows no image or links.
- **Proven through the app** (§4): the metadata account of the app launch holds the Irys URI, the JSON resolves with the description and website, and the 4,570-byte WebP image resolves.

---

## 6. Security model

### 6.1 Deployed programs vs. published source

| Program | Deployed matches local build | Upgrade authority |
|---|---|---|
| `stockroom_treasury` `GPANv5z…` | Yes — `c62dc338…`, the Stock Floor build (before that `8d7ad9a3…`, originally `b4111fe7…`) | `vb4pmin…` |
| `stockroom_rewards` `6u1nXj1…` | Yes — `736f450a…`, redeployed 23 September (previously `6195ac38…`) | `vb4pmin…` |
| `stockroom_credit` `4sS8MrfT…` | Yes — `fea21c47…` | `vb4pmin…` |
| `demo_oracle` `E45Bq8CU…` | Yes — `50d5e020…` | `vb4pmin…` |

Method: SHA-256 of the ProgramData bytes after the 45-byte header, over a window equal to the local build's length, with the remainder required to be zero. Reproduce with `node scripts/verify-deployed-bytes.mjs` after building.

History: the treasury's source was restored after its 17 September deployment, reformatted, and rebuilt with a reconciled lockfile. The rebuild passed the repository's tests but was not deployed, so the published source could not be shown to produce the deployed bytes, and no one can now prove which source produced the original binary.

The rebuild's IDL is identical to the IDL the frontend uses to decode the live treasury accounts (same instructions, discriminators and account types), so the account layout is compatible. **Remediated on 23 September.** The program was upgraded to the tested rebuild (treasury tests 6/6 on that binary) in [`673Yrm9r…cf5w5qpY`](https://explorer.solana.com/tx/673Yrm9r9Hf7LfwZMmb1oRxf49D1cjpwEUgKB8LbZZmAoDkZzvHWwH4MXXXDaA3cyQREGZA8UfXaKc8Tcf5w5qpY?cluster=devnet), at slot 502,628,696. Program ID and accounts were unchanged: all three existing treasuries decode under the upgraded program with their ledgers intact (the flagship still reads 648,829 claimed and 324,415 retained). The checker was re-run, followed by a fresh launch and the full fee path (§4).

**Second upgrade, 23 September: Stock Floor.** ProgramData was extended by 36,000 bytes ([`2GKSLrW9…ApfB6cfU`](https://explorer.solana.com/tx/2GKSLrW9mAgH15JQCpR7PPpTUjs5fpwzqPdaygZ262jiSLfkPEokmP41sj4cNwp7jvpmUMdQhnjRhuZQApfB6cfU?cluster=devnet)) and the program upgraded ([`3rFz2suT…hWhCRdKm`](https://explorer.solana.com/tx/3rFz2suTrLCGa7LqUppXVe81z1JJF32rqXPvefzQu4UmnfeNpgT4FcLwsffeBAKU26dJin62MRA7E4myhWhCRdKm?cluster=devnet)). The account layout is unchanged: Floor is a new enum variant without data, appended after the existing ones, so existing treasuries decode exactly as before, and every existing market loads in the app after the upgrade. The treasury tests passed 13/13 on this binary (5 existing, 8 Stock Floor).

**Rewards redeploy, 23 September.** The rewards program's source did not change, but it compiles in the treasury's account types, which gained the Floor variant, so its rebuild no longer matched the deployed bytes. It was redeployed from that rebuild (rewards tests 11/11 on it) in [`3Ta1ZmML…uuYcDRYz`](https://explorer.solana.com/tx/3Ta1ZmMLSaSsonkNshjgZHpxy2xMP8Z3FnUGyA9eJqsEpJwh1V2fxytYeEVh9csWVw2AYJETyH49pYtuuYcDRYz?cluster=devnet). The Rewards page loads the existing funded rounds and payouts under the redeployed program.

### 6.2 Upgrade authority: what "immutable" means here

All four programs run under the BPF upgradeable loader with upgrade authority `vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF`, which is also the deployer and the flagship market's creator. Where this document says a payout recipient, an allocation or a binding cannot be changed, that is true of every instruction in the current program. The upgrade authority can replace the program. For production the authority would move to a multisig or be revoked; that has not been done.

### 6.3 Authority model

- **Register.** `init_treasury` requires the DBC pool's own creator to sign and binds the treasury to the pool through the five checks in §5.1 ([`lib.rs:76-128`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L76-L128)). The treasury PDA is seeded `["treasury", pool]`.
- **Claim and distribute are permissionless.** Neither `Claim` nor `Distribute` declares a signer ([`lib.rs:306-347`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L306-L347)), so anyone can crank them. That is safe because the destinations are pinned: claimed fees can only enter treasury-owned accounts, and `distribute` requires `payout_quote.owner == treasury.payout_owner` ([`lib.rs:343`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L343)).
- **Withdraw.** `withdraw_retained` requires the creator's signature and sends only to the creator ([`lib.rs:227`](https://github.com/umin-ai/sonata-protocol/blob/019c688e4083cfc877fb8a8cb78c8519b92efd8e/programs/stockroom-treasury/src/lib.rs#L227), signer at `:268`). It is refused on Floor treasuries ([`lib.rs:234`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L234)).
- **Redeem.** Any holder may call it, but it burns only from a token account whose authority is the signer and pays only to a token account owned by the signer; `base_mint` and `quote_mint` are bound to the treasury by `has_one`, and each token program is bound to its mint ([`lib.rs:337-354`](https://github.com/umin-ai/sonata-protocol/blob/39883450bb2f2e5c0d068c3e478b3c506e3e6717/programs/stockroom-treasury/src/lib.rs#L337-L354)). `tests/treasury-floor.test.mjs` tries burning another holder's tokens, redirecting the payout, substituting the mint, over-burning and dust amounts; each is refused.
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
- **`POST /api/devnet` is off on the hosted app.** It authenticates on `oai-authenticated-user-*` headers without signature or session verification ([`app/chatgpt-auth.ts`](https://github.com/umin-ai/sonata/blob/130b5e206e60800ac721b1dd59cd718d6cc5ab4e/app/chatgpt-auth.ts)), and it co-signs with a disposable Devnet authority for the historical credit demo. Since 23 September it returns 404 unless `SONATA_ENABLE_DEVNET_SPONSOR=1` is set ([`route.ts:5-14`](https://github.com/umin-ai/sonata/blob/e4059bf5f4d4b5e95d5dcf82f5d1085c3ec82abb/app/api/devnet/route.ts#L5-L14)). The hosted server has neither that flag nor the authority key, and its proxy strips those headers ([`Caddyfile`](https://github.com/umin-ai/sonata/blob/e4059bf5f4d4b5e95d5dcf82f5d1085c3ec82abb/deploy/lightsail/Caddyfile)). It remains a local-only tool.
- **`POST /api/token-profile` is unauthenticated but limited.** It checks origin, size and image type, and allows 6 uploads per client and 120 in total per 10 minutes ([`route.ts:36`](https://github.com/umin-ai/sonata/blob/e4059bf5f4d4b5e95d5dcf82f5d1085c3ec82abb/app/api/token-profile/route.ts#L36)). Someone with many addresses could still use up the total and block uploads for up to 10 minutes.
- **Hosted on Devnet** at https://sonata.umin.ai (DNS at Cloudflare, not proxied), on one AWS Lightsail instance: Caddy (HTTPS, Let's Encrypt) in front of the app, which runs in workerd through wrangler's local mode and listens only on 127.0.0.1. The firewall opens 80 and 443; SSH is limited to the operator's address. Server-only settings are the Pyth and Jupiter keys and an S3 key that can only upload. Setup is scripted in [`deploy/lightsail/`](https://github.com/umin-ai/sonata/tree/e4059bf5f4d4b5e95d5dcf82f5d1085c3ec82abb/deploy/lightsail). wrangler's local mode is a development server used here as the runtime: adequate for a Devnet demo, not a production host. The DNS record points at the instance's public IP, which has no static IP yet, so stopping and starting the instance would break the address until the record is updated.
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

pump.fun's create page, read on 23 September ([pump.fun/create](https://pump.fun/create)), offers SOL or USDC as the pair, creator rewards sent to the creator or to holders, and Mayhem mode, a creation-time switch under which, per its documentation, an AI agent trades the coin for its first 24 hours ([pump.fun — Mayhem Mode](https://pump.fun/docs/mayhem-mode)).

What Sonata does differently: the quote asset is a stock token; each launch deploys its own DBC config reflecting the creator's chosen graduation target and fee, with fees routed to program-owned custody (§6.4); and a creator can switch on the Stock Floor (§5.5), a burn-to-redeem floor held by the program that the creator cannot withdraw. We did not find a burn-to-redeem floor on pump.fun's or Ember's create pages, and Solana Compass describes StockLaunch's holder distribution as time-weighted accrual, a different mechanism; we have not inspected StockLaunch's contracts. Sonata does not offer more curve choice than Ember, and it is not first to pair launches with stocks.

---

## 9. Not done

- A claim path for fees earned by the locked post-graduation position (§5.4)
- A launch signed by an extension wallet such as Phantom (the app's built-in test wallet has signed one, §4)
- Stock Floor growth after graduation, which needs the DAMM v2 fee claim above
- Permanent storage for token profiles (Irys devnet uploads are temporary)
- Moving or revoking the upgrade authority (§6.2)
- An mNVDA Devnet mint
- Rewards for markets not quoted in mSPY (a rewards program change)
- Launch-time holder or liquidity policy; liquidity allocation for any market other than `GHHFvUXd…`
- On-chain verification of per-recipient reward splits
- The token-badge path for real stock tokens, and any mainnet deployment
- CI
- A static IP and a real domain for the hosted app
- Indexed per-market metrics and price history

---

## 10. Next steps, in order

1. Record one launch signed by an extension wallet, ideally in the demo video.
2. Add a treasury instruction that claims the locked DAMM v2 position's fees, so both the fee path and the Stock Floor keep growing after graduation.
3. Trading a graduated market from its page. The page links to the DAMM v2 pool; swapping on it from the app is not connected.

Do not spend mainnet funds. Hosting notes and remaining limits are in §6.8.

---

## 11. Naming

The product is **Sonata**, renamed from the working name Stockroom on 22 September. On-chain identifiers keep the old name deliberately: the program crates `stockroom_treasury` and `stockroom_rewards`, and the vault seed `"stockroom"`. Renaming the seed would change the vault address and strand every registered treasury; renaming the programs would change their addresses and invalidate the evidence in §4. Two demo tokens also keep the Metaplex names written when they were minted, "Stockroom Treasury Demo" and "Stockroom Community", because the app displays what is on chain.

---

## 12. Reproduce, files and identities

**Hosted (Devnet):** https://sonata.umin.ai

**Frontend** (`umin-ai/sonata`): `npm ci`, `npm run dev`, `npm test`, `npx tsc --noEmit`, `npm run build`.
**Protocol** (`umin-ai/sonata-protocol`): `node --test tests/*.test.mjs`, `cargo test -p credit-math`, `node scripts/verify-deployed-bytes.mjs`, `node scripts/verify-configurable-launch.mjs [out.json]` and `node scripts/verify-fee-path.mjs [proof.json] [out.json]`, `node scripts/verify-graduation.mjs [proof.json] [out.json]` and `node scripts/verify-graduated-trade.mjs`, `node scripts/verify-dollar-launch.mjs mQQQ 25000 300` (needs the frontend dev server for its price route) and `node scripts/create-mock-quote-mints.mjs`, `SONATA_MODE=floor node scripts/verify-dollar-launch.mjs mQQQ 25000 300 artifacts/stock-floor-launch.json` then `node scripts/verify-stock-floor.mjs artifacts/stock-floor-launch.json`, and `node scripts/fund-devnet-wallet.mjs <address> [sol] [symbol] [amount]` (these send Devnet transactions and need the pool creator's funded key); `node scripts/read-graduation.mjs <proof.json> <out.json> <four signatures>` and `node scripts/verify-handoff.mjs` are read-only. Never run the graduation script against the flagship; it refuses to.

Key frontend files: `lib/treasury/runtime.ts` (launch, registration, discovery, on-chain reads), `lib/treasury/dbc-preview.ts` (curve parameters shared by preview and launch), `lib/treasury/quote-assets.json` (quote-mint registry), `app/launch-settings.tsx` (launch options and `canDeploy`), `lib/rewards/` (holder scan and rewards), `lib/liquidity/runtime.ts` (DAMM v2 pool), `lib/treasury/floor.ts` and `app/onchain/stock-floor.tsx` (Stock Floor), `lib/token-profile.ts`, `lib/server/irys-upload.ts` and `app/api/token-profile/route.ts` (token profiles).

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
| mQQQ / mTSLA quote mints | `dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh` / `4UK6qbvzW4zuUfK7mXeJbkVh7ByrPcJMmHB4Ff8MTBaH` |
| Stock Floor proof pool / treasury | `9iuQLtqQETzEjGrPVycWFoANL22W9s3MoNfTt2dfxong` / `6J9Yjaokx5b4S3o2a4eNXHTUs1qchNvFQ2wUEZnnTVfm` |
| App launch (Stock Floor, token profile) pool / treasury | `EFMUmeNJcz8Z49c74sTrmKcPq3qQsdchjzjGGJtMHUwQ` / `4AVWEKpru9kMcytR3Yb9vL6jUegEqD7bh1BpbLpFyDB4` |

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

**Jupiter**
- [Price API v3](https://dev.jup.ag/docs/price/v3) and [Swap quote](https://dev.jup.ag/docs/swap/get-quote) — Solana DEX aggregation used to price the real xStock

**Pyth**
- [Pyth Pro: acquire an API key](https://docs.pyth.network/price-feeds/pro/acquire-api-key), [REST API](https://docs.pyth.network/price-feeds/pro/api/rest), [payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference) — `POST /v1/latest_price`, bearer key kept server-side, `marketSession` values

**Storage**
- [ANS-104 bundled data items](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) — the format the token-profile uploader builds

**Other products**
- [Solana Compass — StockLaunch on Meteora DBC](https://solanacompass.com/news/meteora-opens-token-launches-paired-with-backpack-issued-stocks-via-stocklaunch)
- [Embercurve launch studio](https://embercurve.fun/launch)
- [pump.fun — Bonding curve](https://pump.fun/docs/bonding-curve), [Fees](https://pump.fun/docs/fees), [Mayhem Mode](https://pump.fun/docs/mayhem-mode) and [create page](https://pump.fun/create)

**Hackathon**
- [Stocklana](https://hackathons.solana.com/hackathons/stocklana) — submissions close 25 September 2026, 4:00pm ET
