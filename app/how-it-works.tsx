import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

// What each part of Sonata is built on, what state it is in, and where to check
// it. Kept factual: every "Live" item has transactions in HANDOFF.md.
const HANDOFF = "https://github.com/umin-ai/sonata-protocol/blob/main/HANDOFF.md";
const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

const parts: [string, string, string, string][] = [
  ["Launch", "Meteora Dynamic Bonding Curve", "Quick launch: name, ticker, image, go, on the default curve (opens at $5,000, graduates at $75,000, 1.25% fee, 0.5% to you). Advanced: five steps to pick the stock (S&P 500, Nasdaq 100, Tesla, Microsoft, Amazon, Meta, McDonald's or pre-IPO Anthropic), the curve shape (Classic, Steady, Rocket or Whale wall), the graduation target ($25K, $50K or $75K), the fee (1.25%, 2% or 3%), the extras and the fee model. Either way it is one wallet approval, with an optional dev buy of up to 75% of the supply in the same transaction that creates the pool, so nothing trades before you.", "Live on Devnet"],
  ["Fee model", "Sonata treasury program", "A 1.25% trading fee. Meteora keeps 0.25%. Standard token: 0.5% to the creator (or to a fee module), 0.5% to Sonata. Reward token: the creator's 0.5% is paid to holders instead. Backed token: 0.25% to the creator and 0.25% into a stock reserve holders can cash out. No extra tax on transfers.", "Live on Devnet"],
  ["Fee modules", "Sonata payout bot", "Instead of keeping it, a Standard token's creator can send their 0.5% to Buyback & burn (buys the token and burns it), Top Buyer Bounty (each 15-minute round's 3 biggest net buyers win 50% / 30% / 20%), LP Farm (holders on the curve, liquidity providers after graduation), Split (up to 5 wallets) or Diamond Hands (holders, weighted up to 3× by how long they hold; selling restarts the clock). The choice is written into the token's metadata at launch and can't be changed.", "Live on Devnet"],
  ["Paid automatically", "Sonata payout bot", "Every 15 minutes a bot collects each market's fees and sends them out, in the stock: to the creator's wallet, pro rata to holders, or into the chosen fee module. Destinations are fixed on-chain or in the token's metadata; for Reward tokens and fee modules the bot holds the funds briefly while it pays them.", "Live on Devnet"],
  ["Launch extras", "Meteora Dynamic Bonding Curve", "Volatility fee: Meteora's dynamic fee raises the fee by up to 20% while the price moves fast; the extra is split like the rest of the fee. Graduation airdrop: 5% of the supply is kept off the curve; at graduation Sonata's payout bot withdraws it from Meteora and airdrops it to holders, pro rata. Both are set in the token's Meteora config at launch.", "Live on Devnet"],
  ["After graduation", "Meteora DAMM v2", "When a curve fills, the market moves to a DAMM v2 pool with its liquidity locked forever, split half to the creator and half to Sonata. The creator claims their half's fees with one click. Sonata's half is collected every 15 minutes and split like the fees on the curve (for a Standard token, half to the fee model and half to Sonata), so creator payouts, holder rewards, fee modules and the Backed token's backing keep going after graduation.", "Live on Devnet"],
  ["Dollar targets", "Jupiter, checked by Pyth", "Graduation targets are set in US dollars and converted at the price of the real tokenized stock on Solana (xStocks such as SPYx or MSFTx, or PreStocks for Anthropic). For stocks Pyth covers, its equity feed is an independent check: a gap above 1% blocks the launch.", "Live on Devnet"],
  ["Backed token", "Sonata treasury program", "The stock reserve is held by the program: any holder can burn tokens for their exact share, one holder cashing out never lowers anyone else's share, and the creator can never withdraw it.", "Live on Devnet"],
  ["Charts and trades", "Sonata trade indexer", "Every swap on a Sonata market is read from Meteora's own swap events into a database, which powers the charts, recent trades and 24h volume.", "Live on Devnet"],
  ["Token profiles", "Amazon S3 and CloudFront", "Images, descriptions and links are stored under the SHA-256 of each file, so anyone can check a token's image is the one uploaded.", "Live on Devnet"],
  ["Launchpad identity", "Meteora partner metadata", "One on-chain record names Sonata, with its website and logo, as the launchpad behind every Sonata pool, including graduated ones. New tokens' metadata also links to sonata.umin.ai.", "Live on Devnet"],
];

const programs: [string, string][] = [
  ["Sonata treasury", "GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj"],
  ["Sonata rewards", "6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L"],
  ["Meteora DBC", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"],
];

const notYet = [
  "Mainnet, and real stock tokens as the quote asset (they need a Meteora token badge).",
  "Cheaper launches: about 0.032 SOL today, mostly token metadata; switching to Token-2022 tokens removes most of it.",
  "NVIDIA as a paired stock (no Devnet test token yet).",
  "A professional audit. One key can upgrade all programs.",
];

export function HowItWorks() {
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / HOW IT WORKS</span>
          <h1>How it works</h1>
          <p>What each part is built on, and where to check it. Solana Devnet, test tokens only.</p>
        </div>
      </div>
      <div className="how-grid">
        {parts.map(([title, built, copy, status]) => (
          <Card className="sr-panel" key={title}>
            <div className="how-head">
              <h3>{title}</h3>
              <Badge variant="outline">{status}</Badge>
            </div>
            <span className="sr-eyebrow">{built}</span>
            <p className="sr-note">{copy}</p>
          </Card>
        ))}
      </div>
      <div className="how-grid how-grid-2">
        <Card className="sr-panel">
          <h3>Programs</h3>
          {programs.map(([name, id]) => (
            <div className="sr-detail-row" key={id}>
              <span>{name}</span>
              <a className="sr-text-link" href={explorer(id)} target="_blank" rel="noreferrer">
                {id.slice(0, 5)}…{id.slice(-5)} <ArrowUpRight size={14} />
              </a>
            </div>
          ))}
          <p className="sr-note">The deployed Sonata programs match the published source byte for byte.</p>
        </Card>
        <Card className="sr-panel">
          <h3>Proof</h3>
          <p className="sr-note">Every claim above links to a Devnet transaction in the evidence document.</p>
          <div className="flex flex-col gap-2 mt-2">
            <a className="sr-text-link" href={HANDOFF} target="_blank" rel="noreferrer">Evidence and security model <ArrowUpRight size={14} /></a>
            <a className="sr-text-link" href="https://github.com/umin-ai/sonata" target="_blank" rel="noreferrer">App source <ArrowUpRight size={14} /></a>
            <a className="sr-text-link" href="https://github.com/umin-ai/sonata-protocol" target="_blank" rel="noreferrer">Programs source <ArrowUpRight size={14} /></a>
          </div>
        </Card>
      </div>
      <Card className="sr-panel">
        <h3>Not done yet</h3>
        <ul className="how-list">
          {notYet.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
