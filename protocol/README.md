# Sonata protocol

Anchor programs behind Sonata, a Solana launchpad where community tokens trade against a tokenized stock on Meteora's Dynamic Bonding Curve. Devnet only; mock tokens have no monetary value.

- `programs/stockroom-treasury` registers a treasury for a DBC pool whose config names the Sonata vault PDA as `fee_claimer`, claims partner trading fees into program-owned custody, and splits them between a fixed payout recipient and a creator reserve.
- `programs/stockroom-rewards` holds holder-reward policies and funded reward campaigns paid from a treasury's retained fees.
- `scripts/verify-configurable-launch.mjs` deploys a per-launch DBC config, registers a treasury against it, and reads the resulting state back.
- `scripts/verify-deployed-bytes.mjs` compares each deployed program with its local build. It is read-only and needs no keys.

**Read [HANDOFF.md](HANDOFF.md) for status, on-chain evidence, the security model and Meteora references.** In short: all four deployed programs match the source in this repository byte for byte (the treasury only since its 23 September upgrade; run `scripts/verify-deployed-bytes.mjs` to check); all four are upgradeable by one key; and no program has been audited. Program crates keep the working name "stockroom"; HANDOFF.md §11 explains why.

Tests: `node --test tests/*.test.mjs` runs 29 compiled-program tests (credit 12, rewards 11, treasury 5, treasury registration 1), and `cargo test -p credit-math` runs 6.

## Historical credit prototype

The sections below were written for the earlier credit prototype (`stockroom-credit` and `demo-oracle`). The toolchain notes apply to every program here; the deployment receipts and source map cover only the credit prototype.

A Solana credit program for a tokenized-stock borrowing prototype. Lenders supply demo quote tokens; borrowers lock demo Token-2022 stock collateral and receive that liquidity through program-authorized transfers. Debt, interest, health checks, repayment, liquidation and losses are enforced by the Rust program.

**Status: deployed and exercised on Solana Devnet.** The twelve compiled-program integration tests in `tests/credit.test.mjs` and six math tests pass. The Devnet demonstration completed 24 transactions, all independently checked as finalized and successful. Both credit-prototype programs, `stockroom_credit` and `demo_oracle`, match the tested binaries byte for byte. [Deployment and transaction receipts](docs/devnet-deployment.md). This code has not received an independent audit.

## Run locally

Toolchain used: Rust **1.90.0**, Anchor CLI/Rust **1.0.2**, Agave **3.1.13** (SBF platform tools **v1.52**), Node **22.14.0**. Pin versions through the [official Anchor installation guide](https://www.anchor-lang.com/docs/installation) and [Agave releases](https://github.com/anza-xyz/agave/releases/tag/v3.1.13). Rustup reads the checked-in `rust-toolchain.toml`. The build wrapper also pins the host Rust used for IDL generation; it does not change your global Rust default.

Within this checkout:

```sh
npm ci
npm run setup:keys
npm run build
npm run verify
npm run validator
```

In a second terminal, in this same directory:

```sh
npm run demo:local
```

The validator listens only on `127.0.0.1:18899`, uses a fresh ledger under `target/`, and loads the built programs at their declared addresses. Stop it with Ctrl-C. Demo wallets and test mints are generated locally; all secret keys remain under ignored `.keys/`. Never put an existing wallet key there. `build` can compile the publicly declared program IDs without possessing their deployment keys. Local tests require no real money, external price API, browser wallet or mainnet account.

The demo confirms 24 transactions: mint/market setup, lender supply, borrower collateral, borrowing, repayment, collateral return and lender redemption; then a second loan, price shock, paid liquidation, explicit bad-debt write-off and lender withdrawal. It asserts final balances and saves public-only receipts under `artifacts/`. Before executing, it compares on-validator program bytes with the exact built `.so` files. Local signatures are local-validator receipts; they are not Devnet Explorer links.

## Devnet deployment

For the original workspace, the existing **new, demo-only** deployment wallet is:

```text
vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF
```

The wallet received **5 Devnet SOL** and funded both deployments and the complete demo on 14 September 2026. **2.127332640 Devnet SOL** remained at the recorded post-demo check. The decrease includes rent and test-account funding, not just transaction fees. These are free test tokens, not purchased SOL. For a fresh deployment, the [official web faucet](https://faucet.solana.com/) provides test funding.

To verify the existing deployment or run a fresh demo with new test accounts:

```sh
npm run deploy:devnet
npm run demo:devnet
```

Deployment checks the Devnet genesis hash, passing test evidence, source hashes and binary hashes. It uses explicit task-only signer paths and fixed private deployment buffers. It does not use the user's configured CLI wallet. Post-deployment code checks compare the deployed bytecode against the tested binary, including upgradeable-loader ProgramData. Matching deployments are verified and skipped; a different deployed binary is refused instead of silently overwritten. Interrupted uploads reuse the same buffer and credit its existing rent. Complete buffers are checked before finalization. Uploads default to QUIC, with `STOCKROOM_DEPLOY_TRANSPORT=rpc` as an explicit fallback; complete buffers are finalized over RPC. Do not share buffer keys.

An independent developer cannot deploy to the original program addresses without their private deployment keys. For a fresh clone and a separate Devnet deployment, run this **before building**, in a checkout without program keys:

```sh
npm run setup:keys -- --new-program-ids
npm run build
npm run verify
```

This updates the Rust declarations, Anchor config and SDK constants to new program addresses. Public sample receipts in this repository continue to describe the original run. Both deployment and demo scripts are restricted to Devnet or the explicit loopback-only local demo; they provide no mainnet deployment mode.

## Source map

| Location                               | Purpose                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `programs/stockroom-credit/src/lib.rs` | PDA custody, lender/borrower positions, lending lifecycle, oracle validation and liquidation |
| `programs/demo-oracle/src/lib.rs`      | Separate signer-controlled test price source                                                 |
| `crates/credit-math/src/lib.rs`        | Checked U256 arithmetic, share rounding, interest and collateral valuation                   |
| `sdk/client.mjs` and `sdk/idl/`        | Instruction builders and generated program interfaces                                        |
| `tests/credit.test.mjs`                | Compiled SBF tests with signed transactions and real SPL token CPIs                          |
| `scripts/rpc-demo.mjs`                 | Network-confirmed end-to-end demonstration                                                   |
| `scripts/program-proof.mjs`            | Compare network program bytes with local binaries                                            |
| `artifacts/verification.json`          | Test results tied to source and binary hashes                                                |
| `docs/architecture.md`                 | Account model, rounding, oracle units, loss rules and limits                                 |
| `docs/frontend-integration.md`         | Wallet transaction integration contract for the Stockroom app                                |
| `THIRD_PARTY_NOTICES.md`               | Pinned upstream references, adaptations and licenses                                         |

## What is original, and what is learned

This is an isolated Solana implementation with its own custody and debt state. It uses patterns inspected in marginfi and Solana Foundation vault code. Share math and compounding are adapted from Morpho Blue under the stated GPL license. Aave and OpenZeppelin were used as cross-checks. Source inspection and passing tests do not transfer those protocols' audit status to this code.

The stock-specific scope is narrow: bind one collateral mint, keep raw-token valuation independent of Scaled UI Amount changes, reject unsupported token extensions, and stop new risk when the quote is stale, uncertain or marked closed. The 50% opening LTV, 65% liquidation threshold, 5% bonus and 5% APR are illustrative demo settings, not calibrated promises for real stocks.

See [architecture](docs/architecture.md) and [security status](docs/security-status.md) before extending the prototype. Production needs a real oracle adapter, issuer-asset policy, economic risk calibration, liquidation infrastructure and independent review. The demo oracle administrator can choose arbitrary prices, and the demo mint authority can issue arbitrary test tokens. No stock redemption, dividend rights, insurance or real USDC backing is claimed.

License: **GPL-3.0-or-later**, with upstream attributions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
