# Sonata

**Every trade pays in stock.**

Sonata is a token launchpad on Solana where every token is paired with a tokenized stock, such as SPYx, NVDAx or pre-IPO PreStocks. Trading fees settle in that stock and are paid out on-chain to the creator, the holders or liquidity providers, under rules fixed at launch.

- **App:** https://sonata.umin.ai
- **Programs and evidence:** [umin-ai/sonata-protocol](https://github.com/umin-ai/sonata-protocol) ([HANDOFF.md](https://github.com/umin-ai/sonata-protocol/blob/main/HANDOFF.md) has the on-chain proofs and security model)

## How it works

1. **Launch.** Name, ticker, image and a stock. Each launch gets its own bonding-curve configuration with a dollar graduation target, priced from the real stock on Solana. The creator can buy first in the same transaction. One wallet approval.
2. **Choose who earns.** The creator's share of every fee goes to their wallet, to holders, or to a fee module (Buyback & burn, Top Buyer Bounty, LP Farm, Split, Diamond Hands). Backed tokens also build a stock reserve the creator can never withdraw.
3. **Trade.** Buy and sell with the stock on the market page.
4. **Graduate.** A full curve moves into a permanently locked pool, half the creator's and half Sonata's. Sonata's half keeps paying the token's split.
5. **Get paid.** A payout bot collects and distributes fees automatically. Nothing to claim, and anyone can trigger a payout.

## Repository

| Path | What it is |
|---|---|
| `app/` | The web app: launch, markets, fees, pools, My tokens |
| `lib/treasury/` | Market reads, transaction builders and fee rules for the Sonata treasury program |
| `lib/liquidity/` | Graduated pools, liquidity positions and the mainnet xStock pool list |
| `lib/pricing/` | Stock prices from Solana markets, checked against Pyth where available |
| `indexer/` | Trade indexer and the payout bot (`crank.mjs`) with its fee modules |
| `deploy/lightsail/` | Server setup and deploy steps |

## Run it

Requires Node 22.13 or later. The app runs against Solana Devnet with test versions of the stocks.

```sh
npm ci
npm run dev
```

Optional server settings, in `.env.local`:

- `PYTH_PRO_API_KEY`: enables the Pyth price check at launch.
- `AWS_REGION`, `SONATA_ASSETS_BUCKET`, `SONATA_ASSETS_CDN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: token image uploads.

The indexer and payout bot run on the server; see [deploy/lightsail/README.md](deploy/lightsail/README.md).

## Test

```sh
npm test               # app
npm run test:indexer   # indexer and payout bot
npx tsc --noEmit
```

Never commit wallet keys or `.env` files.
