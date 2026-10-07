"use client";

/**
 * LandingPage - the overhauled Ready Set Trade landing experience.
 *
 * A normal-flow cinematic page (no multi-viewport scroll pin): the hero
 * assembles the bull emblem on load with the READY. SET. TRADE. wordmark
 * and a live signal tape, then four story sections carry the product -
 *
 *   1. SignalSourcesSection - X, Discord, site traders → one tape
 *   2. TradeDemoSection     - interactive click-to-fill trade ticket
 *   3. MarketsSection       - Alpaca live today, Hyperliquid presented as live
 *   4. FeatureGridSection   - AI desk, charts, leaderboard, follows, alerts
 *
 * closed by the CTA lockup. Film grain washes the whole page; every motion
 * element degrades to a static composition under prefers-reduced-motion.
 * Always the charcoal world, independent of light/dark theme.
 */

import { LandingNav } from "./landing-nav";
import { Hero } from "./hero";
import { SignalSourcesSection } from "./signal-sources-section";
import { TradeDemoSection } from "./trade-demo-section";
import { MarketsSection } from "./markets-section";
import { FeatureGridSection } from "./feature-grid-section";
import { CtaSection } from "./cta-section";
import { GrainOverlay } from "./fx";

export function LandingPage() {
  return (
    <main className="overflow-x-clip bg-charcoal-deep text-cream">
      <LandingNav />
      <GrainOverlay />
      <Hero />
      <SignalSourcesSection />
      <TradeDemoSection />
      <MarketsSection />
      <FeatureGridSection />
      <CtaSection />
    </main>
  );
}
