import { Suspense } from "react";
import { LiveDirectory } from "@/app/onchain/live-workspace";
import { WelcomeGuide } from "@/app/onboarding/welcome-guide";
export default function Page() {
  return (
    <>
      <Suspense fallback={null}>
        <WelcomeGuide page="home" />
      </Suspense>
      <LiveDirectory />
    </>
  );
}
