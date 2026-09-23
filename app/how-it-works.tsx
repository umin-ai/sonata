import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

// What each part of Sonata is built on, what state it is in, and where to check
// it. Kept factual: every "Live" item has transactions in HANDOFF.md.
const HANDOFF = "https://github.com/umin-ai/sonata-protocol/blob/main/HANDOFF.md";
const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

const parts: [string, string, string, string][] = [
  ["Launch", "Meteora Dynamic Bonding Curve", "Every launch deploys its own Meteora DBC config and pool from the creator's choices, paired with a stock: S&P 500, Nasdaq 100, Tesla, Microsoft, Amazon, Meta, McDonald's or pre-IPO Anthropic. Sonata's treasury program is the config's fee claimer, so fees go to code, not a wallet.", "Live on Devnet"],
  ["Dollar targets", "Jupiter, checked by Pyth", "Graduation targets are set in US dollars and converted at the price of the real tokenized stock (SPYx, QQQx, TSLAx) across Solana markets. Pyth's equity feed is an independent check: a gap above 1% blocks the launch.", "Live on Devnet"],
  ["Stock Floor", "Sonata treasury program", "Half of net trading fees builds a floor in the stock token. Any holder can burn tokens for their exact share; the creator can never withdraw it.", "Live on Devnet"],
  ["Graduation", "Meteora DAMM v2", "When a curve fills, the market migrates to a DAMM v2 pool with 100% of its liquidity permanently locked.", "Proven on Devnet"],
  ["Charts and trades", "Sonata trade indexer", "Every swap on a Sonata market is read from Meteora's own swap events into a database, which powers the charts, recent trades and 24h volume.", "Live on Devnet"],
  ["Token profiles", "Amazon S3 and CloudFront", "Images, descriptions and links are stored under the SHA-256 of each file, so anyone can check a token's image is the one uploaded.", "Live on Devnet"],
  ["Holder rewards", "Sonata rewards program", "Creators can fund reward rounds for holders from their reserve.", "Live for mSPY markets"],
];

const programs: [string, string][] = [
  ["Sonata treasury", "GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj"],
  ["Sonata rewards", "6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L"],
  ["Meteora DBC", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"],
];

const notYet = [
  "Mainnet, and real stock tokens as the quote asset (they need a Meteora token badge).",
  "Collecting fees after graduation, so the Stock Floor stops growing at graduation.",
  "Holder rewards on markets not quoted in mSPY.",
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
