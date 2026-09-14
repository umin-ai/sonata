import { redirect } from "next/navigation";
import { marketCatalog } from "@/lib/stockroom/markets";

// Keep saved links working now that the Devnet app lives at the homepage.
export default async function DevnetRedirect({
  searchParams,
}: {
  searchParams: Promise<{ market?: string | string[] }>;
}) {
  const { market } = await searchParams;
  const selected = typeof market === "string" &&
    (market === "legacy" || marketCatalog.some((m) => m.id === market));
  redirect(selected ? `/?market=${encodeURIComponent(market)}` : "/");
}
