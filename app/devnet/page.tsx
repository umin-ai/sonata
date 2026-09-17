import { MarketsPage } from "../stockroom-workspace";
import { redirect } from "next/navigation";
import { marketCatalog } from "@/lib/stockroom/markets";

// Retain the earlier credit experiment separately from the vault prototype.
export default async function DevnetRedirect({
  searchParams,
}: {
  searchParams: Promise<{ market?: string | string[] }>;
}) {
  const { market } = await searchParams;
  const selected =
    typeof market === "string" &&
    (market === "legacy" || marketCatalog.some((m) => m.id === market));
  if (selected) redirect(`/markets/${encodeURIComponent(market)}`);
  return <MarketsPage />;
}
