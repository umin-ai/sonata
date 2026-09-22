# Stockroom — live liquidity milestone, 18 September 2026

> Later milestone: creator reserve deployment and funded reward claims are now implemented. See [connected capital and rewards](stockroom-live-capital-rewards-2026-09-18.md). Remaining-work items below describe the earlier liquidity milestone.

This update supersedes older notes saying that all LP deposits and compounding are simulated. It does **not** mean the entire Stockroom roadmap is complete.

## What now works

Local page: http://localhost:5173/earn

An actual ROOM/mSPY Meteora DAMM v2 pool on Solana Devnet. Users supply both tokens, receive a wallet-owned position NFT, trade against that same pool, earn native compounded LP fees, and redeem some or all of their unlocked liquidity. The homepage, sidebar, portfolio, and wallet activity connect to this flow. The existing shared transaction-review, signing, simulation and receipt-recovery layer is reused.

The position is a native Meteora position, **not a newly deployed Stockroom pooled vault contract or a fungible Stockroom share token**. Stockroom's treasury and credit programs remain separate. No existing program was upgraded during this milestone. This deliberately uses the mature protocol's ownership and liquidity accounting rather than duplicating it in an untested wrapper.

## Exact economics and custody

- Pool: `GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v`
- Program: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
- Asset A: ROOM, `3Hwo2RGJpHQfVd5BW92423uU5gomnhQRxDm7PZnfS8Js`, SPL Token, 6 decimals.
- Asset B: mSPY, `6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg`, Token-2022, 8 decimals.
- These are existing Stockroom **valueless mocks**, not shares or issuer-authorized xStocks.
- Fixed 1% trading fee; protocol deductions apply. `collectFeeMode=2`, `compoundingFeeBps=10000`.
- All net LP fees go directly into token-B reserves. They are never a second claimable balance. No keeper or fabricated compound transaction is needed.
- Native full-range constant-product liquidity. Each wallet owns an NFT identifying its independent position in the same pool. Withdrawals burn/reduce position liquidity, not someone else's deposit receipt.
- No lock is applied by Stockroom's deposit flow. Each deposit creates a new position and incurs account rent. Full withdrawal leaves an empty NFT/position; closing it and reclaiming rent are not implemented in the UI.
- Meteora reserves/dead liquidity and round-down redemptions remain part of native accounting. All unlocked units can be redeemed, but atom-level rounding dust need not equal the original deposited atoms.
- A seed position remains in the pool after the test depositors exit. The seed was provided from the authorized Devnet deployer wallet; this is not organic external TVL.
- ROOM/mSPY also has an existing DBC launch market. This DAMM pool is directly seeded and distinct. It is not the DBC pool's graduation/migration. Trades on DBC do not pay these LP positions.
- Providing liquidity changes asset exposure. More earned fees do not imply a positive total return or outperformance versus simply holding. We do not advertise an APY or dollar TVL from valueless test assets.

## Verified end-to-end test

Three separate roles plus seed liquidity: Alice supplies 2,000,000 ROOM and matching mSPY; Bob supplies 4,000,000 ROOM and matching mSPY; a third wallet trades 1,000,000 ROOM. Alice withdraws half, then everything remaining; Bob exits fully.

Checks performed against actual Devnet program execution:

1. Each deposit creates its own position and expected unlocked liquidity.
2. The independent trader is neither depositor.
3. The swap earns a nonzero LP fee and zero separately claimable fee under 100% compounding.
4. Pool reserves reconcile to the swap output and protocol fee. The reserve product increases while total liquidity units remain unchanged, consistent with native fee growth.
5. A non-owner withdrawal simulation fails with `InvalidAuthority`.
6. An impossible minimum-return withdrawal fails with `ExceededSlippage`.
7. An over-withdrawal fails with `InsufficientLiquidity`.
8. Both partial and full redemptions match exact wallet token deltas; both tested depositors finish with zero unlocked units.
9. An independent read-only script re-fetches all 10 successful funding/pool/deposit/trade/withdrawal receipts and verifies ownership, signers and token movements.

The negative tests are failed simulations, not submitted failed transactions. This is an integration test of the real Meteora deployment, not a formal audit, load test or proof of product demand.

### Protocol receipts

- fund-alice: [21fvsmy2oZijSnzcH9u7V7yq2WBamG1EP4ZoyQPYQCcbDPuhhh5PF5EVkELZUP1zKGfNKHtC3ef3hJe4vcZ2UYd4](https://explorer.solana.com/tx/21fvsmy2oZijSnzcH9u7V7yq2WBamG1EP4ZoyQPYQCcbDPuhhh5PF5EVkELZUP1zKGfNKHtC3ef3hJe4vcZ2UYd4?cluster=devnet)
- fund-bob: [3ZtjsccjywH8pTnymS9ePd3BaJLd5TWJ168BqdqSssX2whtRhmzWkwQf86edN6frdAPpEudtHHe6V3afi6aeF4Mz](https://explorer.solana.com/tx/3ZtjsccjywH8pTnymS9ePd3BaJLd5TWJ168BqdqSssX2whtRhmzWkwQf86edN6frdAPpEudtHHe6V3afi6aeF4Mz?cluster=devnet)
- fund-trader: [QgipMescUr5MGZA2h5sn3AhZrPCiE3NfaQnrrVgzuVeZh8vwFFQN2F4KYPvedejM5DvF3ghqJCizFKEzKyVHGfB](https://explorer.solana.com/tx/QgipMescUr5MGZA2h5sn3AhZrPCiE3NfaQnrrVgzuVeZh8vwFFQN2F4KYPvedejM5DvF3ghqJCizFKEzKyVHGfB?cluster=devnet)
- create-pool: [4Rem5wgoJ3SBpLVZLA8Uh1G5ZmYtVAiACwgwFyvW43nMu3QAoQCrdWvp1Qu9xXdqFYzWMUHt1ia8yxMmX7bxgXLu](https://explorer.solana.com/tx/4Rem5wgoJ3SBpLVZLA8Uh1G5ZmYtVAiACwgwFyvW43nMu3QAoQCrdWvp1Qu9xXdqFYzWMUHt1ia8yxMmX7bxgXLu?cluster=devnet)
- deposit-alice: [2HjdML6QozfP6kMgjShURt5jMNitpbRtdG7r27MnCmdQyp38GWA8zwudrDbZHSmYcEqLMKEDLhdbVAu3MmSDEPLz](https://explorer.solana.com/tx/2HjdML6QozfP6kMgjShURt5jMNitpbRtdG7r27MnCmdQyp38GWA8zwudrDbZHSmYcEqLMKEDLhdbVAu3MmSDEPLz?cluster=devnet)
- deposit-bob: [4kEsChXCwddvTaiPJZB6zMdvda4LtQANm9u94Z2Vp35aXejHPtUbgE5BAoYRshXm5kpsrTCFBvtngKYWoPrNgitr](https://explorer.solana.com/tx/4kEsChXCwddvTaiPJZB6zMdvda4LtQANm9u94Z2Vp35aXejHPtUbgE5BAoYRshXm5kpsrTCFBvtngKYWoPrNgitr?cluster=devnet)
- independent-trade: [2BVoYvi5X6Jc5FANRT2xQQxBRPCamD1mq483YsQj7akaWj9mNotR1rZJqAw2uW3r4FEnz2E6m2eTrBbWKfNYKAsN](https://explorer.solana.com/tx/2BVoYvi5X6Jc5FANRT2xQQxBRPCamD1mq483YsQj7akaWj9mNotR1rZJqAw2uW3r4FEnz2E6m2eTrBbWKfNYKAsN?cluster=devnet)
- alice-partial-exit: [5YazqMQr6tERtnhCAmajWi12tV35hG7RYd3iJZmdrhfUwmNLTLtu8XEFRgFTp7KgxnEUhhnx3dvwLWUmuvhTx5cE](https://explorer.solana.com/tx/5YazqMQr6tERtnhCAmajWi12tV35hG7RYd3iJZmdrhfUwmNLTLtu8XEFRgFTp7KgxnEUhhnx3dvwLWUmuvhTx5cE?cluster=devnet)
- alice-full-exit: [2r2k9nwUT7kTfzDqnBjH2ThdSgBPEkXpdXiGFMJYTxB7brzwfRRhtXEHekk1zWLiR5qv3MYH5SqqsSRWhdan2qy6](https://explorer.solana.com/tx/2r2k9nwUT7kTfzDqnBjH2ThdSgBPEkXpdXiGFMJYTxB7brzwfRRhtXEHekk1zWLiR5qv3MYH5SqqsSRWhdan2qy6?cluster=devnet)
- bob-full-exit: [PPUL9nnDewFTnRBgds5JM26eqFFt4rNFhxJ63nr4XPDzFrrxY39ra1deDjg8S6EAfdvaK4jqNCF5MFwYY316TTp](https://explorer.solana.com/tx/PPUL9nnDewFTnRBgds5JM26eqFFt4rNFhxJ63nr4XPDzFrrxY39ra1deDjg8S6EAfdvaK4jqNCF5MFwYY316TTp?cluster=devnet)

## Browser verification

The existing disposable browser wallet deposited 100,000 ROOM plus matching mSPY, bought ROOM with 0.0001 mSPY through the same pool, withdrew half and then fully exited. The UI showed fee growth from 0.00001541 to 0.00001621 mSPY and the position composition changing after the swap. Portfolio returned to zero active LP positions, with the redeemed tokens back in wallet balances. These are test actions, not usage traction.

- Deposit: [3RzbEu8RB68RFo18p3BuPEgekpDWS1nDFofi33yaWAhhBbZB6MSqiB8is4ivBiS6RynK1M8V3nhVvwFWvptsHRko](https://explorer.solana.com/tx/3RzbEu8RB68RFo18p3BuPEgekpDWS1nDFofi33yaWAhhBbZB6MSqiB8is4ivBiS6RynK1M8V3nhVvwFWvptsHRko?cluster=devnet)
- Pool swap: [22u6iV24LziZQ4BWEysp8pkqBW7Vnsnj3RSTuuziyZwqRMnkrk7ecwvG6Zzd23ExLTbcBCUiABvDEtX8khFAikWz](https://explorer.solana.com/tx/22u6iV24LziZQ4BWEysp8pkqBW7Vnsnj3RSTuuziyZwqRMnkrk7ecwvG6Zzd23ExLTbcBCUiABvDEtX8khFAikWz?cluster=devnet)
- Partial withdrawal: [2qxE2WcS3srRcPBKud55CeGbnTcndhtd6Sfzz6LNUmd4iJgxvMZigBVoX9fvkdpQNRNYfuvabVrtaFaiaQ3UsJtK](https://explorer.solana.com/tx/2qxE2WcS3srRcPBKud55CeGbnTcndhtd6Sfzz6LNUmd4iJgxvMZigBVoX9fvkdpQNRNYfuvabVrtaFaiaQ3UsJtK?cluster=devnet)
- Full exit: [yE9ZWgZmuwH6YtVH1vq2cAxYe5M2JaWEHFko6Pi9YBfHiEPFWEqojCFWEtgXMR1z6zoE5ioKKReabzhYpQjQnHv](https://explorer.solana.com/tx/yE9ZWgZmuwH6YtVH1vq2cAxYe5M2JaWEHFko6Pi9YBfHiEPFWEqojCFWEtgXMR1z6zoE5ioKKReabzhYpQjQnHv?cluster=devnet)

Both asset debits/receipts are displayed before signing. Deposit caps and withdrawal minimums use integer math with 0.5% slippage; reviews expire after 30 seconds. Wallet changes and missing NFT ownership reject preparation. Uncertain receipts block new submissions. All transaction builders simulate before review.

A basis-point mismatch was caught during browser review: this SDK's `getQuote2.slippage` takes basis points, so 0.5% is **50**, not 0.5. The frontend now passes 50 and has a regression test against the official SDK helper. The earlier CLI independent-trade proof used the stricter 0.01% floor produced by passing 0.5; its recorded quote and successful receipt are preserved, not retrospectively changed.

The adapter checks Devnet genesis, executable program and account owner, exact supported mints/programs/decimals, compounding mode, the fixed fee configuration, absence of freeze authorities, and supported mint extensions. It rejects unknown transfer-fee/hook/nontransferable extensions. Very small deposits that cannot create a redeemable two-asset position are rejected. Positive one-atom withdrawal quotes retain a one-atom minimum.

Validation: TypeScript check passed; 24 frontend tests passed; production build passed. Browser deposit/swap/partial/full exit and portfolio integration passed. Earn page tested at a 390px viewport with no horizontal overflow. The build retains existing Anchor packaging warnings; it is not warning-free. Public Devnet RPC rate limits occurred during scripted receipt collection; read-only verification was paced and completed successfully.

## Sources inspected and implementation

Official references:

- https://github.com/MeteoraAg/damm-v2 — checkout `a85c926607433f23f0ea60f4ca7b1ae92f4156cb`.
- https://github.com/MeteoraAg/damm-v2-sdk — checkout `8ed7fcef1a70c972eb0fae5b82d876ae2427a6a3`.
- https://docs.meteora.ag/core-products/damm-v2/compounding-liquidity
- https://github.com/MeteoraAg/docs/blob/main/developer-guides/damm-v2/index.mdx

Installed SDK: `@meteora-ag/cp-amm-sdk@1.4.8`, exact version in both package manifests and lockfiles. Inspected official SDK pool creation, deposit, withdrawal, swap and close-position tests; source fee codecs and basis-point helper; onchain position authority, slippage, liquidity bounds and native fee accounting. Successful Devnet execution establishes supported behavior here. This does not establish a byte-for-byte source match or independent audit of Meteora's deployed binary.

Key implementation paths (relative to this repository):

- `cash-access/app/earn/workspace.tsx`: live supply, trade, positions and exits.
- `cash-access/lib/liquidity/runtime.ts`: verified pool reads and official SDK builders.
- `cash-access/lib/liquidity/math.ts`, `math.test.ts`: integer limits, rounding and partial/full redemption boundaries.
- `cash-access/lib/liquidity/market.json`: public pool identity.
- `cash-access/app/onchain/live-session.tsx`: reused signing/review/receipt machinery with LP actions.
- `stockroom-protocol/scripts/liquidity-lifecycle.mjs`: one-shot checkpointed Devnet setup/lifecycle. It refuses replay after a completed evidence file.
- `stockroom-protocol/scripts/verify-liquidity-lifecycle.mjs`: read-only receipt and depositor exit verification.
- `stockroom-protocol/scripts/verify-liquidity-browser.mjs`: read-only browser-flow proof.
- `stockroom-protocol/artifacts/stockroom-liquidity-{market,lifecycle,verification}.json`: public evidence.
- `cash-access/evidence/liquidity-browser-lifecycle.json`: four browser receipts and exact token deltas.
- `cash-access/evidence/liquidity-ui-tests.txt`, `liquidity-build.txt`: validation output.

Private local test keys remain in ignored `.keys` files with restricted permissions. None are exported to the UI or this document. The browser wallet continues to hold only its own disposable session key.

Read-only verification from `stockroom-protocol`:

```sh
node scripts/verify-liquidity-lifecycle.mjs
node scripts/verify-liquidity-browser.mjs
```

## Remaining work, explicitly

1. Creator treasury deployment into liquidity, with enforced ownership and beneficiary rights. A creator-controlled reserve is not automatically community-owned capital.
2. Actually funded community rewards, eligibility/snapshot policy, claims and double-claim prevention. LP fees and funded rewards must remain separately accounted.
3. Creation/discovery of additional supported live strategies, and explicit DBC migration handling. This milestone supports one pinned DAMM pool.
4. Real issuer stock assets, supported valuation/oracle feeds, reliable production RPC, production wallet QA and independent protocol/security review.
5. Submission package, video and final sponsor bounty eligibility checks. Direct Meteora Devnet integration does not prove the separate Clawpump launch requirement, real xStock deployment, mainnet activity, or any bounty award.

The next connected product milestone is creator reserve → capital deployment → funded reward claims. The personal LP ownership, trade-driven fees, compounding and redemption foundation is now executable rather than only simulated.
