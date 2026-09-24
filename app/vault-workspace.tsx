"use client";
import { MeteoraLabel } from "@/app/protocol-identity";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { StockroomShell } from "./stockroom-shell";
import { toast } from "sonner";
import Link from "@/app/plain-link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  ArrowRight,
  Layers3,
  Compass,
  ShieldCheck,
  FlaskConical,
  ExternalLink,
  ChartNoAxesCombined,
  Zap,
} from "lucide-react";
import { StockroomProvider } from "./stockroom-workspace";
import {
  initialDemo,
  hydrateDemo,
  transition,
  type Demo,
  type Action,
} from "@/lib/vaults/demo";
import { DemoContext as Context } from "./vault-state";
export {
  MarketDirectory as VaultDirectory,
  MarketDetail as VaultDetail,
  CapitalPortfolio as VaultPortfolio,
  CommunityHub as CommunityPage,
  CapitalActivity as VaultActivity,
} from "./market-workspace";
export function AppProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (
    path.startsWith("/devnet") ||
    path.startsWith("/markets") ||
    path.startsWith("/credit") ||
    path.startsWith("/activity/")
  )
    return (
      <div className="sr-credit-app">
        <StockroomProvider>{children}</StockroomProvider>
      </div>
    );
  return <VaultProvider>{children}</VaultProvider>;
}
function VaultProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Demo>(initialDemo);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false),
    [hasBackup, setHasBackup] = useState(false);
  const path = usePathname();
  useEffect(() => {
    if (!window.location.hash) window.scrollTo({ top: 0, behavior: "instant" });
  }, [path]);
  useEffect(() => {
    let cancelled = false;
    // Load browser-owned state after hydration; actions remain disabled until ready.
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        setHasBackup(!!localStorage.getItem("stockroom-vault-demo-backup"));
        const raw = localStorage.getItem("stockroom-vault-demo-v1");
        if (raw) {
          const saved = hydrateDemo(JSON.parse(raw));
          stateRef.current = saved;
          setState(saved);
        }
      } catch {}
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem("stockroom-vault-demo-v1", JSON.stringify(state));
      } catch {
        toast.error(
          "Browser storage unavailable; this session will not be saved.",
        );
      }
  }, [state, ready]);
  const act = (a: Action) => {
    if (!ready) throw new Error("Your saved demo is still loading.");
    const next = transition(
      stateRef.current,
      a,
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    stateRef.current = next;
    setState(next);
    toast.success(`${next.entries[0].type} complete`, {
      description: "Local simulation · no real funds moved",
    });
  };
  const reset = () => {
    try {
      localStorage.setItem(
        "stockroom-vault-demo-backup",
        JSON.stringify(stateRef.current),
      );
      setHasBackup(true);
    } catch {
      toast.error("Could not save backup. Existing session kept.");
      return;
    }
    const fresh = initialDemo();
    stateRef.current = fresh;
    setState(fresh);
    toast.success("Fresh demo started. Previous session can be restored.");
  };
  const restore = () => {
    try {
      const raw = localStorage.getItem("stockroom-vault-demo-backup");
      if (raw) {
        const old = hydrateDemo(JSON.parse(raw));
        stateRef.current = old;
        setState(old);
        toast.success("Previous demo restored.");
      }
    } catch {
      toast.error("Previous demo could not be read.");
    }
  };
  return (
    <Context.Provider value={{ state, act, ready }}>
      <StockroomShell reset={reset} restore={restore} hasBackup={hasBackup}>
        {children}
      </StockroomShell>
    </Context.Provider>
  );
}
function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="sr-heading">
      <div>
        <div className="sr-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function ProductCoverage() {
  return (
    <Card className="sr-panel sr-prose">
      <span className="sr-eyebrow">THE COMPLETE PRODUCT MAP</span>
      <h3>One lifecycle. Every layer accounted for.</h3>
      <p>
        Sonata connects fee-generating markets, treasury decisions and
        community participation. The local prototype demonstrates the
        accounting; external integrations remain individually tracked.
      </p>
      <div className="sr-coverage-grid">
        {[
          [
            "Markets & discovery",
            "Live on Devnet",
            "Registered Sonata / mSPY pools, onchain fee balances and verified custody.",
            "/",
          ],
          [
            "Capital & compounding",
            "Live on Devnet",
            "Wallet-owned ROOM/mSPY LP positions, native fee compounding, partial withdrawals and full exits, and creator reserves deployed from the Treasury page.",
            "/earn?net=devnet&pool=GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v",
          ],
          [
            "Creator & community",
            "Live on Devnet",
            "Creator reserve deployment into wallet-owned LP positions and funded, fixed-recipient reward claims. Automated holder snapshots remain separate work.",
            "/rewards",
          ],
          [
            "Analytics & receipts",
            "Working simulation",
            "Separate principal, fees, creator revenue, protocol revenue and member claims. Receipts show balance changes and funding sources. Return scenarios use explicit inputs; price movements remain outside the ledger.",
            "/lab/activity",
          ],
          [
            "Credit & collateral",
            "Separate earlier sandbox",
            "Borrowing work is retained. These new LP positions are not connected to it or accepted as collateral.",
            "/devnet",
          ],
          [
            "Market creation & locks",
            "Working local model",
            "Seed a simulated community/stock pair and test a creator liquidity lock. Live DBC pool creation is available separately; migration remains outstanding.",
            "/lab/create",
          ],
        ].map(([name, status, description, url]) => (
          <Link className="sr-coverage-card" href={url} key={name}>
            <Badge className="sr-chip">{status}</Badge>
            <h4>
              {name} <ArrowUpRight size={14} />
            </h4>
            <p>{description}</p>
          </Link>
        ))}
      </div>
      <h4>Research retained for expansion</h4>
      <p>
        Beefy inspires compounding and transaction review; Superform, strategy
        discovery; Glider, allocation controls; Fluid, productive liquidity and
        credit; Pendle, clearer separation of principal and yield; Clanker and
        Flaunch, creator revenue destinations. These are design references, not
        integrated protocols or promised returns.
      </p>
      <p>
        Issuer-aware baskets, recurring deposits, supported oracle feeds,
        pre-IPO assets, launch migration, automated harvesting and future credit
        remain in the plan. Each needs its own working integration before it can
        be claimed in a submission.
      </p>
    </Card>
  );
}
const integrations = [
  {
    name: "Pyth",
    category: "MARKET DATA",
    badge: "Scenario available",
    description:
      "Price freshness and deviation checks before a vault operation.",
    next: "Connect supported live feeds; verify units, confidence and market sessions.",
    prize: "3 months of Pyth Pro",
    url: "https://docs.pyth.network",
    icon: ShieldCheck,
  },
  {
    name: "PreStocks",
    category: "PRE-IPO ASSETS",
    badge: "Planned",
    description:
      "Extend the asset registry to supported private-company exposure.",
    next: "Verify exact mints, ownership terms, transfers and executable liquidity.",
    prize: "$5,000 bounty pool",
    url: "https://prestocks.com/products",
    icon: Layers3,
  },
  {
    name: "Tessera",
    category: "PRE-IPO ASSETS",
    badge: "Planned",
    description: "Explore strategies using OpenAI or Kalshi T-Tokens.",
    next: "Validate token compatibility and build a substantive asset integration.",
    prize: "$6,000 bounty pool",
    url: "https://docs.tessera.pe",
    icon: Compass,
  },
  {
    name: "Meteora DBC",
    category: "MARKET CREATION",
    badge: "Devnet fee flow verified",
    description:
      "Sonata’s own ROOM / mock-SPY DBC pool feeds its creator-controlled reserve.",
    next: "Browser pool creation, graduation/migration and reinvestment remain ahead. Clawpump is not part of this verified path.",
    prize: "$5,000 bounty pool",
    url: "https://docs.meteora.ag/developer-guides/dbc",
    icon: ChartNoAxesCombined,
  },
  {
    name: "Clawpump",
    category: "CREATOR DISTRIBUTION",
    badge: "Route unverified",
    description:
      "A potential creator entry point for a stock-paired community launch.",
    next: "Complete an actual stock-paired launch through Clawpump and Meteora.",
    prize: "$5,000 bounty pool",
    url: "https://clawpump.tech/developers",
    icon: Zap,
  },
];
export function EcosystemPage() {
  return (
    <>
      <Heading
        eyebrow="THE CONNECTIONS BEHIND THE PRODUCT"
        title="The bigger picture."
        description="Explore the intended integrations and see exactly what is working today."
        action={
          <Button asChild variant="outline">
            <a
              className="sr-secondary"
              target="_blank"
              rel="noreferrer"
              href="https://hackathons.solana.com/hackathons/stocklana"
            >
              Stocklana <ExternalLink size={14} />
            </a>
          </Button>
        }
      />
      <div className="sr-status-banner">
        <FlaskConical size={23} />
        <div>
          <h3>Interactive prototype · integration work ahead</h3>
          <p>
            The strategy model runs locally. The Devnet treasury now collects
            actual Meteora DBC fees and executes fixed-recipient payouts. Bounty
            eligibility and award stacking are not confirmed.
          </p>
        </div>
      </div>
      <ProductCoverage />
      <div className="sr-issuer-preview">
        <div>
          <span className="sr-eyebrow">NEXT ASSET FRONTIER</span>
          <h2>Before the opening bell.</h2>
          <p>
            Pre-IPO strategies belong here only after their rights, liquidity
            and valuation are understood.
          </p>
        </div>
        <div className="sr-preview-asset">
          <span>O</span>
          <h3>OpenAI</h3>
          <small>Tessera candidate</small>
          <b>Research preview</b>
        </div>
        <div className="sr-preview-asset">
          <span>K</span>
          <h3>Kalshi</h3>
          <small>Tessera candidate</small>
          <b>Research preview</b>
        </div>
      </div>
      <div className="sr-section-top">
        <h2>Integration roadmap</h2>
        <span className="sr-small">No partnership implied</span>
      </div>
      <div className="sr-integration-grid">
        {integrations.map(
          ({
            name,
            category,
            badge,
            description,
            next,
            prize,
            url,
            icon: Icon,
          }) => (
            <Card className="sr-panel sr-integration" key={name}>
              <div className="sr-card-top">
                <span className="sr-integration-icon">
                  {name === "Meteora DBC" ? (
                    <img
                      src="/protocol-logos/meteora.svg"
                      width={28}
                      height={28}
                      alt=""
                    />
                  ) : (
                    <Icon size={23} />
                  )}
                </span>
                <Badge className="sr-chip">{badge}</Badge>
              </div>
              <span className="sr-eyebrow">{category}</span>
              <h3>
                {name === "Meteora DBC" ? (
                  <MeteoraLabel>{name}</MeteoraLabel>
                ) : (
                  name
                )}
              </h3>
              <p>{description}</p>
              <div className="sr-integration-next">
                <span>TO VERIFY</span>
                <p>{next}</p>
              </div>
              <div className="sr-integration-footer">
                <span>{prize}</span>
                <a href={url} target="_blank" rel="noreferrer">
                  Docs <ArrowUpRight size={14} />
                </a>
              </div>
              {name === "Pyth" && (
                <Link className="sr-text-link" href="/vaults/spy">
                  Try the pricing scenario <ArrowRight size={14} />
                </Link>
              )}
              {name === "Meteora DBC" && (
                <Button asChild variant="outline">
                  <Link className="sr-secondary sr-full" href="/onchain">
                    Open market setup <ArrowRight size={14} />
                  </Link>
                </Button>
              )}
            </Card>
          ),
        )}
      </div>
      <Card className="sr-panel sr-prose">
        <h3>Built with reference, not guesswork.</h3>
        <p>
          The interface draws on Superform’s strategy presentation, Beefy’s
          transaction previews and the explicit revenue controls explored in
          Clanker and Flaunch. This prototype is independently implemented;
          their contracts have not been ported or audited for this app.
        </p>
        <div className="sr-source-links">
          <a
            target="_blank"
            rel="noreferrer"
            href="https://github.com/beefyfinance/beefy-v2"
          >
            Beefy frontend <ArrowUpRight size={14} />
          </a>
          <a
            target="_blank"
            rel="noreferrer"
            href="https://github.com/superform-xyz"
          >
            Superform repositories <ArrowUpRight size={14} />
          </a>
          <a
            target="_blank"
            rel="noreferrer"
            href="https://github.com/MeteoraAg/dynamic-bonding-curve-sdk"
          >
            Meteora DBC SDK <ArrowUpRight size={14} />
          </a>
        </div>
      </Card>
    </>
  );
}
