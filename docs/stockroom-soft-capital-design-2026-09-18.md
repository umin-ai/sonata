# Stockroom — Soft Capital visual redesign

18 September 2026. Local app: http://localhost:5173/ . No deployment or on-chain program change in this milestone.

## Direction

The user requested a complete neumorphic identity and a clearer, more attractive experience. The resulting system uses warm ivory surfaces, forest-green actions, raised panels, inset controls, a restrained S mark, and a sculpted stock/ROOM coin illustration built with CSS. The illustration is decorative, not a stock chart or performance claim.

The live [Morpho market directory](https://app.morpho.org/variable) and [Superform Earn interface](https://app.superform.xyz/) were opened and visually inspected. Lessons applied: obvious primary tasks, consistent market comparisons, distinct action hierarchy, and navigation that separates discovery from management. Neither interface was copied, and no TVL/APY from those products was imported into Stockroom.

## Implemented

- Shared neumorphic theme across Discover, Earn, Portfolio, Rewards, Activity, Create, Capital, Treasury, and the shared strategy screens.
- Homepage with the “Put stocks to work” identity, three linked product entry points, actual registered markets, working case-insensitive name/symbol search, empty search feedback and loading placeholders.
- Navigation grouped into personal workspace and creator tools. Research/prototype links are secondary.
- Consistent buttons, badges, inputs, selects, tabs, cards, tables, menus, dialogs, focus rings, and mobile presentation using the existing shadcn components.
- Compact connected-wallet panel; optional wallet information behind a disclosure. Existing signing controls and transaction safety checks remain intact.
- Treasury title identifies its pair; reserve actions now link directly to liquidity deployment and reward funding.
- Removed stale homepage and treasury claims describing already-live features as unfinished; corrected an old simulated-community link to the actual reward flow.
- Favicon updated to the new palette. The legacy credit sandbox remains a separate route/style boundary.

## Verification

- TypeScript check and production build pass; build output in `evidence/neumorphic-build.txt`.
- Desktop composition checked at 1440 × 1000.
- Mobile document width checked at 390 px on all eight live routes: `/`, `/earn`, `/create`, `/capital`, `/rewards`, `/portfolio`, `/activity`, `/onchain`. No horizontal document overflow observed.
- Search “crew” displayed only CREW; an unmatched query showed the empty state; Clear search restored the directory.
- Mobile navigation opened, displayed the grouped links, navigated and closed.
- Existing connected browser wallet loaded its creator reserve. A reserve deployment was prepared/simulated; the redesigned review showed both token amounts, maximum debits, ownership, destination, fees, rent and expiry. Cancel closed it. No transaction was signed or submitted during design QA.
- Reduced-motion preference disables added motion. Text labels and visible focus outlines remain available; this is not a claim of a complete accessibility audit.
- `git diff --check` passes.

## Main files

`app/neumorphic.css`, `app/stockroom-shell.tsx`, `app/layout.tsx`, `app/onchain/live-workspace.tsx`, `app/onchain/live-session.tsx`, `app/onchain/treasury-workspace.tsx`, `public/favicon.svg`.

A lack of disk space temporarily blocked the first edit. Only the regenerable Rust `stockroom-protocol/target/debug/deps` cache was removed; program deployment binaries, local keys, source and evidence were preserved. Subsequent Rust debug tests may rebuild those dependencies.

This milestone improves presentation and task navigation. It does not establish conversion improvement, product-market fit, real asset backing or production readiness.

## Typography refinement

User preference: 13px is the smallest text size anywhere. All application CSS font declarations below 13px were raised, including mobile overrides. The shared text-xs token and calendar text now use 13px, and native small text has a 13px floor. Rendered text was inspected on all eight live pages at 390px: no visible text below 13px and no horizontal document overflow. TypeScript and production build pass.

## Token identity refinement

Added a shared TokenName/TokenPair component: bold token symbols beside local logos in market headings/cards, balances, reserve selection, liquidity positions, rewards and signing reviews. Mock-stock symbols remain explicit and use the existing stock logo assets; ROOM uses the Stockroom mark; community tokens without artwork use a monogram. Mobile selection controls wrap rather than forcing token names outside their cards. Loaded images and 800-weight labels were verified in the browser. The 13px minimum is preserved.
