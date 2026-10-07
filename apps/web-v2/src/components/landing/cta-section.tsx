"use client";

/**
 * CtaSection - the close, overhauled. The full lockup under a breathing gold
 * glow, the headline rising in word by word, a magnetic gold CTA with a
 * hover sheen, the capability strip, and the footer. Always the charcoal
 * world.
 */

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { signInWithGoogle } from "@/lib/auth-client";
import { MagneticButton, RiseWords, Starfield } from "./fx";

const FEATURES = [
  "Alpaca stocks & options",
  "Paper and Live accounts",
  "One-click risk-sized entries",
  "Signals from X & Discord",
  "Leverage on Hyperliquid",
];

export function CtaSection() {
  const reduce = useReducedMotion();
  const year = new Date().getFullYear();

  return (
    <section className="relative overflow-hidden bg-charcoal-deep">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: "radial-gradient(ellipse at 50% 32%, #1a232f 0%, #0c151e 72%)",
          }}
        />
        <div
          className="absolute inset-0 bg-cover bg-center opacity-40 mix-blend-soft-light"
          style={{ backgroundImage: "url(/brand/landing/act3-trade-plate.webp)" }}
        />
        <div
          className="absolute inset-0 bg-cover bg-center opacity-20 mix-blend-screen"
          style={{ backgroundImage: "url(/brand/landing/gold-dust-overlay.webp)" }}
        />
        {/* Breathing gold glow behind the lockup. */}
        <motion.div
          animate={reduce ? undefined : { opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          className="absolute left-1/2 top-[16%] h-[460px] w-[680px] max-w-[90vw] -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(210,168,81,0.18) 0%, rgba(197,154,62,0.07) 45%, rgba(197,154,62,0) 70%)",
            filter: "blur(24px)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(8,14,22,0.65) 100%)",
          }}
        />
        {/* Animated star/dust particles over the static texture. */}
        <Starfield count={47} />
      </div>

      <div className="relative mx-auto h-px w-full max-w-6xl bg-gradient-to-r from-transparent via-gold/40 to-transparent" />

      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-28 text-center sm:py-36">
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.92 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="relative h-56 w-56 sm:h-72 sm:w-72 lg:h-80 lg:w-80"
        >
          <Image
            src="/brand/logo-dark.png"
            alt="Ready Set Trade"
            fill
            sizes="(max-width: 640px) 224px, 320px"
            className="object-contain"
          />
        </motion.div>

        <h2 className="mt-12 font-wordmark text-4xl font-bold leading-[1.1] tracking-tight text-cream sm:text-5xl">
          <RiseWords text="Markets move on signal." />
          <br />
          <RiseWords text="So do you." delay={0.25} />
        </h2>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.6, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mt-3 max-w-xl text-base leading-relaxed text-muted-slate sm:text-lg"
        >
          The premium cockpit for paper and live trading - signals, AI research,
          and bracketed exits in one place.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.6, delay: 0.65, ease: [0.16, 1, 0.3, 1] }}
          className="mt-12 flex w-full flex-col items-center gap-4 sm:w-auto sm:flex-row"
        >
          <MagneticButton
            onClick={() => signInWithGoogle()}
            className="group relative inline-flex h-12 w-full items-center justify-center overflow-hidden rounded-full bg-gold px-8 font-data text-sm font-medium uppercase tracking-[0.16em] text-charcoal-deep transition-colors duration-300 hover:bg-gold-bright sm:w-auto"
          >
            <span className="relative z-10">Enter the Terminal</span>
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          </MagneticButton>
          <Link
            href="/guide"
            className="inline-flex h-12 w-full items-center justify-center rounded-full border border-gold/30 px-8 font-data text-sm font-medium uppercase tracking-[0.16em] text-cream transition-colors duration-300 hover:border-gold/60 hover:text-gold-bright sm:w-auto"
          >
            Read the Guide
          </Link>
        </motion.div>
      </div>

      {/* Capability strip. */}
      <div className="relative z-10 mx-auto w-full max-w-5xl px-6 pb-24">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gold/10 bg-gold/10 lg:grid-cols-5">
          {FEATURES.map((feature, i) => (
            <div
              key={feature}
              className={[
                "flex items-center justify-center bg-charcoal px-5 py-7 text-center",
                i === FEATURES.length - 1 ? "col-span-2 lg:col-span-1" : "",
              ].join(" ")}
            >
              <span className="font-data text-2xs uppercase tracking-[0.18em] text-muted-slate">
                {feature}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer. */}
      <footer className="relative z-10 border-t border-gold/10 bg-charcoal-deep/40 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
          <div className="flex items-center gap-3">
            <Image src="/brand/emblem-dark.png" alt="" width={28} height={28} className="h-7 w-7" />
            <span className="font-wordmark text-xs font-semibold uppercase tracking-[0.28em] text-cream">
              Ready Set Trade
            </span>
          </div>

          <div className="flex items-center gap-10">
            <Link
              href="/guide"
              className="font-data text-xs uppercase tracking-[0.18em] text-muted-slate transition-colors hover:text-cream"
            >
              Guide
            </Link>
            <a
              href="/legal"
              className="font-data text-xs uppercase tracking-[0.18em] text-muted-slate transition-colors hover:text-cream"
            >
              Legal
            </a>
            <button
              type="button"
              onClick={() => signInWithGoogle()}
              className="font-data text-xs uppercase tracking-[0.18em] text-muted-slate transition-colors hover:text-cream"
            >
              Sign in
            </button>
            <span className="font-data text-xs uppercase tracking-[0.18em] text-muted-slate/60">
              © {year}
            </span>
          </div>
        </div>
      </footer>
    </section>
  );
}
