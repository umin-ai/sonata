# Sources and licensing

Stockroom Protocol is licensed under **GPL-3.0-or-later**; see `LICENSE`.
The Rust adaptation of Morpho's GPL-2.0-or-later math is distributed under the later GPL version allowed by its notices. Dependencies retain their respective licenses. This is an independent implementation; none of the referenced organizations endorses it or has audited it.

## Adapted reference: Morpho Blue

Original authors: **Morpho Labs**, GPL-2.0-or-later.
Inspected commit: `8e26ca6a8dbc5089edcd67fb576248810fd2870a` (9 September 2026).

- [SharesMathLib.sol](https://github.com/morpho-org/morpho-blue/blob/8e26ca6a8dbc5089edcd67fb576248810fd2870a/src/libraries/SharesMathLib.sol): virtual asset/share offsets and directional conversion rounding, adapted into `crates/credit-math/src/lib.rs`.
- [MathLib.sol](https://github.com/morpho-org/morpho-blue/blob/8e26ca6a8dbc5089edcd67fb576248810fd2870a/src/libraries/MathLib.sol): third-order compounding approximation and integer rounding conventions, adapted into that Rust crate. Stockroom adds fractional quote-atom interest carry and full-width U256 intermediates.
- [Morpho.sol](https://github.com/morpho-org/morpho-blue/blob/8e26ca6a8dbc5089edcd67fb576248810fd2870a/src/Morpho.sol): inspected supply/borrow/repay/liquidation ordering and residual bad-debt accounting. Stockroom uses a fixed rate, separate opening and liquidation thresholds, bounded Token-2022 collateral and Solana PDA custody. It is not a byte-for-byte port.

Morpho's upstream notices attribute its virtual-share method to OpenZeppelin's ERC-4626 inflation-attack mitigation. GPL source notices are preserved above; the original upstream files remain accessible at the pinned links. The upstream license permits version 2 or a later version.

## Inspected Solana references (no upstream lending program copied)

| Project                       | Pinned source                                                                                               | What was inspected                                                                                                              | License    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| marginfi                      | [5c97c5ef](https://github.com/0dotxyz/marginfi-v2/tree/5c97c5efb68a24f68041d2bb7d90917b8dc989e2)            | Interest before debt mutation; health checks; signer and bank/vault constraints; borrow/liquidation tests; boxed token accounts | Apache-2.0 |
| Solana Foundation async vault | [ccefe2f0](https://github.com/solana-foundation/vault/tree/ccefe2f047d435be08094365ac96b999bc1558a8)        | PDA escrow, mint binding and token CPI patterns                                                                                 | MIT        |
| Solana Vault Standard         | [ceb54f34](https://github.com/solanabr/solana-vault-standard/tree/ceb54f34b683404f51459538777b85695018b28f) | Vault/share design reference; not a claim of standards conformance                                                              | MIT        |
| Token-2022                    | [36ab4139](https://github.com/solana-program/token-2022/tree/36ab4139912c3991a2858270cccf434dfd295802)      | Scaled UI Amount is display metadata; raw custody amounts remain raw; extension allowlist                                       | Apache-2.0 |

Also reviewed the primary [OpenZeppelin ERC-4626 implementation](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol) and [Aave validation logic](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/ValidationLogic.sol) to cross-check share protection and the distinction between borrowing limits and liquidation health. These two links are living references, not pinned dependencies.

Kamino and Fluid/Jupiter were reviewed separately for research. Their BUSL program sources have **not** been copied into this implementation.

## Direct software dependencies

Exact versions and transitive dependencies are recorded in `Cargo.lock` and `package-lock.json`.
Anchor, Solana SPL interfaces, `uint`, the Solana JavaScript SDKs and LiteSVM retain their upstream license notices in their distributed packages. The test harness uses LiteSVM's public SDK and official SPL instructions; it does not emulate the credit instructions in JavaScript.
