# Stockroom project isolation

Stockroom now uses its own original Devnet program, ROOM token, Meteora pool and treasury. Mixed-project sources, IDLs, deployment scripts, frontend notes and transaction evidence were preserved outside the active projects in `../archive/rondo-mixup-2026-09-18/`. The other project's onchain program and accounts were not changed.

## Active bindings

| Component | Address |
| --- | --- |
| Stockroom treasury program | `GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj` |
| ROOM mint | `3Hwo2RGJpHQfVd5BW92423uU5gomnhQRxDm7PZnfS8Js` |
| ROOM / mSPY pool | `BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf` |
| Treasury | `QZJpgjyuQ7uWzySDaJThv4MWT98YesXNkaU25hcN4Rr` |
| Fixed payout recipient | `FVi525b7VrxYRFg7BdEQK8BJGSao4c3xcr6Yv5kLhXJh` |

The manifest is `lib/treasury/market.json`; the ABI is `lib/treasury/stockroom_treasury.json`. Program and pool are pinned by identity tests, which also derive the correct authority and custody addresses. Pending transaction signatures and receipt labels are scoped by program plus pool. The test wallet remains reusable, but balances and actions use only the active market's mints.

## Correct contract semantics

The current Stockroom treasury allocates 50% of claimed fees to its fixed recipient and retains 50%. Only its creator can withdraw retained stock. ROOM ownership does **not** confer redemption rights. The interface now says **creator-controlled reserve**, shows lifetime creator withdrawals and makes no holder-vault or lending claim for this account.

The trading and fee collection controls remain public keeper actions with fixed destinations. There is no deployed compounding strategy in this integration. The separate strategy prototype remains a labelled simulation.

## Fresh verification on Stockroom

- Browser-signed buy: 0.001 mSPY paid, 279,748.064691 ROOM received.
- Browser-signed collection: 0.002408 mSPY moved from the pool into Stockroom's treasury, including fees already present before this test.
- Browser-signed allocation: 0.001204 mSPY paid to the fixed recipient; 0.001204 retained.
- Browser-signed sell: 10,000 ROOM paid, 0.00003503 mSPY received.
- Independent RPC checks verified all four receipts, wallet identity, balance deltas and conservation of both tokens. A valid quote simulated successfully; an impossible minimum output failed with the slippage error.
- Frontend type check, production build and 20 frontend tests passed. Protocol build and verification passed: six math tests and 18 compiled-program tests, including six treasury authorization/accounting tests.

New transaction evidence: `evidence/treasury-trading-lifecycle.json`. The previous project's receipts are archived and are not Stockroom evidence.

## Source and deployed binary

Restored Stockroom sources and build/deploy configuration exclude the other project's program. The lockfile preserves Anchor 1.0.2 and pins the transitive `ruint` dependency to 1.17.0 for the SBF compiler.

No program upgrade was performed. A fresh read of Stockroom's deployed bytes matches its original deployment hash. The reformatted source and reconciled lockfile produce a separately tested build with a different hash; do not claim that rebuilt artifact has been deployed. `stockroom-protocol/artifacts/stockroom-treasury-deployment.json` records both hashes, and deployment tooling refuses an unnoticed mismatch.

Local preview: http://localhost:5173/onchain. No site was published and no mainnet assets were used.
