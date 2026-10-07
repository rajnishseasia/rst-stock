"use client";

/**
 * Hero - the overhauled opening act.
 *
 * One orchestrated load moment: the canonical bull emblem (the same clean
 * /brand/emblem-dark.png used in the nav and CTA - NOT the layered ring
 * assembly, whose ring plate reads as a stray gold outline) scales in under
 * a soft blurred glow while the READY. SET. TRADE. wordmark staggers up
 * beside it and the CTA ignites. The emblem then breathes and leans subtly
 * toward the cursor. A live-styled signal tape runs along the hero's lower
 * edge - the page's one marquee and its clearest "this is a trading
 * product" cue.
 *
 * Scrolling out: the whole stage parallaxes and dims (no pinning; the page
 * flows normally so the story sections arrive quickly).
 */

import { useRef } from "react";
import Link from "next/link";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useScroll,
  useReducedMotion,
} from "motion/react";
import { signInWithGoogle } from "@/lib/auth-client";
import { DevSignIn } from "@/components/auth/dev-sign-in";
import { StaticEmblem } from "./bull-assembly";
import { MagneticButton, Starfield, useCanHover } from "./fx";

const GAIN = "#41cf95";
const LOSS = "#e5654f";

const TAPE: Array<{ sym: string; delta: string; up: boolean; from: string }> = [
  { sym: "$NVDA", delta: "+1.8%", up: true, from: "@thetapereader" },
  { sym: "$AMD", delta: "+2.4%", up: true, from: "Copper Wolf" },
  { sym: "$TSLA", delta: "-0.6%", up: false, from: "@chartsurgeon" },
  { sym: "$SPY", delta: "+0.4%", up: true, from: "stock-calls" },
  { sym: "$MSFT", delta: "+1.1%", up: true, from: "@wickwatcher" },
  { sym: "$PLTR", delta: "-1.3%", up: false, from: "Iron Fern" },
  { sym: "$COIN", delta: "+3.2%", up: true, from: "Vega Nomad" },
  { sym: "$META", delta: "+0.9%", up: true, from: "@gapfillgus" },
];

function TapeItem({ sym, delta, up, from }: (typeof TAPE)[number]) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-2 px-6">
      <span className="font-data text-xs font-semibold text-cream">{sym}</span>
      <span
        className="font-data text-xs tabular-nums"
        style={{ color: up ? GAIN : LOSS }}
      >
        {up ? "▲" : "▼"} {delta}
      </span>
      <span className="font-data text-2xs text-muted-slate">{from}</span>
    </span>
  );
}

function SignalTape() {
  const reduce = useReducedMotion();
  return (
    <div className="relative border-y border-gold/15 bg-charcoal-deep/60 py-3 backdrop-blur-sm [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
      {reduce ? (
        <div className="flex overflow-x-auto">
          {TAPE.map((t) => (
            <TapeItem key={t.sym} {...t} />
          ))}
        </div>
      ) : (
        <motion.div
          className="flex w-max"
          animate={{ x: ["0%", "-50%"] }}
          transition={{ duration: 32, ease: "linear", repeat: Infinity }}
        >
          {[...TAPE, ...TAPE].map((t, i) => (
            <TapeItem key={`${t.sym}-${i}`} {...t} />
          ))}
        </motion.div>
      )}
    </div>
  );
}

const WORDS = ["READY.", "SET.", "TRADE."];

export function Hero() {
  const reduce = useReducedMotion();
  const canHover = useCanHover();
  const stageRef = useRef<HTMLDivElement>(null);

  // Cursor lean - the assembled emblem tilts a few px toward the pointer.
  const leanX = useMotionValue(0);
  const leanY = useMotionValue(0);
  const sLeanX = useSpring(leanX, { stiffness: 60, damping: 20 });
  const sLeanY = useSpring(leanY, { stiffness: 60, damping: 20 });

  // Scroll-out: dim and drift as the visitor leaves the hero.
  const { scrollY, scrollYProgress } = useScroll({
    target: stageRef,
    offset: ["start start", "end start"],
  });
  const stageOpacity = useTransform(scrollYProgress, [0, 0.85], [1, 0]);
  const stageY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const emblemY = useTransform(scrollYProgress, [0, 1], [0, 60]);
  // Scroll cue vanishes within the first ~200px of scroll. Driven by
  // absolute pixels, not target progress - the target-based value proved
  // unreliable for this fade in practice.
  const cueOpacity = useTransform(scrollY, [0, 200], [1, 0]);

  return (
    <section
      ref={stageRef}
      className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-charcoal-deep"
      onPointerMove={(e) => {
        if (reduce || !canHover) return;
        const r = e.currentTarget.getBoundingClientRect();
        leanX.set(((e.clientX - r.left) / r.width - 0.5) * 18);
        leanY.set(((e.clientY - r.top) / r.height - 0.5) * 12);
      }}
      onPointerLeave={() => {
        leanX.set(0);
        leanY.set(0);
      }}
    >
      {/* Atmosphere: layered radial charcoal, the vault plate, drifting gold dust. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 120% 90% at 70% 20%, #1a232f 0%, #10161f 45%, #0c151e 78%)",
          }}
        />
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30 mix-blend-soft-light"
          style={{ backgroundImage: "url(/brand/landing/act3-trade-plate.webp)" }}
        />
        {!reduce && (
          <motion.div
            className="absolute inset-[-8%] bg-cover bg-center opacity-25 mix-blend-screen"
            style={{ backgroundImage: "url(/brand/landing/gold-dust-overlay.webp)" }}
            animate={{ y: [-14, 14] }}
            transition={{ duration: 14, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
          />
        )}
        {/* Animated star/dust particles over the static texture. */}
        <Starfield count={94} />
        {/* Gold horizon line behind the content split. */}
        <div className="absolute left-1/2 top-1/2 h-px w-[140%] -translate-x-1/2 bg-gradient-to-r from-transparent via-gold/15 to-transparent" />
      </div>

      {/* Stage: copy left, emblem right; stacks on mobile. */}
      <motion.div
        style={reduce ? undefined : { opacity: stageOpacity, y: stageY }}
        className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-10 px-6 pb-16 pt-24 lg:flex-row lg:gap-6"
      >
        <div className="flex max-w-xl flex-1 flex-col items-center text-center lg:items-start lg:text-left">
          <h1 className="font-wordmark font-extrabold uppercase leading-[0.95] tracking-[0.06em]">
            {WORDS.map((word, i) => (
              <span key={word} className="block overflow-hidden pb-1">
                <motion.span
                  initial={reduce ? false : { y: "105%" }}
                  animate={{ y: 0 }}
                  transition={{
                    duration: 0.8,
                    delay: 0.15 + i * 0.22,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className={[
                    "block text-6xl sm:text-7xl xl:text-8xl",
                    i === 2 ? "text-transparent" : "text-cream",
                  ].join(" ")}
                  style={
                    i === 2
                      ? {
                          backgroundImage:
                            "linear-gradient(100deg, #b88a2e 0%, #e7d9b4 25%, #fffdf7 48%, #e7d9b4 62%, #c59a3e 100%)",
                          backgroundSize: "220% 100%",
                          WebkitBackgroundClip: "text",
                          backgroundClip: "text",
                        }
                      : undefined
                  }
                >
                  {i === 2 && !reduce ? (
                    <motion.span
                      className="block"
                      animate={{ backgroundPositionX: ["0%", "100%"] }}
                      transition={{
                        duration: 6,
                        ease: "easeInOut",
                        repeat: Infinity,
                        repeatType: "mirror",
                      }}
                      style={{
                        backgroundImage:
                          "linear-gradient(100deg, #b88a2e 0%, #e7d9b4 25%, #fffdf7 48%, #e7d9b4 62%, #c59a3e 100%)",
                        backgroundSize: "220% 100%",
                        WebkitBackgroundClip: "text",
                        backgroundClip: "text",
                        color: "transparent",
                      }}
                    >
                      {word}
                    </motion.span>
                  ) : (
                    word
                  )}
                </motion.span>
              </span>
            ))}
          </h1>

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.95, ease: [0.16, 1, 0.3, 1] }}
            className="mt-6 max-w-md text-base leading-relaxed text-muted-slate sm:text-lg"
          >
            Signals from X, Discord, and real traders. One click sizes,
            stops, and targets the trade.
          </motion.p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 1.15, ease: [0.16, 1, 0.3, 1] }}
            className="mt-10 flex flex-col items-center gap-4 sm:flex-row"
          >
            <MagneticButton
              onClick={() => signInWithGoogle()}
              className="group relative inline-flex h-13 items-center justify-center overflow-hidden rounded-full bg-gold px-9 font-data text-sm font-semibold uppercase tracking-[0.14em] text-charcoal-deep transition-colors duration-300 hover:bg-gold-bright"
            >
              <span className="relative z-10">Enter the Terminal</span>
              {/* Sheen sweep on hover. */}
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            </MagneticButton>
            <Link
              href="/guide"
              className="inline-flex h-13 items-center justify-center rounded-full border border-gold/30 px-8 font-data text-sm font-medium uppercase tracking-[0.14em] text-cream transition-colors duration-300 hover:border-gold/60 hover:text-gold-bright"
            >
              Read the Guide
            </Link>
          </motion.div>

          {/* Local development only: Google OAuth cannot work on a dev machine,
              so without this the app is impossible to sign into locally. Renders
              nothing in a production build (see DevSignIn). */}
          <div className="mt-6 flex w-full justify-center sm:justify-start">
            <DevSignIn />
          </div>
        </div>

        {/* The clean brand emblem: scales in on load, then breathes. */}
        <motion.div
          style={reduce ? undefined : { x: sLeanX, y: sLeanY }}
          className="relative flex-1"
        >
          <motion.div style={reduce ? undefined : { y: emblemY }}>
            <motion.div
              initial={reduce ? false : { opacity: 0, scale: 0.86 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1.3, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              <motion.div
                animate={reduce ? undefined : { scale: [1, 1.015, 1] }}
                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
                className="relative"
              >
                {/* Soft blurred glow only - no hard-edged ring shapes. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2 h-[54vmin] max-h-[460px] w-[54vmin] max-w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    background:
                      "radial-gradient(circle, rgba(210,168,81,0.16) 0%, rgba(210,168,81,0.05) 48%, transparent 72%)",
                    filter: "blur(22px)",
                  }}
                />
                {/* Sweeping light beam: a broad blurred conic wedge rotating
                    around the emblem's center - the "radar" light that
                    washes across the bull as it circles. Centered with
                    inset-0/m-auto because motion's rotate would override a
                    translate-based centering. */}
                {!reduce && (
                  <motion.div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-10 m-auto aspect-square w-[66vmin] max-w-[540px] rounded-full"
                    style={{
                      background:
                        "conic-gradient(from 0deg, transparent 0deg, transparent 296deg, rgba(210,168,81,0.10) 318deg, rgba(231,217,180,0.38) 344deg, rgba(255,253,247,0.30) 352deg, rgba(210,168,81,0.10) 358deg, transparent 360deg)",
                      filter: "blur(12px)",
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 9, repeat: Infinity, ease: "linear" }}
                  />
                )}
                <StaticEmblem />
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
      </motion.div>

      {/* Scroll cue - appears after the load moment settles, sits just above
          the tape, and fades out on the first bit of scroll. */}
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 2.2 }}
        className="pointer-events-none relative z-10 mb-5 flex justify-center"
      >
        <motion.div
          style={reduce ? undefined : { opacity: cueOpacity }}
          className="flex flex-col items-center gap-2.5"
        >
          <span className="font-data text-3xs uppercase tracking-[0.32em] text-muted-slate">
            Scroll
          </span>
          <span className="relative h-9 w-px overflow-hidden rounded-full bg-cream/15">
            {!reduce && (
              <motion.span
                className="absolute left-0 top-0 h-3.5 w-px rounded-full bg-gold-bright"
                animate={{ y: [-14, 38] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </span>
        </motion.div>
      </motion.div>

      {/* Live-styled signal tape along the hero's lower edge. */}
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.6 }}
        className="relative z-10"
      >
        <SignalTape />
      </motion.div>
    </section>
  );
}
