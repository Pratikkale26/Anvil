"use client";

import { useLandingPipeline } from "@/lib/use-landing-pipeline";
import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { NpmHighlight } from "@/components/landing/npm-highlight";
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
      {/* Layered ambient: warm top wash + cool side accent + faint grid */}
      <div
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          background: [
            "radial-gradient(55% 45% at 50% -8%, rgba(245,166,35,0.07) 0%, transparent 70%)",
            "radial-gradient(40% 30% at 90% 12%, rgba(107,123,255,0.05) 0%, transparent 70%)",
            "radial-gradient(35% 25% at 8% 38%, rgba(14,168,128,0.04) 0%, transparent 70%)",
          ].join(", "),
        }}
      />
      <div
        aria-hidden
        className="fixed inset-0 -z-10 pointer-events-none opacity-[0.025] mix-blend-screen"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />

      <Nav apiOk={state.apiOk} />
      <Hero overallSavings={state.overallSavings} />
      <NpmHighlight />
      <HowItWorks />
      <VerifiedAgainst />
      <Playground state={state} />
      <CuAnalysis demo={state.demo} cuData={state.cuData} totals={state.totals} isMobile={state.isMobile} />
      <Readiness isTablet={state.isTablet} />
      <Footer />
    </main>
  );
}
