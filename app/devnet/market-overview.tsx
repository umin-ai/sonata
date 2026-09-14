"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getMarket, marketCatalog } from "@/lib/stockroom/markets";
import type {
  demoMarkets,
  marketHistory,
  movementDetail,
} from "@/lib/stockroom/runtime";
type Markets = Awaited<ReturnType<typeof demoMarkets>>;
type History = Awaited<ReturnType<typeof marketHistory>>;
type Movement = Awaited<ReturnType<typeof movementDetail>>;
const num = (n?: number, digits = 2) =>
  n === undefined
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: digits });
const short = (s: string) => s.slice(0, 5) + "…" + s.slice(-5);
const explorer = (kind: "address" | "tx", s: string) =>
  `https://explorer.solana.com/${kind}/${s}?cluster=devnet`;
const runtime = () => import("@/lib/stockroom/runtime");

export function MarketOverview({
  markets,
  selected,
  onSelect,
  disabled,
  error,
}: {
  markets: Markets;
  selected: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  error: string;
}) {
  const active = markets.find((m) => m.id === selected),
    config = getMarket(selected);
  return (
    <section className="card mock-markets" aria-label="Devnet markets">
      <div className="section-title">
        <h2>Markets</h2>
        <span className="provider">4 isolated pools · demo USD</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Collateral</TableHead>
            <TableHead>Supplied</TableHead>
            <TableHead>Borrowed</TableHead>
            <TableHead>Available</TableHead>
            <TableHead>Utilization</TableHead>
            <TableHead>Borrow APR</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {marketCatalog.map((config) => {
            const m = markets.find((x) => x.id === config.id);
            return (
              <TableRow
                key={config.id}
                data-state={selected === config.id ? "selected" : undefined}
              >
                <TableCell>
                  <Button
                    variant="ghost"
                    className="market-symbol-button"
                    disabled={disabled}
                    onClick={() => onSelect(config.id)}
                    aria-label={`Select ${config.symbol}`}
                    aria-pressed={selected === config.id}
                  >
                    {config.symbol} ↗
                  </Button>
                  <small>{config.name}</small>
                </TableCell>
                <TableCell>{num(m?.supplied)}</TableCell>
                <TableCell>{num(m?.borrowed)}</TableCell>
                <TableCell>{num(m?.cash)}</TableCell>
                <TableCell>
                  {m ? num(m.utilization * 100, 2) + "%" : "—"}
                </TableCell>
                <TableCell>{m ? num(m.apr * 100) + "%" : "—"}</TableCell>
                <TableCell>
                  <Button
                    variant={selected === config.id ? "default" : "outline"}
                    disabled={disabled}
                    onClick={() => onSelect(config.id)}
                    aria-label={`Open ${config.symbol} market`}
                    aria-pressed={selected === config.id}
                  >
                    {selected === config.id ? "Selected" : "Open"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {error && (
        <p className="input-error" role="alert">
          {error} Refresh balances to retry.
        </p>
      )}
      <div className="market-flow" aria-label="Selected market asset flow">
        <div>
          <span>01 / Issuance</span>
          <strong>{num(active?.issued, 4)}</strong>
          <small>{config.symbol} issued on Devnet</small>
        </div>
        <div>
          <span>02 / Collateral custody</span>
          <strong>{num(active?.collateral, 4)}</strong>
          <small>{config.symbol} in the market vault</small>
        </div>
        <div>
          <span>03 / Lending liquidity</span>
          <strong>{num(active?.cash)}</strong>
          <small>demo USD available for loans</small>
        </div>
        <div>
          <span>04 / Outstanding loans</span>
          <strong>{num(active?.borrowed, 6)}</strong>
          <small>demo USD principal + accrued interest</small>
        </div>
      </div>
      <p className="market-data-note">
        Balances read from Devnet
        {active ? ` at slot ${active.slot.toLocaleString()}` : ""}. Supplied
        assets = available cash + outstanding debt. Stock issuance is not
        collateral backing. Prices are fixed test fixtures, not live equity
        quotes.
      </p>
      <div className="market-account-links">
        {[
          ["Stock mint", config.collateralMint],
          ["Cash mint", config.debtMint],
          ["Market", config.market],
          ["Cash vault", config.cashVault],
          ["Collateral vault", config.collateralVault],
          ["Test price feed", config.oracleAccount],
        ].map(([label, address]) => (
          <a
            key={label}
            href={explorer("address", address)}
            target="_blank"
            rel="noreferrer"
          >
            {label} ↗
          </a>
        ))}
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onSelect(selected === "legacy" ? "MockSPYx" : "legacy")
          }
        >
          {selected === "legacy"
            ? "Back to MockSPYx"
            : "Original demo position"}
        </Button>
      </div>
    </section>
  );
}

export function MarketLedger({
  marketId,
  refreshKey,
}: {
  marketId: string;
  refreshKey: number;
}) {
  const config = getMarket(marketId);
  const [rows, setRows] = useState<History>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false),
    [details, setDetails] = useState<Record<string, Movement>>({}),
    [detailBusy, setDetailBusy] = useState("");
  useEffect(() => {
    if (!refreshKey) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await (await runtime()).marketHistory(marketId);
        if (!cancelled) {
          setRows(next);
          setHasMore(next.length === 12);
          setError("");
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Activity unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketId, refreshKey]);
  async function older() {
    setLoading(true);
    try {
      const more = await (
        await runtime()
      ).marketHistory(marketId, rows.at(-1)?.signature);
      setRows((old) => [
        ...old,
        ...more.filter((r) => !old.some((o) => o.signature === r.signature)),
      ]);
      setHasMore(more.length === 12);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activity unavailable.");
    } finally {
      setLoading(false);
    }
  }
  async function detail(signature: string) {
    setDetailBusy(signature);
    try {
      const d = await (await runtime()).movementDetail(marketId, signature);
      setDetails((old) => ({ ...old, [signature]: d }));
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Transaction details unavailable.",
      );
    } finally {
      setDetailBusy("");
    }
  }
  return (
    <section className="card mock-ledger" aria-label="Onchain market activity">
      <div className="section-title">
        <div>
          <p className="eyebrow">ONCHAIN ACTIVITY / ALL WALLETS</p>
          <h2>{config.symbol} market movements</h2>
        </div>
        <span className="provider">
          {loading ? "Reading Devnet…" : `${rows.length} receipts loaded`}
        </span>
      </div>
      <p className="devnet-copy">
        Expand a receipt to see actual token balance changes and credit events.
        Use Refresh balances to fetch new activity. Failed transactions do not
        settle token movements.
      </p>
      <details className="issuance-receipts">
        <summary>Issuance & market deployment receipts</summary>
        <div>
          {config.steps.map((s) => (
            <a
              key={s.signature}
              href={explorer("tx", s.signature)}
              target="_blank"
              rel="noreferrer"
            >
              {s.label} <span>{short(s.signature)} ↗</span>
            </a>
          ))}
        </div>
      </details>
      {error && (
        <p className="input-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !rows.length && !error && (
        <p className="devnet-copy">No market transactions returned yet.</p>
      )}
      <div className="market-ledger-rows">
        {rows.map((r) => {
          const d = details[r.signature],
            known = config.steps.find((s) => s.signature === r.signature);
          return (
            <article className="market-ledger-row" key={r.signature}>
              <div className="ledger-row-head">
                <div>
                  <strong>
                    {r.err
                      ? "Failed transaction"
                      : d?.events.length
                        ? d.events.map((e) => e.action).join(" + ")
                        : (known?.label ?? "Market transaction")}
                  </strong>
                  <span>
                    {r.blockTime
                      ? new Date(r.blockTime * 1000).toLocaleString()
                      : "Timestamp unavailable"}{" "}
                    · slot {r.slot.toLocaleString()}
                  </span>
                </div>
                <span
                  className={`devnet-status ${r.err ? "failed" : r.confirmationStatus}`}
                >
                  {r.err ? "failed" : r.confirmationStatus}
                </span>
                <a
                  href={explorer("tx", r.signature)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(r.signature)} ↗
                </a>
                {!d && (
                  <Button
                    variant="outline"
                    disabled={!!detailBusy}
                    onClick={() => void detail(r.signature)}
                  >
                    {detailBusy === r.signature ? "Loading…" : "View movements"}
                  </Button>
                )}
              </div>
              {d && (
                <div className="ledger-movements">
                  {d.failed ? (
                    <p>Transaction failed. No token movements settled.</p>
                  ) : (
                    <>
                      {d.events.map((e, i) => (
                        <p key={i}>
                          <strong>{e.action}</strong> ·{" "}
                          {e.cash
                            ? `${num(e.cash, 6)} demo USD`
                            : `${num(e.collateral, 8)} ${config.symbol}`}{" "}
                          · wallet{" "}
                          <a
                            href={explorer("address", e.owner)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {short(e.owner)}
                          </a>
                          {e.badDebt > 0
                            ? ` · ${num(e.badDebt, 6)} demo USD bad debt`
                            : ""}
                        </p>
                      ))}
                      {d.movements.map((m) => (
                        <div className="token-movement" key={m.account}>
                          <a
                            href={explorer("address", m.account)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {m.location} · {short(m.account)}
                          </a>
                          <strong
                            className={m.amount > 0 ? "token-in" : "token-out"}
                          >
                            {m.amount > 0 ? "+" : ""}
                            {num(m.amount, 8)} {m.symbol}
                          </strong>
                        </div>
                      ))}
                      {!d.movements.length && (
                        <p>
                          No stock or demo-USD balance change. This receipt may
                          initialize accounts or change market state.
                        </p>
                      )}
                    </>
                  )}
                  <small>
                    Network fee: {num(d.fee, 6)} Devnet SOL · amounts decoded
                    from this receipt
                  </small>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {hasMore && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void older()}
        >
          Load older transactions
        </Button>
      )}
    </section>
  );
}
