# Sonata protocol

Anchor programs behind Sonata, a Solana launchpad where community tokens trade against a tokenized stock on Meteora's Dynamic Bonding Curve (DBC). Devnet only; mock tokens have no monetary value.

**Try the app on Devnet: https://sonata.umin.ai** (source: [umin-ai/sonata](https://github.com/umin-ai/sonata)).

**Read [HANDOFF.md](HANDOFF.md) for status, on-chain evidence, the security model and Meteora references.** In short: both deployed programs match the source in this repository byte for byte (run `node scripts/verify-deployed-bytes.mjs` to check; history in HANDOFF.md §6.1); both are upgradeable by one key; and neither has been audited. Program crates keep the working name "stockroom"; HANDOFF.md §11 explains why.

## Programs

| Program | Devnet address |
| --- | --- |
| [`stockroom_treasury`](programs/stockroom-treasury/src/lib.rs) | `GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj` |
| [`stockroom_rewards`](programs/stockroom-rewards/src/lib.rs) | `6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L` |

- **Treasury** registers a treasury for a DBC pool whose config names the Sonata vault PDA as `fee_claimer`, and refuses any config that is not Sonata's standard launch (`NonStandardConfig`). It claims partner trading fees into program-owned custody, claims the fees of the Vault's locked DAMM v2 position after graduation (`claim_graduated`), and pays fees out by a mode fixed at registration. New launches use the two modes added on 24 September, split by the permissionless `distribute_split`: 50% to the fixed payout recipient and 50% to Sonata, paid to the Vault admin (Standard, the app's default; also used for Reward tokens, whose payout recipient is Sonata's payout bot); or 25% to the recipient, 25% kept as a Stock Floor that holders redeem by burning tokens and the creator cannot withdraw, and 50% to Sonata (StandardFloor, the app's "Backed token"). Earlier markets keep their modes, split by `distribute`: 100% to the recipient (Refrain); 50% to it and 50% kept as a creator reserve (Duet); or 50% to it and 50% kept as a Stock Floor (Floor).
- **Rewards** holds holder-reward policies and funded reward campaigns paid from a treasury's retained fees.

An earlier credit prototype (`stockroom_credit` and `demo_oracle`) is retired. Its source was removed from this tree on 26 September 2026 and remains at commit [`0d9046a`](https://github.com/umin-ai/sonata-protocol/tree/0d9046a4443cb9c661466f03d9f080d3d8609bd0).

## Build and test

Toolchain used: Rust **1.90.0**, Anchor CLI/Rust **1.0.2**, Agave **3.1.13** (SBF platform tools **v1.52**), Node **22.14.0**. Pin versions through the [official Anchor installation guide](https://www.anchor-lang.com/docs/installation) and [Agave releases](https://github.com/anza-xyz/agave/releases/tag/v3.1.13). Rustup reads the checked-in `rust-toolchain.toml`. `scripts/build.mjs` uses `../.tools/stockroom/anchor` and its Agave release when present, otherwise `anchor` on your PATH, and pins the host Rust used for IDL generation without changing your global Rust default.

```sh
npm ci
npm run build                            # both programs; writes target/deploy, target/idl, sdk/idl and artifacts/build.json
npm test                                 # node --test tests/*.test.mjs
node scripts/verify-deployed-bytes.mjs   # read-only: deployed bytes vs. local build
```

`npm run build` compiles the publicly declared program IDs without their deployment keys. The tests load the compiled programs from `target/deploy` into LiteSVM, so run the build first. `node --test tests/*.test.mjs` runs 54 tests (rewards 11, treasury 5, treasury Stock Floor 8, treasury graduated claim 5, treasury standard config 5, treasury partner metadata 1, treasury registration 1, treasury platform split 18). They need no validator, wallet or real money. There is no CI.

## Scripts

Read-only, no keys needed:

- `scripts/verify-deployed-bytes.mjs` compares each deployed program with its local build and reports its upgrade authority.
- `scripts/verify-handoff.mjs` re-checks every transaction, account and label in HANDOFF.md (`--links` also checks every other link).
- `scripts/read-graduation.mjs` re-verifies a graduation from chain.

Devnet proofs (these send transactions and need a funded key at `.keys/deployer.json`; `npm run setup:keys` creates one):

- `scripts/verify-configurable-launch.mjs` deploys a per-launch DBC config, registers a treasury against it, and reads the resulting state back.
- `scripts/verify-fee-path.mjs` exercises the fee path on a per-launch pool in Duet or Refrain mode: a buy, the claim, then a 50/50 split and a creator withdrawal (Duet) or 100% to the payout recipient (Refrain).
- `scripts/verify-graduation.mjs` exercises DBC → DAMM v2 graduation on a per-launch pool.
- `scripts/verify-stock-floor.mjs` proves the Stock Floor on a Floor-mode launch: a separate holder buys, fees split 50/50, the holder burns for an exact share, and the creator's withdrawal is refused on-chain.
- `scripts/verify-creator-position.mjs` graduates a launch whose locked liquidity is split 50/50 and claims the creator's locked-position fees with the app's own claim code.
- `scripts/verify-graduated-claim.mjs` proves `claim_graduated`; `scripts/verify-standard-config.mjs` proves the `NonStandardConfig` refusal.
- `scripts/module-trades.mjs` is a helper, not a proof: it makes test buys and sells on a market other than the flagship so that market's fee module has fees to pay. It uses the test wallets in `.keys/` and tops them up from the deployer.

Each of these checks the Devnet genesis hash before sending anything. HANDOFF.md §12 lists the full commands. Keys stay under the git-ignored `.keys/`.

## Source map

| Location | Purpose |
| --- | --- |
| [`programs/stockroom-treasury/src/lib.rs`](programs/stockroom-treasury/src/lib.rs) | Treasury program: registration, fee claims, fee modes, Stock Floor, partner metadata |
| [`programs/stockroom-rewards/src/lib.rs`](programs/stockroom-rewards/src/lib.rs) | Rewards program: holder policies, funded campaigns, deliveries and claims |
| [`tests/`](tests/) | LiteSVM tests of the compiled programs; [`tests/fixtures/treasury-dbc.json`](tests/fixtures/treasury-dbc.json) holds recorded Devnet DBC accounts |
| [`sdk/idl/`](sdk/idl/) | Generated IDLs for both programs, copied there by the build |
| [`scripts/`](scripts/) | Build, deploy, Devnet proof and read-only verification scripts |
| [`scripts/program-proof.mjs`](scripts/program-proof.mjs) | Compares network program bytes with local binaries; used by the deploy scripts |
| [`artifacts/`](artifacts/README.md) | Evidence the scripts wrote; HANDOFF.md cites most of it |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Dependencies and licenses |

License: **GPL-3.0-or-later** (see [LICENSE](LICENSE)), with dependency notes in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
