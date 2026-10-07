"use client";

/**
 * BullAssembly - the centered RST emblem that assembles from nothing into the
 * full mark as the user scrolls: the gold RING (READY), then the gold
 * horn-arrows (SET), then the cream bull FACE (TRADE), finishing with a gold rim
 * glow as the emblem "ignites."
 *
 * All three layers share an identical square box with object-contain, which is
 * what guarantees they recombine into the exact full emblem.
 *
 * When prefers-reduced-motion is set, this renders the static fully-assembled
 * emblem with no scroll transforms.
 */

import Image from "next/image";
import {
  motion,
  useTransform,
  type MotionStyle,
  type MotionValue,
} from "motion/react";

const STAGE =
  "absolute inset-0 mx-auto my-auto h-full w-full select-none";

function Layer({
  src,
  style,
}: {
  src: string;
  style: MotionStyle;
}) {
  return (
    <motion.div className={STAGE} style={style}>
      <Image
        src={src}
        alt=""
        fill
        priority
        sizes="(max-width: 640px) 70vmin, 560px"
        className="object-contain"
      />
    </motion.div>
  );
}

/**
 * StaticEmblem - the fully-assembled mark, no motion. Used for the
 * prefers-reduced-motion fallback so it never needs a scroll MotionValue.
 */
export function StaticEmblem() {
  return (
    <div className="relative flex items-center justify-center">
      <div className="relative aspect-square w-[64vmin] max-w-[520px]">
        <Image
          src="/brand/emblem-dark.png"
          alt="The Ready Set Trade bull emblem"
          fill
          priority
          sizes="(max-width: 640px) 70vmin, 560px"
          className="object-contain"
        />
      </div>
    </div>
  );
}

export function BullAssembly({
  progress,
  reducedMotion,
}: {
  progress: MotionValue<number>;
  reducedMotion: boolean;
}) {
  // Hooks must run unconditionally even in the reduced-motion branch; the
  // resulting MotionValues are simply unused when we render the static emblem.
  // RING - READY. Earliest to appear, smallest parallax travel.
  const ringOpacity = useTransform(progress, [0, 0.1], [0, 1]);
  const ringScale = useTransform(progress, [0, 0.16], [0.62, 1]);
  const ringRotate = useTransform(progress, [0, 0.16], [-10, 0]);
  const ringY = useTransform(progress, [0, 1], [10, -10]);

  // HORNS - SET. Settles in with a slight overshoot, plus medium parallax that
  // keeps drifting after the settle (combined into one Y so it stays a single
  // top-level hook).
  const hornsOpacity = useTransform(progress, [0.26, 0.44], [0, 1]);
  const hornsScale = useTransform(progress, [0.26, 0.5], [1.18, 1]);
  const hornsRotate = useTransform(progress, [0.26, 0.5], [4, 0]);
  const hornsY = useTransform(
    progress,
    [0, 0.26, 0.46, 1],
    [-20, -46, 0, -26]
  );

  // FACE - TRADE. Rises into place last.
  const faceOpacity = useTransform(progress, [0.56, 0.76], [0, 1]);
  const faceScale = useTransform(progress, [0.56, 0.8], [0.86, 1]);
  const faceY = useTransform(progress, [0.56, 0.8], [44, 0]);

  // GOLD RIM GLOW - the emblem ignites gold once complete.
  const glowOpacity = useTransform(progress, [0.72, 0.92], [0, 1]);

  if (reducedMotion) {
    return <StaticEmblem />;
  }

  return (
    <div className="relative flex items-center justify-center">
      <div className="relative aspect-square w-[64vmin] max-w-[520px]">
        {/* Gold rim glow - sits behind the emblem and lights up when complete. */}
        <motion.div
          aria-hidden
          style={{ opacity: glowOpacity }}
          className="pointer-events-none absolute inset-0 -z-10"
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at center, rgba(210,168,81,0.45) 0%, rgba(197,154,62,0.18) 42%, rgba(197,154,62,0) 68%)",
              filter: "blur(8px)",
            }}
          />
        </motion.div>

        <Layer
          src="/brand/landing/emblem-ring.png"
          style={{
            opacity: ringOpacity,
            scale: ringScale,
            rotate: ringRotate,
            y: ringY,
          }}
        />
        <Layer
          src="/brand/landing/emblem-horns.png"
          style={{
            opacity: hornsOpacity,
            scale: hornsScale,
            rotate: hornsRotate,
            y: hornsY,
          }}
        />
        <Layer
          src="/brand/landing/emblem-face.png"
          style={{
            opacity: faceOpacity,
            scale: faceScale,
            y: faceY,
          }}
        />
      </div>
    </div>
  );
}
