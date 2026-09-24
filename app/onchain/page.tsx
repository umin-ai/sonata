import { redirect } from "next/navigation";
import { LiveMarket } from "@/app/onchain/live-workspace";

// One market's page (/onchain?pool=…). With no market named, go to the market
// list rather than opening a default one.
export default async function Page({ searchParams }: { searchParams: Promise<{ pool?: string | string[] }> }) {
  const { pool } = await searchParams;
  if (typeof pool !== "string" || !pool) redirect("/");
  return <LiveMarket />;
}
