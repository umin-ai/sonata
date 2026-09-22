import { notFound } from "next/navigation";
import { marketCatalog } from "@/lib/stockroom/markets";
import { MarketPage } from "../../stockroom-workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  if (marketId !== "legacy" && !marketCatalog.some((m) => m.id === marketId))
    notFound();
  return <MarketPage />;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  const known =
    marketId === "legacy" || marketCatalog.some((m) => m.id === marketId);
  return {
    title: known ? `${marketId} — Sonata` : "Market not found — Sonata",
  };
}
