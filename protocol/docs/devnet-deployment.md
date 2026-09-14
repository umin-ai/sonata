# Stockroom Devnet deployment and receipts

Recorded 14 September 2026. **PASS: both programs deployed, exact binary comparisons passed, and all 24 demo transactions finalized successfully.**

These transactions use demo Token-2022 stock collateral, a demo USD token and a controlled test oracle. They do not move real stocks or real USDC. The published Stockroom website is not yet connected to this transaction flow.

## Programs

| Program | Devnet Explorer | Deployment transaction |
|---|---|---|
| demo_oracle | [E45Bq8CUh12Fncuyd5GMHKgkmjpVp8n2C7521ExryDwg](https://explorer.solana.com/address/E45Bq8CUh12Fncuyd5GMHKgkmjpVp8n2C7521ExryDwg?cluster=devnet) | [Confirmed deployment](https://explorer.solana.com/tx/5PAktf6LNR8cfocnbJMvTZsTVGQQrYeRL1ciQAtwmEC3WfDPHdVkgGmGR7WFcw1gvUsLvhgKYDV749LCPBAKntGg?cluster=devnet) |
| stockroom_credit | [4sS8MrfTUjavLyMs5GtircsjMab5vfVZdLE7YPcZo9BH](https://explorer.solana.com/address/4sS8MrfTUjavLyMs5GtircsjMab5vfVZdLE7YPcZo9BH?cluster=devnet) | [Confirmed deployment](https://explorer.solana.com/tx/5gwvEmEWSEznZgRVHmopeQjYVeMn7xuzJsvpnN4k23PWebLVL5z8oseRQdZz1oWmHHjrq3Mkw3XWMyxrYR1HC8DP?cluster=devnet) |

Both use the upgradeable loader. The demo deployment wallet retains upgrade authority; neither program is immutable. The comparison verifies deployed bytes against the locally tested binary, not an independent audit or a cross-machine reproducible build.

## Demonstrated behavior

The first loan supplies 5,000 demo USD, locks 10 demo stocks, borrows 500 demo USD, repays debt plus elapsed interest, returns collateral and redeems lender capital. The second loan borrows 900 demo USD, applies an explicit mock price shock from 200 to 50 USD per raw stock, executes a paid liquidation and writes off uncovered debt against lender NAV.

Before final redemption, the second scenario leaves 4,576.190479 demo USD in lender NAV. Final outstanding debt, debt shares, supply shares and borrower collateral are all zero; one quote-token atom remains as rounding dust.

The admin wallet received 5 Devnet SOL. Its recorded balance after deployment and demo is **2.127332640 Devnet SOL**. Funding consumed includes rent, temporary buffers, fees and demo-account funding. Demo transaction fees themselves total 0.000205 SOL.

## Market and demo assets

| Account | Devnet Explorer |
|---|---|
| market | [DDPudEgUyLGgvy2bDgrtoYfAXmNd2LaB842VveeWNvQF](https://explorer.solana.com/address/DDPudEgUyLGgvy2bDgrtoYfAXmNd2LaB842VveeWNvQF?cluster=devnet) |
| stockMint | [7iXwqi1TNYZEpQDe6AoT2yPpnr7rNyRNYCtipgTmSb7S](https://explorer.solana.com/address/7iXwqi1TNYZEpQDe6AoT2yPpnr7rNyRNYCtipgTmSb7S?cluster=devnet) |
| cashMint | [2GbGdocbeW9ggwrFKzXwxoVRko3sWednUi46MjiGpX4S](https://explorer.solana.com/address/2GbGdocbeW9ggwrFKzXwxoVRko3sWednUi46MjiGpX4S?cluster=devnet) |
| oracleAccount | [GE9SjeSpqcGCmd9UcL3566FYHhhYCcYa6uB78FMatHCw](https://explorer.solana.com/address/GE9SjeSpqcGCmd9UcL3566FYHhhYCcYa6uB78FMatHCw?cluster=devnet) |
| cashVault | [EnRPBaNy67u14YiJCCtHbp3a2tnT8MjFStQprUtJVpbQ](https://explorer.solana.com/address/EnRPBaNy67u14YiJCCtHbp3a2tnT8MjFStQprUtJVpbQ?cluster=devnet) |
| collateralVault | [3DgEtHHzRQ3aEGFLne1bcVrco2NTtexA5LV8mkT7Ytfq](https://explorer.solana.com/address/3DgEtHHzRQ3aEGFLne1bcVrco2NTtexA5LV8mkT7Ytfq?cluster=devnet) |

The demo leaves the market empty and its mock price is not continuously updated. A new run creates fresh test wallets and mints. A live browser borrowing flow needs a deliberate demo-token distribution and oracle-refresh design.

## Finalized transaction receipts

| Step | Action | Receipt |
|---:|---|---|
| 1 | Create demo quote mint | [View transaction](https://explorer.solana.com/tx/uDyKniGpxd32gKJ6WZ8ohpXFfL3uxVF8Usp2mCYpKZXQoCP9GwD7jxaSDt96PLXC91aDsftDVeSMe91e9ebii1T?cluster=devnet) |
| 2 | Create demo stock mint | [View transaction](https://explorer.solana.com/tx/K97LWeMUwa27WCDkpShtNspvK1gjhAfD9eUEJF1diRKi7becEiW589bzGPY9TXzzuKAjCr7SB2EhQrZPsXcuZuv?cluster=devnet) |
| 3 | Fund lender test accounts | [View transaction](https://explorer.solana.com/tx/3qWeSLEdVWjYN87zE6cbhdo4sdA34fsaVVDHcnSMEsWUXaUdayUX8ythkXm3BXyUSvKYff3wUV9bgTM4bpuubAE6?cluster=devnet) |
| 4 | Fund borrower test accounts | [View transaction](https://explorer.solana.com/tx/3M9Y9UGNkp2Lg7y6EXHKY8BAk1HgJK9wfpbLCmecP24jxLqxy3WnJHjU2jbcyoADZUYhP1xf9imLBA8FWZoxCHVC?cluster=devnet) |
| 5 | Fund liquidator test accounts | [View transaction](https://explorer.solana.com/tx/52A4y94z7S3umwAK8PHC4Sy5EWuXs1cBjDtkxAXk9m8XnkQ7W6rokrmZ8VkDrmWDRvUiZQntbggkWDDJW1ZjjLS2?cluster=devnet) |
| 6 | Initialize demo oracle | [View transaction](https://explorer.solana.com/tx/3GS5fNSMLQhgFMhsAfNmGuexiLL2Kr43wCUY5C4oYVKvKsK3i8TN1HmHnVBBZ5buRB3BsoXvkgj6Gd7uiCK76m1m?cluster=devnet) |
| 7 | Initialize Stockroom market | [View transaction](https://explorer.solana.com/tx/3Mz1KuhpUUDUiDVeFrfUZEkyWmTu8Ca9ycKNeEVURVG8b7bw9qRbLvLm7Dov2dufyxiTYWhA3eG5gGG6cENCA6iR?cluster=devnet) |
| 8 | Initialize lender position | [View transaction](https://explorer.solana.com/tx/2HqCJtRt7CCB2ZTRxQzn8J6mq1wUy2di4wpJJje2cUrXddPfgzQ5kQsEdHBKb1suqJZZ12R6rhfdHbEEnK9GQLpt?cluster=devnet) |
| 9 | Initialize borrower position | [View transaction](https://explorer.solana.com/tx/w5Zwno5oZK6WX4pfcD1aQeG65UvHSmJkZRLqeMn7tj6TGnxg15jDXNwX1EWyww67SVNTQitTEeQMAX3hKbpn2dC?cluster=devnet) |
| 10 | Initialize liquidator position | [View transaction](https://explorer.solana.com/tx/3Y6yzsXfwJurR1r4LUr7v68fd4wKFpTP3q4qKA8XckoSoViYdpBdUTYhkcKTdpkSwYntpQwEQTQUhQ6d8gtuWCRh?cluster=devnet) |
| 11 | Lender supplies 5,000 demo USD | [View transaction](https://explorer.solana.com/tx/3WqgAnUp6FF5n3F9nE8McbxULT1tYFhUUzdJrnPyxzSANnni9XKNpxNTkfJnQjNP6DQmP78PkP218QGNF32iXTcR?cluster=devnet) |
| 12 | Borrower deposits 10 demo stocks | [View transaction](https://explorer.solana.com/tx/4wEy2yMzVDrrnCZNMbvBzc7zB6b9N8h7LMhFotaQD3YsJ11ZtAkdUt5vs3ac2xJdgxssKj3gAiFUTLDS5mHKLkkY?cluster=devnet) |
| 13 | Refresh demo price | [View transaction](https://explorer.solana.com/tx/m93yhNJSjLeroQh2n4SUz5zcSJmk8sVRghQaeLuXNanw9Ykvuvxh9HvZt399LTE8TuYCZWyCU1FewE6FteQawEC?cluster=devnet) |
| 14 | Borrower receives 500 demo USD | [View transaction](https://explorer.solana.com/tx/4rdLBEMoaZocrgDCu3hmonhF9kgshxKKMEEWf9xnXuxf7inySHgirmBpP91TSWf6QXsMf5wtjkN917nWFeGH9VKj?cluster=devnet) |
| 15 | Borrower repays debt and elapsed interest | [View transaction](https://explorer.solana.com/tx/3qwBEyE7CTGGzqHBpNpRPxZeTMigpaZC1rezJNw557agGVkdWoMUWWsJuo9FtSMWEB8ze67jMNS2W9YhxkGY51XK?cluster=devnet) |
| 16 | Borrower releases all collateral | [View transaction](https://explorer.solana.com/tx/8NxbEmnfDsjPSyP8rnXz82ZVEoZbSwxcdFacaBLNUAweZBXX3BVSP4zHPZkYQtxR2sCN7MiqLX6vB8mcw8VwocC?cluster=devnet) |
| 17 | Lender redeems available capital and interest | [View transaction](https://explorer.solana.com/tx/GuSJWoXVYhX54aFsKSsJVahcNsozSWNqmdenCyxuqaxkrko2RB6G7v4J5B31u35xAu9t5DP2hHBLeu14nHjr6ZE?cluster=devnet) |
| 18 | Lender supplies liquidation test liquidity | [View transaction](https://explorer.solana.com/tx/8kp7giaKCJYPnTKEwKoiKBzwLdWjyuqQUbbdZthR2PMddnz8XmT9PWPCG3FPXFnVpfwuzpGCNJAoE5Dd9eZAmdf?cluster=devnet) |
| 19 | Borrower posts liquidation test collateral | [View transaction](https://explorer.solana.com/tx/KXgNbDshW9iKroiR5UTiyQfRcouWLucmQdJ6rvCgP3EZsySTLg35Cas9xNSsgv6uWHbBKp3CPQYD9DuRHNB8BbM?cluster=devnet) |
| 20 | Refresh opening quote | [View transaction](https://explorer.solana.com/tx/3RP6RANYuzPSQkuDjAcWGN6msxBubNfArNEiJ1W9uBRU4ehpmHKjeJyZjebsYqbf6anUc1BAYRmpjyTJhQjvJuMw?cluster=devnet) |
| 21 | Borrower receives 900 demo USD | [View transaction](https://explorer.solana.com/tx/5fZAUYWtr8mh8r1bFC2AdyX3Qu13LKMNtLTF4vanR8wskTVV8U4ZGyZTqZFRm2N3ptmUv4DFob8uytCnzwyb2bJZ?cluster=devnet) |
| 22 | Demo price shock to 50 USD per raw stock | [View transaction](https://explorer.solana.com/tx/3yd7mbznhjRpjD5aiPDrhCwUJEa3y3yhvFe5qrceGxtseB3k9XDXxy3xU8Em31bmvKUwbnJ9Vd2dEzBcxuHEAPdP?cluster=devnet) |
| 23 | Liquidator pays and seizes exhausted collateral | [View transaction](https://explorer.solana.com/tx/5FKPA9QzbpPGne19t1gjEDc3Tw5AcBeMv1Ptw8dNLG4wrS4Ue8Ab4FWWoRXExT5YzvUdZQENGUd1GKCgPiPMk1mJ?cluster=devnet) |
| 24 | Lender redeems reduced NAV after bad debt | [View transaction](https://explorer.solana.com/tx/2MqL2SjodE388RykQveQhV4HCjMo2pFMeVLtuix23mh5pZiWvshEujj3o7LeTdG5x4YHRk1vC5VXGbHoNLeic8Rm?cluster=devnet) |

## Evidence and repeatability

- [Deployment proofs](../artifacts/devnet-deployment.json)
- [Full demo receipts and final state](../artifacts/devnet-2026-09-14T03-34-45-792Z.json)
- [Independent signature-status check](../artifacts/devnet-status.json)
- [18 passing tests and source/binary hashes](../artifacts/verification.json)

The initial RPC upload hit public connection limits; QUIC upload also encountered duplicate-write and leader-cache issues. Complete buffers were compared byte for byte before finalization. The deployment script now verifies and skips matching deployed programs, reuses interrupted buffers, checks their authority, and credits already-funded rent. Running it again after the successful demo verified both programs without deploying again.

Use `npm run deploy:devnet` to check this deployment and `npm run demo:devnet` for a fresh test run. Never publish the ignored `.keys/` directory.
