"use client";

/**
 * TradeDemoSection - the interactive centerpiece, overhauled.
 *
 * Left: three signal cards (X caller, site trader, Discord room). Right: a
 * terminal-styled ticket that cascade-fills on click - size from the 1%
 * risk budget, stop at structure, partial take-profit, trailing runner.
 * While the section is on screen and untouched, the demo advances itself
 * every few seconds; the first click hands control to the visitor.
 *
 * The three numbers under the headline are the product's real defaults
 * (1% risk budget, 0.4R first target, 5% trailing floor), not marketing
 * inventions. All ticket figures are consistent demo data on a $25k account.
 */

import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useInView,
  useReducedMotion,
} from "motion/react";
import { Check, Users } from "lucide-react";
import { SpotlightCard, Counter, RiseWords, TiltCard } from "./fx";
import { XGlyph, DiscordGlyph } from "./signal-sources-section";

const GAIN = "#41cf95";
const LOSS = "#e5654f";

type DemoSignal = {
  id: string;
  sourceLabel: string;
  sourceIcon: React.ReactNode;
  author: string;
  text: string;
  symbol: string;
  entry: number;
  stop: number;
  qty: number;
  tp1: number;
  stopDistance: number;
};

const SIGNALS: DemoSignal[] = [
  {
    id: "x-nvda",
    sourceLabel: "X caller",
    sourceIcon: <XGlyph className="h-4 w-4 fill-cream/60" />,
    author: "@thetapereader",
    text: "$NVDA reclaiming 920 on volume. Long against the low of day.",
    symbol: "NVDA",
    entry: 924.1,
    stop: 917.6,
    qty: 38,
    tp1: 926.7,
    stopDistance: 6.5,
  },
  {
    id: "trader-amd",
    sourceLabel: "Site trader",
    sourceIcon: <Users className="h-4 w-4 text-cream/60" strokeWidth={1.5} />,
    author: "Copper Wolf",
    text: "Shared fill: long $AMD 158.40, stop under the morning base.",
    symbol: "AMD",
    entry: 158.4,
    stop: 154.9,
    qty: 71,
    tp1: 159.8,
    stopDistance: 3.5,
  },
  {
    id: "discord-tsla",
    sourceLabel: "Discord room",
    sourceIcon: <DiscordGlyph className="h-4 w-4 fill-cream/60" />,
    author: "stock-calls",
    text: "$TSLA momentum setup. Entry 262.30 with a defined invalidation.",
    symbol: "TSLA",
    entry: 262.3,
    stop: 257.3,
    qty: 50,
    tp1: 264.3,
    stopDistance: 5.0,
  },
];

const MECHANICS = [
  { value: 1, suffix: "%", label: "per-trade risk budget — configurable" },
  { value: 0.4, suffix: "R", decimals: 1, label: "first take-profit, sells half — adjustable" },
  { value: 5, suffix: "%", label: "trailing stop on the runner — adjustable" },
];

const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function TicketRow({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, x: 16 },
        show: { opacity: 1, x: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
      }}
      className="flex items-baseline justify-between gap-4 border-b border-cream/5 py-3.5 last:border-b-0"
    >
      <span className="font-data text-2xs uppercase tracking-[0.14em] text-muted-slate">
        {label}
      </span>
      <span className="text-right">
        <span
          className="font-data text-sm font-semibold tabular-nums text-cream"
          style={valueColor ? { color: valueColor } : undefined}
        >
          {value}
        </span>
        {sub ? (
          <span className="block font-data text-2xs tabular-nums text-muted-slate">{sub}</span>
        ) : null}
      </span>
    </motion.div>
  );
}

export function TradeDemoSection() {
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLDivElement>(null);
  const inView = useInView(sectionRef, { amount: 0.45 });
  const [activeId, setActiveId] = useState(SIGNALS[0].id);
  const [userDriven, setUserDriven] = useState(false);
  const active = SIGNALS.find((s) => s.id === activeId) ?? SIGNALS[0];

  // Self-driving demo until the visitor takes over.
  useEffect(() => {
    if (reduce || userDriven || !inView) return;
    const interval = setInterval(() => {
      setActiveId((prev) => {
        const i = SIGNALS.findIndex((s) => s.id === prev);
        return SIGNALS[(i + 1) % SIGNALS.length].id;
      });
    }, 4600);
    return () => clearInterval(interval);
  }, [reduce, userDriven, inView]);

  return (
    <section ref={sectionRef} className="relative overflow-hidden bg-charcoal-deep py-28 sm:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 100% 80% at 85% 20%, #161e29 0%, #0c151e 70%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-6">
        <h2 className="max-w-3xl font-wordmark text-4xl font-bold tracking-tight text-cream sm:text-5xl lg:text-6xl">
          <RiseWords text="Click a signal." />
          <br />
          <RiseWords text="The ticket does the math." delay={0.18} />
        </h2>

        <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-slate sm:text-lg">
          Every ticket comes pre-wired with the desk&apos;s exit discipline:
          risk only a set slice of your account, bank half at the first
          target, and let a trailing stop chase the rest. It works from the
          feed, from any open position row, or straight off the chart.
        </p>

        {/* Real product defaults as the numbers - counters, mono, tabular.
            Mobile: number + label share a row; sm+: three columns. */}
        <div className="mt-6 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-6">
          {MECHANICS.map((m) => (
            <div key={m.label} className="flex items-baseline gap-3 sm:block">
              <Counter
                to={m.value}
                suffix={m.suffix}
                decimals={m.decimals ?? 0}
                className="w-20 shrink-0 font-data text-3xl font-semibold tabular-nums text-gold-bright sm:w-auto sm:text-4xl"
              />
              <p className="text-sm leading-snug text-muted-slate sm:mt-1.5 sm:text-sm">{m.label}</p>
            </div>
          ))}
        </div>

        {/* 10-second execution callout — sits directly below the three stats. */}
        <div className="mt-5 flex max-w-2xl items-center gap-5 rounded-xl border border-gold/25 bg-gold/[0.05] px-5 py-4">
          <span
            aria-label="Under 10 seconds"
            className="shrink-0 font-data text-4xl font-bold leading-none tabular-nums text-gold-bright"
          >
            &lt;10s
          </span>
          <div>
            <p className="text-sm font-semibold leading-snug text-cream/90">
              Any stock or options trade, placed in under 10 seconds
            </p>
            <p className="mt-1 text-sm leading-snug text-muted-slate">
              Click a signal and RST handles everything else — position sizing,
              order routing, stop placement, take-profits, and the trailing
              runner. You&apos;re in the trade; RST manages it to close.
            </p>
          </div>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
          {/* Signal picker. These are toggle buttons, not tabs: there is no
              tabpanel and no roving-tabindex/arrow-key handling, so the ARIA
              tab pattern would promise keyboard semantics that do not exist.
              aria-pressed conveys the same "this one is loaded" state. */}
          <div className="flex flex-col gap-4" role="group" aria-label="Demo signals">
            {SIGNALS.map((signal) => {
              const isActive = signal.id === activeId;
              return (
                <button
                  key={signal.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setUserDriven(true);
                    setActiveId(signal.id);
                  }}
                  className={[
                    "group relative overflow-hidden rounded-2xl border p-5 text-left transition-[background-color,border-color,box-shadow,translate,scale] duration-500 ease-spring",
                    isActive
                      ? "border-gold/50 bg-charcoal shadow-[0_18px_50px_-20px_rgba(197,154,62,0.3)]"
                      : "border-cream/10 bg-charcoal/50 hover:-translate-y-1 hover:border-cream/25 hover:bg-charcoal/80 active:scale-[0.99]",
                  ].join(" ")}
                >
                  {/* Progress shimmer under the active card while the demo self-drives. */}
                  {isActive && !userDriven && !reduce && (
                    <motion.span
                      key={`sweep-${signal.id}`}
                      aria-hidden
                      className="absolute bottom-0 left-0 h-[2px] bg-gradient-to-r from-gold/0 via-gold to-gold-bright"
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: 4.6, ease: "linear" }}
                    />
                  )}
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      {signal.sourceIcon}
                      <span className="font-data text-2xs uppercase tracking-[0.16em] text-muted-slate">
                        {signal.sourceLabel}
                      </span>
                    </span>
                    <span className="font-data text-xs text-muted-slate">{signal.author}</span>
                  </div>
                  <p className="mt-3 text-[15px] leading-snug text-cream/90">{signal.text}</p>
                  <span
                    className={[
                      "mt-4 inline-flex items-center gap-1.5 font-data text-2xs uppercase tracking-[0.16em] transition-colors",
                      isActive ? "text-gold-bright" : "text-muted-slate group-hover:text-cream/70",
                    ].join(" ")}
                  >
                    {isActive ? (
                      <>
                        <Check className="h-3.5 w-3.5" strokeWidth={2} />
                        Loaded into ticket
                      </>
                    ) : (
                      "Trade this"
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* The ticket. */}
          <TiltCard>
          <SpotlightCard className="glass-edge rounded-2xl border border-cream/10 bg-[#10171f]/95">
            {/* Gold sheen sweeps the ticket each time a new signal loads. */}
            {!reduce && (
              <motion.span
                key={`flash-${active.id}`}
                aria-hidden
                className="pointer-events-none absolute inset-0 z-10"
                initial={{ x: "-130%" }}
                animate={{ x: "130%" }}
                transition={{ duration: 1.0, ease: "easeOut" }}
                style={{
                  background:
                    "linear-gradient(105deg, transparent 42%, rgba(210,168,81,0.12) 50%, transparent 58%)",
                }}
              />
            )}
            <div className="p-6 sm:p-8">
              <div className="flex items-center justify-between">
                <span className="font-data text-2xs uppercase tracking-[0.2em] text-muted-slate">
                  Trade ticket
                </span>
                <AnimatePresence mode="wait">
                  <motion.span
                    key={active.id}
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.25 }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 font-data text-3xs uppercase tracking-[0.16em] text-gold-bright"
                  >
                    <Check className="h-3 w-3" strokeWidth={2} />
                    Auto-filled
                  </motion.span>
                </AnimatePresence>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={active.id}
                  initial={reduce ? false : "hidden"}
                  animate="show"
                  exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
                  variants={{ show: { opacity: 1, transition: { staggerChildren: 0.06 } } }}
                  className="mt-4"
                >
                  <motion.div
                    variants={{
                      hidden: { opacity: 0, x: 16 },
                      show: {
                        opacity: 1,
                        x: 0,
                        transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] },
                      },
                    }}
                    className="flex items-baseline justify-between border-b border-cream/5 pb-3.5"
                  >
                    <span className="font-data text-3xl font-semibold text-cream">
                      ${active.symbol}
                    </span>
                    <span
                      className="font-data text-xs uppercase tracking-[0.16em]"
                      style={{ color: GAIN }}
                    >
                      Buy long
                    </span>
                  </motion.div>

                  <TicketRow label="Entry" value={`$${usd(active.entry)}`} />
                  <TicketRow
                    label="Stop loss"
                    value={`$${usd(active.stop)}`}
                    sub="auto: low of day"
                    valueColor={LOSS}
                  />
                  <TicketRow label="Max risk" value="$250.00" sub="1% of $25,000" />
                  <TicketRow
                    label="Size"
                    value={`${active.qty} shares`}
                    sub={`$250 ÷ $${usd(active.stopDistance)} stop distance`}
                    valueColor="#d2a851"
                  />
                  <TicketRow
                    label="Take profit"
                    value={`$${usd(active.tp1)}`}
                    sub="0.4R, sells half"
                    valueColor={GAIN}
                  />
                  <TicketRow
                    label="Trailing runner"
                    value="5% trail"
                    sub="rides the rest"
                    valueColor={GAIN}
                  />
                </motion.div>
              </AnimatePresence>

              <p className="mt-5 font-data text-3xs uppercase tracking-[0.14em] text-muted-slate/70">
                Illustrative demo data. Not investment advice.
              </p>
            </div>
          </SpotlightCard>
          </TiltCard>
        </div>
      </div>
    </section>
  );
}
