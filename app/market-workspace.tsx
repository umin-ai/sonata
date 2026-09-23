"use client";
import {valueTone} from '@/lib/value-tone';
import { TokenMarketPanel } from "./token-market-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Choice } from "./stockroom-ui";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { LineChart, Line, CartesianGrid, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useState, useEffect, type ReactNode } from "react";
import Link from "@/app/plain-link";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronRight,
  Layers3,
  LockKeyhole,
  RefreshCw,
  Search,
  Activity,
  Info,
  Plus,
  FlaskConical,
  ShieldCheck,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useDemo, money } from "./vault-state";
import {
  marketVaults,
  pairName,
  availableCapital,
  lockedCapital,
  recipients,
  type Vault,
  type Entry,
  type Action,
  type Demo,
} from "@/lib/vaults/demo";
import { forecast } from "@/lib/vaults/forecast";
const sum = (p: Demo["positions"], field: "capital" | "earned" | "rewards") =>
  Object.values(p).reduce((a, v) => a + v[field], 0);
const blank = { capital: 0, rewards: 0, earned: 0 };
const shortMoney = (c: number) =>
  c >= 100000000
    ? `$${(c / 100000000).toFixed(2)}M`
    : c >= 100000
      ? `$${(c / 100000).toFixed(1)}K`
      : money(c);
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sr-detail-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
function Token({ v, size = 40 }: { v: Vault; size?: number }) {
  return (
    <span className="sr-token" style={{ width: size, height: size }}>
      {v.id === "room" ? (
        <span className="sr-room-token">R</span>
      ) : (
        <img
          src={`/token-logos/${v.ticker}.png`}
          width={size}
          height={size}
          alt=""
        />
      )}
      <span className="sr-usdc">
        {v.quote === "USDC" ? "$" : v.quote.slice(0, 1)}
      </span>
    </span>
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
        <span className="sr-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Metrics({ items }: { items: [string, string, string][] }) {
  return (
    <div className="sr-stats">
      {items.map(([label, value, note]) => (
        <Card key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{note}</small>
        </Card>
      ))}
    </div>
  );
}
function useReview(onComplete?: (action: Action) => void) {
  const { act } = useDemo();
  const [pending, setPending] = useState<{
    action: Action;
    title: string;
    note: string;
  } | null>(null);
  const [error, setError] = useState("");
  const run = (action: Action) => {
    try {
      act(action);
      setError("");
      onComplete?.(action);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const review = (action: Action, title: string, note: string) => {
    setError("");
    setPending({ action, title, note });
  };
  const feedback = (
    <>
      {error && (
        <p role="alert" className="sr-warning">
          {error}
        </p>
      )}
      <Dialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <DialogContent className="sr-modal">
          <DialogTitle>{pending?.title}</DialogTitle>
          <DialogDescription>
            Local simulation · no assets move on Solana
          </DialogDescription>
          <p>{pending?.note}</p>
          <Button
            className="sr-primary"
            onClick={() => {
              if (pending && run(pending.action)) setPending(null);
            }}
            variant="default"
          >
            Confirm simulation
          </Button>
          {error && (
            <p role="alert" className="sr-warning">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
  return { run, review, feedback };
}
function Journey({
  v,
  onNavigate,
}: {
  v: Vault;
  onNavigate?: (href: string) => void;
}) {
  const { state } = useDemo(),
    m = state.markets[v.id],
    p = state.positions[v.id] ?? blank;
  const steps =
    v.id === "room"
      ? [
          {
            name: "Create market",
            detail:
              m.status === "active" ? "Seed funded" : "Choose pair & terms",
            done: m.status === "active",
            href: "/lab/create",
          },
          {
            name: "Earn fees",
            detail: money(state.fees.creator) + " creator income",
            done: state.fees.creator > 0,
            href: "/vaults/room#earn",
          },
          {
            name: "Allocate revenue",
            detail:
              money(state.treasury + sum(state.treasuryPositions, "capital")) +
              " in treasury",
            done: state.entries.some((e) => e.type === "Allocate revenue"),
            href: "/lab/community#allocation",
          },
          {
            name: "Fund rewards",
            detail:
              money(
                state.community +
                  Object.values(state.claimable).reduce((a, b) => a + b, 0),
              ) + " reserved / due",
            done: state.entries.some((e) => e.type === "Publish rewards"),
            href: "/lab/community#rewards",
          },
        ]
      : [
          {
            name: "Choose strategy",
            detail: pairName(v),
            done: true,
            href: `/vaults/${v.id}#terms`,
          },
          {
            name: "Fund position",
            detail: money(p.capital) + " invested",
            done: p.capital > 0,
            href: `/vaults/${v.id}#position`,
          },
          {
            name: "Earn & reinvest",
            detail: money(p.earned) + " lifetime fees",
            done: p.earned > 0,
            href: `/vaults/${v.id}#earn`,
          },
          {
            name: "Review & exit",
            detail: money(availableCapital(state, v.id)) + " unlocked",
            done: state.entries.some(
              (e) => e.marketId === v.id && e.type === "Withdraw",
            ),
            href: `/vaults/${v.id}#position`,
          },
        ];
  return (
    <nav className="sr-journey" aria-label={`${v.ticker} lifecycle`}>
      {steps.map((s, i) => (
        <Link
          key={s.name}
          href={s.href}
          onClick={() => onNavigate?.(s.href)}
          className={s.done ? "complete" : ""}
        >
          <span className="sr-step-number">
            {s.done ? <Check size={14} /> : String(i + 1).padStart(2, "0")}
          </span>
          <span>
            <b>{s.name}</b>
            <small>{s.detail}</small>
          </span>
          <ChevronRight size={14} />
        </Link>
      ))}
    </nav>
  );
}
function NextAction({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link className="sr-next-action" href={href}>
      <span>
        <span className="sr-eyebrow">CONTINUE YOUR JOURNEY</span>
        <b>{title}</b>
        <small>{description}</small>
      </span>
      <ArrowRight size={22} />
    </Link>
  );
}
export function MarketDirectory() {
  const { state } = useDemo();
  const [filter, setFilter] = useState("All markets"),
    [query, setQuery] = useState("");
  const all = marketVaults(state);
  const list = all.filter(
    (v) =>
      (filter === "All markets" || v.category === filter) &&
      `${v.name} ${pairName(v)}`.toLowerCase().includes(query.toLowerCase()),
  );
  const capital =
    sum(state.positions, "capital") + sum(state.treasuryPositions, "capital");
  const started = all.find((v) => (state.positions[v.id]?.capital ?? 0) > 0);
  return (
    <>
      <Heading
        eyebrow="MARKETS / STOCK LIQUIDITY"
        title="Put your capital to work."
        description="Choose a stock market. Earn from trading activity. Decide where the income goes."
        action={
          <Button asChild>
            <Link href="/lab/create">
              <Plus />
              Create market
            </Link>
          </Button>
        }
      />
      <Metrics
        items={[
          [
            "Your invested capital",
            money(sum(state.positions, "capital")),
            "Personal positions",
          ],
          [
            "Managed capital",
            money(capital),
            "Personal + treasury · counted once",
          ],
          [
            "LP fees earned",
            money(
              sum(state.positions, "earned") +
                sum(state.treasuryPositions, "earned"),
            ),
            "Cumulative simulated income",
          ],
        ]}
      />
      <NextAction
        href="/onchain"
        title="Trade and follow the fees on Devnet"
        description="Buy or sell in the live test pool, collect the resulting stock-token fees, then split them between a fixed recipient and the creator reserve."
      />
      <Card className="sx-table-card">
        <Tabs value={filter} onValueChange={setFilter}>
          <div className="sx-table-toolbar">
            <TabsList aria-label="Market category">
              {["All markets", "Index", "Technology", "Community"].map((f) => (
                <TabsTrigger key={f} value={f}>
                  {f === "All markets" ? "All" : f}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="sx-search">
              <Search />
              <Input
                aria-label="Search markets"
                placeholder="Search an asset or pair"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {["All markets", "Index", "Technology", "Community"].map(
            (category) => (
              <TabsContent key={category} value={category} className="m-0">
                <Table className="sx-market-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market / strategy</TableHead>
                      <TableHead>Model liquidity</TableHead>
                      <TableHead>Your position</TableHead>
                      <TableHead>Claimable fees</TableHead>
                      <TableHead>Reinvestment</TableHead>
                      <TableHead>
                        <span className="sr-only">Open market</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((v) => {
                      const m = state.markets[v.id],
                        p = state.positions[v.id] ?? blank;
                      return (
                        <TableRow key={v.id}>
                          <TableCell>
                            <Link
                              className="sx-market-name"
                              href={
                                m.status === "draft"
                                  ? "/lab/create"
                                  : `/vaults/${v.id}`
                              }
                            >
                              <Token v={v} />
                              <span>
                                <strong>{pairName(v)}</strong>
                                <small>
                                  {v.name} · {v.risk}
                                </small>
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell>
                            {m.status === "draft" ? (
                              <Badge variant="outline">Awaiting seed</Badge>
                            ) : (
                              shortMoney(
                                m.externalCapital +
                                  p.capital +
                                  (state.treasuryPositions[v.id]?.capital ?? 0),
                              )
                            )}
                          </TableCell>
                          <TableCell>{money(p.capital)}</TableCell>
                          <TableCell className="text-primary">
                            {money(p.rewards)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {m.compoundPercent
                                ? `${m.compoundPercent}% on trade`
                                : "On request"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button
                              asChild
                              variant="ghost"
                              size="icon"
                              aria-label={`Open ${pairName(v)}`}
                            >
                              <Link
                                href={
                                  m.status === "draft"
                                    ? "/lab/create"
                                    : `/vaults/${v.id}`
                                }
                              >
                                <ArrowUpRight />
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {!list.length && (
                  <Empty>
                    <Search />
                    <h3>No matching markets</h3>
                    <p>Try another asset or category.</p>
                  </Empty>
                )}
              </TabsContent>
            ),
          )}
        </Tabs>
        <div className="px-5 py-4 border-t text-xs text-muted-foreground">
          Fixed-price simulation · 0.30% example LP fee · no measured live APR
          or APY
        </div>
      </Card>
      <NextAction
        href={started ? `/vaults/${started.id}#earn` : "/vaults/spy"}
        title={
          started
            ? `Continue with ${pairName(started)}`
            : "Open your first position"
        }
        description={
          started
            ? `${money(state.positions[started.id].rewards)} in fees is ready to claim or reinvest.`
            : "Use your demo wallet to follow a complete deposit, earnings and withdrawal cycle."
        }
      />
      <Card className="sx-feature-banner">
        <div>
          <Badge variant="outline" className="mb-3">
            CREATOR → TREASURY → MEMBERS
          </Badge>
          <h3>A market that gives back.</h3>
          <p>
            Creator-owned fees can fund treasury positions and member rewards.
            Follow each payout back to its source.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/lab/community">
            Open community <ArrowRight />
          </Link>
        </Button>
      </Card>
    </>
  );
}
export function LaunchMarket() {
  const { state, ready } = useDemo(),
    { review, feedback } = useReview();
  const [quote, setQuote] = useState("NVDAx"),
    [amount, setAmount] = useState("1000"),
    [days, setDays] = useState(7),
    [compound, setCompound] = useState(50);
  const v = marketVaults(state).find((v) => v.id === "room")!,
    m = state.markets.room,
    seed = Math.round(Number(amount) * 100);
  if (m.status === "active")
    return (
      <>
        <Heading
          eyebrow="YOUR COMMUNITY MARKET"
          title="One market. All the connections."
          description={`${pairName(v)} is active in your local simulation. Its creation terms follow the position everywhere.`}
        />
        <Journey v={v} />
        <Card className="sr-panel">
          <div className="sr-section-top">
            <div className="sr-pair-title">
              <Token v={v} />
              <h2>{pairName(v)}</h2>
            </div>
            <Badge className="sr-chip">Local market active</Badge>
          </div>
          <Row label="Creator seed">{money(m.seed)}</Row>
          <Row label="Seed release">
            {m.lockUntilDay > state.day
              ? `Demo day ${m.lockUntilDay}`
              : "Unlocked"}
          </Row>
          <Row label="Reinvest / claimable">
            {m.compoundPercent}% / {100 - m.compoundPercent}%
          </Row>
          <p className="sr-note">
            Terms are fixed for this simulated market. Migrated older sessions
            retain their existing fixture pool. No mint, DBC curve or onchain
            pool was created.
          </p>
        </Card>
        <NextAction
          href="/vaults/room"
          title="Open your market"
          description="Simulate trading, inspect fee ownership and follow creator revenue into the treasury."
        />
      </>
    );
  return (
    <>
      <Link className="sr-back" href="/lab">
        ← All markets
      </Link>
      <Heading
        eyebrow="CREATE / COMMUNITY × STOCKS"
        title="Give your community a market."
        description="Choose a stock quote, fund the initial liquidity and define where LP earnings go."
      />
      <Journey v={v} />
      <div className="sr-launch-grid">
        <Card className="sr-panel">
          <span className="sr-eyebrow">01 / THE PAIR</span>
          <h3>ROOM × your chosen stock</h3>
          <p className="sr-note">
            ROOM is a fictional community token. Pairing it with a stock does
            not give it equity backing.
          </p>
          <Label className="sr-field">
            Stock quote asset
            <Choice
              value={quote}
              onValueChange={(value) => setQuote(value)}
              label="Stock quote asset"
            >
              {marketVaults(state)
                .filter((v) => v.id !== "room")
                .map((v) => (
                  <option key={v.id}>{v.ticker}</option>
                ))}
            </Choice>
          </Label>
          <Label className="sr-field">
            Seed liquidity · demo USD
            <Input
              type="number"
              min="100"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Label>
          <Row label="From your demo wallet">{money(state.cash)} available</Row>
          <Row label="Initial inventory">50% ROOM / 50% {quote}</Row>
          <p className="sr-note">
            This model converts demo USD at fixed prices. It does not simulate
            the acquisition of either token.
          </p>
          <span className="sr-eyebrow">02 / FEE DESTINATIONS</span>
          <Label className="sr-field">
            Reinvest net LP fees
            <Choice
              value={compound}
              onValueChange={(value) => setCompound(Number(value))}
              label="Reinvest net LP fees"
            >
              <option value={0}>0% · all fees claimable</option>
              <option value={50}>50% · split growth and income</option>
              <option value={100}>100% · all fees reinvested</option>
            </Choice>
          </Label>
          <p className="sr-note">
            Applies to every managed LP position in this pool. Reinvestment
            happens only when you simulate trading.
          </p>
          <span className="sr-eyebrow">03 / CREATOR COMMITMENT</span>
          <Label className="sr-field">
            Lock initial seed liquidity
            <Choice
              value={days}
              onValueChange={(value) => setDays(Number(value))}
              label="Lock initial seed liquidity"
            >
              <option value={0}>No lock</option>
              <option value={7}>7 demo days</option>
              <option value={30}>30 demo days</option>
            </Choice>
          </Label>
          <p className="sr-note">
            Only your initial seed is locked. New deposits and claimable fees
            stay available. Locking adds no yield boost.
          </p>
        </Card>
        <Card className="sr-panel sr-launch-preview">
          <Badge className="sr-chip">REVIEW YOUR MARKET</Badge>
          <div className="sr-launch-pair">
            <span className="sr-room-token">R</span>
            <span>×</span>
            <img
              src={`/token-logos/${quote}.png`}
              alt={quote}
              width="56"
              height="56"
            />
          </div>
          <h2>ROOM / {quote}</h2>
          <p>
            A creator-led market.
            <br />
            Explicit capital ownership.
          </p>
          <Row label="Your seed position">
            {money(Number.isFinite(seed) ? seed : 0)}
          </Row>
          <Row label="Trader pays · example">0.30% LP + 0.10% creator</Row>
          <Row label="Protocol fee">10% of managed LP fees</Row>
          <Row label="Net LP fee split">
            {compound}% reinvest / {100 - compound}% claim
          </Row>
          <Row label="Seed lock ends">
            {days ? `Demo day ${state.day + days}` : "Immediately unlocked"}
          </Row>
          <Row label="Creator revenue starts at">
            $0.00 · earned from activity
          </Row>
          {feedback}
          <Button
            className="sr-primary sr-full"
            disabled={
              !ready ||
              !Number.isSafeInteger(seed) ||
              seed < 10000 ||
              seed > state.cash
            }
            onClick={() =>
              review(
                {
                  type: "launch",
                  vault: "room",
                  quote,
                  amount: seed,
                  lockDays: days,
                  compoundPercent: compound,
                },
                "Create and fund demo market",
                `${money(seed)} leaves your demo wallet and becomes your ROOM / ${quote} LP position. ${days ? `The seed cannot be withdrawn until demo day ${state.day + days}.` : "No seed lock."} ${compound}% of net LP income reinvests; the remainder is claimable. Creator fees are separate. Terms cannot be edited after creation in this model.`,
              )
            }
            variant="default"
          >
            Review market creation <ArrowRight size={16} />
          </Button>
          <div className="sr-guard">
            <FlaskConical size={20} />
            <p>
              Local pool model. No token mint, bonding curve or DBC migration is
              executed. The Meteora launch integration remains ahead.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
function ReturnForecast({ v }: { v: Vault }) {
  const { state } = useDemo();
  const m = state.markets[v.id];
  const [amount, setAmount] = useState("1000"),
    [volume, setVolume] = useState(
      String(
        Math.max(
          100,
          Math.round(
            ((m.externalCapital +
              (state.positions[v.id]?.capital ?? 100000) +
              (state.treasuryPositions[v.id]?.capital ?? 0)) /
              100) *
              0.05,
          ),
        ),
      ),
    ),
    [days, setDays] = useState(30),
    [reinvest, setReinvest] = useState(m.compoundPercent),
    [cost, setCost] = useState("0.10");
  const capital = Math.round(Number(amount) * 100),
    dailyVolume = Math.round(Number(volume) * 100),
    dailyCost = Math.round(Number(cost) * 100);
  const otherCapital =
    m.externalCapital + (state.treasuryPositions[v.id]?.capital ?? 0);
  const valid =
    [capital, dailyVolume, dailyCost].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) &&
    capital > 0 &&
    capital <= 100000000 &&
    dailyVolume <= 100000000;
  const scenarios = valid
    ? [0.5, 1, 1.5].map((scale) =>
        forecast({
          capital,
          otherCapital,
          dailyVolume: Math.round(dailyVolume * scale),
          days,
          compoundPercent: reinvest,
          dailyCost,
        }),
      )
    : [];
  const base = scenarios[1];
  return (
    <Card className="sr-panel" id="forecast">
      <div className="sr-section-top">
        <div>
          <span className="sr-eyebrow">PLAN / BEFORE YOU COMMIT</span>
          <h3>What could the fees earn?</h3>
          <p>Change the assumptions. See the calculation.</p>
        </div>
        <Badge className="sr-chip">Scenario · not a prediction</Badge>
      </div>
      <div className="sr-forecast-inputs">
        <Label className="sr-field">
          Starting position · USD
          <Input
            type="number"
            min="1"
            max="1000000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Label>
        <Label className="sr-field">
          Daily pool volume · USD
          <Input
            type="number"
            min="0"
            max="1000000"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
          />
        </Label>
        <Label className="sr-field">
          Period
          <Choice
            value={days}
            onValueChange={(value) => setDays(Number(value))}
            label="Period"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>365 days</option>
          </Choice>
        </Label>
        <Label className="sr-field">
          Reinvest net income
          <Choice
            value={reinvest}
            onValueChange={(value) => setReinvest(Number(value))}
            label="Reinvest net income"
          >
            <option value={0}>0%</option>
            <option value={50}>50%</option>
            <option value={100}>100%</option>
          </Choice>
        </Label>
        <Label className="sr-field">
          Daily position cost · USD
          <Input
            type="number"
            step="0.01"
            min="0"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Label>
      </div>
      {base ? (
        <>
          <div className="sr-forecast-results">
            {scenarios.map((s, i) => (
              <div key={i} className={i === 1 ? "base" : ""}>
                <span>
                  {
                    [
                      "Lower volume · 0.5×",
                      "Your assumptions · 1×",
                      "Higher volume · 1.5×",
                    ][i]
                  }
                </span>
                <strong className={valueTone(s.net)}>
                  {s.net >= 0 ? "+" : ""}
                  {money(s.net)}
                </strong>
                <small>Net fee result over {days} days</small>
              </div>
            ))}
          </div>
          <ChartContainer
            className="h-64 w-full"
            config={{
              lower: { label: "Lower volume", color: "var(--chart-2)" },
              base: { label: "Your assumptions", color: "var(--chart-1)" },
              higher: { label: "Higher volume", color: "var(--chart-3)" },
            }}
          >
            <LineChart
              accessibilityLayer
              data={Array.from({ length: days + 1 }, (_, day) => ({
                day,
                lower:
                  scenarios[0].points[
                    Math.min(day, scenarios[0].points.length - 1)
                  ].value - capital,
                base:
                  scenarios[1].points[
                    Math.min(day, scenarios[1].points.length - 1)
                  ].value - capital,
                higher:
                  scenarios[2].points[
                    Math.min(day, scenarios[2].points.length - 1)
                  ].value - capital,
              }))}
              margin={{ left: 0, right: 15, top: 10, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickFormatter={(day) => `Day ${day}`}
                minTickGap={35}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={65}
                tickFormatter={(value) => money(value)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => money(Number(value))}
                    labelFormatter={(label) => `Day ${label}`}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                dataKey="lower"
                type="monotone"
                stroke="var(--color-lower)"
                dot={false}
                strokeDasharray="4 4"
                isAnimationActive={false}
              />
              <Line
                dataKey="base"
                type="monotone"
                stroke="var(--color-base)"
                dot={false}
                strokeWidth={2.5}
                isAnimationActive={false}
              />
              <Line
                dataKey="higher"
                type="monotone"
                stroke="var(--color-higher)"
                dot={false}
                strokeDasharray="4 4"
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
          <div className="sr-forecast-breakdown">
            <Row label="Gross LP fees">{money(base.gross)}</Row>
            <Row label="Protocol fee / execution costs">
              {money(base.protocol)} / {money(base.cost)}
            </Row>
            <Row label="Ending position / income held aside">
              {money(base.position)} / {money(base.claimable)}
            </Row>
            <Row label="Period return on initial capital">
              <span className={valueTone(base.net)}>{base.net>0?"+":""}{((base.net / capital) * 100).toFixed(2)}%</span>
            </Row>
            <Row label="Other liquidity · held constant">
              {money(otherCapital)}
            </Row>
          </div>
        </>
      ) : (
        <p className="sr-warning" role="alert">
          Enter a positive position and valid volume and cost amounts, up to
          $1,000,000 each.
        </p>
      )}
      <p className="sr-note">
        Full-range, fixed-price scenario: 0.30% LP fee × your capital share,
        less 10% protocol fee and the daily cost above. Reinvestment is modeled
        daily. No token emissions, price movement, slippage or impermanent loss.
        Costs can exceed fees. Changing these assumptions does not change the
        pool’s configured reinvestment policy. There is no measured live APR or
        APY.
      </p>
    </Card>
  );
}
export function MarketDetail({ id }: { id: string }) {
  const { state } = useDemo();
  const v = marketVaults(state).find((v) => v.id === id);
  if (!v)
    return (
      <Empty className="sr-empty">
        <h2>Market not found</h2>
        <Link href="/lab">All markets</Link>
      </Empty>
    );
  if (state.markets[id].status === "draft")
    return (
      <>
        <Heading
          eyebrow="COMMUNITY MARKET"
          title="This market starts with you."
          description="Choose the quote asset, commit seed liquidity and define its fee policy."
        />
        <Journey v={v} />
        <NextAction
          href="/lab/create"
          title="Create the ROOM market"
          description="No capital or revenue exists for this market until you fund it."
        />
      </>
    );
  return <MarketInner key={id} v={v} />;
}
function MarketInner({ v }: { v: Vault }) {
  const { state, ready } = useDemo();
  const [section, setSection] = useState("Overview"),
    [mode, setMode] = useState<"deposit" | "withdraw">("deposit"),
    [amount, setAmount] = useState("1000"),
    [volume, setVolume] = useState("10000");
  const { run, review, feedback } = useReview((action) => {
    if (action.type === "deposit" || action.type === "withdraw") setAmount("");
  });
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      if (hash === "#terms") setSection("Terms");
      else if (hash === "#forecast") setSection("Forecast");
      else if (hash === "#earn") setSection("Overview");
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const m = state.markets[v.id],
    p = state.positions[v.id] ?? blank,
    t = state.treasuryPositions[v.id] ?? blank,
    f = state.marketFees[v.id];
  const stale = !!state.staleMarkets[v.id],
    unlocked = availableCapital(state, v.id),
    locked = lockedCapital(state, v.id);
  const cents = Math.round(Number(amount) * 100),
    trade = Math.round(Number(volume) * 100),
    available = mode === "deposit" ? state.cash : unlocked;
  const valid =
    ready &&
    Number.isSafeInteger(cents) &&
    cents > 0 &&
    cents <= available &&
    !(stale && mode === "deposit");
  return (
    <>
      <Link className="sr-back" href="/lab">
        ← All markets
      </Link>
      <div className="sr-vault-heading">
        <Token v={v} size={56} />
        <div>
          <span className="sr-eyebrow">
            SONATA /{" "}
            {v.id === "room" ? "COMMUNITY MARKET" : "STOCK LIQUIDITY"}
          </span>
          <h1>{pairName(v)}</h1>
          <p>{v.name} · fixed-price simulation</p>
        </div>
        <Badge className="sr-chip">{v.risk} risk</Badge>
      </div>
      <Journey
        v={v}
        onNavigate={(href) => {
          if (href.endsWith("#terms")) setSection("Terms");
          if (href.endsWith("#earn")) setSection("Overview");
        }}
      />
      <TokenMarketPanel id={v.id} />
      <div className="sr-detail-layout">
        <div>
          <Metrics
            items={[
              [
                "Managed capital",
                money(p.capital + t.capital),
                "Personal + treasury",
              ],
              [
                "Your net LP earnings",
                money(p.earned),
                "Lifetime simulated fees",
              ],
              [
                "Market volume",
                shortMoney(state.marketVolume[v.id] ?? 0),
                "Only your simulated trades",
              ],
            ]}
          />
          <Tabs
            value={section}
            onValueChange={setSection}
            className="sr-detail-tabs"
          >
            <TabsList aria-label="Market sections">
              {["Overview", "Forecast", "Terms", "Receipts"].map((label) => (
                <TabsTrigger key={label} value={label}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="Overview">
              <Card className="sr-panel" id="earn">
                <div className="sr-section-top">
                  <div>
                    <span className="sr-eyebrow">THE EARNING ENGINE</span>
                    <h3>One trade. Clear destinations.</h3>
                    <p>Simulate activity and follow the fees it creates.</p>
                  </div>
                  <Activity size={22} />
                </div>
                <div className="sr-fee-river">
                  <div>
                    <span>Traders pay</span>
                    <strong>0.30%</strong>
                    <small>LP fee on swap volume</small>
                  </div>
                  <ArrowRight size={18} />
                  <div>
                    <span>Managed LP income</span>
                    <strong>90 / 10</strong>
                    <small>LPs / protocol fee</small>
                  </div>
                  <ArrowRight size={18} />
                  <div>
                    <span>Your net fee split</span>
                    <strong>
                      {m.compoundPercent} / {100 - m.compoundPercent}
                    </strong>
                    <small>Reinvested / claimable</small>
                  </div>
                </div>
                <Row label="Your claimable LP fees">{money(p.rewards)}</Row>
                <Row label="Treasury claimable LP fees">{money(t.rewards)}</Row>
                {v.id === "room" && (
                  <Row label="Separate creator fee">0.10% of volume</Row>
                )}
                <div className="sr-trade-control">
                  <Label className="sr-field">
                    Simulated trade volume · USD
                    <Input
                      type="number"
                      min="100"
                      max="1000000"
                      value={volume}
                      onChange={(e) => setVolume(e.target.value)}
                    />
                  </Label>
                  <Button
                    className="sr-secondary"
                    disabled={
                      !ready ||
                      stale ||
                      p.capital + t.capital <= 0 ||
                      !Number.isSafeInteger(trade) ||
                      trade < 10000 ||
                      trade > 100000000
                    }
                    onClick={() =>
                      run({ type: "trade", vault: v.id, amount: trade })
                    }
                    variant="outline"
                  >
                    <FlaskConical size={16} /> Simulate trade
                  </Button>
                </div>
                {p.capital + t.capital <= 0 && (
                  <p className="sr-note">
                    Fund a position first. Trading cannot generate income for an
                    empty position.
                  </p>
                )}
                <div className="sr-actions">
                  <Button
                    className="sr-primary"
                    disabled={!ready || stale || p.rewards <= 0}
                    onClick={() =>
                      review(
                        { type: "compound", vault: v.id },
                        "Reinvest your claimable fees",
                        `${money(p.rewards)} moves from your claimable income into this LP position. It cannot also be paid out as a reward.`,
                      )
                    }
                    variant="default"
                  >
                    <RefreshCw size={15} /> Reinvest fees
                  </Button>
                  <Button
                    className="sr-secondary"
                    disabled={!ready || p.rewards <= 0}
                    onClick={() =>
                      review(
                        { type: "claim", vault: v.id },
                        "Receive LP income",
                        `${money(p.rewards)} moves to your demo wallet. Your invested capital stays in the market.`,
                      )
                    }
                    variant="outline"
                  >
                    Claim to wallet
                  </Button>
                </div>
                <p className="sr-note">
                  Trade activity is manually simulated. No background keeper,
                  time-based income or real market volume is generated.
                </p>
              </Card>
              {f && (
                <Card className="sr-panel">
                  <span className="sr-eyebrow">
                    THIS MARKET / CUMULATIVE FEES
                  </span>
                  <h3>Follow every cent.</h3>
                  <Row label="Total trader-paid LP fees">{money(f.pool)}</Row>
                  <Row label="Personal LP / treasury LP earnings">
                    {money(f.investor)} / {money(f.treasury)}
                  </Row>
                  <Row label="External LP / protocol">
                    {money(f.externalLP)} / {money(f.protocol)}
                  </Row>
                  <Row label="Reinvested automatically on trade">
                    {money(f.reinvested)}
                  </Row>
                  {v.id === "room" && (
                    <Row label="Additional creator revenue">
                      {money(f.creator)}
                    </Row>
                  )}
                  <p className="sr-note">
                    Automatic reinvestment is included in LP earnings above, not
                    counted twice. Later manual reinvestments appear in
                    receipts.
                  </p>
                </Card>
              )}
              {v.id === "room" ? (
                <NextAction
                  href="/lab/community#allocation"
                  title={
                    state.creatorCash > 0
                      ? `Allocate ${money(state.creatorCash)} of creator revenue`
                      : "Open the community treasury"
                  }
                  description="Creator-owned income can fund treasury positions, operations and member rewards."
                />
              ) : (
                <NextAction
                  href="/lab/portfolio"
                  title="See this position in your portfolio"
                  description="Capital and claimable fees stay connected across every view."
                />
              )}
            </TabsContent>
            <TabsContent value="Forecast">
              <ReturnForecast v={v} />
            </TabsContent>
            <TabsContent value="Terms">
              <Card className="sr-panel sr-prose" id="terms">
                <h3>The mandate behind your position</h3>
                <p>
                  {v.id === "room"
                    ? `A fictional ROOM / ${v.quote} liquidity position. Both assets can fall; ROOM is not stock-backed and does not grant rights to the treasury.`
                    : v.description}
                </p>
                <Row label="Position ownership">
                  Personal and treasury accounts are separate
                </Row>
                <Row label="Net LP fee reinvestment">
                  {m.compoundPercent}% on simulated trade
                </Row>
                <Row label="Remaining LP income">
                  {100 - m.compoundPercent}% claimable
                </Row>
                <Row label="External fixture liquidity">
                  {money(m.externalCapital)}
                </Row>
                <Row label="Exit asset in this model">
                  Demo USD at fixed prices
                </Row>
                <h4>LP exposure changes with trading</h4>
                <p>
                  A real liquidity position can underperform holding its initial
                  assets. This ledger does not model price movements, corporate
                  actions, trading inventory, slippage or mint restrictions. It
                  does not issue onchain shares.
                </p>
                <h4>Creator lock ≠ depositor lock</h4>
                <p>
                  The creator seed can be time-locked. Later deposits are not
                  locked by that commitment. There is no extra APY for a longer
                  lock.
                </p>
                <div className="sr-guard">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>Price freshness scenario</strong>
                    <p>
                      Stale prices block new deposits, compounding and simulated
                      trades. Fixed-price exits and claims remain available.
                    </p>
                  </div>
                  <Button
                    className="sr-secondary"
                    disabled={!ready}
                    onClick={() => run({ type: "price", vault: v.id })}
                    variant="outline"
                  >
                    {stale ? "Restore demo price" : "Simulate stale price"}
                  </Button>
                </div>
              </Card>
            </TabsContent>
            <TabsContent value="Receipts">
              <Card className="sr-panel">
                <h3>Market receipts</h3>
                <FlowReceipts marketId={v.id} />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
        <aside>
          <Card className="sr-deposit-panel" id="position">
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as "deposit" | "withdraw");
                setAmount(
                  value === "deposit" ? "1000" : (unlocked / 100).toFixed(2),
                );
              }}
            >
              <TabsList className="w-full" aria-label="Position action">
                <TabsTrigger value="deposit">Deposit</TabsTrigger>
                <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
              </TabsList>
              <TabsContent value={mode} className="space-y-4">
                <h3>
                  {mode === "deposit"
                    ? "Your position starts here."
                    : "Bring capital home."}
                </h3>
                <div className="sr-amount-box">
                  <Label htmlFor="market-amount">
                    {mode === "deposit" ? "Deposit amount" : "Withdraw amount"}
                  </Label>
                  <div>
                    <Input
                      id="market-amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <b>USD</b>
                  </div>
                  <div className="sr-balance">
                    <span>{money(available)} available</span>
                    <Button
                      onClick={() => setAmount((available / 100).toFixed(2))}
                      variant="ghost"
                    >
                      MAX
                    </Button>
                  </div>
                </div>
                <Row label="Invested capital">{money(p.capital)}</Row>
                <Row label="Unlocked capital">{money(unlocked)}</Row>
                <Row label="Claimable fees">{money(p.rewards)}</Row>
                <Row label="After this action">
                  {money(
                    p.capital +
                      (Number.isSafeInteger(cents)
                        ? mode === "deposit"
                          ? cents
                          : -Math.min(cents, available)
                        : 0),
                  )}
                </Row>
                <p className="sr-note">
                  {mode === "deposit"
                    ? `Initial allocation: 50% ${v.ticker}, 50% ${v.quote} by value. Fixed-price demo conversion; zero modeled execution cost.`
                    : "Capital returns to demo USD. Unclaimed fees remain separately available."}
                </p>
                {stale && (
                  <p className="sr-warning">
                    Price scenario is stale. New deposits and reinvestment are
                    paused.
                  </p>
                )}
                {cents > available && (
                  <p className="sr-warning">
                    Amount exceeds available{" "}
                    {mode === "withdraw" ? "unlocked capital" : "cash"}.
                  </p>
                )}
                <Button
                  className="sr-primary sr-full"
                  disabled={!valid}
                  onClick={() =>
                    review(
                      { type: mode, vault: v.id, amount: cents },
                      `Review ${mode}`,
                      `${money(cents)} ${mode === "deposit" ? `moves from your wallet into ${pairName(v)} liquidity. It earns the position's share of trading income, with ${m.compoundPercent}% reinvested on each simulated trade.` : "of unlocked capital returns to your demo wallet at fixed prices."} No real assets move.`,
                    )
                  }
                  variant="default"
                >
                  Review {mode} <ArrowRight size={15} />
                </Button>
                {feedback}
              </TabsContent>
            </Tabs>
          </Card>
          {v.id === "room" && (
            <Card className="sr-panel sr-lock-panel">
              <div className="sr-section-top">
                <h3>
                  <LockKeyhole size={17} /> Creator commitment
                </h3>
                <Badge className="sr-chip">Day {state.day}</Badge>
              </div>
              <Row label="Seed still locked">{money(locked)}</Row>
              <Row label="Release">
                {m.lockUntilDay > state.day
                  ? `Day ${m.lockUntilDay} · ${m.lockUntilDay - state.day} days left`
                  : "Unlocked"}
              </Row>
              <Progress
                aria-label="Creator seed lock elapsed"
                value={
                  m.lockUntilDay
                    ? Math.min(100, (state.day / m.lockUntilDay) * 100)
                    : 100
                }
              />
              <p className="sr-note">
                Only the initial creator seed is restricted. Advancing the demo
                clock releases it when due; it produces no income.
              </p>
              <Button
                className="sr-secondary sr-full"
                disabled={!ready || state.day >= 365}
                onClick={() =>
                  run({
                    type: "advanceDay",
                    amount: Math.min(7, 365 - state.day),
                  })
                }
                variant="outline"
              >
                Advance 7 demo days
              </Button>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
export function FlowReceipts({
  marketId,
  communityOnly = false,
  limit,
}: {
  marketId?: string;
  communityOnly?: boolean;
  limit?: number;
}) {
  const { state } = useDemo();
  const [selected, setSelected] = useState<Entry | null>(null);
  const matching = state.entries.filter(
    (e) =>
      (!marketId ||
        e.marketId === marketId ||
        (!e.marketId &&
          e.vault ===
            marketVaults(state).find((v) => v.id === marketId)?.ticker)) &&
      (!communityOnly ||
        e.owner === "treasury" ||
        !e.marketId ||
        e.marketId === "room"),
  );
  const entries = limit ? matching.slice(0, limit) : matching;
  return (
    <>
      {!entries.length ? (
        <Empty className="sr-empty">
          <Activity />
          <h3>Your next action leaves a receipt.</h3>
          <p>
            Funding, earnings and payouts appear here with the balances they
            change.
          </p>
        </Empty>
      ) : (
        <Table className="sx-receipt-table">
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Account / market</TableHead>
              <TableHead>Recorded</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>
                <span className="sr-only">Inspect receipt</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => (
              <TableRow key={`${entry.id}-${index}`}>
                <TableCell>
                  <Button
                    variant="ghost"
                    className="justify-start px-0"
                    onClick={() => setSelected(entry)}
                  >
                    {entry.type}
                  </Button>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.vault}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {entry.day === undefined
                    ? "Earlier session"
                    : `Day ${entry.day}`}{" "}
                  ·{" "}
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {money(entry.amount)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Inspect ${entry.type} receipt ${index + 1}`}
                    onClick={() => setSelected(entry)}
                  >
                    <ArrowUpRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="sx-receipt-sheet">
          <SheetHeader>
            <SheetTitle>{selected?.type}</SheetTitle>
            <SheetDescription>
              Local receipt · no onchain transaction
            </SheetDescription>
          </SheetHeader>
          <div className="sr-modal-number">{money(selected?.amount ?? 0)}</div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {selected?.note}
          </p>
          {selected?.movements?.length ? (
            <>
              <h4>Balances changed</h4>
              <div className="sr-receipt-movements">
                {selected.movements.map((m) => (
                  <div key={m.account}>
                    <span>{m.account}</span>
                    <small>
                      {money(m.before)} → {money(m.after)}
                    </small>
                    <b
                      className={valueTone(m.after-m.before)}
                    >
                      {m.after >= m.before ? "+" : ""}
                      {money(m.after - m.before)}
                    </b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Alert>
              <Info />
              <AlertDescription>
                {selected?.movements
                  ? "No money moved in this action."
                  : "Older receipt: detailed balance movements were not recorded."}
              </AlertDescription>
            </Alert>
          )}
          {!!selected?.sources?.length && (
            <>
              <h4>Funding references</h4>
              <div className="sr-receipt-sources">
                {selected.sources.map((id) => {
                  const source = state.entries.find((e) => e.id === id);
                  return source ? (
                    <Button
                      key={id}
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(source)}
                    >
                      {source.type} · {source.vault}
                      <ArrowUpRight />
                    </Button>
                  ) : null;
                })}
              </div>
            </>
          )}
          {selected?.marketId && (
            <Button asChild variant="outline">
              <Link
                href={`/vaults/${selected.marketId}`}
                onClick={() => setSelected(null)}
              >
                Open source market <ArrowUpRight />
              </Link>
            </Button>
          )}
          <p className="sr-receipt-id">Reference: {selected?.id}</p>
        </SheetContent>
      </Sheet>
    </>
  );
}
export function CapitalActivity() {
  return (
    <>
      <Heading
        eyebrow="CAPITAL / AUDIT TRAIL"
        title="Every move, connected."
        description="Inspect balance changes. Trace allocations back to the activity that funded them."
      />
      <Card className="sr-panel">
        <FlowReceipts />
      </Card>
    </>
  );
}
export function CapitalPortfolio() {
  const { state } = useDemo();
  const all = marketVaults(state),
    positions = all.filter(
      (v) =>
        (state.positions[v.id]?.capital ?? 0) > 0 ||
        (state.positions[v.id]?.rewards ?? 0) > 0,
    );
  return (
    <>
      <Heading
        eyebrow="YOUR CAPITAL"
        title="One view of what you own."
        description="Invested capital, available income and community payouts retain their own identities."
        action={
          <Button asChild variant="default">
            <Link className="sr-primary" href="/lab">
              Explore markets <ArrowUpRight size={16} />
            </Link>
          </Button>
        }
      />
      <Metrics
        items={[
          [
            "Invested capital",
            money(sum(state.positions, "capital")),
            "Including reinvested fees",
          ],
          [
            "Claimable LP income",
            money(sum(state.positions, "rewards")),
            "Belongs to your positions",
          ],
          [
            "Available wallet",
            money(state.cash),
            "Separate from creator treasury",
          ],
        ]}
      />
      {positions.length ? (
        <Card className="sx-table-card">
          <Table className="sx-market-table">
            <TableHeader>
              <TableRow>
                <TableHead>Your position</TableHead>
                <TableHead>Capital</TableHead>
                <TableHead>Claimable income</TableHead>
                <TableHead>Exit conditions</TableHead>
                <TableHead>
                  <span className="sr-only">Manage position</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((v) => {
                const p = state.positions[v.id];
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      <Link className="sx-market-name" href={`/vaults/${v.id}`}>
                        <Token v={v} />
                        <span>
                          <strong>{pairName(v)}</strong>
                          <small>Personal position</small>
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>{money(p.capital)}</TableCell>
                    <TableCell className="text-primary">
                      {money(p.rewards)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {lockedCapital(state, v.id)
                          ? `${money(lockedCapital(state, v.id))} seed locked`
                          : "Unlocked"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/vaults/${v.id}`}>
                          Manage
                          <ArrowUpRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <NextAction
          href="/vaults/spy"
          title="Make your first deposit"
          description="Use demo capital to follow a complete earning and withdrawal cycle."
        />
      )}

      <Card className="sr-panel">
        <div className="sr-section-top">
          <div>
            <span className="sr-eyebrow">YOUR COMMUNITY MEMBERSHIP</span>
            <h3>Rewards with a source.</h3>
            <p>
              These payouts come from a funded member allocation, separately
              from your LP income.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link className="sr-secondary" href="/lab/community#rewards">
              View rewards <ArrowRight size={15} />
            </Link>
          </Button>
        </div>
        <Row label="Member reward claimable">
          {money(state.claimable.you ?? 0)}
        </Row>
        <Row label="Member rewards already received">
          {money(state.paid.you ?? 0)}
        </Row>
      </Card>
      <Card className="sr-panel">
        <div className="sr-section-top">
          <h3>Your latest movements</h3>
          <Link className="sr-text-link" href="/lab/activity">
            All receipts <ArrowRight size={15} />
          </Link>
        </div>
        <FlowReceipts limit={6} />
      </Card>
    </>
  );
}
export function CommunityHub() {
  const { state, ready } = useDemo(),
    { run, review, feedback } = useReview();
  const [allocation, setAllocation] = useState(state.split),
    [market, setMarket] = useState("spy"),
    [amount, setAmount] = useState("100");
  const [appliedSplit, setAppliedSplit] = useState(state.split);
  if (appliedSplit !== state.split) {
    setAppliedSplit(state.split);
    setAllocation(state.split);
  }
  const markets = marketVaults(state),
    room = markets.find((v) => v.id === "room")!,
    selected = markets.find((v) => v.id === market)!;
  const invested = sum(state.treasuryPositions, "capital"),
    income = sum(state.treasuryPositions, "rewards"),
    due = Object.values(state.claimable).reduce((a, b) => a + b, 0),
    paid = Object.values(state.paid).reduce((a, b) => a + b, 0);
  const cents = Math.round(Number(amount) * 100),
    positions = markets.filter(
      (v) =>
        (state.treasuryPositions[v.id]?.capital ?? 0) > 0 ||
        (state.treasuryPositions[v.id]?.rewards ?? 0) > 0,
    );
  const next =
    state.markets.room.status === "draft"
      ? {
          href: "/lab/create",
          title: "Create the community market",
          description:
            "Pair ROOM with a stock and fund its first liquidity position.",
        }
      : state.creatorCash > 0
        ? {
            href: "#allocation",
            title: `Give ${money(state.creatorCash)} a destination`,
            description:
              "Allocate earned creator revenue into treasury cash, rewards and operations.",
          }
        : state.treasury > 0
          ? {
              href: "#treasury",
              title: "Put treasury cash to work",
              description: `${money(state.treasury)} is available for a separate treasury position.`,
            }
          : state.community > 0 || due > 0
            ? {
                href: "#rewards",
                title: "Bring the earnings back to members",
                description:
                  "Publish funded allocations, then claim your share.",
              }
            : {
                href: "/vaults/room#earn",
                title: "Generate the first creator revenue",
                description:
                  "Simulate trading in your community market, then follow its fees here.",
              };
  return (
    <>
      <Heading
        eyebrow="COMMUNITY / FOUNDERS COLLECTIVE"
        title="Activity becomes opportunity."
        description="Creator income funds a treasury. Its capital can earn. Funded rewards return to members."
        action={
          <Button asChild variant="outline">
            <Link
              className="sr-secondary"
              href={
                state.markets.room.status === "draft"
                  ? "/lab/create"
                  : "/vaults/room"
              }
            >
              <Token v={room} size={24} />
              {pairName(room)} <ArrowUpRight size={15} />
            </Link>
          </Button>
        }
      />
      <NextAction
        href="/onchain"
        title="Follow actual fees on Devnet"
        description="The deployed treasury collects Meteora fees, applies a fixed payout split and tracks retained stock for holders. The strategy controls below remain simulated."
      />
      <Journey v={room} />
      <Metrics
        items={[
          [
            "Creator income available",
            money(state.creatorCash),
            "Separate from personal LP fees",
          ],
          [
            "Treasury capital",
            money(state.treasury + invested),
            `${money(income)} claimable earnings separate`,
          ],
          [
            "Rewards reserved + due",
            money(state.community + due),
            `${money(paid)} already paid out`,
          ],
        ]}
      />
      <NextAction {...next} />
      {feedback}
      <div className="sr-community-layout">
        <Card className="sr-panel" id="allocation">
          <span className="sr-eyebrow">01 / ALLOCATE EARNED REVENUE</span>
          <h3>Give every dollar a destination.</h3>
          <p className="sr-note">
            Only creator-owned fees enter this policy. Personal LP income is
            never used.
          </p>
          <div className="sr-allocation-bar">
            <i style={{ width: `${allocation}%` }} />
            <i style={{ width: "20%" }} />
            <i style={{ width: `${80 - allocation}%` }} />
          </div>
          <Label className="sr-range-label" htmlFor="treasury-policy">
            Treasury share <strong>{allocation}%</strong>
          </Label>
          <Slider
            id="treasury-policy"
            thumbLabel="Treasury share"
            min={0}
            max={80}
            step={5}
            value={[allocation]}
            onValueChange={(values) => setAllocation(values[0])}
          />
          <Row label="Treasury / reserve / operations">
            {allocation}% / 20% / {80 - allocation}%
          </Row>
          {allocation !== state.split && (
            <Button
              className="sr-secondary sr-full"
              disabled={!ready}
              onClick={() =>
                review(
                  { type: "policy", amount: allocation },
                  "Update revenue policy",
                  `Future creator revenue allocations: ${allocation}% treasury, 20% reserve, ${80 - allocation}% operations. Existing balances do not move.`,
                )
              }
              variant="outline"
            >
              Review policy change
            </Button>
          )}
          <Row label="Revenue available">{money(state.creatorCash)}</Row>
          <Row label="Into treasury cash">
            {money(Math.floor((state.creatorCash * state.split) / 100))}
          </Row>
          <Row label="Into reward reserve">
            {money(Math.floor(state.creatorCash * 0.2))}
          </Row>
          <Row label="Into operations">
            {money(
              state.creatorCash -
                Math.floor((state.creatorCash * state.split) / 100) -
                Math.floor(state.creatorCash * 0.2),
            )}
          </Row>
          <Button
            className="sr-primary sr-full"
            disabled={
              !ready || state.creatorCash <= 0 || allocation !== state.split
            }
            onClick={() =>
              review(
                { type: "allocate" },
                "Allocate creator revenue",
                `${money(state.creatorCash)} moves into treasury cash (${state.split}%), member reserve (20%) and operations (${80 - state.split}%). No tokens are purchased yet.`,
              )
            }
            variant="default"
          >
            Review allocation <ArrowRight size={15} />
          </Button>
          {state.creatorCash === 0 && (
            <p className="sr-note">
              No unallocated revenue.{" "}
              <Link href="/vaults/room#earn">
                Trading in the community market
              </Link>{" "}
              creates the next batch.
            </p>
          )}
          <p className="sr-note">
            Example creator fee: 0.10% of ROOM market volume. This is
            Sonata’s local model, not a claim about a venue’s live terms.
            Older sessions may retain the original $500 fixture.
          </p>
        </Card>
        <Card className="sr-panel" id="treasury">
          <span className="sr-eyebrow">02 / PUT THE TREASURY TO WORK</span>
          <h3>Same strategy. Separate ownership.</h3>
          <p className="sr-note">
            Treasury positions receive only their own proportional LP earnings.
          </p>
          <Label className="sr-field">
            Treasury strategy
            <Choice
              value={market}
              onValueChange={(value) => setMarket(value)}
              label="Treasury strategy"
            >
              {markets
                .filter((v) => state.markets[v.id].status === "active")
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {pairName(v)}
                  </option>
                ))}
            </Choice>
          </Label>
          <Label className="sr-field">
            Treasury deposit · USD
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Label>
          <Row label="Available treasury cash">{money(state.treasury)}</Row>
          <Row label="Risk / fee reinvestment">
            {selected.risk} / {state.markets[market].compoundPercent}%
          </Row>
          <Row label="Treasury lock">None in this model</Row>
          <Button
            className="sr-primary sr-full"
            disabled={
              !ready ||
              !Number.isSafeInteger(cents) ||
              cents <= 0 ||
              cents > state.treasury ||
              state.staleMarkets[market]
            }
            onClick={() =>
              review(
                {
                  type: "deposit",
                  vault: market,
                  owner: "treasury",
                  amount: cents,
                },
                "Deploy treasury capital",
                `${money(cents)} moves from treasury cash to its own ${pairName(selected)} position. Initial inventory is 50 / 50 by value. It can lose value in real markets.`,
              )
            }
            variant="default"
          >
            Review treasury deposit <ArrowRight size={15} />
          </Button>
          <Link className="sr-text-link" href={`/vaults/${market}`}>
            Inspect this market’s terms <ArrowUpRight size={14} />
          </Link>
          <div className="sr-guard">
            <Info size={19} />
            <p>
              Membership does not grant ownership of treasury assets. Rewards
              require an explicit funded allocation.
            </p>
          </div>
          <Row label="Operations retained">{money(state.operations)}</Row>
        </Card>
      </div>
      <Card className="sr-panel">
        <div className="sr-section-top">
          <div>
            <span className="sr-eyebrow">03 / TREASURY POSITIONS</span>
            <h3>Let earnings open the next door.</h3>
            <p>
              Reinvest into the position, retain income, or fund member rewards.
            </p>
          </div>
          <Layers3 size={23} />
        </div>
        {positions.length === 0 ? (
          <Empty className="sr-empty">
            <h3>Allocate revenue, then invest it.</h3>
            <p>
              A treasury deposit above creates the position and its earning
              controls here.
            </p>
          </Empty>
        ) : (
          positions.map((v) => {
            const p = state.treasuryPositions[v.id],
              m = state.markets[v.id];
            return (
              <div className="sr-treasury-position" key={v.id}>
                <div className="sr-section-top">
                  <Link className="sr-text-link" href={`/vaults/${v.id}`}>
                    <Token v={v} />
                    {pairName(v)} <ArrowUpRight size={15} />
                  </Link>
                  <Badge className="sr-chip">Treasury owns this position</Badge>
                </div>
                <div className="sr-position-strip">
                  <div>
                    <span>Invested</span>
                    <strong>{money(p.capital)}</strong>
                  </div>
                  <div>
                    <span>Claimable income</span>
                    <strong className="sr-lime">{money(p.rewards)}</strong>
                  </div>
                  <div>
                    <span>Lifetime fees</span>
                    <strong>{money(p.earned)}</strong>
                  </div>
                </div>
                <p className="sr-note">
                  {m.compoundPercent}% of new net fees reinvests on each
                  simulated trade. Remaining income is available below.
                </p>
                <div className="sr-actions">
                  <Button
                    className="sr-secondary"
                    disabled={
                      !ready || state.staleMarkets[v.id] || p.capital <= 0
                    }
                    onClick={() =>
                      run({
                        type: "trade",
                        vault: v.id,
                        owner: "treasury",
                        amount: 1000000,
                      })
                    }
                    variant="outline"
                  >
                    Simulate $10k volume
                  </Button>
                  <Button
                    className="sr-primary"
                    disabled={
                      !ready || state.staleMarkets[v.id] || p.rewards <= 0
                    }
                    onClick={() =>
                      review(
                        { type: "compound", vault: v.id, owner: "treasury" },
                        "Reinvest treasury earnings",
                        `${money(p.rewards)} returns to this treasury LP position. It will no longer be available to fund rewards.`,
                      )
                    }
                    variant="default"
                  >
                    Reinvest
                  </Button>
                  <Button
                    className="sr-secondary"
                    disabled={!ready || p.rewards <= 0}
                    onClick={() =>
                      review(
                        { type: "fundRewards", vault: v.id, owner: "treasury" },
                        "Fund the reward reserve",
                        `${money(p.rewards)} of treasury-owned LP income moves into the member reserve. Principal and personal LP earnings stay unchanged.`,
                      )
                    }
                    variant="outline"
                  >
                    Fund rewards
                  </Button>
                  <Button
                    className="sr-secondary"
                    disabled={!ready || p.rewards <= 0}
                    onClick={() =>
                      review(
                        { type: "claim", vault: v.id, owner: "treasury" },
                        "Receive treasury income",
                        `${money(p.rewards)} moves to treasury cash for later use.`,
                      )
                    }
                    variant="outline"
                  >
                    Income to cash
                  </Button>
                  <Button
                    className="sr-secondary"
                    disabled={!ready || p.capital <= 0}
                    onClick={() =>
                      review(
                        {
                          type: "withdraw",
                          vault: v.id,
                          owner: "treasury",
                          amount: p.capital,
                        },
                        "Exit treasury position",
                        `${money(p.capital)} returns to treasury cash at fixed demo prices. Claimable income remains separate.`,
                      )
                    }
                    variant="outline"
                  >
                    Exit position
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </Card>
      <Card className="sr-panel" id="rewards">
        <div className="sr-section-top">
          <div>
            <span className="sr-eyebrow">04 / FUNDED MEMBER REWARDS</span>
            <h3>Give something back.</h3>
            <p>
              Publish the reserve into member claims. Each allocation can be
              paid once.
            </p>
          </div>
          <Button
            className="sr-primary"
            disabled={!ready || state.community <= 0}
            onClick={() =>
              review(
                { type: "distribute" },
                "Publish funded rewards",
                `${money(state.community)} moves from the reserve into a fictional 50 / 30 / 20 member snapshot. This creates claims against existing funds, not new money.`,
              )
            }
            variant="default"
          >
            Publish {money(state.community)}
          </Button>
        </div>
        <div className="sr-reward-grid">
          {recipients.map((r) => (
            <div className="sr-reward-card" key={r.id}>
              <Badge className="sr-chip">{r.weight}% of snapshot</Badge>
              <h4>{r.name}</h4>
              <strong>{money(state.claimable[r.id] ?? 0)}</strong>
              <p>Claimable · {money(state.paid[r.id] ?? 0)} paid</p>
              {r.id === "you" ? (
                <Button
                  className="sr-secondary sr-full"
                  disabled={!ready || !(state.claimable.you > 0)}
                  onClick={() =>
                    review(
                      { type: "rewardClaim", recipient: "you" },
                      "Claim your community reward",
                      `${money(state.claimable.you ?? 0)} moves from your funded member entitlement into your personal demo wallet. The claim cannot be repeated.`,
                    )
                  }
                  variant="outline"
                >
                  Claim to wallet
                </Button>
              ) : (
                <small>Separate member account</small>
              )}
            </div>
          ))}
        </div>
        <Row label="Unpublished reserve">{money(state.community)}</Row>
        <Row label="Published claims outstanding">{money(due)}</Row>
        <Row label="Total member payouts">{money(paid)}</Row>
        <p className="sr-note">
          Fictional membership snapshot. No live holder scan, distribution
          contract or Merkle proof is connected. Claiming returns capital to the
          same wallet used across Sonata.
        </p>
      </Card>
      <Card className="sr-panel">
        <div className="sr-section-top">
          <h3>From activity to outcome</h3>
          <Link className="sr-text-link" href="/lab/activity">
            All receipts <ArrowRight size={15} />
          </Link>
        </div>
        <FlowReceipts communityOnly limit={8} />
      </Card>
    </>
  );
}
