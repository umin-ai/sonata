# Sources and licensing

Sonata protocol (package `stockroom-protocol`) is licensed under **GPL-3.0-or-later**; see `LICENSE`.
Dependencies retain their respective licenses. This is an independent implementation; none of the referenced organizations endorses it or has audited it.

## Direct software dependencies

Exact versions and transitive dependencies are recorded in `Cargo.lock` and `package-lock.json`.

- Rust: Anchor (`anchor-lang`, `anchor-spl`) 1.0.2; Meteora's `dynamic-bonding-curve` crate, pinned to commit `f552f20aa3c1c7631427c3827aeea7c58b902813` and used by `programs/stockroom-treasury` for DBC CPI and account types; and Solana SDK crates such as `solana-instructions-sysvar`.
- JavaScript: `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `@solana/spl-token-metadata`, `@meteora-ag/cp-amm-sdk` and `@meteora-ag/dynamic-bonding-curve-sdk` in the scripts; `litesvm` and `@solana/kit` in the tests.

Each keeps its upstream license notice in its distributed package or source repository. The tests load the compiled programs into LiteSVM and send signed transactions with the official SPL instructions; they do not emulate program instructions in JavaScript.

## Removed code

Until 26 September 2026 this repository also held a credit prototype (`programs/stockroom-credit`, `programs/demo-oracle` and `crates/credit-math`). `crates/credit-math` adapted GPL-2.0-or-later math from Morpho Blue. That code, and the notices and pinned upstream references that applied to it, remain at commit [`0d9046a`](https://github.com/umin-ai/sonata-protocol/blob/0d9046a4443cb9c661466f03d9f080d3d8609bd0/THIRD_PARTY_NOTICES.md).
