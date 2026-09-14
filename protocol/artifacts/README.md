# Recorded evidence

These files record what actually ran on 14 September 2026.

| Evidence                                 | Result                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification.json`                      | PASS; six Rust math tests, twelve compiled SBF integration tests, Rust/JavaScript formatting checks; exact source and binary hashes               |
| `localnet-2026-09-14T02-51-56-818Z.json` | PASS; 24 confirmed Agave local-validator transactions; two exact on-validator bytecode matches; normal loan closure plus loss-bearing liquidation |
| `localnet-2026-09-14T02-40-18-184Z.json` | Earlier successful local run; retained with its own pre-formatting binary hashes                                                                  |
| `build.json`                             | Pinned compiler versions and latest program source/binary hashes                                                                                  |
| `devnet-status.json`                     | Zero test SOL; neither program deployed to Devnet; public faucet returned error 429                                                               |
| `dependency-audit.json`                  | npm advisories remain; see `docs/security-status.md`                                                                                              |

The latest network run used 58,017 compute units at its most expensive recorded step, including initialization. It ended with zero outstanding debt, zero supply shares and zero remaining borrower collateral. In the crash scenario, the lender's 5,000 demo USD NAV fell to approximately 4,576.19 before redemption. This is an explicit test of loss accounting, not a promised return.

The thirty-day interest scenario is tested by advancing LiteSVM's clock. The RPC demo accrues only the actual short elapsed local-validator time. No local receipt is represented as a Devnet or mainnet transaction.

All addresses and signatures here are public test data. No secret keys, deployment buffers or wallet seed phrases are included. Reproduce the evidence with the commands in the root README; network runs generate fresh test mints and wallets.
