# Verification and security status

Recorded on 14 September 2026. This is a prototype with explicit tests, not an audit report.

- Six Rust math tests cover rounding direction, full-width products, overflow/zero division, virtual-share behavior, interest remainder carry, threshold boundaries and paid-liquidation bounds.
- Twelve LiteSVM integration tests execute compiled Solana SBF programs, with transaction signature verification enabled, real SPL/Token-2022 programs and actual account constraints. They cover the loan lifecycle, unsafe borrowing/withdrawal, missing/wrong signers, account substitution, price validity, pause authorization, slippage, token-transfer failure rollback, healthy/partial/bad-debt liquidation, display multiplier changes, vault donations and multiple debt holders.
- The separate Agave RPC demo confirms 24 transactions and checks final balances. Byte-for-byte program proofs are included in runs made after `program-proof.mjs` was added. The initial preserved local run predates that additional check and has its own recorded binary hashes.
- Build/test manifests bind the verification to exact source and binary hashes. They are not a claim of cross-machine reproducible/verifiable builds; a Docker verifiable-build pipeline and external audit are still pending.

## Toolchain issues found and resolved

Anchor 1.0.2's transitive macro dependencies initially resolved to 1.2.0 and caused a compile error. `Cargo.lock` now pins the matching 1.0.2 macro family; builds use `--locked`. Anchor's IDL builder selected the old global stable Rust unless explicitly overridden. The wrapper sets host Rust 1.90.0 for that command without changing the user's global default.

The first liquidation account parser exceeded Solana's 4 KiB stack frame. Large accounts are now boxed, following the supported Anchor approach; the rebuilt code passes liquidation execution. The wrapper rejects any future stack-offset overflow diagnostics even if the underlying build reports exit zero.

The downloaded Agave platform SDK contains an empty `syscalls.txt`, producing “undefined and not known syscalls” post-processing warnings for standard Solana calls. This has not been hidden or replaced with invented syscall names. Both LiteSVM and Agave 3.1.13's validator successfully load and execute the programs, including the relevant token CPIs and clock reads. Actual deployment keeps preflight and feature verification enabled.

## JavaScript dependency audit

`artifacts/dependency-audit.json` preserves the npm audit output. The pinned legacy Anchor/web3/SPL client stack currently includes advisories in transitive `bigint-buffer`, `toml`, `stream-json` and `uuid`; npm's suggested old SDK downgrades do not preserve the required Token-2022 API. These findings have **not** been cleared by a forced downgrade or dismissed as a passing audit.

The present SDK/harness is local development tooling: the test amounts, IDLs and transactions are generated here, and no HTTP service accepting user-supplied TOML or arbitrary binary buffers is shipped. Before promoting this SDK into a public browser/server product, review reachable paths and migrate affected dependencies to maintained compatible packages, or apply verified fixes. Native `bigint-buffer` has an [upstream buffer overflow advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg); input bounds and the runtime fallback matter. Test success does not remove that advisory. Rust dependencies have not yet undergone an independent cargo advisory/supply-chain audit.

## Material outstanding work

The controlled demo oracle is not Pyth, Switchboard or an issuer-backed feed. Mock mint authorities are trusted; the quote token can be subject to its issuer's mint/freeze powers. Real stock transfer restrictions, issuer compatibility, off-hours liquidity and corporate-action/raw-price mapping need explicit integration and stress testing. The demo's interest rate and thresholds are examples. No rate controller, keeper fleet, governance timelock, production upgrade process or independent security audit is provided. Directly running this code with real assets would exceed the demonstrated scope.

Devnet rent funding, Devnet receipts and the frontend wallet integration remain separate from the successful local proof until those artifacts exist.
