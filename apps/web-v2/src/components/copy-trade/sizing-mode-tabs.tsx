"use client";

import { cn } from "@/lib/utils";
import {
  SIZING_MODES,
  SIZING_MODE_PRESENTATION,
  type SizingMode,
} from "./mirror-sizing";

/** Keep the sizing selector tappable until the desktop drawer reaches xl. */
const TOUCH_HEIGHT_COMPACT_XL = "h-11 xl:h-7";

/**
 * The four-way sizing-mode selector, rendered from the one shared table.
 *
 * Both the panel's manual-copy control and the per-follow mirror control mount
 * this, so the label and the caption for a given mode cannot disagree between
 * the two surfaces the way they used to.
 *
 * Hook-free on purpose: the selected mode is owned by whoever mounts it, which
 * keeps this testable by calling it directly and invoking the handler it wired.
 */
export function SizingModeTabs({
  value,
  onChange,
  disabled = false,
  compact = false,
  stackOnNarrow = false,
}: {
  value: SizingMode;
  onChange: (mode: SizingMode) => void;
  disabled?: boolean;
  /** The manage-follows dropdown is narrow, so its buttons run one step down. */
  compact?: boolean;
  /** Use a two-row control until a small drawer has enough inline width. */
  stackOnNarrow?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Order sizing basis"
      className={cn(
        stackOnNarrow
          ? "grid w-full max-w-full grid-cols-2 overflow-hidden"
          : "inline-flex overflow-hidden",
        // Below xl this is a flat tab strip on a hairline, like every other
        // mobile strip: the selected basis is brighter text over a gold rule,
        // not a gold-filled segment (DESIGN.md: gold is a seasoning). At xl it
        // is the compact bordered terminal control it always was, with the
        // selected segment tinted rather than flooded (see the button below).
        "border-b border-[#1a3b46] xl:border xl:rounded-md xl:border-border xl:bg-transparent xl:p-0",
        stackOnNarrow && "sm:inline-flex sm:w-auto",
      )}
    >
      {SIZING_MODES.map((mode, idx) => {
        const presentation = SIZING_MODE_PRESENTATION[mode];
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => onChange(mode)}
            aria-pressed={selected}
            data-state={selected ? "active" : "inactive"}
            title={presentation.aria}
            className={cn(
              "relative font-medium transition-colors",
              compact
                ? "h-11 px-1.5 text-2xs xl:h-6"
                : `${TOUCH_HEIGHT_COMPACT_XL} px-2 text-xs`,
              idx > 0 && "xl:border-l xl:border-border",
              stackOnNarrow && idx % 2 === 1 && "max-sm:border-l max-sm:border-[#2c4d57]",
              stackOnNarrow && idx >= 2 && "max-sm:border-t max-sm:border-[#2c4d57]",
              // At xl the selected segment used to be a solid gold slab. Four
              // of these sit side by side in a drawer, so up to a quarter of
              // the control was a flat gold block (DESIGN.md: gold accents, it
              // never fills). It now carries the same tint the chart-overlay
              // toggles use: a primary wash under primary text. No per-segment
              // border, because the group draws its own frame and the
              // `xl:border-l` dividers already separate the segments.
              selected
                ? "font-semibold text-white xl:bg-primary/15 xl:font-medium xl:text-primary"
                : "text-[#8da5ad] hover:text-white xl:text-muted-foreground xl:hover:bg-muted xl:hover:text-muted-foreground",
            )}
          >
            {presentation.label}
            {selected ? (
              <span
                aria-hidden="true"
                data-sizing-mode-rule="true"
                className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-[#e7c65d] xl:hidden"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
