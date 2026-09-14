# Stockroom Protocol

Stockroom's own Solana credit program for a tokenized-stock borrowing prototype. Lenders supply demo quote tokens; borrowers lock demo Token-2022 stock collateral and receive that liquidity through program-authorized transfers. Debt, interest, health checks, repayment, liquidation and losses are enforced by the Rust program.

**Status: working local prototype.** Twelve compiled-program integration tests and six math tests pass. A complete RPC demonstration runs on Agave's local validator. Devnet deployment is prepared but awaits test SOL. This code has not received an independent audit. The currently published Stockroom website has not yet been wired to these program instructions.

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

At the recorded deployment attempt it held zero Devnet SOL. The rent/setup estimate was approximately **2.9 Devnet SOL**; 5 provides margin for deployment and demo transactions. These are free test tokens, not purchased SOL. The public RPC faucet returned HTTP/RPC 429. The [official web faucet](https://faucet.solana.com/) can be used by a human; its documented CLI proof-of-work alternative itself requires a small starting fee balance.

After test funding:

```sh
npm run deploy:devnet
npm run demo:devnet
```

Deployment checks the Devnet genesis hash, passing test evidence, source hashes and binary hashes. It uses explicit task-only signer paths and fixed private deployment buffers. It does not use the user's configured CLI wallet. Post-deployment code checks compare the deployed bytecode against the tested binary, including upgradeable-loader ProgramData. Failed uploads can reuse the private buffer; do not share its key.

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
