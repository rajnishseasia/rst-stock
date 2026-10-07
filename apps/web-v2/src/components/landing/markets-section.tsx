"use client";

/**
 * MarketsSection - where orders route, overhauled.
 *
 * Alpaca (live today) carries the wide spotlight cell; Hyperliquid sits in
 * the narrow cell behind an animated gold shimmer border.
 *
 * NOTE: the Hyperliquid cell carries NO "coming soon" label - the shimmer is
 * the only cue, and the headline states "Leverage on Hyperliquid." flatly.
 * Together with the "GTC limit orders" chip below and "Streaming over
 * WebSockets" in the signal-sources card, this page presents unshipped
 * roadmap items as live, per owner instruction. Time the deploy of this page
 * with those features actually shipping, or add explicit labelling first.
 */

import { motion, useReducedMotion } from "motion/react";
import { SpotlightCard, RiseWords } from "./fx";

const CHIP =
  "inline-flex items-center rounded-full border border-cream/15 bg-charcoal-deep/60 px-3 py-1 font-data text-2xs uppercase tracking-[0.14em] text-cream/80";

/** Slow rotating conic border - the "in the works" glow for Hyperliquid. */
function ShimmerFrame({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <div className="relative h-full overflow-hidden rounded-2xl p-px">
      {reduce ? (
        <div aria-hidden className="absolute inset-0 rounded-2xl border border-cream/15" />
      ) : (
        <motion.div
          aria-hidden
          className="absolute inset-[-100%]"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, transparent 300deg, rgba(210,168,81,0.7) 340deg, transparent 360deg)",
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
        />
      )}
      <div className="relative h-full rounded-[calc(1rem-1px)] border border-cream/10 bg-[#10171f]">
        {children}
      </div>
    </div>
  );
}

export function MarketsSection() {
  const reduce = useReducedMotion();

  return (
    <section className="relative overflow-hidden bg-charcoal-deep py-28 sm:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 90% 70% at 80% 90%, #171f2a 0%, #0c151e 70%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-6">
        <h2 className="max-w-3xl font-wordmark text-4xl font-bold tracking-tight text-cream sm:text-5xl lg:text-6xl">
          <RiseWords text="Any stock. Options too." />
          <br />
          <RiseWords text="Leverage on Hyperliquid." delay={0.18} />
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-3"
          >
            <SpotlightCard className="glass-edge-soft h-full rounded-2xl border border-gold/25 bg-charcoal">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(ellipse at 12% 0%, rgba(210,168,81,0.12) 0%, transparent 55%)",
                }}
              />
              <div className="relative p-8 sm:p-10">
                <span className="font-wordmark text-3xl font-bold text-cream">Alpaca</span>
                <p className="mt-5 max-w-md text-base leading-relaxed text-muted-slate">
                  Route every trade to your own Alpaca account. Any US stock,
                  plus single-leg options with real contract symbols, and your
                  bracket exits ride along with the order.
                </p>
                <div className="mt-8 flex flex-wrap gap-2">
                  <span className={CHIP}>Stocks</span>
                  <span className={CHIP}>Options</span>
                  <span className={CHIP}>Paper &amp; live</span>
                  <span className={CHIP}>Bracket exits</span>
                  <span className={CHIP}>GTC limit orders</span>
                </div>
              </div>
            </SpotlightCard>
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.65, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-2"
          >
            <ShimmerFrame>
              <div className="p-8 sm:p-10">
                <span className="font-wordmark text-3xl font-bold text-cream">Hyperliquid</span>
                <p className="mt-5 text-base leading-relaxed text-muted-slate">
                  Trade many of the biggest names with leverage on Hyperliquid.
                  Same ticket, same risk discipline, more firepower.
                </p>
                <div className="mt-8 flex flex-wrap gap-2">
                  <span className={CHIP}>Leverage</span>
                  <span className={CHIP}>Top stocks</span>
                </div>
              </div>
            </ShimmerFrame>
          </motion.div>
        </div>

        {/* More broker connections - re-enable when these integrations ship.
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.55, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-cream/10 bg-charcoal/40 px-5 py-4"
        >
          <span className="font-data text-2xs uppercase tracking-[0.18em] text-muted-slate">
            Also connects
          </span>
          <span className={CHIP}>Robinhood</span>
          <span className={CHIP}>Interactive Brokers</span>
        </motion.div>
        */}
      </div>
    </section>
  );
}
