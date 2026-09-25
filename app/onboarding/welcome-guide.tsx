"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, ArrowUpRight, Coins, Compass, Map as MapIcon, Rocket, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BrandMark } from "@/app/stockroom-brand";

type Step = { icon: LucideIcon; title: string; line: string };
type Guide = { title: string; sub: string; steps: [Step, Step, Step, Step] };

// One short guide per page: four numbered steps, a few words each.
export const GUIDES = {
  home: {
    title: "Welcome to Sonata",
    sub: "Here's what you can do",
    steps: [
      { icon: Compass, title: "Pick a market", line: "Every token trades against a stock" },
      { icon: ArrowLeftRight, title: "Buy or sell", line: "Pay with SPYx, NVDAx and more" },
      { icon: Coins, title: "Earn in stock", line: "Creators, holders or LPs, by token type" },
      { icon: Rocket, title: "Launch your own", line: "Name, ticker, stock. Go" },
    ],
  },
} satisfies Record<string, Guide>;
export type GuidePage = keyof typeof GUIDES;

const seenKey = (page: GuidePage) => `sonata.guide.v1.${page}`;

function StepBody({ step, n }: { step: Step; n: number }) {
  const Icon = step.icon;
  return (
    <div className="guide-node">
      <span className="guide-num">{String(n).padStart(2, "0")}</span>
      <span className="guide-step-icon"><Icon size={24} aria-hidden /></span>
      <div className="guide-step-copy"><strong>{step.title}</strong><small>{step.line}</small></div>
    </div>
  );
}

/**
 * A page's welcome guide, opened from a "Quick tour" button (never on its
 * own; ?guide=1 opens it on load, for demos) and closed with LET’S GO. The button
 * shows a dot until the guide has been seen once in this browser.
 */
export function WelcomeGuide({ page }: { page: GuidePage }) {
  const force = useSearchParams().get("guide") === "1";
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setSeen(localStorage.getItem(seenKey(page)) === "1");
      } catch {
        // No storage (private window): no dot.
      }
      if (force) setOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [page, force]);
  const show = () => {
    setOpen(true);
    setSeen(true);
    try {
      localStorage.setItem(seenKey(page), "1");
    } catch {
      // Not remembered; the dot shows again next visit.
    }
  };
  const g = GUIDES[page];
  return (
    <>
    <button type="button" className="guide-launch" onClick={show} aria-label="Quick tour of this page">
      <MapIcon size={16} aria-hidden />
      Quick tour
      {!seen && <i className="guide-dot" aria-hidden />}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="guide-dialog">
        <div className="guide-heading">
          <span className="guide-eyebrow"><span /> QUICK TOUR <span className="guide-edition">SONATA / 01</span></span>
          <DialogTitle className="guide-title">{g.title}</DialogTitle>
          <DialogDescription className="guide-sub">{g.sub}</DialogDescription>
        </div>
        <div className="guide-briefing">
          <div className="guide-visual" aria-hidden="true">
            <span className="guide-visual-label">STOCK-POWERED MARKETS</span>
            <div className="guide-emblem"><div className="guide-emblem-frame" /><BrandMark /></div>
            <div className="guide-visual-copy">MAKE YOUR<br /><em>NEXT MOVE.</em></div>
            <div className="guide-visual-track"><i /><i /><i /><i /></div>
            <span className="guide-visual-footer">DISCOVER / TRADE / CREATE</span>
          </div>
          <ol className="guide-list">
            {g.steps.map((step, i) => (
              <li key={step.title}><StepBody step={step} n={i + 1} /></li>
            ))}
          </ol>
        </div>

        <div className="guide-foot">
          <small>Solana Devnet · test tokens, no value</small>
          <Button onClick={() => setOpen(false)}>LET’S GO <ArrowUpRight size={18} aria-hidden /></Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
