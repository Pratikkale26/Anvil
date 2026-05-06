"use client";

import { useLandingPipeline } from "@/lib/use-landing-pipeline";
import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { VerifiedAgainst } from "@/components/landing/verified-against";
import { Playground } from "@/components/landing/playground";
import { CuAnalysis } from "@/components/landing/cu-analysis";
import { Readiness } from "@/components/landing/readiness";
import { Footer } from "@/components/landing/footer";

export default function Home() {
  const state = useLandingPipeline();

  return (
    <main className="min-h-screen bg-anvil-bg text-anvil-text">
      {/* Single ambient gradient — replaces the previous 3 radials + dot grid */}
      <div
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, rgba(245,166,35,0.06) 0%, transparent 70%)",
        }}
      />

      <Nav apiOk={state.apiOk} />
      <Hero overallSavings={state.overallSavings} />
      <HowItWorks />
      <VerifiedAgainst />
      <Playground state={state} />
      <CuAnalysis demo={state.demo} cuData={state.cuData} totals={state.totals} isMobile={state.isMobile} />
      <Readiness isTablet={state.isTablet} />
      <Footer />
    </main>
  );
}
