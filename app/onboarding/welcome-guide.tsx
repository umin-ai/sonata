"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, Coins, Compass, Rocket, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BrandMark } from "@/app/stockroom-brand";

type Step = { icon: LucideIcon; title: string; line: string };
type Guide = { title: string; sub: string; steps: [Step, Step, Step, Step] };

// One short guide per page: four numbered steps around Sonata, a few words each.
export const GUIDES = {
  home: {
    title: "Welcome to Sonata",
    sub: "Here's what you can do",
    steps: [
      { icon: Compass, title: "Pick a market", line: "Every token trades against a stock" },
      { icon: ArrowLeftRight, title: "Buy or sell", line: "Pay with mSPY, mQQQ and more" },
      { icon: Coins, title: "Earn in stock", line: "Fees paid out every 15 min" },
      { icon: Rocket, title: "Launch your own", line: "Name, ticker, stock. Go" },
    ],
  },
} satisfies Record<string, Guide>;
export type GuidePage = keyof typeof GUIDES;

const seenKey = (page: GuidePage) => `sonata.guide.v1.${page}`;

// Where each step sits on the map (viewBox 560 x 300), clockwise from top left,
// and the curved arrow from the hub to it.
const NODES = [
  { x: 10, y: 20, path: "M240 128 C 214 108 206 62 184 62" },
  { x: 380, y: 20, path: "M320 128 C 346 108 354 62 376 62" },
  { x: 380, y: 196, path: "M320 172 C 346 192 354 238 376 238" },
  { x: 10, y: 196, path: "M240 172 C 214 192 206 238 184 238" },
] as const;

function StepBody({ step, n }: { step: Step; n: number }) {
  const Icon = step.icon;
  return (
    <div className="guide-node">
      <span className="guide-num">{n}</span>
      <Icon size={20} aria-hidden />
      <strong>{step.title}</strong>
      <small>{step.line}</small>
    </div>
  );
}

/**
 * A welcome guide for a page: shown once per browser (remembered in
 * localStorage; ?guide=1 shows it again), closed with OK!.
 */
export function WelcomeGuide({ page }: { page: GuidePage }) {
  const force = useSearchParams().get("guide") === "1";
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(seenKey(page)) === "1";
    } catch {
      // No storage (private window): show it, and it stays closed for this visit once dismissed.
    }
    if (seen && !force) return;
    const timer = setTimeout(() => setOpen(true), 350);
    return () => clearTimeout(timer);
  }, [page, force]);
  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(seenKey(page), "1");
    } catch {
      // Not remembered; it shows again next visit.
    }
  };
  const g = GUIDES[page];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="guide-dialog sm:max-w-[640px]">
        <DialogTitle className="guide-title">{g.title}</DialogTitle>
        <DialogDescription className="guide-sub">{g.sub}</DialogDescription>

        {/* Desktop: a map, Sonata in the middle and arrows out to each step. */}
        <svg className="guide-map" viewBox="0 0 560 300" role="img" aria-label={g.steps.map((s, i) => `${i + 1}. ${s.title}`).join(", ")}>
          <defs>
            <marker id="guide-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="guide-arrowhead" />
            </marker>
          </defs>
          {NODES.map((n, i) => (
            <path key={i} d={n.path} className="guide-link" markerEnd="url(#guide-arrow)" />
          ))}
          <circle cx="280" cy="150" r="48" className="guide-hub" />
          <foreignObject x="232" y="112" width="96" height="76">
            <div className="guide-hub-body">
              <BrandMark />
              <b>Sonata</b>
            </div>
          </foreignObject>
          {NODES.map((n, i) => (
            <foreignObject key={i} x={n.x} y={n.y} width="170" height="84">
              <StepBody step={g.steps[i]} n={i + 1} />
            </foreignObject>
          ))}
        </svg>

        {/* Phones: the same steps in order, one arrow between each. */}
        <ol className="guide-list">
          {g.steps.map((s, i) => (
            <li key={s.title}>
              <StepBody step={s} n={i + 1} />
            </li>
          ))}
        </ol>

        <div className="guide-foot">
          <small>Solana Devnet · test tokens, no value</small>
          <Button onClick={close}>OK!</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
