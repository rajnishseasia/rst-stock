"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { describePerpProtection, type PerpProtectionRuleView } from "./mirror-sizing";

/**
 * What a follower is actually agreeing to when a mirror points at Hyperliquid.
 *
 * The existing "How it works" dialog explains Copy / Follow / Mirror correctly,
 * but it was written for the Alpaca equity path. Nothing in the follow UI said
 * that a Hyperliquid destination means leveraged orders on a live exchange,
 * where the leverage comes from, that nothing is attached to protect the
 * position, or that a mirrored open writes account-level settings.
 *
 * Every line below describes the follower-facing policy and protections:
 *
 *  - leverage: automatic perps start from the source leverage and clamp down to
 *    the follower's persisted global maximum, an optional lower maximum saved
 *    for this follow (or the global maximum when absent), and the live market's
 *    maximum. They never raise leverage above the source trade.
 *  - no exits, BY DEFAULT: `placePerpMirrorOrder` submits one market order with
 *    a reduce-only flag and a cloid, and nothing else. That is still the whole
 *    story for a follow with no exit configured, which is every follow until
 *    someone sets one. Do not add copy here implying otherwise for that case.
 *  - exits WHEN THE FOLLOWER SETS THEM: with a take-profit or stop-loss saved on
 *    the follow, `attachPerpProtection`
 *    (apps/worker/src/services/copy-mirror-perp-protection.ts) places reduce-only
 *    trigger legs against the position right after the open lands, derived from
 *    the follower's percent-of-margin figures. It retries and then gives up; it
 *    never closes the position to compensate. The `protection` prop is what
 *    decides which of these two the block states, and it must never say the
 *    second while the follow is in the first state.
 *  - account settings: the open path calls `updateLeverage` for the coin before
 *    the order, and `decidePerpOpenAgainstPosition` skips instead of rewriting
 *    when the follower already holds that market at a different leverage or
 *    margin mode.
 */
export interface PerpMirrorDisclosureItem {
  title: string;
  body: string;
}

/**
 * The exit bullet, which is the ONE line in this block that depends on the
 * follow rather than on the deployment.
 *
 * Two separate claims, and the wrong one is a lie in whichever direction it is
 * wrong: telling a follower with no exit configured that one is attached is the
 * failure this file's tests were written to prevent, and telling a follower who
 * set a stop that they have none would push them to place a duplicate by hand.
 */
function exitDisclosure(
  protection: PerpProtectionRuleView | null | undefined,
): PerpMirrorDisclosureItem {
  const configured = protection ? describePerpProtection(protection) : null;
  if (!configured) {
    return {
      title: "No stop-loss, and no take-profit.",
      body:
        "Nothing is attached to a mirrored perp order. There is no stop, no bracket, and no automatic exit. Your position is reduced only if the trader you follow closes and that close is copied to your account.",
    };
  }
  return {
    title: "Your own exit is attached, and only yours.",
    body:
      `${configured} The legs are placed right after the position opens and are cancelled if the trader you follow closes first, because their close takes precedence. ` +
      "If the exchange does not accept them, the position is left open with no exit rather than closed for you, and that is recorded for an operator. Nothing here monitors or defends the position beyond those two levels.",
  };
}

/**
 * Build the block for one follow.
 *
 * The exit bullet is assembled in place rather than patched into a frozen array
 * afterwards, so there is exactly one ordering of these statements and no index
 * anywhere that has to stay in step with it.
 */
export function perpMirrorDisclosures(
  protection?: PerpProtectionRuleView | null,
): readonly PerpMirrorDisclosureItem[] {
  return [
  {
    title: "Orders go to Hyperliquid, not to Alpaca.",
    body:
      "When this deployment is pointed at Hyperliquid mainnet, a mirrored perp is a real leveraged order placed against your own funds on a live exchange. Hyperliquid has no paper account.",
  },
  {
    title: "Your saved ceilings control copied leverage.",
    body:
      "A mirrored open starts with the source trade's leverage and is reduced to the lowest of your global automatic-perps maximum, an optional lower maximum saved for this follow, and the live market maximum on Hyperliquid. If this follow has no separate maximum, it inherits your global maximum. Leverage is never raised above the source.",
  },
  exitDisclosure(protection),
  {
    title: "A leveraged position can be liquidated.",
    body:
      "Hyperliquid can liquidate the position, which can cost the entire margin posted against it. Mirroring does not monitor or defend the position for you.",
  },
  {
    title: "A mirrored open changes settings on your account.",
    body:
      "Before placing, the worker writes the leverage and margin mode (cross or isolated) for that market on your Hyperliquid account, and the setting remains after the order. If you already hold that market at a different leverage or margin mode, the mirror is skipped rather than rewriting it.",
  },
  ];
}

/**
 * The block as it reads for a follow with no exit configured, which is every
 * follow until someone sets one. Kept as a named constant because the "How it
 * works" dialog states the general case, where no particular follow is in view.
 */
export const PERP_MIRROR_DISCLOSURES: readonly PerpMirrorDisclosureItem[] =
  perpMirrorDisclosures(null);

/**
 * The disclosure block, shown wherever a follow can be pointed at Hyperliquid.
 * Deliberately plain: this is a risk statement, not a feature list.
 *
 * `protection` omitted keeps the block exactly as it reads for a follow with no
 * exit configured, which is the honest default for every surface that does not
 * know about one.
 */
export function PerpMirrorDisclosure({
  className,
  protection,
}: {
  className?: string;
  protection?: PerpProtectionRuleView | null;
}) {
  const items = perpMirrorDisclosures(protection);
  return (
    <section
      role="note"
      aria-label="What Hyperliquid perp mirroring does"
      className={cn(
        "rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-2xs",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Mirroring to Hyperliquid places leveraged perp orders
      </p>
      <ul className="mt-1.5 ml-4 list-disc space-y-1 text-foreground/90 marker:text-amber-600/60">
        {items.map((item) => (
          <li key={item.title}>
            <span className="font-medium">{item.title}</span> {item.body}
          </li>
        ))}
      </ul>
    </section>
  );
}
