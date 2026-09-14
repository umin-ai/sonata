import { redirect } from "next/navigation";
import { marketCatalog } from "@/lib/stockroom/markets";
import { MarketsPage } from "./stockroom-workspace";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ market?: string | string[] }>;
}) {
  const { market } = await searchParams;
  if (
    typeof market === "string" &&
    (market === "legacy" || marketCatalog.some((m) => m.id === market))
  )
    redirect(`/markets/${encodeURIComponent(market)}`);
  return <MarketsPage />;
}
