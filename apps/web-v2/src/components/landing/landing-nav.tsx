"use client";

/**
 * LandingNav - slim sticky bar that floats transparent over the hero and
 * grows a charcoal backdrop-blur once the visitor scrolls. Slides down as
 * part of the hero's load moment, and carries a gold scroll-progress
 * hairline along its bottom edge. Always the dark/charcoal world..
 */

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  motion,
  useScroll,
  useSpring,
  useMotionValueEvent,
  useReducedMotion,
} from "motion/react";
import { signInWithGoogle } from "@/lib/auth-client";

export function LandingNav() {
  const reduce = useReducedMotion();
  const [scrolled, setScrolled] = useState(false);

  const { scrollY, scrollYProgress } = useScroll();
  useMotionValueEvent(scrollY, "change", (v) => setScrolled(v > 24));
  // "change" only fires on subsequent scrolls, so seed from the position the
  // page actually loaded at (browser scroll restoration, or a #hash landing) -
  // otherwise the bar stays transparent over content until the first scroll.
  useEffect(() => {
    setScrolled(scrollY.get() > 24);
  }, [scrollY]);
  const progress = useSpring(scrollYProgress, {
    stiffness: 120,
    damping: 30,
    restDelta: 0.001,
  });

  return (
    <motion.header
      initial={reduce ? false : { y: -64, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      className={[
        "fixed inset-x-0 top-0 z-50 transition-colors duration-500",
        scrolled
          ? "border-b border-gold/10 bg-charcoal-deep/70 backdrop-blur-xl backdrop-saturate-150"
          : "border-b border-transparent bg-transparent",
      ].join(" ")}
    >
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          aria-label="Ready Set Trade home"
          className="flex items-center gap-3"
        >
          <Image
            src="/brand/emblem-dark.png"
            alt=""
            width={32}
            height={32}
            priority
            className="h-8 w-8"
          />
          <span className="hidden font-wordmark text-sm font-semibold uppercase tracking-[0.28em] text-cream sm:inline">
            Ready Set Trade
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-5">
          <Link
            href="/guide"
            className="group relative hidden font-data text-xs uppercase tracking-[0.2em] text-muted-slate transition-colors hover:text-cream sm:inline-flex"
          >
            Guide
            <span className="absolute -bottom-1 left-0 h-px w-0 bg-gold-bright transition-[width] duration-300 group-hover:w-full" />
          </Link>
          <button
            type="button"
            onClick={() => signInWithGoogle()}
            className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-4 py-2 font-data text-2xs font-medium uppercase tracking-[0.16em] text-gold-bright transition-colors duration-300 hover:bg-gold hover:text-charcoal-deep sm:text-xs"
          >
            Enter the Terminal
          </button>
        </div>
      </nav>

      {/* Gold scroll-progress hairline. */}
      <motion.div
        aria-hidden
        style={reduce ? undefined : { scaleX: progress }}
        className={[
          "h-px origin-left bg-gradient-to-r from-gold/60 via-gold-bright to-gold/60",
          reduce ? "hidden" : "",
        ].join(" ")}
      />
    </motion.header>
  );
}
