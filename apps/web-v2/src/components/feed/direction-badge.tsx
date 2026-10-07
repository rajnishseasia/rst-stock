/**
 * Direction pill for a caller's STATED side, shared by the feed rows and the
 * chart-screen thesis card.
 *
 * Rendered ONLY for a direction the caller stated: the prop is
 * `SignalDirection`, never a defaulted side, so absence is expressed by the
 * parent not rendering this at all (see signal-thesis.ts for why that matters).
 *
 * Styled on the brand direction ramp (green-500/red-500 over the shared tint
 * tokens) rather than raw emerald/red palette classes, matching the canonical
 * chip recipe: solid direction color as text over a tint of the same color,
 * no border.
 */

import { cn } from "@/lib/utils";
import { signalDirectionLabel, type SignalDirection } from "./signal-thesis";

export function DirectionBadge({
  direction,
  className,
}: {
  direction: SignalDirection;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide",
        direction === "short"
          ? "bg-loss-tint text-red-500"
          : "bg-gain-tint text-green-500",
        className,
      )}
    >
      {signalDirectionLabel(direction)}
    </span>
  );
}
