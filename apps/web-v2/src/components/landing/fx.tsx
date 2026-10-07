"use client";

/**
 * fx - shared motion primitives for the landing overhaul.
 *
 *   GrainOverlay   - fixed film-grain wash over the whole page (GPU-cheap:
 *                    one fixed pointer-events-none layer, never repaints).
 *   Counter        - mono number that counts up when scrolled into view.
 *   MagneticButton - CTA that leans toward the cursor on hover (springs on
 *                    motion values only; no React re-renders per frame).
 *   SpotlightCard  - card whose border/glow follows the cursor.
 *
 * Every primitive collapses to static under prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useInView,
  useReducedMotion,
  animate,
  useMotionTemplate,
} from "motion/react";

/**
 * Hover-capability probe: pointer-driven effects (tilt, magnetic pull) are
 * skipped on touch devices, where pointermove only fires during scroll-drags
 * and makes cards wobble. SSR-safe: defaults to false until mounted.
 */
export function useCanHover() {
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    setCanHover(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return canHover;
}

/* Film grain as an inline SVG feTurbulence tile - no asset request. */
const GRAIN_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E";

export function GrainOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] opacity-[0.05] mix-blend-overlay"
      style={{ backgroundImage: `url("${GRAIN_URI}")` }}
    />
  );
}

export function Counter({
  to,
  prefix = "",
  suffix = "",
  decimals = 0,
  className,
  duration = 1.6,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? to : 0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setDisplay(to);
      return;
    }
    const controls = animate(0, to, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [inView, to, reduce, duration]);

  const formatted = display.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span ref={ref} className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

export function MagneticButton({
  children,
  className,
  onClick,
  strength = 0.35,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  strength?: number;
}) {
  const reduce = useReducedMotion();
  const canHover = useCanHover();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 200, damping: 18 });
  const sy = useSpring(y, { stiffness: 200, damping: 18 });
  const inert = reduce || !canHover;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      style={inert ? undefined : { x: sx, y: sy }}
      onPointerMove={(e) => {
        if (inert) return;
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * strength);
        y.set((e.clientY - (r.top + r.height / 2)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
      whileTap={{ scale: 0.97 }}
      className={className}
    >
      {children}
    </motion.button>
  );
}

export function SpotlightCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const mx = useMotionValue(-400);
  const my = useMotionValue(-400);
  const spotlight = useMotionTemplate`radial-gradient(340px circle at ${mx}px ${my}px, rgba(210,168,81,0.10), transparent 70%)`;
  const borderGlow = useMotionTemplate`radial-gradient(220px circle at ${mx}px ${my}px, rgba(210,168,81,0.45), transparent 70%)`;

  return (
    <div
      className={["group relative overflow-hidden", className ?? ""].join(" ")}
      onPointerMove={(e) => {
        if (reduce) return;
        const r = e.currentTarget.getBoundingClientRect();
        mx.set(e.clientX - r.left);
        my.set(e.clientY - r.top);
      }}
      onPointerLeave={() => {
        mx.set(-400);
        my.set(-400);
      }}
    >
      {/* Cursor-following border highlight, masked to a 1px ring. */}
      {!reduce && (
        <>
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background: borderGlow,
              padding: 1,
              WebkitMask:
                "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
              WebkitMaskComposite: "xor",
              maskComposite: "exclude",
            }}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{ background: spotlight }}
          />
        </>
      )}
      {children}
    </div>
  );
}

/**
 * Starfield - animated gold dust particles layered over the static dust
 * texture. Each star twinkles and drifts slowly upward via the .rst-star
 * CSS keyframe (compositor-only). Placement/timing come from a seeded PRNG
 * so the server and client render the identical field (no hydration
 * mismatch) - never Math.random() in render. Negative animation delays
 * scatter the stars through their cycles so the field is alive on load.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_TONES = ["#d2a851", "#e7d9b4", "#c59a3e", "#f4f1ea"];

export function Starfield({ count = 48 }: { count?: number }) {
  // Seeded, so SSR and client agree; memoized, so the hero's 94 stars are not
  // rebuilt on every parent re-render.
  const stars = useMemo(() => {
    const rand = mulberry32(20260708);
    return Array.from({ length: count }, (_, i) => {
      const dur = 2.1 + rand() * 2.9;
      return {
        id: i,
        left: rand() * 100,
        top: rand() * 100,
        size: 1.7 + rand() * 3.1,
        tone: STAR_TONES[Math.floor(rand() * STAR_TONES.length)],
        tw: 0.55 + rand() * 0.45,
        drift: 30 + rand() * 46,
        sway: (rand() - 0.5) * 26,
        dur,
        delay: -rand() * dur,
      };
    });
  }, [count]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {stars.map((s) => (
        <span
          key={s.id}
          className="rst-star absolute rounded-full"
          style={
            {
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: s.size,
              height: s.size,
              backgroundColor: s.tone,
              boxShadow: s.size > 2.5 ? `0 0 ${s.size * 4}px ${s.tone}` : undefined,
              "--dur": `${s.dur}s`,
              "--delay": `${s.delay}s`,
              "--tw": s.tw,
              "--drift": `-${s.drift}px`,
              "--sway": `${s.sway}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * TiltCard - subtle 3D perspective tilt following the pointer (max ~4deg),
 * springs back on leave. Rotation runs on motion values only (no re-renders)
 * and the whole effect is skipped under reduced motion.
 */
export function TiltCard({
  children,
  className,
  maxDeg = 4,
}: {
  children: ReactNode;
  className?: string;
  maxDeg?: number;
}) {
  const reduce = useReducedMotion();
  const canHover = useCanHover();
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 140, damping: 18 });
  const sry = useSpring(ry, { stiffness: 140, damping: 18 });

  if (reduce || !canHover) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={className} style={{ perspective: 1000 }}>
      <motion.div
        style={{ rotateX: srx, rotateY: sry, transformStyle: "preserve-3d" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ry.set(((e.clientX - r.left) / r.width - 0.5) * 2 * maxDeg);
          rx.set(-((e.clientY - r.top) / r.height - 0.5) * 2 * maxDeg);
        }}
        onPointerLeave={() => {
          rx.set(0);
          ry.set(0);
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/**
 * Word-by-word rise-in for display headlines.
 *
 * The in-view trigger lives on the stable parent span, NOT on the translated
 * words: a word translated 110% inside an overflow-hidden clip has zero
 * visible area, so an IntersectionObserver watching the word itself may
 * never fire and the headline stays invisible. The parent is never
 * transformed, so it observes reliably and staggers its children.
 *
 * The inter-word separator is a NON-BREAKING space (U+00A0) on purpose: a
 * plain " " would sit at the end of the inner inline-block's line box, where
 * CSS trims trailing collapsible whitespace, and the words would render
 * jammed together ("Everysignal."). Line breaks still occur between the
 * adjacent inline-block word wrappers, so wrapping is unaffected.
 */
export function RiseWords({
  text,
  className,
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const words = text.split(" ");
  if (reduce) {
    return <span className={className}>{text}</span>;
  }
  return (
    <motion.span
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.4 }}
      variants={{
        show: { transition: { staggerChildren: 0.07, delayChildren: delay } },
      }}
    >
      {/* aria-label on a plain span isn't reliably exposed by screen readers,
          so the real text lives in an sr-only node and the animated words
          are hidden from the accessibility tree entirely. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, i) => (
          <span
            key={`${word}-${i}`}
            className="inline-block overflow-hidden pb-1 align-bottom"
          >
            <motion.span
              className="inline-block"
              variants={{
                hidden: { y: "110%" },
                show: {
                  y: 0,
                  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
                },
              }}
            >
              {word}
              {i < words.length - 1 ? " " : ""}
            </motion.span>
          </span>
        ))}
      </span>
    </motion.span>
  );
}
