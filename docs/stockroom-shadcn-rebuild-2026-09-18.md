# Stockroom shadcn rebuild — 18 September 2026

## Scope

The primary Stockroom workspace now uses the installed shadcn/Radix component system across Markets, Create market, Market detail, Portfolio, Community, Activity and Integrations. It remains available locally at http://localhost:5173/. Nothing was published.

The older devnet credit sandbox remains a separate, working section. Its two remaining native market selectors were migrated to the shared Select wrapper. Its wallet and transaction logic were retained; no onchain transaction was executed during this UI rebuild.

## Components and interaction

- Sidebar, mobile Sheet navigation, Breadcrumb and Separator provide shared navigation, active routes and compact mode.
- Card, Badge, Alert and Empty unify summaries, disclosures and empty states.
- Table and Tabs power market filters, positions and activity. Search filters the selected market category.
- Button, Input, Label and Select replace bespoke transaction and configuration controls.
- Slider adjusts the treasury allocation; its thumb has an explicit accessible name. Progress shows seed-lock time.
- Dialog reviews changes before applying the local transition; Sonner reports success or failure.
- Sheet shows receipt balance changes and lets users follow funding references.
- Chart/Recharts replaces the static forecast drawing with three interactive scenarios, axes, legend and tooltips.

The theme uses graphite surfaces, mint actions, restrained translucent backgrounds and locally hosted Manrope. Shared Tailwind theme tokens also cover portal content. Legacy global reset rules were moved into the base layer so they no longer override component colours. No runtime package or lockfile changed.

## Preserved mechanics

Creation terms, seed locks, deposits, withdrawals, simulated trading, automatic and manual fee reinvestment, creator allocations, treasury positions, funded distributions and single-use reward claims retain the existing integer-cent transition model. Browser hydration populates both state and its action reference before controls become ready. Previous demo balances are preserved, and the pre-test session was restored after browser QA.

## Verification

- 15 existing ledger and forecast tests passed, including conservation of funds, ownership separation, locks, stale-price guards and rejection of invalid actions.
- TypeScript and production build passed.
- Targeted UI ESLint: no errors; two existing-style advisories for locally served token-logo img elements.
- Browser-tested search/category filtering, creation Select and review Dialog, creation of ROOM/QQQx, simulated trading and reinvestment, allocation slider keyboard input, treasury deposit, treasury-funded reward reserve, distribution, member claim and prevention of a repeated claim.
- Receipt Sheet displayed balance changes and navigated from member claim to the funded distribution and its source references.
- Zero trading volume with daily costs produced a negative forecast.
- Deposit/withdraw tabs and reviews, forecast/terms/receipts tabs, mobile navigation dismissal, restored state and credit market Select were checked.
- Responsive checks at 1440, 390 and 320 pixels; tables scroll inside their containers. Temporary viewport overrides were reset.

## Boundaries

The main capital cycle is a local simulation. It does not create a mint, Meteora pool, vault shares, live trading volume or a production reward distributor. Forecasts are assumption-driven fee calculations, not verified APY. Sponsor integrations and bounty eligibility remain unverified. The UI rebuild does not change these facts.
