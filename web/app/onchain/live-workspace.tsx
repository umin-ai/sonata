"use client";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "@/app/plain-link";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  discoverMarkets,
  marketFromIdentity,
  readWalletBalances,
  connection,
  explorer,
  type Market,
} from "@/lib/treasury/runtime";
import {
  SNAPSHOT_NUMBERS_MAX_AGE_MS,
  versionOf,
  type CardData,
  type MarketIdentity,
  type MarketPageSnapshot,
  type SnapshotEntry,
  type StreamPosition,
} from "@/lib/treasury/market-snapshot";
import { SnapshotProvider } from "./snapshot-context";
import { PublicKey } from "@solana/web3.js";
import { formatUnits } from "@/lib/treasury/units";
import { LiveWallet, useLive } from "./live-session";
import { OnchainTreasury } from "./treasury-workspace";
import { LiquidityPortfolio } from "@/app/earn/demo-portfolio";
import { useMarkets } from "./use-markets";
import { snapshotDeadline } from "./panel-state";
import { LiveStreamProvider, useLiveEvent, useLiveProfiles, useLiveStream, useLiveStreamInstance } from "./live-stream";
import {
} from "@/app/token-profile-fields";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
const href = (m: Pick<Market, "pool">) => `/onchain?pool=${m.pool}`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
function Heading({
  title,
  description,
  refresh,
}: {
  title: string;
  description: string;
  refresh?: () => void;
}) {
  return (
    <div className="sr-heading">
      <div>
        <span className="sr-eyebrow">SONATA</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {refresh && (
        <Button variant="outline" onClick={refresh}>
          <RefreshCw />
          Refresh
        </Button>
      )}
    </div>
  );
}
function Failure({ text }: { text: string }) {
  return text ? (
    <Alert variant="destructive" className="mb-5">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
function Address({ value }: { value: string }) {
  return (
    <a
      className="sr-text-link"
      href={explorer("address", value)}
      target="_blank"
      rel="noreferrer"
    >
      {short(value)}
      <ArrowUpRight size={13} />
    </a>
  );
}
/**
 * One market's page (/onchain?pool=…; `pool` comes from the page, so the
 * server and the browser pick the same branch). With the server's snapshot
 * entry for it, the market (rebuilt from its identity) renders at once, with
 * the snapshot's numbers until the live read verifies it. Otherwise the
 * browser finds it on the chain first, as before, or the live stream brings
 * it the moment it is listed. With a stream position (`initial.stream`, or
 * `stream` when the snapshot does not have the market yet) the page opens its
 * market's live stream: numbers, trades and stats pushed as they change.
 */
export function LiveMarket({
  pool,
  initial = null,
  stream = null,
}: {
  pool: string;
  initial?: MarketPageSnapshot | null;
  stream?: StreamPosition | null;
}) {
  const live = useLiveStreamInstance({ scope: "market", pool, since: initial?.stream ?? stream });
  const liveProfiles = useLiveProfiles(live);
  const seeded = useMemo(() => {
    if (!initial || initial.entry.market.pool !== pool) return null;
    try {
      return marketFromIdentity(initial.entry.market);
    } catch {
      return null;
    }
  }, [initial, pool]);
  const profiles = useMemo(() => {
    if (!seeded?.uri) return undefined;
    // A profile the stream carried later (it was not readable when the page was rendered) is shown when it comes.
    const pushed = liveProfiles[seeded.uri];
    const body = pushed ?? initial?.profile;
    return body !== undefined ? { [seeded.uri]: body } : undefined;
  }, [initial, seeded, liveProfiles]);
  const prices = useMemo(
    () => (initial && seeded && initial.price !== undefined ? { [quoteSymbolOf(seeded.quoteMint)]: initial.price } : undefined),
    [initial, seeded],
  );
  if (!initial || !seeded)
    return (
      <LiveStreamProvider value={live}>
        <DiscoveredMarket pool={pool} />
      </LiveStreamProvider>
    );
  return (
    <LiveStreamProvider value={live}>
      <SnapshotProvider profiles={profiles} prices={prices} locale={initial.locale}>
        <OnchainTreasury
          key={pool}
          selected={seeded}
          initialData={initial.ageMs <= SNAPSHOT_NUMBERS_MAX_AGE_MS ? initial.entry.data : null}
          initialDeadline={snapshotDeadline(initial.ageMs, SNAPSHOT_NUMBERS_MAX_AGE_MS)}
          initialVersion={versionOf(initial.entry)}
        />
      </SnapshotProvider>
    </LiveStreamProvider>
  );
}
// A market the server's snapshot does not have (launched moments ago, or not a
// Sonata market): found on the chain first, or brought by the live stream the
// moment it is listed (its entry, rebuilt with marketFromIdentity and verified
// by the page's own live read like any other), whichever comes first; the
// other is then not used, so the page reads the market once. Once found it is
// kept, so a later transaction does not look it up again; until then, one does.
function DiscoveredMarket({ pool }: { pool: string }) {
  const { revision } = useLive();
  const [found, setFound] = useState<{ market: Market | null; error: string } | null>(null);
  const [pushed, setPushed] = useState<{ market: Market; data: CardData | null; until: number; version: number } | null>(null);
  const stream = useLiveStream();
  const take = (entry: SnapshotEntry) => {
    if (pushed || found?.market) return;
    try {
      // While the stream is live its numbers do not age (panel-state.ts).
      const until = stream?.status === "live" ? Infinity : performance.now() + SNAPSHOT_NUMBERS_MAX_AGE_MS;
      setPushed({ market: marketFromIdentity(entry.market), data: entry.data, until, version: versionOf(entry) });
    } catch {
      /* Not a market this build can show: the chain lookup decides. */
    }
  };
  useLiveEvent(stream, "market", (ev) => {
    if (ev.pool === pool && ev.kind === "added") take({ ...ev.entry, version: ev.version });
  });
  useLiveEvent(stream, "snapshot", (s) => {
    if (s.scope === "market" && s.entry?.market.pool === pool) take(s.entry);
  });
  // The stream brought it: no chain lookup (the page's live read verifies it).
  const known = !!found?.market || !!pushed;
  useEffect(() => {
    if (known) return;
    let active = true;
    discoverMarkets().then(
      (markets) => active && setFound({ market: markets.find((m) => m.pool === pool) ?? null, error: "" }),
      (e) => active && setFound((last) => ({ market: last?.market ?? null, error: message(e, "Markets unavailable") })),
    );
    return () => {
      active = false;
    };
  }, [pool, revision, known]);
  if (pushed)
    return (
      <OnchainTreasury key={pool} selected={pushed.market} initialData={pushed.data} initialDeadline={pushed.until} initialVersion={pushed.version} />
    );
  if (found?.market) return <OnchainTreasury key={pool} selected={found.market} />;
  return (
    <>
      <Heading
        title="Open market"
        description={
          !found
            ? "Verifying market registration on Solana…"
            : "This pool is not registered with the supported Sonata configuration."
        }
      />
      <Failure text={found?.error ?? ""} />
      <Button asChild variant="outline">
        <Link href="/">Back to markets</Link>
      </Button>
    </>
  );
}
export { LiveLaunch } from "./live-launch";
export function LivePortfolio() {
  const { address, revision } = useLive();
  const [liquidityRefresh, setLiquidityRefresh] = useState(0);
  const { list, error, loading, refresh } = useMarkets();
  // The wallet's balances in every listed market in one batched read, re-read
  // when the wallet, the set of markets or the chain (a confirmed transaction)
  // changes, not every time the list's numbers refresh.
  const pools = list.map((e) => e.market.pool).join(",");
  const [listed, setListed] = useState({ pools: "", markets: [] as MarketIdentity[] });
  if (listed.pools !== pools) setListed({ pools, markets: list.map((e) => e.market) });
  const key = address ? `${address}|${pools}|${revision}` : "";
  const [read, setRead] = useState<{
    key: string;
    balances?: Awaited<ReturnType<typeof readWalletBalances>>;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!key || !listed.markets.length) return;
    let active = true;
    readWalletBalances(address, listed.markets).then(
      (balances) => active && setRead({ key, balances }),
      (e) => active && setRead({ key, error: message(e, "Balances unavailable") }),
    );
    return () => {
      active = false;
    };
  }, [key, address, listed]);
  const current = read?.key === key ? read : null;
  const fetching = !!key && !!listed.markets.length && !current;
  // Creator reserves come with the list's card numbers (display only).
  const positions = current?.balances
    ? list.flatMap(({ market, data }) => {
        const balance = current.balances!.get(market.pool);
        return balance ? [{ market, balance, treasury: { available: data?.available ?? "0" } }] : [];
      })
    : [];
  const failure =
    current?.error ?? list.find((e) => !e.data && e.error && e.market.creator === address)?.error ?? "";
  return (
    <>
      <Heading
        title="Your portfolio."
        description="Wallet tokens, liquidity positions and creator reserves. Read directly from Solana."
        refresh={() => {
          setLiquidityRefresh((v) => v + 1);
          void refresh();
        }}
      />
      <LiveWallet />
      <Failure text={error || failure} />
      {address && (
        <>
          {/* One wallet and reserve figure per quote token: amounts in different
              mock stocks are never added together. */}
          <div className="sr-stats">
            {[...new Set(positions.map((p) => p.market.quoteMint))].map((mint) => {
              const rows = positions.filter((p) => p.market.quoteMint === mint);
              const q = quoteSymbolOf(mint);
              return (
                <Card key={mint}>
                  <span>
                    Wallet <TokenName symbol={q} />
                  </span>
                  <strong>{formatUnits(rows[0].balance.quote)}</strong>
                  <small>
                    Creator reserves{" "}
                    {formatUnits(
                      rows
                        .filter((p) => p.market.creator === address)
                        .reduce((sum, p) => sum + BigInt(p.treasury.available), 0n),
                    )}{" "}
                    {q} · across {rows.length} market{rows.length === 1 ? "" : "s"}
                  </small>
                </Card>
              );
            })}
            <Card>
              <span>Devnet SOL</span>
              <strong>
                {positions[0] ? formatUnits(positions[0].balance.sol, 9) : "—"}
              </strong>
              <small>For transaction fees</small>
            </Card>
          </div>
          <Card className="sr-panel">
            <h3>Community holdings</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Wallet tokens</TableHead>
                  <TableHead>Your role</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.market.pool}>
                    <TableCell>
                      <TokenPair base={p.market.symbol} quote={quoteSymbolOf(p.market.quoteMint)} size={24} />
                    </TableCell>
                    <TableCell>{formatUnits(p.balance.base, 6)}</TableCell>
                    <TableCell>
                      {p.market.creator === address
                        ? "Creator"
                        : p.market.payoutOwner === address
                          ? "Fee recipient"
                          : "Trader"}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" asChild>
                        <Link href={href(p.market)}>
                          Manage
                          <ArrowUpRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(loading || fetching) && (
              <p className="sr-note">Reading balances…</p>
            )}
          </Card>
          <LiquidityPortfolio refreshToken={liquidityRefresh} />
          <Card className="sr-panel mt-6">
            <h3>Your tokens&apos; fees</h3>
            <p className="sr-note">
              What each token you launched has paid you, and what is waiting to claim.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/capital">
                  My tokens
                  <ArrowUpRight />
                </Link>
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
export function LiveActivity() {
  const { address, revision, labels } = useLive();
  const [rows, setRows] = useState<
      Awaited<ReturnType<typeof connection.getSignaturesForAddress>>
    >([]),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!address) return;
    setError("");
    try {
      setRows(
        await connection.getSignaturesForAddress(
          new PublicKey(address),
          { limit: 30 },
          "confirmed",
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "History unavailable");
    }
  }, [address]);
  useEffect(() => {
    setRows([]);
    void refresh();
  }, [refresh, revision]);
  return (
    <>
      <Heading
        title="Wallet activity."
        description="Confirmed network receipts, including transactions made outside Sonata."
        refresh={refresh}
      />
      <LiveWallet />
      <Failure text={error} />
      {address && (
        <Card className="sr-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operation</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Receipt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.signature}>
                  <TableCell>
                    {labels[r.signature] ?? "Wallet transaction"}
                  </TableCell>
                  <TableCell>
                    {r.blockTime
                      ? new Date(r.blockTime * 1000).toLocaleString()
                      : "Pending timestamp"}
                  </TableCell>
                  <TableCell>
                    {r.err ? "Failed" : r.confirmationStatus}
                  </TableCell>
                  <TableCell>
                    <a
                      className="sr-text-link"
                      href={explorer("tx", r.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(r.signature)}
                      <ArrowUpRight size={13} />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && (
            <p className="sr-note">No receipts loaded for this wallet.</p>
          )}
        </Card>
      )}
    </>
  );
}
