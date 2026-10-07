"use client";

/**
 * FeatureGridSection - "The rest of the cockpit", overhauled.
 *
 * Five spotlight cells (2 wide + 3 narrow). Each carries a small living
 * preview instead of static text: the chat answers in, the chart draws
 * itself with a signal marker popping on, leaderboard rows slide in,
 * avatars stack, the Discord fill alert types on. All previews are real
 * DOM mini-components in the product's own visual language.
 */

import {
  motion,
  useReducedMotion,
} from "motion/react";
import { Trophy, Users, Bell } from "lucide-react";
import { SpotlightCard, RiseWords } from "./fx";

const GAIN = "#41cf95";

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

function Cell({
  children,
  delay,
  className,
}: {
  children: React.ReactNode;
  delay: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      whileHover={reduce ? undefined : { y: -4 }}
      transition={{ duration: 0.65, delay, ease: EASE }}
      className={className}
    >
      <SpotlightCard className="glass-edge-soft h-full rounded-2xl border border-cream/10 bg-charcoal/60 transition-colors duration-300 hover:border-cream/20">
        <div className="flex h-full flex-col p-7">{children}</div>
      </SpotlightCard>
    </motion.div>
  );
}

function ChatPreview() {
  const reduce = useReducedMotion();
  return (
    <div className="mt-6 space-y-2.5">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: 0.4, delay: 0.3, ease: EASE }}
        className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-gold/15 px-4 py-2.5 text-sm text-cream/90"
      >
        How did my NVDA entry look against the filings this week?
      </motion.div>
      <div className="relative">
        {/* Typing indicator flashes in the answer's spot before it lands. */}
        {!reduce && (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: [0, 1, 1, 0] }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: 0.9, delay: 0.55, times: [0, 0.2, 0.8, 1] }}
            className="absolute left-0 top-0 flex w-fit items-center gap-1 rounded-2xl rounded-bl-sm border border-cream/10 bg-charcoal-deep/70 px-4 py-3"
          >
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-muted-slate"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.18 }}
              />
            ))}
          </motion.div>
        )}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 1.5, ease: EASE }}
          className="w-fit max-w-[90%] rounded-2xl rounded-bl-sm border border-cream/10 bg-charcoal-deep/70 px-4 py-2.5 text-sm text-muted-slate"
        >
          Your fill sits 0.8% above Tuesday&apos;s breakout. The 10-Q shows data
          center revenue up again, and you have 38 shares with the stop at 917.60.
        </motion.div>
      </div>
    </div>
  );
}

function ChartPreview() {
  const reduce = useReducedMotion();
  const points = "0,64 30,58 60,60 90,48 120,52 150,38 180,42 210,26 240,30 270,14";
  return (
    <svg
      viewBox="0 0 280 80"
      className="mt-6 w-full"
      role="img"
      aria-label="Price line drawing itself with a signal marker"
    >
      <motion.polyline
        points={points}
        fill="none"
        stroke={GAIN}
        strokeWidth={2}
        strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, amount: 0.7 }}
        transition={{ duration: 1.6, ease: "easeOut" }}
      />
      <motion.g
        initial={reduce ? false : { opacity: 0, scale: 0.6 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.7 }}
        transition={{ duration: 0.4, delay: 1.0, ease: EASE }}
        style={{ transformOrigin: "150px 38px" }}
      >
        <circle cx={150} cy={38} r={4} fill="#d2a851" />
        <rect
          x={104}
          y={8}
          width={92}
          height={20}
          rx={10}
          fill="rgba(210,168,81,0.14)"
          stroke="rgba(210,168,81,0.4)"
        />
        <text x={150} y={22} textAnchor="middle" fontSize={10} fill="#d2a851" className="font-data">
          signal fired
        </text>
      </motion.g>
    </svg>
  );
}

function LeaderboardPreview() {
  const reduce = useReducedMotion();
  const rows = [
    { rank: 1, name: "Copper Wolf", stat: "+31.2%" },
    { rank: 2, name: "@thetapereader", stat: "+24.8%" },
    { rank: 3, name: "Iron Fern", stat: "+19.5%" },
  ];
  return (
    <div className="mt-6 space-y-2">
      {rows.map((row, i) => (
        <motion.div
          key={row.rank}
          initial={reduce ? false : { opacity: 0, x: -14 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.4, delay: 0.2 + i * 0.12, ease: EASE }}
          className="flex items-center justify-between rounded-lg border border-cream/5 bg-charcoal-deep/60 px-3.5 py-2"
        >
          <span className="flex items-center gap-2.5">
            <span className="font-data text-xs text-gold-bright">{row.rank}</span>
            <span className="font-data text-xs text-cream/85">{row.name}</span>
          </span>
          <span className="font-data text-xs tabular-nums" style={{ color: GAIN }}>
            {row.stat}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

function FollowPreview() {
  const reduce = useReducedMotion();
  const initials = ["CW", "TR", "IF"];
  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex -space-x-2.5">
          {initials.map((tag, i) => (
            <motion.span
              key={tag}
              initial={reduce ? false : { opacity: 0, scale: 0.5 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{ duration: 0.35, delay: 0.2 + i * 0.1, ease: EASE }}
              className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-charcoal bg-gradient-to-br from-gold to-gold-lo font-data text-2xs font-semibold text-charcoal-deep"
            >
              {tag}
            </motion.span>
          ))}
        </div>
        <motion.span
          initial={reduce ? false : { opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.4, delay: 0.55 }}
          className="rounded-full border border-gold/30 bg-gold/10 px-3 py-1 font-data text-3xs uppercase tracking-[0.16em] text-gold-bright"
        >
          Auto-copying
        </motion.span>
      </div>
      {/* Copy-from attribution, exactly as it appears in the feed. */}
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: 0.4, delay: 0.7, ease: EASE }}
        className="rounded-lg border border-cream/5 bg-charcoal-deep/60 px-3.5 py-2"
      >
        <span className="font-data text-xs text-cream/85">
          Long 71 AMD <span className="text-muted-slate">· copied from Copper Wolf</span>
        </span>
      </motion.div>
    </div>
  );
}

function AlertPreview() {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.8 }}
      transition={{ duration: 0.45, delay: 0.3, ease: EASE }}
      className="mt-6 rounded-lg border border-cream/5 bg-charcoal-deep/60 px-3.5 py-2.5"
    >
      <span className="font-data text-2xs text-muted-slate">#trade-alerts</span>
      <p className="mt-1 font-data text-xs text-cream/85">
        Filled: 38 NVDA @ $924.10 <span style={{ color: GAIN }}>· exits attached</span>
      </p>
    </motion.div>
  );
}

export function FeatureGridSection() {
  return (
    <section className="relative overflow-hidden bg-charcoal-deep py-28 sm:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 90% 70% at 50% 100%, #161e29 0%, #0c151e 70%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-6">
        <h2 className="font-wordmark text-4xl font-bold tracking-tight text-cream sm:text-5xl lg:text-6xl">
          <RiseWords text="The rest of the cockpit." />
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-6">
          <Cell delay={0} className="lg:col-span-3">
            <h3 className="wght-title font-wordmark text-lg text-cream">AI research desk</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-slate">
              A streaming chat that can read your positions, pull quotes and
              bars, and dig through filings and news while you trade.
            </p>
            <ChatPreview />
          </Cell>

          <Cell delay={0.08} className="lg:col-span-3">
            <h3 className="wght-title font-wordmark text-lg text-cream">
              Charts that know your signals
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-slate">
              TradingView advanced charts with every signal and order annotated
              right on the candles.
            </p>
            <ChartPreview />
          </Cell>

          <Cell delay={0} className="lg:col-span-2">
            <Trophy className="h-5 w-5 text-gold-bright" strokeWidth={1.5} />
            <h3 className="wght-title mt-3 font-wordmark text-lg text-cream">Leaderboard</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-slate">
              See which callers and traders actually deliver over time.
            </p>
            <LeaderboardPreview />
          </Cell>

          <Cell delay={0.08} className="lg:col-span-2">
            <Users className="h-5 w-5 text-gold-bright" strokeWidth={1.5} />
            <h3 className="wght-title mt-3 font-wordmark text-lg text-cream">Follow traders</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-slate">
              Follow the traders you rate and copy their entries into your own
              sized ticket.
            </p>
            <FollowPreview />
          </Cell>

          <Cell delay={0.16} className="lg:col-span-2">
            <Bell className="h-5 w-5 text-gold-bright" strokeWidth={1.5} />
            <h3 className="wght-title mt-3 font-wordmark text-lg text-cream">Fills to Discord</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-slate">
              Every fill pings your Discord, and your P&amp;L exports as a
              shareable card.
            </p>
            <AlertPreview />
          </Cell>
        </div>
      </div>
    </section>
  );
}
