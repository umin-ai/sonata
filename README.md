# Stockroom

A working cash-access research prototype for existing NVDAx holders. It compares a live Jupiter sell quote with a Kamino-based borrowing estimate and shows simulated sale, loan and repayment outcomes.

## Boundaries

This is a validation prototype, not a wallet or brokerage. Holdings are editable samples. It does not connect wallets, construct transactions, sign, submit, or execute loans. The only RPC method is read-only `getAccountInfo` for the public stock mint. Source terms and regional eligibility remain to be resolved before an execution release.

## Working features

- Requests an amount of USDC; obtains a live stock sell quote sized to meet it.
- Reads NVDAx decimals, effective scaled-UI multiplier and issuer pause state.
- Checks the sample holding in raw units before enabling sale review.
- Reads Kamino reserve APY and max LTV; models estimated interest and price-decline effects.
- Shows an explicit dated 65% liquidation assumption, not a live protocol health calculation.
- Quotes expire after 20 seconds; unavailable data is not replaced by invented numbers.
- Reviews frozen scenarios and previews repayment using separate USDC funds.
- Registers a feature-detected WebMCP configure-only tool; it never executes financial actions.

## Local development

Use the locked dependencies and `npm run dev`. API route: `/api/compare?cash=500&holding=10`.

`node --experimental-strip-types --test lib/finance.test.ts` checks multiplier activation, raw-unit rounding, interest, borrowing and liquidation boundaries, and invalid inputs. `npx tsc --noEmit` checks types. The integration evidence records both successful calls and rate-limit failures.

## Next execution gates

1. Confirm target-user pain and recruit actual eligible stock holders.
2. Add a wallet connection and verify balances, source eligibility and issuer terms.
3. Replace indicative lending accounting with SDK-verified obligation health, live caps, fees, and current liquidation parameters.
4. Obtain production-grade RPC/API access and caching/rate limits appropriate to expected usage.
5. Build and simulate wallet-specific transactions; complete controlled funding, repayment and reconciliation tests.
6. Test repeated real use and willingness to pay before claiming product-market fit.

The product name is provisional. No name or trademark availability check has been performed.
