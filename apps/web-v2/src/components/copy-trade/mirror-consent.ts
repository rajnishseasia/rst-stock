import type { AppRouter } from "@trade-bot/api";
import type { inferRouterOutputs } from "@trpc/server";
import { formatUsd } from "@/lib/format";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import {
  describePerpProtection,
  describeSizePerOrder,
  NO_PERP_PROTECTION_SENTENCE,
  type PerpProtectionRuleView,
  type SizingMode,
} from "./mirror-sizing";
import {
  DESTINATION_PRESENTATION,
  type MirrorDestination,
  type MirrorDestinationConfig,
} from "./account-targeting";
import { followMembershipKeys } from "./follow-membership";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/**
 * The real procedure output, not a local copy of its shape. `visibility` is the
 * field that matters here: the auto-mirror flags live on the WORKER, and the
 * API is a separate deployment, so "unknown" means "this deployment was never
 * told", never "off".
 */
export type MirrorStatus = RouterOutputs["copyTrade"]["mirrorStatus"];

/** Human label for a follow target's source, for chips and refusal messages. */
export function followTargetTypeLabel(
  type: "x_author" | "user" | "politician" | "hl_wallet",
): string {
  if (type === "x_author") return "Caller";
  if (type === "user") return "User";
  if (type === "hl_wallet") return "Wallet";
  return "Politician";
}

// ============================================
// Arming
// ============================================

/**
 * Every claim in the arming and stopping copy below is a statement about worker
 * code that exists today. Checked before it was written:
 *
 *  - STOPPING PLACES NOTHING NEW. The poll cycle loads its follow rows with
 *    `where(eq(copyTradeFollows.autoMirror, true))`
 *    (apps/worker/src/services/copy-mirror.ts), so a follow with the flag off is
 *    never resolved into a candidate at all. `loadFollowRow` re-reads the row at
 *    delivery time and a missing or disarmed row resolves to a refusal.
 *  - UNFOLLOWING IS A HARD DELETE. `copyTradeFollows.unfollow`
 *    (apps/api/src/routers/copy-trade-follows.ts) issues `db.delete(...)`, so the
 *    sizing rule and the selected mirror account go with it.
 *  - NEITHER CLOSES ANYTHING. No path in the worker sells, unwinds or reduces a
 *    holding in response to a disarm or an unfollow. The comment above the perp
 *    consent gate states the rule outright: withdrawing consent must stop new
 *    exposure and must never abandon exposure the mirror already created.
 *  - A QUEUED CLOSE CAN STILL LAND. Closes are deliberately exempt from the
 *    consent re-read on both venues, and already-staged deliveries drain from
 *    `loadDueDeliveries` independently of the follow list. `decideSellMirrorQty`
 *    clamps a mirrored sell to the follower's real long, so an exempted close can
 *    only shrink a holding and can never open a short.
 */
export const ARMING_STANDING_ORDER =
  "Orders are placed for you automatically from then on. You are not asked again, trade by trade.";

export const ARMING_STOP_CAVEAT =
  "Turning this off later stops new orders. It does not close positions the mirror already opened.";

/**
 * The two things this confirmation can be about.
 *
 * "repoint" is the same decision as "arm", taken again about a different
 * destination, which is why it is a variant of this summary and not a dialog of
 * its own. Moving an armed follow is NOT a settings edit:
 *
 *  - The API keeps the follow armed for any non-null credential
 *    (apps/api/src/routers/copy-trade-follows.ts: `effectiveAutoMirror` only
 *    falls to false when `credentialId` is explicitly null), so the picker alone
 *    can move live automation from Paper to Live, or from Alpaca to leveraged
 *    Hyperliquid perps.
 *  - The WORKER already treats the destination as part of the consent:
 *    `decideFollowConsent` (apps/worker/src/services/copy-mirror-consent.ts)
 *    skips a staged delivery as `consent-withdrawn` when the follow's live
 *    credential no longer matches the one it was staged against.
 *
 * So a silent re-point would have the UI granting consent for a destination at
 * the same moment the backend reads that change as consent being taken back.
 */
export type ArmingVariant = "arm" | "repoint";

export const REPOINT_STANDING_ORDER =
  "This follow stays armed. From now on its orders are placed into the new account instead, and you are not asked again, trade by trade.";

/**
 * True of the worker as it stands. Closes are exempt from the consent re-read on
 * both venues (`decideEquityMirrorConsent` returns early for a closing sell,
 * `decidePerpMirrorConsent` for a reduce-only), and an exempted close is clamped
 * to the follower's real position, so it can only shrink one. Everything else
 * staged against the old credential fails the `liveCredentialId !==
 * stagedCredentialId` check and is skipped.
 */
export const REPOINT_STOP_CAVEAT =
  "Positions the mirror already opened on the old account stay there: nothing is moved, sold or closed. An order from this trader already queued against the old account is dropped rather than re-aimed, except a queued close, which still goes through on the old account and can only reduce a position.";

export interface MirrorLimits {
  /**
   * Mirrored orders allowed per FOLLOWER per day, or null when unreported.
   *
   * Per follower, not per follow. `countMirrorsToday`
   * (apps/worker/src/services/copy-mirror.ts) counts by the
   * `copymirror:<followerUserId>:` client_order_id prefix with no follow,
   * target or asset-type predicate, so every armed follow and both venues draw
   * down this one number. See `describeDailyCap` for why that distinction is
   * load bearing in the confirmation.
   */
  dailyCap: number | null;
  /** Absolute per-order dollar ceiling, or null when unreported. */
  maxOrderDollars: number | null;
  /** True when `dailyCap` is the built-in default, not a reported config. */
  dailyCapFromDefaults: boolean;
  /** True when `maxOrderDollars` is the built-in default, not a config. */
  maxOrderDollarsFromDefaults: boolean;
}

/**
 * What this deployment says its caps are, falling back PER FIELD to the
 * compiled-in defaults it also reports.
 *
 * Per field, not all-or-nothing. `resolveMirrorStatus`
 * (apps/api/src/lib/copy-mirror.ts) decides each cap from its own environment
 * variable, so an API process that carries COPY_TRADE_AUTOMIRROR_DAILY_CAP but
 * not COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS reports a number and a null. A
 * whole-object fallback discarded the reported number and printed the default
 * in its place, so the arming confirmation stated a cap this deployment had
 * explicitly contradicted, and labelled it "the built-in default" while it was
 * neither the default in force nor the configured one.
 *
 * Both null only when the status itself has not loaded, so the confirmation
 * says "not reported" instead of inventing a number.
 */
export function resolveMirrorLimits(status: MirrorStatus | null | undefined): MirrorLimits {
  if (!status) {
    return {
      dailyCap: null,
      maxOrderDollars: null,
      dailyCapFromDefaults: false,
      maxOrderDollarsFromDefaults: false,
    };
  }
  return {
    dailyCap: status.dailyCap ?? status.defaults.dailyCap,
    maxOrderDollars: status.maxOrderDollars ?? status.defaults.maxOrderDollars,
    dailyCapFromDefaults: status.dailyCap === null,
    maxOrderDollarsFromDefaults: status.maxOrderDollars === null,
  };
}

export interface ArmingFact {
  label: string;
  value: string;
}

export interface ArmingSummary {
  title: string;
  facts: ArmingFact[];
  standingOrder: string;
  stopCaveat: string;
  /** True when the destination is Hyperliquid, so the perp disclosure belongs. */
  showPerpDisclosure: boolean;
  /**
   * The exit this follow will attach, carried through so the disclosure states
   * the follow's ACTUAL exit rather than the general case.
   *
   * Null on an Alpaca destination and on a Hyperliquid one with nothing
   * configured. The disclosure treats both the same, which is correct: neither
   * has a perp exit attached.
   */
  perpProtection: PerpProtectionRuleView | null;
  confirmLabel: string;
}

/**
 * Everything a user must be told before real-money automation is switched on.
 *
 * Pure so the wording is asserted directly rather than through a rendered tree,
 * and so both entry points (the manage-follows row and the panel's inline
 * switch) put the same sentences in front of the user.
 */
export function buildArmingSummary(input: {
  trader: string;
  /** Human label for the destination account, or null when none is selected. */
  account: string | null;
  destinationProvider: "alpaca" | "hyperliquid" | null;
  sizingMode: SizingMode;
  sizingValue: number;
  /**
   * The follow's configured perp exit, when it has one. Omitted or null means
   * no exit, which is what every follow carries until someone sets one.
   */
  perpProtection?: PerpProtectionRuleView | null;
  limits: MirrorLimits;
  /** Defaults to "arm". See ArmingVariant for why "repoint" shares this. */
  variant?: ArmingVariant;
  /** For "repoint": the account the follow is being moved off, if known. */
  previousAccount?: string | null;
}): ArmingSummary {
  const trader = input.trader.trim() || "this trader";
  const repoint = input.variant === "repoint";
  const facts: ArmingFact[] = [
    { label: "Trader", value: trader },
    ...(repoint
      ? [{ label: "Moving from", value: input.previousAccount ?? "No account" }]
      : []),
    {
      label: repoint ? "New account" : "Account",
      value: input.account ?? "No account selected",
    },
    // The provider is named outright on a re-point. "Live account 9876" and
    // "Hyperliquid perps" read as two account names; the thing that actually
    // changed is which venue, and with what risk, the orders land on.
    ...(repoint
      ? [{ label: "Venue", value: describeVenue(input.destinationProvider) }]
      : []),
    {
      // The destination decides what a percentage is a percentage OF, so the
      // venue is passed rather than assumed: `pct` scales Alpaca's
      // margin-inflated buying power and Hyperliquid's free cross collateral,
      // and this fact sits directly above the button that arms the thing.
      label: "Size per order",
      value: describeSizePerOrder(
        input.sizingMode,
        input.sizingValue,
        input.destinationProvider,
      ),
    },
    // Stated ONLY for a Hyperliquid destination, because that is the only one
    // the worker attaches an exit on. Printing "Automatic exit: None" beside an
    // Alpaca account would read as a property of that account rather than of a
    // feature that does not apply to it, and the equity path's own missing exit
    // is separate work that this fact must not appear to describe.
    ...(input.destinationProvider === "hyperliquid"
      ? [{ label: "Automatic exit", value: describeArmedPerpProtection(input.perpProtection) }]
      : []),
    { label: "Daily cap", value: describeDailyCap(input.limits) },
    { label: "Per-order ceiling", value: describePerOrderCeiling(input.limits) },
  ];

  return {
    title: repoint
      ? `Send ${trader}'s automatic orders to a different account?`
      : `Place orders automatically from ${trader}?`,
    facts,
    standingOrder: repoint ? REPOINT_STANDING_ORDER : ARMING_STANDING_ORDER,
    stopCaveat: repoint ? REPOINT_STOP_CAVEAT : ARMING_STOP_CAVEAT,
    showPerpDisclosure: input.destinationProvider === "hyperliquid",
    perpProtection:
      input.destinationProvider === "hyperliquid" ? input.perpProtection ?? null : null,
    confirmLabel: repoint ? "Move automatic orders" : "Turn on automatic orders",
  };
}

/**
 * Consent copy for the independent stock/perp editor. The legacy summary above
 * remains unchanged for the feed panel, while this variant always names the
 * venue and carries a destination-specific protection and risk statement.
 */
export function buildDestinationArmingSummary(input: {
  trader: string;
  destination: MirrorDestination;
  account: string | null;
  sizingMode: SizingMode;
  sizingValue: number;
  perpProtection?: PerpProtectionRuleView | null;
  globalPerpMaxLeverage?: number | null;
  followPerpMaxLeverage?: number | null;
  limits: MirrorLimits;
  variant?: ArmingVariant;
  previousAccount?: string | null;
}): ArmingSummary {
  const trader = input.trader.trim() || "this trader";
  const repoint = input.variant === "repoint";
  const presentation = DESTINATION_PRESENTATION[input.destination];
  const isPerp = input.destination === "perp";
  const protection = isPerp ? input.perpProtection ?? null : null;
  const effectiveLeverage = isPerp
    ? effectivePerpLeverage(input.globalPerpMaxLeverage, input.followPerpMaxLeverage)
    : null;
  const facts: ArmingFact[] = [
    { label: "Trader", value: trader },
    ...(repoint
      ? [{ label: "Moving from", value: input.previousAccount ?? "No account" }]
      : []),
    { label: "Venue", value: presentation.venue },
    {
      label: repoint ? "New account" : "Account",
      value: input.account ?? "No account selected",
    },
    {
      label: "Size per order",
      value: describeSizePerOrder(input.sizingMode, input.sizingValue, presentation.provider),
    },
    ...(isPerp
      ? [
          {
            label: "Leverage ceiling",
            value:
              effectiveLeverage === null
                ? "Unavailable until a valid global cap loads."
                : `${effectiveLeverage}x maximum. Leaders and markets may use less.`,
          },
          { label: "Protection", value: describeArmedPerpProtection(protection) },
          {
            label: "Risk",
            value:
              "Hyperliquid is a live leveraged exchange. A perp position can be liquidated and may lose its margin.",
          },
        ]
      : [
          {
            label: "Protection",
            value:
              "No automatic take-profit or stop-loss controls are available for Alpaca stock mirrors.",
          },
          {
            label: "Risk",
            value:
              "Alpaca stock and option orders can lose money. Turning this off does not close positions already opened.",
          },
        ]),
    { label: "Daily cap", value: describeDailyCap(input.limits) },
    { label: "Per-order ceiling", value: describePerOrderCeiling(input.limits) },
  ];

  return {
    title: repoint
      ? `Move ${trader}'s automatic ${presentation.orderNoun} orders to this destination?`
      : `Place ${trader}'s ${presentation.orderNoun} orders automatically?`,
    facts,
    standingOrder: repoint ? REPOINT_STANDING_ORDER : ARMING_STANDING_ORDER,
    stopCaveat: repoint ? REPOINT_STOP_CAVEAT : ARMING_STOP_CAVEAT,
    showPerpDisclosure: isPerp,
    perpProtection: protection,
    confirmLabel: repoint
      ? `Move automatic ${presentation.label.toLowerCase()} orders`
      : `Turn on automatic ${presentation.label.toLowerCase()} orders`,
  };
}

function validPerpLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COPY_PERP_MAX_LEVERAGE_MIN &&
    value <= COPY_PERP_MAX_LEVERAGE_MAX
  );
}

function effectivePerpLeverage(
  globalPerpMaxLeverage: number | null | undefined,
  followPerpMaxLeverage: number | null | undefined,
): number | null {
  if (!validPerpLeverage(globalPerpMaxLeverage)) return null;
  return validPerpLeverage(followPerpMaxLeverage)
    ? Math.min(globalPerpMaxLeverage, followPerpMaxLeverage)
    : globalPerpMaxLeverage;
}

/**
 * The exit line in the arming confirmation.
 *
 * Says "None" out loud rather than omitting the row. This confirmation is the
 * one place a follower is told what a standing order actually does, and a
 * missing line reads as "not applicable" where the truth is "nothing will ever
 * close this for you".
 */
function describeArmedPerpProtection(
  protection: PerpProtectionRuleView | null | undefined,
): string {
  const configured = protection ? describePerpProtection(protection) : null;
  if (!configured) return NO_PERP_PROTECTION_SENTENCE;
  // Capitalised because this is a fact value in a list, not a clause.
  return `${configured.charAt(0).toUpperCase()}${configured.slice(1)}`;
}

/** What kind of venue a destination is, in the terms that change the risk. */
function describeVenue(provider: "alpaca" | "hyperliquid" | null): string {
  if (provider === "hyperliquid") return "Hyperliquid perps, leveraged, live exchange";
  if (provider === "alpaca") return "Alpaca stocks and options";
  return "Unknown, this deployment did not report the venue";
}

/**
 * The daily cap, stated at the scope the worker actually enforces it at.
 *
 * ONE BUDGET PER FOLLOWER, SHARED BY EVERY FOLLOW AND BOTH VENUES.
 * `countMirrorsToday` (apps/worker/src/services/copy-mirror.ts) counts orders
 * whose client_order_id starts with `copymirror:<followerUserId>:`, narrowed by
 * user and by today and by nothing else: no follow id, no target, no asset
 * type. So an Alpaca equity mirror and a Hyperliquid perp mirror spend from the
 * same allowance. `withinDailyCap` (apps/api/src/lib/copy-mirror.ts) then
 * compares that follower-wide count to the single deployment cap, and its own
 * doc says "the follower is still under their daily mirror cap". The operator
 * reference agrees: docs/deployment/copy-mirror-env-reference.md calls
 * COPY_TRADE_AUTOMIRROR_DAILY_CAP "Mirrored orders per follower per day".
 *
 * This sentence used to say "for this follow", which inverted the arithmetic
 * the user does at exactly the moment they do it. Someone arming four traders
 * read four independent budgets, sized each follow as though it owned 20
 * orders, and got 20 between the four. One busy trader then exhausts the lot
 * and candidates from the other three are skipped as `daily-cap` for the rest
 * of the day, with nothing on screen saying so: the switches all still read On
 * and the rows still print their projections. The consequence is spelled out
 * here rather than left as an inference, because the sharing is the whole point
 * of the correction and a reader who only takes in the number learns nothing.
 */
function describeDailyCap(limits: MirrorLimits): string {
  if (limits.dailyCap === null) {
    return "Not reported by this deployment.";
  }
  const sentence =
    `Up to ${limits.dailyCap} mirrored orders a day in total. That budget is shared by every follow ` +
    `you have armed, across Alpaca and Hyperliquid together, so it is not ${limits.dailyCap} for this ` +
    "follow on its own: once it is spent, mirrors from your other follows are skipped for the rest " +
    "of the day.";
  return limits.dailyCapFromDefaults
    ? `${sentence} This deployment reports no cap of its own, so this is the built-in default.`
    : sentence;
}

function describePerOrderCeiling(limits: MirrorLimits): string {
  if (limits.maxOrderDollars === null) {
    return "Not reported by this deployment.";
  }
  const sentence = `Nothing above ${formatUsd(limits.maxOrderDollars)} of notional in a single order.`;
  return limits.maxOrderDollarsFromDefaults
    ? `${sentence} This deployment reports no ceiling of its own, so this is the built-in default.`
    : sentence;
}

// ============================================
// Stopping
// ============================================

/**
 * The three ways a user stops an armed follow.
 *
 * "clear-account" is a stop, not a settings edit, even though the control that
 * reaches it is a destination picker. `copyTradeFollows.update`
 * (apps/api/src/routers/copy-trade-follows.ts) computes
 * `effectiveAutoMirror = input.credentialId === null ? false : ...` and writes
 * `updateSet.autoMirror` on that same condition, so choosing "No account" on an
 * armed follow turns auto-mirror off server-side whatever the client asked for.
 * That is the same event as flipping the switch, and it carries the same
 * misreading: the user believes the exposure went with it.
 */
export type StopKind = "disarm" | "unfollow" | "clear-account";

export interface StopSummary {
  title: string;
  /** Ordered, each one true of the worker as it stands. */
  points: string[];
  confirmLabel: string;
}

/** Stop copy for one independently configured venue. */
export function buildDestinationStopSummary(input: {
  kind: "disarm" | "clear-account";
  destination: MirrorDestination;
  trader: string;
  account: string | null;
  sizingMode: SizingMode;
  sizingValue: number;
  perpProtection?: PerpProtectionRuleView | null;
}): StopSummary {
  const trader = input.trader.trim() || "this trader";
  const presentation = DESTINATION_PRESENTATION[input.destination];
  const otherDestination = input.destination === "stock" ? "perp" : "stock";
  const otherPresentation = DESTINATION_PRESENTATION[otherDestination];
  const protection =
    input.destination === "perp"
      ? describeArmedPerpProtection(input.perpProtection ?? null)
      : "No automatic take-profit or stop-loss controls are available for Alpaca stock mirrors.";
  const destinationScope =
    `This stops only automatic ${presentation.orderNoun} orders from ${trader}. ` +
    `${otherPresentation.label} are unchanged and may remain active.`;
  const safetyPoints = [
    destinationScope,
    `Positions the mirror already opened on ${presentation.label} stay open. Stopping does not sell, close or unwind any of them, and you still have to exit them yourself.`,
    `A ${presentation.orderNoun} close copied from this trader that is already queued can still go through. A queued close only reduces a position, it never opens one.`,
  ];
  return {
    title:
      input.kind === "clear-account"
        ? `Clear ${presentation.label} account for ${trader} and stop automatic orders?`
        : `Stop automatic ${presentation.orderNoun} orders from ${trader}?`,
    points: [
      `Destination: ${presentation.venue}. Account: ${input.account ?? "No account selected"}.`,
      `Size per order: ${describeSizePerOrder(input.sizingMode, input.sizingValue, presentation.provider)}. Protection: ${protection}`,
      input.destination === "perp"
        ? "Risk: Hyperliquid is a live leveraged exchange; an open perp position can still be liquidated after stopping."
        : "Risk: Open Alpaca stock or option positions remain exposed after stopping; stopping does not sell or close them.",
      destinationScope,
      ...(input.kind === "clear-account"
        ? [
            `The ${presentation.label} account is cleared and that destination is disarmed. The follow itself stays, with its sizing rule. Pointing it at an account again does not switch automatic orders back on: you would be asked for that separately.`,
          ]
        : []),
      ...safetyPoints.slice(1),
    ],
    confirmLabel:
      input.kind === "clear-account"
        ? `Clear ${presentation.label.toLowerCase()} account and stop automatic orders`
        : `Stop automatic ${presentation.orderNoun} orders`,
  };
}

/**
 * The stop confirmation. Both stops are irreversible in the sense that matters:
 * the user believes they are undoing the exposure, and they are not.
 */
export function buildStopSummary(input: { kind: StopKind; trader: string }): StopSummary {
  const trader = input.trader.trim() || "this trader";
  const shared = [
    "Positions the mirror already opened stay open. Stopping does not sell, close or unwind any of them, and you still have to exit them yourself.",
    "A close copied from this trader that is already queued can still go through. A queued close only reduces a position, it never opens one.",
  ];

  if (input.kind === "clear-account") {
    return {
      title: `Clear ${trader}'s mirror account and stop automatic orders?`,
      points: [
        `No new orders will be placed from ${trader}. Removing the destination also turns auto-mirror off, because with nowhere to send them this follow can place nothing.`,
        // True of the API as it stands: with auto-mirror already false, a later
        // patch that only carries a credential leaves `effectiveAutoMirror` at
        // the row's current value, and `updateSet.autoMirror` is not written at
        // all. Re-arming has to come from the switch, which asks.
        "The follow itself stays, with its sizing rule. Pointing it at an account again does not switch automatic orders back on: you would be asked for that separately.",
        ...shared,
      ],
      confirmLabel: "Clear account and stop automatic orders",
    };
  }

  if (input.kind === "unfollow") {
    return {
      title: `Unfollow ${trader}?`,
      points: [
        `No new orders will be placed from ${trader}.`,
        "The follow is deleted, along with its sizing rule and its selected mirror account. Following again starts from the defaults.",
        ...shared,
      ],
      confirmLabel: "Unfollow and stop new orders",
    };
  }

  return {
    title: `Stop placing orders from ${trader}?`,
    points: [
      `No new orders will be placed from ${trader}. The follow itself stays, with its sizing rule and account.`,
      ...shared,
    ],
    confirmLabel: "Stop automatic orders",
  };
}

/**
 * Whether a follow's automation is armed, as far as the calling surface can
 * tell. "unknown" is a real third answer, not a placeholder: the feed and
 * leaderboard rows read the follows list out of the query cache, and a cache
 * that has not been populated cannot prove a follow is harmless.
 */
export type FollowArmedState = "armed" | "unarmed" | "unknown";

/** The only fields armed-ness needs off a `copyTradeFollows.list` row. */
export interface FollowArmedLookupRow {
  targetType: string;
  targetKey: string;
  membershipKeys?: readonly string[];
  autoMirror: boolean;
  destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
}

/** Check the destination fields needed to trust a typed armed-state answer. */
function isMirrorDestinationConfig(value: unknown): value is MirrorDestinationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.enabled === "boolean" &&
    (config.credentialId === null || typeof config.credentialId === "string") &&
    (config.sizingMode === "pct" ||
      config.sizingMode === "pct_equity" ||
      config.sizingMode === "usd" ||
      config.sizingMode === "ratio") &&
    typeof config.sizingValue === "number" &&
    Number.isFinite(config.sizingValue)
  );
}

/** Resolve independent venue flags, failing closed unless both typed rows load. */
function typedDestinationsArmedState(value: unknown): FollowArmedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const destinations = value as Record<string, unknown>;
  const stock = destinations.stock;
  const perp = destinations.perp;
  if (!isMirrorDestinationConfig(stock) || !isMirrorDestinationConfig(perp)) {
    return "unknown";
  }
  return stock.enabled || perp.enabled ? "armed" : "unarmed";
}

/**
 * Armed-ness of one follow target, from the follows list the surface already
 * holds. A target with no matching row is "unknown", never "unarmed": the two
 * differ only in what we know, and only one of them is safe to act on.
 */
export function followArmedState(
  follows: readonly FollowArmedLookupRow[] | null | undefined,
  target: { type: string; key: string },
): FollowArmedState {
  if (!Array.isArray(follows)) return "unknown";
  const match = follows.find(
    (follow) => {
      if (!follow || typeof follow !== "object") return false;
      if (
        typeof follow.targetType !== "string" ||
        typeof follow.targetKey !== "string" ||
        (follow.membershipKeys !== undefined &&
          (!Array.isArray(follow.membershipKeys) ||
            !follow.membershipKeys.every((key: unknown) => typeof key === "string")))
      ) {
        return false;
      }
      return (
        follow.targetType === target.type &&
        followMembershipKeys(follow).includes(target.key)
      );
    },
  );
  if (!match) return "unknown";
  // An own `destinations` field identifies the independent API shape. Do not
  // fall back to the compatibility flag when that shape is incomplete.
  if (Object.prototype.hasOwnProperty.call(match, "destinations")) {
    return typedDestinationsArmedState(match.destinations);
  }
  if (typeof match.autoMirror !== "boolean") return "unknown";
  return match.autoMirror ? "armed" : "unarmed";
}

/**
 * Does tapping "Following" have to ask first?
 *
 * ARMED: always. Unfollowing is a hard delete that takes the sizing rule and
 * the chosen mirror account with it, so one tap on a dense feed row would
 * destroy automation the user deliberately set up, and would do it without ever
 * saying that the positions the mirror already opened stay open. That is the
 * belief `buildStopSummary` exists to correct.
 *
 * UNARMED: no. There is no automation to tear down, and Follow / Following is
 * the feed's cheapest, most-tapped control. Putting a modal in front of every
 * one of those taps buys the user nothing and teaches them to dismiss the
 * dialog on sight, which is exactly what would then happen to the armed one. A
 * follow that was armed earlier and stopped since may still have open positions
 * behind it, but the user was already told that when they stopped it, by this
 * same dialog.
 *
 * UNKNOWN: ask. Failing closed costs a dialog; failing open silently deletes an
 * armed follow, which is the bug this gate exists for.
 */
export function unfollowNeedsConfirmation(state: FollowArmedState): boolean {
  return state !== "unarmed";
}

// ============================================
// Post-mutation feedback
// ============================================

/**
 * Success-toast text for one follow update.
 *
 * Arming used to raise the same "Follow settings updated" as nudging a sizing
 * value by one, so the single most consequential change in the product was
 * confirmed in the same words as the least.
 */
export const MIRROR_ACCOUNT_CLEARED_TOAST =
  "Mirror account cleared, which also turned auto-mirror off: with no destination this follow can place nothing. Positions it already opened stay open.";

const destinationActions = new WeakMap<object, "stop" | "clear">();

/**
 * Carry a confirmed destination stop to the update toast without adding UI
 * metadata to the server contract. The mutation keeps the nested config
 * object while it shallow-spreads the request variables.
 */
export function markDestinationStop(
  config: MirrorDestinationConfig,
  wasEnabled: boolean,
): MirrorDestinationConfig {
  if (wasEnabled && !config.enabled) destinationActions.set(config, "stop");
  return config;
}

/** Record an explicit account clear, including a clear while already off. */
export function markDestinationClear(
  config: MirrorDestinationConfig,
  previousCredentialId: string | null,
): MirrorDestinationConfig {
  if (previousCredentialId !== null && config.credentialId === null) {
    destinationActions.set(config, "clear");
  }
  return config;
}

export function followUpdateToast(patch: {
  autoMirror?: boolean;
  credentialId?: string | null;
  perpTakeProfitPct?: number | null;
  perpStopLossPct?: number | null;
  destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
}): string {
  const destinationEntries = Object.entries(patch.destinations ?? {}) as Array<
    [MirrorDestination, MirrorDestinationConfig]
  >;
  if (destinationEntries.length > 0) {
    const [destination, config] = destinationEntries[0]!;
    const label = DESTINATION_PRESENTATION[destination].label;
    const action = destinationActions.get(config);
    destinationActions.delete(config);
    if (config.enabled) {
      return `${label} auto-mirror armed. New ${DESTINATION_PRESENTATION[destination].orderNoun} trades from this trader are now placed automatically.`;
    }
    if (action === "clear") {
      return `${label} mirror account cleared and automatic orders stopped. Positions it already opened stay open.`;
    }
    if (action !== "stop") return "Follow settings updated";
    return `${label} auto-mirror stopped. No new orders. Positions it already opened stay open.`;
  }
  // Clearing the destination is checked first because the API force-disarms on
  // it regardless of what `autoMirror` was: `effectiveAutoMirror` is false
  // whenever `credentialId` is explicitly null, and `updateSet.autoMirror` is
  // written on that same condition. The user pressed "No account" and got a
  // disarm as well, so the disarm is the part they were not told about.
  if (patch.credentialId === null) return MIRROR_ACCOUNT_CLEARED_TOAST;
  if (patch.autoMirror === true) {
    return "Auto-mirror armed. New trades from this trader are now placed automatically.";
  }
  if (patch.autoMirror === false) {
    return "Auto-mirror stopped. No new orders. Positions it already opened stay open.";
  }
  // The exit is resolved into absolute trigger prices AT MIRROR TIME, from the
  // entry and the leverage that particular position got
  // (apps/worker/src/services/copy-mirror-perp-protection.ts). Nothing re-reads
  // this column for a position that is already open, so editing it changes what
  // the NEXT mirror gets and nothing else. Reporting it as "updated" on its own
  // would leave a follower believing they had just moved a live stop.
  if (patch.perpTakeProfitPct !== undefined || patch.perpStopLossPct !== undefined) {
    return "Automatic exit saved. It is attached to perp positions opened from now on. Positions already open keep the levels they were given, or none.";
  }
  return "Follow settings updated";
}

export const UNFOLLOW_TOAST =
  "Unfollowed. No new orders. Positions the mirror already opened stay open.";

// ============================================
// Deployment status
// ============================================

export interface MirrorDeploymentNotice {
  kind: "off" | "unknown";
  headline: string;
  detail: string;
  /**
   * Reason to put on a disabled arming switch, or null when arming stays
   * allowed. "unknown" never blocks: the API not having been told is not
   * evidence that the worker is off.
   */
  blockReason: string | null;
}

/**
 * What Manage follows should say about this deployment, or null when there is
 * nothing honest and useful to say.
 *
 * There is deliberately NO "mirroring is on" banner. `visibility: "visible"`
 * only means this API process carries the flags; it cannot confirm the worker
 * process agrees, so a confident "On" would be a guess dressed as a fact.
 */
export function describeMirrorDeployment(
  status: MirrorStatus | null | undefined,
): MirrorDeploymentNotice | null {
  if (!status) return null;

  if (status.visibility === "unknown") {
    return {
      kind: "unknown",
      headline: "Auto-mirroring status: unknown",
      detail:
        "This deployment does not report whether the auto-mirror worker is running, so we cannot tell you whether an armed follow will place anything. Ask an operator before relying on it.",
      blockReason: null,
    };
  }

  if (status.enabled === false) {
    return {
      kind: "off",
      headline: "Auto-mirroring is turned off on this deployment",
      detail:
        "Arming a follow saves the setting but places no orders until an operator turns auto-mirroring back on.",
      blockReason:
        "Auto-mirroring is turned off on this deployment, so arming this follow would place no orders. Ask an operator to turn it on.",
    };
  }

  return null;
}
