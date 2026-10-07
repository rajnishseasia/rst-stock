import type { ChangeTone } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The one shared gain/loss badge: solid direction color as text over a 15%
 * tint of the same color, pill radius, no border. Every percent-change chip
 * in the app renders through this so direction reads as one system.
 *
 * The component does ZERO number formatting (audit M16): callers pass display
 * text already produced by formatChangePct, formatPerpChangePct, or
 * formatSignalChipChange, together with its tone, so a badge can never
 * re-derive direction from a formatted string.
 */
export interface ChangeBadgeProps {
  /** Preformatted display text, sign included ("+1.25%", "-0.40%", "-"). */
  text: string;
  tone: ChangeTone;
  /** "sm" drops to the 10px micro size for dense list rows. */
  size?: "default" | "sm";
  className?: string;
}

const TONE_CLASS: Record<ChangeTone, string> = {
  positive: "bg-gain-tint text-green-500",
  negative: "bg-loss-tint text-red-500",
  neutral: "bg-muted/40 text-muted-foreground",
};

export function ChangeBadge({
  text,
  tone,
  size = "default",
  className,
}: ChangeBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium tabular-nums",
        size === "sm" ? "px-1 text-3xs" : "px-1.5 py-0.5 text-2xs",
        TONE_CLASS[tone],
        className,
      )}
    >
      {/* Decorative direction triangle; the +/- sign stays in the text so
          copy-paste and screen readers keep the direction. */}
      {tone !== "neutral" && (
        <span
          aria-hidden="true"
          className={cn(
            "size-0 shrink-0 border-x-4 border-x-transparent",
            tone === "positive"
              ? "border-b-[6px] border-b-current"
              : "border-t-[6px] border-t-current",
          )}
        />
      )}
      {text}
    </span>
  );
}
