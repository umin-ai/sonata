# Recorded evidence

These files record what actually ran on 14 September 2026.

| Evidence                                 | Result                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification.json`                      | PASS; six Rust math tests, twelve compiled SBF integration tests, Rust/JavaScript formatting checks; exact source and binary hashes               |
| `localnet-2026-09-14T02-51-56-818Z.json` | PASS; 24 confirmed Agave local-validator transactions; two exact on-validator bytecode matches; normal loan closure plus loss-bearing liquidation |
| `localnet-2026-09-14T02-40-18-184Z.json` | Earlier successful local run; retained with its own pre-formatting binary hashes                                                                  |
| `build.json`                             | Pinned compiler versions and latest program source/binary hashes                                                                                  |
| `devnet-deployment.json`                 | Both programs executable on Devnet; deployment signatures and exact deployed-binary comparisons |
| `devnet-2026-09-14T03-34-45-792Z.json`    | PASS; 24 successful Devnet transactions; custody, repayment, liquidation and loss accounting |
| `devnet-status.json`                     | All 24 signatures independently checked as finalized and successful; 2.127332640 test SOL remaining |
| `dependency-audit.json`                  | npm advisories remain; see `docs/security-status.md`                                                                                              |

The Devnet run used 52,259 compute units at its most expensive recorded step, including initialization. It ended with zero outstanding debt, zero supply shares, zero remaining borrower collateral, and one quote-token atom of rounding dust in the market. In the crash scenario, the lender's 5,000 demo USD NAV fell to 4,576.190479 before redemption. This is an explicit test of loss accounting, not a promised return.

The thirty-day interest scenario is tested by advancing LiteSVM's clock. RPC demos accrue only actual elapsed network time. No local receipt is represented as a Devnet or mainnet transaction. See [the Devnet receipt index](../docs/devnet-deployment.md) for public Explorer links.

All addresses and signatures here are public test data. No secret keys, deployment buffers or wallet seed phrases are included. Reproduce the evidence with the commands in the root README; network runs generate fresh test mints and wallets.
