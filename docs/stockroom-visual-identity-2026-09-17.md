# Stockroom — Midnight Glass

The visual redesign is local at http://localhost:5173/ and is not published.

## Direction

A dark, restrained financial workspace with an original S monogram, self-hosted Manrope typography, icy mint accents, translucent layered panels, fine borders and soft background illumination. The interface uses space and typographic hierarchy instead of additional decoration or illustration.

## Changes

- Replaced the fixed sidebar with a capsule navigation and compact wallet control.
- Rebuilt discovery around an actionable index-strategy card, a clear metric strip and a three-column strategy directory.
- Redesigned vault cards, transaction panels, review dialogs, receipts, portfolio, community treasury, rewards and ecosystem coverage.
- Brought the retained devnet credit routes into the same colour, typography and surface system without changing transaction execution.
- Preserved filters, search, sorting, existing routes, balances, local persistence and the connected accounting model.
- Maintained explicit simulation labels, issuer/risk disclosures and integration statuses.
- Added responsive layouts, keyboard focus styling, reduced-motion support and opaque fallbacks for browsers without backdrop-filter.
- Bundled the font files locally with their SIL Open Font License in public/fonts/OFL-Manrope.txt.

## Verification

Desktop and phone visual checks; homepage filtering; all main navigation routes; a $10 simulated deposit followed by full withdrawal returning the demo balance; devnet market list and market details (read-only). TypeScript and production build checked. No mainnet actions, wallet signatures or deployment.
