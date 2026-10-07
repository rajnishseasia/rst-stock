"use client";

/**
 * SignalSourcesSection - "Every signal. One tape."
 *
 * Overhaul: the four sources sit as compact nodes on the left, each with a
 * flowing gold "wire" into a live unified-feed terminal card on the right.
 * The feed card cycles new signal rows in every few seconds so the product
 * feels alive without any user action. Everything degrades to a static
 * composition under prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useInView,
  useReducedMotion,
} from "motion/react";
import { Users } from "lucide-react";
import { SpotlightCard, RiseWords, TiltCard } from "./fx";

const GAIN = "#41cf95";

export function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className ?? "h-4 w-4 fill-cream/70"}>
      <path d="M18.9 2H22l-7.37 8.42L23.3 22h-6.6l-5.18-6.77L5.6 22H2.5l7.88-9L1 2h6.77l4.68 6.19L18.9 2Zm-1.16 18h1.83L7.34 3.9H5.38L17.74 20Z" />
    </svg>
  );
}

export function DiscordGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className ?? "h-4 w-4 fill-cream/70"}>
      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.5 0 12.6 12.6 0 0 0-.61-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06c0 .02.01.04.03.05a19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.1 13 13 0 0 1-1.87-.9.08.08 0 0 1-.01-.12c.13-.1.25-.19.37-.29a.07.07 0 0 1 .08 0c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08 0c.12.1.25.2.37.3a.08.08 0 0 1 0 .12 12 12 0 0 1-1.88.89.08.08 0 0 0-.04.1c.36.7.77 1.37 1.22 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6.02-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z" />
    </svg>
  );
}

const SOURCES = [
  { icon: <XGlyph />, name: "X callers", detail: "Tracked accounts, parsed as they post" },
  { icon: <DiscordGlyph />, name: "Discord room", detail: "The stock-calls channel, live" },
  {
    icon: <Users className="h-4 w-4 text-cream/70" strokeWidth={1.5} />,
    name: "Site traders",
    detail: "Real shared fills from the platform",
  },
];

type FeedRow = {
  id: number;
  tag: string;
  text: string;
  source: string;
};

const FEED_POOL: Omit<FeedRow, "id">[] = [
  { tag: "$NVDA", text: "long the reclaim of 920, stop under LOD", source: "@thetapereader" },
  { tag: "$AMD", text: "shared fill 158.40, exits attached", source: "Copper Wolf" },
  { tag: "$TSLA", text: "momentum setup, defined invalidation", source: "@chartsurgeon" },
  { tag: "$SPY", text: "calls over 552, tight risk", source: "stock-calls" },
  { tag: "$MSFT", text: "breakout hold, adding on strength", source: "@wickwatcher" },
  { tag: "$COIN", text: "momentum building, watching 265", source: "Vega Nomad" },
];

/** How many rows the card shows at once. Must stay < FEED_POOL.length. */
const WINDOW = 4;

/**
 * Age label by row position rather than a value baked into the row: the top
 * row is always the freshest, and a row visibly ages as it is pushed down.
 * Storing the age on the row instead made every inserted row read "now"
 * forever, so the whole card eventually showed four "now" timestamps.
 */
const AGES = ["now", "18s", "44s", "2m"];

function FeedItem({ row, age }: { row: Omit<FeedRow, "id">; age: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-cream/5 px-5 py-3.5 last:border-b-0">
      <span className="mt-0.5 font-data text-xs font-semibold" style={{ color: GAIN }}>
        {row.tag}
      </span>
      <span className="flex-1 text-sm leading-snug text-cream/85">{row.text}</span>
      <span className="text-right">
        <span className="block font-data text-2xs text-muted-slate">{row.source}</span>
        <span className="block font-data text-3xs tabular-nums text-muted-slate/60">{age}</span>
      </span>
    </div>
  );
}

function LiveFeedCard() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [rows, setRows] = useState<FeedRow[]>(() =>
    FEED_POOL.slice(0, WINDOW).map((r, i) => ({ ...r, id: i }))
  );
  // Mirrors `rows` so the interval can read the current window without
  // re-subscribing, and without mutating cursors inside a state updater
  // (StrictMode invokes updaters twice).
  const rowsRef = useRef(rows);
  const cursor = useRef(WINDOW);
  const uid = useRef(WINDOW);

  // Cycle a new row in every few seconds while visible.
  useEffect(() => {
    if (reduce || !inView) return;
    const interval = setInterval(() => {
      const kept = rowsRef.current.slice(0, WINDOW - 1);
      const visible = new Set(kept.map((r) => r.tag));
      // Skip any symbol still on screen, otherwise the pool wraps around
      // while an older copy is still in the window and the same ticker
      // renders twice at once.
      let incoming = FEED_POOL[cursor.current % FEED_POOL.length];
      while (visible.has(incoming.tag)) {
        cursor.current += 1;
        incoming = FEED_POOL[cursor.current % FEED_POOL.length];
      }
      cursor.current += 1;
      uid.current += 1;

      const next = [{ ...incoming, id: uid.current }, ...kept];
      rowsRef.current = next;
      setRows(next);
    }, 2800);
    return () => clearInterval(interval);
  }, [reduce, inView]);

  return (
    <TiltCard maxDeg={3}>
    <SpotlightCard className="glass-edge rounded-2xl border border-cream/10 bg-[#10171f]/95">
      <div ref={ref}>
        <div className="flex items-center justify-between border-b border-cream/10 px-5 py-3.5">
          <span className="font-data text-2xs uppercase tracking-[0.2em] text-muted-slate">
            Unified tape
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              {!reduce && (
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                  style={{ backgroundColor: GAIN }}
                />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: GAIN }} />
            </span>
            <span className="font-data text-3xs uppercase tracking-[0.16em]" style={{ color: GAIN }}>
              Live
            </span>
          </span>
        </div>
        <div className="relative overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row, i) => (
              <motion.div
                key={row.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: -18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              >
                <FeedItem row={row} age={AGES[i] ?? AGES[AGES.length - 1]} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="border-t border-cream/10 px-5 py-2.5">
          <span className="font-data text-3xs uppercase tracking-[0.16em] text-muted-slate/70">
            Streaming over WebSockets
          </span>
        </div>
      </div>
    </SpotlightCard>
    </TiltCard>
  );
}

export function SignalSourcesSection() {
  const reduce = useReducedMotion();

  return (
    <section className="relative overflow-hidden bg-charcoal-deep py-28 sm:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 90% 70% at 15% 10%, #171f2a 0%, #0c151e 70%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-6">
        <h2 className="max-w-2xl font-wordmark text-4xl font-bold tracking-tight text-cream sm:text-5xl lg:text-6xl">
          <RiseWords text="Every signal." />
          <br />
          <RiseWords text="One tape." delay={0.18} />
        </h2>
        <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-slate sm:text-lg">
          Three streams, one feed you can act on the moment it prints.
        </p>

        <div className="mt-16 grid grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-4">
          {/* Source nodes with flowing wires into the feed. */}
          <div className="flex flex-col gap-3">
            {SOURCES.map((source, i) => (
              <motion.div
                key={source.name}
                initial={reduce ? false : { opacity: 0, x: -24 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.55, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex items-center gap-4 rounded-xl border border-cream/10 bg-charcoal/50 py-4 pl-4 pr-6 lg:rounded-r-none lg:border-r-0"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold/25 bg-gold/10">
                  {source.icon}
                </span>
                <span className="min-w-0">
                  <span className="block font-wordmark text-sm font-semibold text-cream">
                    {source.name}
                  </span>
                  <span className="block truncate text-xs text-muted-slate">{source.detail}</span>
                </span>
                {/* Wire: flows right into the feed column on desktop. */}
                <span
                  aria-hidden
                  className="absolute -right-4 top-1/2 hidden h-px w-4 -translate-y-1/2 overflow-hidden lg:block"
                >
                  <span className="absolute inset-0 bg-gold/25" />
                  {!reduce && (
                    <motion.span
                      className="absolute top-0 h-full w-3 bg-gradient-to-r from-transparent via-gold-bright to-transparent"
                      animate={{ x: [-14, 20] }}
                      transition={{
                        duration: 1.6,
                        repeat: Infinity,
                        ease: "linear",
                        delay: i * 0.35,
                      }}
                    />
                  )}
                </span>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <LiveFeedCard />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
