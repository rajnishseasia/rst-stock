"use client";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Keep arming controls tappable until the desktop drawer reaches xl. */
const TOUCH_HEIGHT_COMPACT_XL = "h-11 xl:h-7";

/**
 * The two arming controls, extracted so neither one can mutate.
 *
 * Both used to call the update mutation straight out of `onCheckedChange`, so a
 * single stray tap armed real-money automation with no dialog, no summary and
 * no way back except noticing the toast. Here the change handler can only raise
 * a request; whoever mounts the switch is responsible for confirming it. That
 * is the property `mirror-consent.test.tsx` pins.
 *
 * Hook-free on purpose so the tests can call these directly and invoke the
 * handler that was actually wired, rather than reading the source back.
 */
export const AUTO_MIRROR_ARMED_CAPTION =
  "Auto-places real orders, on your confirmation. Off by default.";

/** The per-follow switch in the Manage follows dropdown. */
export function AutoMirrorSwitch({
  armed,
  interactive,
  reason,
  label = "Auto-mirror",
  ariaLabel = "Toggle auto-mirror (auto-places real orders)",
  onRequestArm,
  onRequestDisarm,
}: {
  armed: boolean;
  interactive: boolean;
  /** Why the switch is unusable and what to do, from `autoMirrorSwitchState`. */
  reason: string | null;
  /** Optional destination-specific label for the independent editor. */
  label?: string;
  ariaLabel?: string;
  onRequestArm: () => void;
  onRequestDisarm: () => void;
}) {
  return (
    <label
      className={cn(
        "mt-2 flex items-start justify-between gap-2 rounded-xl border border-[#203b44] bg-[#0b242d] px-2 py-1 xl:rounded-md xl:border-0 xl:bg-transparent xl:px-0 xl:py-0",
        TOUCH_HEIGHT_COMPACT_XL,
      )}
      title={reason ?? undefined}
    >
      <span className="flex flex-col">
        <span className="text-xs font-medium">{label}</span>
        <span
          className={cn(
            "text-2xs",
            reason ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {reason ?? AUTO_MIRROR_ARMED_CAPTION}
        </span>
      </span>
      <Switch
        checked={armed}
        disabled={!interactive}
        onCheckedChange={(checked) => {
          if (checked) onRequestArm();
          else onRequestDisarm();
        }}
        aria-label={ariaLabel}
      />
    </label>
  );
}

/** The compact switch on a Mirror-setup feed row in the copy-trade panel. */
export function InlineMirrorSwitch({
  displayName,
  armed,
  interactive,
  reason,
  accountMode,
  onRequestArm,
  onRequestDisarm,
}: {
  displayName: string;
  armed: boolean;
  interactive: boolean;
  reason: string | null;
  accountMode: "PAPER" | "LIVE" | null;
  onRequestArm: () => void;
  onRequestDisarm: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer select-none items-center gap-1.5 rounded-xl border px-2 transition-colors focus-within:ring-2 focus-within:ring-[#e7c65d] xl:rounded-md xl:px-1.5",
        TOUCH_HEIGHT_COMPACT_XL,
        armed
          ? "border-[#39725a] bg-[#12352d] text-[#88e6ba] xl:border-border xl:bg-transparent xl:text-foreground"
          : "border-[#31505a] bg-[#0b242d] text-[#b3c6cb] xl:border-border xl:bg-transparent xl:text-foreground",
      )}
      title={
        reason ??
        `Auto-place trades from ${displayName}. You confirm the details before anything is armed.`
      }
    >
      <Switch
        checked={armed}
        disabled={!interactive}
        onCheckedChange={(checked) => {
          if (checked) onRequestArm();
          else onRequestDisarm();
        }}
        aria-label={`Auto-mirror ${displayName}`}
      />
      <span className="text-2xs font-medium">{armed ? "On" : "Mirror"}</span>
      {accountMode && (
        <span
          className={cn(
            "text-3xs font-semibold uppercase",
            accountMode === "LIVE" ? "text-red-400" : "text-amber-300",
          )}
        >
          {accountMode === "LIVE" ? "Live" : "Paper"}
        </span>
      )}
    </label>
  );
}
