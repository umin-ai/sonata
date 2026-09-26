import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { LiveMarket } from "@/app/onchain/live-workspace";
import { marketSnapshots, requestLocale } from "@/lib/server/market-snapshot";

// One market's page (/onchain?pool=…). With no market named, go to the market
// list rather than opening a default one. The server's market snapshot gives
// the header, chart card and numbers in the first HTML, and with live push the
// stream position the page's updates start from; the browser then verifies
// the market on the chain before anything can be sent.
export const dynamic = "force-dynamic";
const POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function Page({ searchParams }: { searchParams: Promise<{ pool?: string | string[] }> }) {
  const { pool } = await searchParams;
  if (typeof pool !== "string" || !pool) redirect("/");
  const snapshots = marketSnapshots();
  const [snapshot, h] = await Promise.all([snapshots.marketPage(pool, { schedule: after }), headers()]);
  // Without its market in the snapshot (launched moments ago), the page still
  // opens the live stream, and shows the market as soon as it is listed; not
  // for a pool that is not an address (the stream would refuse it).
  return (
    <LiveMarket
      pool={pool}
      initial={snapshot ? { ...snapshot, locale: requestLocale(h) } : null}
      stream={snapshot || !POOL.test(pool) ? null : snapshots.streamPosition()}
    />
  );
}
