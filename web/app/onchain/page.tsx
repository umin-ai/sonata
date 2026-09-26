import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { LiveMarket } from "@/app/onchain/live-workspace";
import { marketSnapshots, requestLocale } from "@/lib/server/market-snapshot";

// One market's page (/onchain?pool=…). With no market named, go to the market
// list rather than opening a default one. The server's market snapshot gives
// the header, chart card and numbers in the first HTML; the browser then
// verifies the market on the chain before anything can be sent.
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ pool?: string | string[] }> }) {
  const { pool } = await searchParams;
  if (typeof pool !== "string" || !pool) redirect("/");
  const [snapshot, h] = await Promise.all([marketSnapshots().marketPage(pool, { schedule: after }), headers()]);
  return <LiveMarket pool={pool} initial={snapshot ? { ...snapshot, locale: requestLocale(h) } : null} />;
}
