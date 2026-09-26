import { Suspense } from "react";
import { headers } from "next/headers";
import { after } from "next/server";
import { LiveDirectory } from "@/app/onchain/live-directory";
import { WelcomeGuide } from "@/app/onboarding/welcome-guide";
import { marketSnapshots, requestLocale } from "@/lib/server/market-snapshot";

// The market list arrives complete in the first HTML, from the server's market
// snapshot (lib/server/market-snapshot.ts). Without one, the browser reads the
// list itself as before.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [snapshot, h] = await Promise.all([marketSnapshots().home({ schedule: after }), headers()]);
  return (
    <>
      <Suspense fallback={null}>
        <WelcomeGuide page="home" />
      </Suspense>
      <LiveDirectory initial={snapshot ? { ...snapshot, locale: requestLocale(h) } : null} />
    </>
  );
}
