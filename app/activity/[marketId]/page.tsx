import { notFound } from "next/navigation";
import { marketCatalog } from "@/lib/stockroom/markets";
import { ActivityPage } from "../../stockroom-workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  if (marketId !== "legacy" && !marketCatalog.some((m) => m.id === marketId))
    notFound();
  return <ActivityPage />;
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
    title: known
      ? `${marketId} activity — Stockroom`
      : "Market not found — Stockroom",
  };
}
