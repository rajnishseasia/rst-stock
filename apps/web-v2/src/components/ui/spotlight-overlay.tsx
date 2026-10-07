"use client";

/**
 * SpotlightOverlay - a drop-in cursor spotlight for any panel.
 *
 * Render it as a child of a `relative` container, BEFORE that container's
 * other children, and give those children `relative` so they paint on top of
 * it. It tracks the pointer on its PARENT element and paints a soft gold
 * radial that follows the cursor (the effect from the landing page's
 * trade-ticket card). Position updates mutate CSS variables directly - no
 * React re-renders per frame.
 *
 * Pointer reads are coalesced into one rAF callback: pointermove can fire
 * faster than the display refreshes, and the host panel (e.g. the trade form)
 * re-renders constantly, so an unthrottled getBoundingClientRect() per event
 * forces a synchronous layout on a dirty tree.
 *
 * Inert on touch/no-hover devices and under prefers-reduced-motion.
 */

import { useEffect, useRef } from "react";

export function SpotlightOverlay({
  radius = 320,
  strength = 0.08,
}: {
  radius?: number;
  strength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (reduce || !canHover) return;

    let frame = 0;
    let clientX = 0;
    let clientY = 0;

    const paint = () => {
      frame = 0;
      const r = parent.getBoundingClientRect();
      el.style.setProperty("--sx", `${clientX - r.left}px`);
      el.style.setProperty("--sy", `${clientY - r.top}px`);
      el.style.opacity = "1";
    };
    const move = (e: PointerEvent) => {
      clientX = e.clientX;
      clientY = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      el.style.opacity = "0";
    };
    parent.addEventListener("pointermove", move);
    parent.addEventListener("pointerleave", leave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      parent.removeEventListener("pointermove", move);
      parent.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 opacity-0 transition-opacity duration-300"
      style={{
        background: `radial-gradient(${radius}px circle at var(--sx, -400px) var(--sy, -400px), rgba(210, 168, 81, ${strength}), transparent 70%)`,
      }}
    />
  );
}
