import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { Proof } from "@/components/landing/proof";
import { Steps } from "@/components/landing/steps";
import { Verified } from "@/components/landing/verified";
import { Cu } from "@/components/landing/cu";
import { Cta } from "@/components/landing/cta";
import { Footer } from "@/components/landing/footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-anvil-bg text-anvil-text">
      {/* Ambient: warm top wash + faint grid, painted behind everything. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background: [
            "radial-gradient(60% 40% at 50% -6%, rgba(245,166,35,0.09) 0%, transparent 70%)",
            "radial-gradient(40% 30% at 92% 10%, rgba(107,123,255,0.05) 0%, transparent 70%)",
          ].join(", "),
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.02] mix-blend-screen"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <Nav />
      <Hero />
      <Proof />
      <Steps />
      <Verified />
      <Cu />
      <Cta />
      <Footer />
    </main>
  );
}
