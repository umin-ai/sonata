# Stockroom — wallet connection UX

18 September 2026. Local implementation only.

## Observed pattern

Opened Jupiter's live Connect drawer and expanded its additional wallet options. The interface separates the connect entry point, provider selection and account management. Meteora's entry page required acceptance of terms; those terms were not accepted and its wallet picker was not inspected. The installed Wallet Standard feature type definitions were also read for the existing connection API.

## Implemented

- One primary **Connect wallet** button in the header on live routes.
- Connected state shows a short address with the provider's icon, or a flask for the browser test wallet.
- Account menu: full address, Copy address, View on explorer, Change wallet and Disconnect. Solana Devnet remains explicit.
- A shared accessible dialog lists actually registered Wallet Standard providers with their icons. The live provider requires both Devnet support and transaction signing capability.
- Connection requests show progress and provider errors. Selecting a wallet requests connection only, not a transaction signature.
- Without a compatible wallet, the modal explains the missing extension and offers official Phantom, Solflare and Backpack links. Those links do not pretend to connect an absent provider.
- Browser test wallet is available under Developer options, clearly labeled for valueless test assets. Existing test keys and balances are preserved.
- Removed repeated inline wallet cards; their transaction progress and error feedback remain.
- Successful extension connection clears the active browser-test-wallet fallback. A failed attempt leaves the current account intact. Late connection results after disconnect cannot restore the disconnected account.

## Verification and limits

TypeScript and production build pass. Browser checks covered the connected header, account menu, change-wallet dialog, no-extension state, disconnect, Connect wallet, developer test-wallet reconnection and navigation to Earn with the same public address. No wallet transaction was signed or broadcast. The in-app browser has no compatible extension installed, so the actual Phantom/Solflare approval path has not been exercised in this environment. No fake provider was injected and no extension installation was attempted.

Primary files: `app/onchain/wallet-connect.tsx`, `app/onchain/live-context.ts`, `app/onchain/live-session.tsx`, `app/stockroom-shell.tsx`, `hooks/use-wallet.ts`, `app/neumorphic.css`. Build evidence: `evidence/wallet-ux-build.txt`.

This supersedes earlier documentation describing a signing-wallet card repeated on each page.
