# Stockroom interactive Devnet app

The `/devnet` route uses Stockroom's deployed credit and demo-oracle programs.
The original `/` market research and example experiences are retained.

## Try it

1. Choose **Try with demo wallet**, or connect a Wallet Standard wallet supporting `solana:devnet` and `solana:signTransaction`.
2. Get demo assets. Review and sign the fixed starter pack: 25 demo stocks, 1,000 demo USD, and 0.005 Devnet SOL. Position rent is deducted from that SOL; the faucet pays for associated token account setup and the grant's network fee.
3. Deposit 8 demo stocks and borrow 500 demo USD atomically.
4. Repay the entire loan, including accrued interest, then release collateral.
5. The Supply tab allows supplying and redeeming demo USD. Redemptions depend on pool cash availability.

The temporary wallet key stays in sessionStorage. It is not uploaded. It is disposable and may become inaccessible when the browser session ends. Never use it for real assets. Receipts are saved separately in localStorage; pending receipts remain checkable after refresh.

## Network and authorities

Public addresses and initialization receipts are in `lib/stockroom/deployment.json`.
The interactive market began with 50,000 demo USD supplied as lending capital.
These freely minted assets have no financial backing or real-world value.

Browser-side reads, simulation, sending, and receipt checks use the Solana Labs public Devnet endpoint, verified against the Devnet genesis hash. Public endpoints can throttle or be reset. The browser reads confirmed account state and the onchain clock; balances are not fabricated when reads fail.

The authenticated `/api/devnet` endpoint never calls an RPC. It verifies and co-signs only:

- An exact, canonical starter-pack transaction, including position initialization. The existing position PDA prevents another successful grant to the same wallet.
- A fixed 200 demo USD oracle publication preceding allowed Stockroom borrower instructions. The caller pays the network fee. No other instruction may reference the demo authority.

`STOCKROOM_DEMO_AUTHORITY` is a server-only secret for a dedicated disposable Devnet authority. It controls these demo mints and this market's mock oracle. It is separate from the program upgrade authority. It was funded with only 0.25 Devnet SOL. No deployer private key is embedded in the app or hosted environment.

This faucet is suitable for the current owner-private trial. Claim checks are onchain per wallet, not a durable per-person anti-Sybil system. The sponsor's finite test-SOL budget bounds expenditure; add authenticated per-person rate limiting before broad public sharing. Supply and repayment do not require the sponsor.

## Transaction boundaries

- Decimal inputs use BigInt token atoms; excess decimal precision and exponent notation are rejected.
- Account owners, market configuration, wallet position, and associated token identities are checked before preparing actions.
- Share conversions use the protocol's virtual offsets and rounding. Debt includes interest accrued against the network clock.
- Borrowing and supply include maximum-debt-share and minimum-supply-share bounds. Repayment has a maximum cash bound, and redemption has a minimum cash bound.
- Borrowing limits, custody, collateral health, interest, repayment, share burning, and redemption liquidity are ultimately enforced by the deployed program.
- The browser checks that sponsor and external-wallet responses preserve the transaction message. All required signatures must verify before submission.
- A signature is saved before submission to handle ambiguous network failures. A pending transaction blocks another action until its receipt is resolved. Expiry is determined from its last valid block height.

## Limitations

The demo oracle is administrator-controlled, fixed at 200, and refreshed in the borrowing transaction. There is no live equity feed or realistic price-discovery demonstration. The programs remain upgradeable and have not undergone an independent audit. Real xStocks with issuer controls are not accepted by this demo. The demo does not establish regulatory eligibility, real collateral redemption rights, or production solvency.

The existing protocol's compiled-SBF and Devnet tests cover liquidation and bad debt. The browser currently presents borrowing, full repayment, collateral release, supply, and full redemption; it does not expose a liquidator console or a public price-shock button.

## Runtime compatibility

Anchor's published browser bundle and a Buffer polyfill are used for the shared instruction builder. Vite maps `bigint-buffer` to its published pure-JavaScript build: native-addon loading in Workers otherwise leaves a broken `Error.prepareStackTrace` hook. No library source is patched. Node tests use the package's CommonJS interoperability fallback.

Sources: [Solana cluster documentation](https://solana.com/docs/references/clusters), the deployed protocol's committed IDLs and SDK, and the pinned packages' shipped source and type declarations. GPL source notices accompany the SDK and integer math.

## Verified browser run, 14 September 2026

All six steps passed with actual wallet signatures: grant, atomic deposit/borrow, full repayment, collateral release, supply, and redemption. Public receipts are recorded in `evidence/devnet-browser-lifecycle.json`. The final position had zero debt, collateral, and LP shares; the wallet held all 25 demo stocks again. The browser wallet path was exercised; an external wallet extension was not available for end-to-end testing.
