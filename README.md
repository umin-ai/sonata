# Sonata

Sonata is a token launchpad on Solana where every token is paired with a tokenized stock, such as SPYx, NVDAx or pre-IPO PreStocks. Trading fees settle in that stock and are paid out on-chain to the creator, the holders or liquidity providers, under rules fixed at launch. Launches use Meteora's Dynamic Bonding Curve (DBC) and graduate into a permanently locked Meteora DAMM v2 pool. Devnet only; mock tokens have no monetary value.

- **App (Devnet):** https://sonata.umin.ai
- **Evidence:** [HANDOFF.md](HANDOFF.md) has the status, on-chain proofs, security model and Meteora references.

## Layout

| Path | What it is |
|---|---|
| [`web/`](web/README.md) | The web app (launch, markets, fees, pools, My tokens), the trade indexer and payout bot (`web/indexer/`), and the server setup (`web/deploy/lightsail/`) |
| [`protocol/`](protocol/README.md) | The Anchor programs `stockroom_treasury` and `stockroom_rewards`, their tests, the Devnet proof and verification scripts, and the evidence those scripts wrote (`protocol/artifacts/`) |
| [`HANDOFF.md`](HANDOFF.md) | Handoff and evidence: every claim points to a source line, a Devnet transaction or account, or an external page |

Each folder keeps its own `package.json` and lockfile. There is no root package and no workspace, so run npm inside `web/` or `protocol/`.

## Quick start

Web app (Node 22.13 or later; runs against Solana Devnet):

```sh
cd web
npm ci
npm run dev
```

Protocol (Rust 1.90.0, Anchor 1.0.2 and Agave 3.1.13; see [protocol/README.md](protocol/README.md#build-and-test)):

```sh
cd protocol
npm ci
npm run build   # both programs; the tests load them from target/deploy
npm test
```

## Tests

- `web/`: `npm test` (app), `npm run test:indexer` (indexer and payout bot) and `npx tsc --noEmit`. App tests sit next to the code as `web/lib/**/*.test.ts`; indexer tests are `web/indexer/*.test.mjs` and `web/indexer/modules/*.test.mjs`.
- `protocol/`: `npm test` runs `node --test tests/*.test.mjs`, LiteSVM tests of the compiled programs in `protocol/tests/`. They need no validator, wallet or real money.

There is no CI; the tests run locally.

## License

`protocol/` is licensed under **GPL-3.0-or-later** (see [protocol/LICENSE](protocol/LICENSE)), with dependency notes in [protocol/THIRD_PARTY_NOTICES.md](protocol/THIRD_PARTY_NOTICES.md).

Never commit wallet keys or `.env` files.
