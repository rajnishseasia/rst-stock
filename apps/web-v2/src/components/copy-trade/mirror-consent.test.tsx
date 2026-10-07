import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  click,
  elementText,
  findByAriaLabel,
  findByTitle,
  flattenElements,
  type TestElement,
} from "@/testing/element-tree";
import { FollowButtonView } from "./follow-button";
import {
  AUTO_MIRROR_ARMED_CAPTION,
  AutoMirrorSwitch,
  InlineMirrorSwitch,
} from "./auto-mirror-switch";
import { ArmMirrorDialog, StopMirrorDialog } from "./mirror-consent-dialogs";
import { SizingModeTabs } from "./sizing-mode-tabs";
import {
  FollowRow,
  buildFollowArmingSummary,
  type ConsentAsk,
} from "./manage-follows";
import { Select, SelectItem } from "@/components/ui/select";
import { PerpMirrorDisclosure } from "./perp-mirror-disclosure";
import {
  accountOptionLabel,
  autoMirrorSwitchState,
  type AlpacaAccountOption,
} from "./account-targeting";
import {
  ARMING_STANDING_ORDER,
  ARMING_STOP_CAVEAT,
  buildArmingSummary,
  buildDestinationStopSummary,
  buildStopSummary,
  describeMirrorDeployment,
  followArmedState,
  followUpdateToast,
  followTargetTypeLabel,
  MIRROR_ACCOUNT_CLEARED_TOAST,
  resolveMirrorLimits,
  unfollowNeedsConfirmation,
  UNFOLLOW_TOAST,
  type FollowArmedLookupRow,
  type MirrorLimits,
  type MirrorStatus,
} from "./mirror-consent";
import {
  describeSizePerOrder,
  NO_PERP_PROTECTION_SENTENCE,
  PERP_PROTECTION_PRESENTATION,
  SIZING_MODES,
  SIZING_MODE_PRESENTATION,
  type SizingMode,
} from "./mirror-sizing";
import { PERP_PROTECTION_BOUNDS } from "@trade-bot/types";
import { Input } from "@/components/ui/input";
import type { FollowItem } from "./use-manage-follows";

// ============================================
// Local tree helpers
// ============================================

/**
 * `element-tree` invokes onClick; a Radix Switch reports through
 * `onCheckedChange`, so this reaches that one. Same idea: call the handler the
 * component really wired, never a stand-in.
 */
function toggle(element: TestElement | undefined, checked: boolean): void {
  const handler = element?.props.onCheckedChange;
  if (typeof handler !== "function") {
    throw new Error("Element has no onCheckedChange handler");
  }
  (handler as (next: boolean) => void)(checked);
}

/** First element rendered from a given component, by identity. */
function findByComponent(node: ReactNode, component: unknown): TestElement | undefined {
  return flattenElements(node).find((element) => element.type === component);
}

const AUTO_MIRROR_LABEL = "Toggle auto-mirror (auto-places real orders)";

// ============================================
// Fixtures
// ============================================

const FOLLOW: FollowItem = {
  id: "follow-1",
  targetType: "user",
  targetKey: "trader-key",
  targetLabel: "Example Trader",
  sizingMode: "pct",
  sizingValue: 5,
  maxTradeSize: null,
  maxCoinSize: null,
  autoMirror: false,
  credentialId: "live-credential",
  credentialAccountLabel: "Live account LIVE-9876",
  credentialAccountType: "LIVE",
  credentialProvider: "alpaca",
  perpTakeProfitPct: null,
  perpStopLossPct: null,
  perpMaxLeverage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const LIMITS: MirrorLimits = {
  dailyCap: 20,
  maxOrderDollars: 1_000,
  dailyCapFromDefaults: false,
  maxOrderDollarsFromDefaults: false,
};

/**
 * The three destinations a row can be pointed at in these tests: the Live
 * Alpaca account the fixture follow is on, a Paper one, and Hyperliquid perps.
 * A re-point between them is exactly the escalation the confirmation exists for.
 */
const ACCOUNTS = [
  {
    id: "live-credential",
    provider: "alpaca",
    accountId: "LIVE-9876",
    accountType: "LIVE",
  },
  {
    id: "paper-credential",
    provider: "alpaca",
    accountId: "PAPER-1234",
    accountType: "PAPER",
  },
  {
    id: "perp-credential",
    provider: "hyperliquid",
    accountId: null,
    accountType: "LIVE",
  },
] as const satisfies readonly AlpacaAccountOption[];

interface RowSpies {
  updates: unknown[];
  /** Just the kind, for the assertions that only care which gate was hit. */
  consents: string[];
  /** The whole request, so a re-point's destination can be asserted. */
  asks: ConsentAsk[];
  drafts: string[];
  maxTradeSizeDrafts: string[];
  maxCoinSizeDrafts: string[];
  /** Staged exit levels, per leg. */
  protectionDrafts: Array<{ leg: "stopLoss" | "takeProfit"; next: string }>;
}

function renderRow(
  overrides: Partial<FollowItem> = {},
  extra: {
    deploymentBlockReason?: string | null;
    disabled?: boolean;
    accounts?: AlpacaAccountOption[];
    /** Uncommitted sizing value, as ManageFollows would be holding it. */
    valueDraft?: string;
    maxTradeSizeDraft?: string;
    maxCoinSizeDraft?: string;
    /** Uncommitted exit edits, same ownership. */
    protectionDraft?: { stopLoss: string; takeProfit: string };
    /** The terminal's account snapshot, as the panel threads it in. */
    buyingPower?: number;
    equity?: number;
    /**
     * Which credential that snapshot was read from. Defaults to the follow's
     * own destination, the only case where the two numbers above describe the
     * account this follow will actually trade in.
     */
    balancesCredentialId?: string | null;
    /** The user's global automatic-perp leverage ceiling. */
    globalPerpMaxLeverage?: number | null;
  } = {},
): { tree: ReactNode; spies: RowSpies } {
  const follow = { ...FOLLOW, ...overrides };
  const spies: RowSpies = {
    updates: [],
    consents: [],
    asks: [],
    drafts: [],
    maxTradeSizeDrafts: [],
    maxCoinSizeDrafts: [],
    protectionDrafts: [],
  };
  const tree = FollowRow({
    follow,
    accounts: extra.accounts ?? [...ACCOUNTS],
    accountsLoading: false,
    buyingPower: extra.buyingPower ?? 10_000,
    equity: extra.equity ?? 10_000,
    balancesCredentialId:
      extra.balancesCredentialId === undefined
        ? follow.credentialId
        : extra.balancesCredentialId,
    limits: LIMITS,
    deploymentBlockReason: extra.deploymentBlockReason ?? null,
    valueDraft: extra.valueDraft ?? String(follow.sizingValue),
    onValueDraftChange: (next) => spies.drafts.push(next),
    maxTradeSizeDraft: extra.maxTradeSizeDraft ?? (follow.maxTradeSize !== null ? String(follow.maxTradeSize) : ""),
    onMaxTradeSizeDraftChange: (next) => spies.maxTradeSizeDrafts.push(next),
    maxCoinSizeDraft: extra.maxCoinSizeDraft ?? (follow.maxCoinSize !== null ? String(follow.maxCoinSize) : ""),
    onMaxCoinSizeDraftChange: (next) => spies.maxCoinSizeDrafts.push(next),
    protectionDraft: extra.protectionDraft ?? {
      stopLoss: follow.perpStopLossPct === null ? "" : String(follow.perpStopLossPct),
      takeProfit: follow.perpTakeProfitPct === null ? "" : String(follow.perpTakeProfitPct),
    },
    onProtectionDraftChange: (leg, next) => spies.protectionDrafts.push({ leg, next }),
    onUpdate: (patch) => spies.updates.push(patch),
    onRequestConsent: (ask) => {
      spies.asks.push(ask);
      spies.consents.push(ask.kind);
    },
    globalPerpMaxLeverage:
      extra.globalPerpMaxLeverage === undefined ? 2 : extra.globalPerpMaxLeverage,
    disabled: extra.disabled ?? false,
  });
  return { tree, spies };
}

/**
 * Pick a destination through the account Select the row really mounted, by
 * invoking the `onValueChange` it wired, not a stand-in for it. The Select root
 * carries no accessible name of its own (the name is on its trigger), so it is
 * found by component identity.
 */
function pickAccount(tree: ReactNode, value: string): void {
  const select = findByComponent(tree, Select);
  const handler = select?.props.onValueChange;
  if (typeof handler !== "function") {
    throw new Error("row rendered no account Select with an onValueChange");
  }
  (handler as (next: string) => void)(value);
}

/**
 * Render the arming switch the row actually mounted, with the props the row
 * actually passed. `element-tree` walks children only, so the switch's own
 * output is unreachable from the row's tree without this step.
 */
function renderRowSwitch(tree: ReactNode): ReactNode {
  const mounted = findByComponent(tree, AutoMirrorSwitch);
  if (!mounted) throw new Error("row rendered no AutoMirrorSwitch");
  return AutoMirrorSwitch(mounted.props as Parameters<typeof AutoMirrorSwitch>[0]);
}

/** Flip the row's real arming switch, through the component the row mounted. */
function flipRowSwitch(tree: ReactNode, checked: boolean): void {
  toggle(findByAriaLabel(renderRowSwitch(tree), AUTO_MIRROR_LABEL), checked);
}

/**
 * Click one of the row's real sizing-basis tabs. `element-tree` walks children
 * only, so the tabs' own buttons exist only once the component the row mounted
 * is rendered with the props the row passed it.
 */
/** Commit the row's sizing value the way a user does, with Enter. */
function commitSizingValue(tree: ReactNode): void {
  const input = findByComponent(tree, Input);
  const handler = input?.props.onKeyDown;
  if (typeof handler !== "function") {
    throw new Error("row rendered no sizing value input with an onKeyDown");
  }
  (handler as (event: { key: string }) => void)({ key: "Enter" });
}

/** True when this element carries a click handler at all. */
function hasClickHandler(element: TestElement | undefined): boolean {
  return typeof element?.props.onClick === "function";
}

// ============================================
// 1. Arming cannot happen without confirmation
// ============================================

describe("arming is gated on a confirmation", () => {
  test("flipping the manage-follows switch on updates nothing, it asks", () => {
    // The bug: this handler used to call the update mutation directly, so one
    // stray tap armed real-money automation with no dialog and no summary.
    const { tree, spies } = renderRow();

    flipRowSwitch(tree, true);

    expect(spies.consents).toEqual(["arm"]);
    expect(spies.updates).toEqual([]);
  });

  test("flipping it off asks too, instead of stopping on the first click", () => {
    const { tree, spies } = renderRow({ autoMirror: true });

    flipRowSwitch(tree, false);

    expect(spies.consents).toEqual(["disarm"]);
    expect(spies.updates).toEqual([]);
  });

  test("Unfollow asks before deleting the follow", () => {
    const { tree, spies } = renderRow();

    click(findByAriaLabel(tree, "Unfollow Example Trader"));

    expect(spies.consents).toEqual(["unfollow"]);
    expect(spies.updates).toEqual([]);
  });

  test("the panel's inline Mirror switch also only raises a request", () => {
    const requests: string[] = [];
    const rendered = InlineMirrorSwitch({
      displayName: "Example Trader",
      armed: false,
      interactive: true,
      reason: null,
      accountMode: "LIVE",
      onRequestArm: () => requests.push("arm"),
      onRequestDisarm: () => requests.push("disarm"),
    });

    toggle(findByAriaLabel(rendered, "Auto-mirror Example Trader"), true);
    toggle(findByAriaLabel(rendered, "Auto-mirror Example Trader"), false);

    expect(requests).toEqual(["arm", "disarm"]);
  });

  test("the confirmation's own control is what arms, and Cancel does not", () => {
    let confirmed = 0;
    const summary = buildArmingSummary({
      trader: "Example Trader",
      account: "Live account LIVE-9876",
      destinationProvider: "alpaca",
      sizingMode: "pct",
      sizingValue: 5,
      limits: LIMITS,
    });
    const dialog = ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary,
      onConfirm: () => {
        confirmed += 1;
      },
    });

    // Cancel is wired to nothing at all: it closes the dialog through Radix and
    // cannot reach the mutation even by accident.
    const cancel = findByAriaLabel(dialog, "Cancel, do not place orders automatically");
    expect(cancel).toBeDefined();
    expect(hasClickHandler(cancel)).toBe(false);
    expect(confirmed).toBe(0);

    click(findByAriaLabel(dialog, summary.confirmLabel));
    expect(confirmed).toBe(1);
  });

  test("both dialogs mount through the real AlertDialog primitives", () => {
    // The tests above call the components as functions, which never exercises
    // the Radix chain underneath. Rendering them catches an invalid element
    // type or a bad prop that the tree walk would happily skip past.
    const arm = createElement(ArmMirrorDialog, {
      open: true,
      onOpenChange: () => {},
      summary: buildArmingSummary({
        trader: "Example Trader",
        account: "Hyperliquid perps",
        destinationProvider: "hyperliquid",
        sizingMode: "usd",
        sizingValue: 250,
        limits: LIMITS,
      }),
      onConfirm: () => {},
    });
    const stop = createElement(StopMirrorDialog, {
      open: true,
      onOpenChange: () => {},
      summary: buildStopSummary({ kind: "unfollow", trader: "Example Trader" }),
      onConfirm: () => {},
    });

    expect(() => renderToStaticMarkup(arm)).not.toThrow();
    expect(() => renderToStaticMarkup(stop)).not.toThrow();
  });
});

// ============================================
// 2. What the arming confirmation says
// ============================================

describe("the arming confirmation states what is being agreed to", () => {
  const summary = buildArmingSummary({
    trader: "Example Trader",
    account: "Live account LIVE-9876",
    destinationProvider: "alpaca",
    sizingMode: "pct",
    sizingValue: 5,
    limits: LIMITS,
  });

  test("names the trader, the account, the size, the daily cap and the ceiling", () => {
    const facts = Object.fromEntries(summary.facts.map((f) => [f.label, f.value]));

    expect(facts.Trader).toBe("Example Trader");
    expect(facts.Account).toBe("Live account LIVE-9876");
    // The unit is spelled out, not implied by a glyph next to a number.
    expect(facts["Size per order"]).toBe("5% of your buying power");
    expect(facts["Daily cap"]).toContain("20");
    expect(facts["Per-order ceiling"]).toContain("$1,000.00");
  });

  test("shows the effective perp leverage ceiling after applying the optional follow cap", () => {
    const inherited = buildFollowArmingSummary(summary, 2, null);
    const strict = buildFollowArmingSummary(summary, 2, 1);

    expect(
      inherited.facts.find((fact) => fact.label === "Perp leverage ceiling")?.value,
    ).toContain("2x");
    expect(
      strict.facts.find((fact) => fact.label === "Perp leverage ceiling")?.value,
    ).toContain("1x");
    expect(elementText(ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary: strict,
      onConfirm: () => {},
    }))).toContain("Perp leverage ceiling");
  });

  test("says orders are placed without asking again", () => {
    expect(summary.standingOrder).toBe(ARMING_STANDING_ORDER);
    expect(summary.standingOrder).toContain("not asked again");
  });

  test("says turning it off later does not close anything", () => {
    expect(summary.stopCaveat).toBe(ARMING_STOP_CAVEAT);
    expect(summary.stopCaveat).toContain("does not close positions");
  });

  test("the confirm control names the action instead of saying OK", () => {
    expect(summary.confirmLabel).toBe("Turn on automatic orders");
    expect(summary.confirmLabel).not.toBe("OK");
    expect(elementText(ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary,
      onConfirm: () => {},
    }))).toContain("Turn on automatic orders");
  });

  test("a Hyperliquid destination gets the perp disclosure, an Alpaca one does not", () => {
    const perpSummary = buildArmingSummary({
      trader: "Example Trader",
      account: "Hyperliquid perps",
      destinationProvider: "hyperliquid",
      sizingMode: "usd",
      sizingValue: 250,
      limits: LIMITS,
    });
    expect(perpSummary.showPerpDisclosure).toBe(true);
    expect(summary.showPerpDisclosure).toBe(false);

    const withPerps = ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary: perpSummary,
      onConfirm: () => {},
    });
    const withoutPerps = ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary,
      onConfirm: () => {},
    });

    expect(findByComponent(withPerps, PerpMirrorDisclosure)).toBeDefined();
    expect(findByComponent(withoutPerps, PerpMirrorDisclosure)).toBeUndefined();
  });

  test("says so plainly when no account is selected", () => {
    const noAccount = buildArmingSummary({
      trader: "Example Trader",
      account: null,
      destinationProvider: null,
      sizingMode: "pct",
      sizingValue: 5,
      limits: LIMITS,
    });
    expect(
      noAccount.facts.find((f) => f.label === "Account")?.value,
    ).toBe("No account selected");
  });

  test("reports unknown caps as unreported rather than inventing a number", () => {
    const unknown = buildArmingSummary({
      trader: "Example Trader",
      account: null,
      destinationProvider: null,
      sizingMode: "pct",
      sizingValue: 5,
      limits: resolveMirrorLimits(null),
    });
    const facts = Object.fromEntries(unknown.facts.map((f) => [f.label, f.value]));
    expect(facts["Daily cap"]).toBe("Not reported by this deployment.");
    expect(facts["Per-order ceiling"]).toBe("Not reported by this deployment.");
  });

  test("marks a fallback cap as the built-in default, not as configuration", () => {
    const limits = resolveMirrorLimits(unknownStatus());
    expect(limits.dailyCapFromDefaults).toBe(true);
    expect(limits.maxOrderDollarsFromDefaults).toBe(true);
    const summaryFromDefaults = buildArmingSummary({
      trader: "Example Trader",
      account: null,
      destinationProvider: null,
      sizingMode: "pct",
      sizingValue: 5,
      limits,
    });
    expect(
      summaryFromDefaults.facts.find((f) => f.label === "Daily cap")?.value,
    ).toContain("built-in default");
  });

  test("a cap the deployment does report is never replaced by the default", () => {
    // A partly configured API is the normal case, not an edge one:
    // resolveMirrorStatus reads each cap from its OWN environment variable, so
    // mirroring COPY_TRADE_AUTOMIRROR_DAILY_CAP without
    // COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS yields exactly this shape. The
    // whole-object fallback threw the reported 7 away and told the user 20.
    const limits = resolveMirrorLimits(
      visibleStatus({ dailyCap: 7, maxOrderDollars: null }),
    );

    expect(limits.dailyCap).toBe(7);
    expect(limits.dailyCapFromDefaults).toBe(false);
    expect(limits.maxOrderDollars).toBe(1_000);
    expect(limits.maxOrderDollarsFromDefaults).toBe(true);
  });

  test("the confirmation prints that reported cap, and flags only the fallback", () => {
    const partial = buildArmingSummary({
      trader: "Example Trader",
      account: "Live account LIVE-9876",
      destinationProvider: "alpaca",
      sizingMode: "pct",
      sizingValue: 5,
      limits: resolveMirrorLimits(visibleStatus({ dailyCap: 7, maxOrderDollars: null })),
    });
    const facts = Object.fromEntries(partial.facts.map((f) => [f.label, f.value]));

    expect(facts["Daily cap"]).toContain("Up to 7 mirrored orders");
    // The reported number is configuration, so it must not be captioned as the
    // built-in default the deployment was never running.
    expect(facts["Daily cap"]).not.toContain("built-in default");
    expect(facts["Per-order ceiling"]).toContain("built-in default");
  });

  test("the other direction: a reported ceiling survives an unreported cap", () => {
    const limits = resolveMirrorLimits(
      visibleStatus({ dailyCap: null, maxOrderDollars: 250 }),
    );

    expect(limits.maxOrderDollars).toBe(250);
    expect(limits.maxOrderDollarsFromDefaults).toBe(false);
    expect(limits.dailyCap).toBe(20);
    expect(limits.dailyCapFromDefaults).toBe(true);
  });

  /**
   * The cap is one budget per FOLLOWER, not one per follow.
   *
   * `countMirrorsToday` (apps/worker/src/services/copy-mirror.ts) counts every
   * order whose client_order_id starts with `copymirror:<followerUserId>:`,
   * filtered by user and by date and by nothing else: no follow id, no target,
   * no asset type, so a Hyperliquid perp mirror and an Alpaca equity mirror draw
   * down the same number. `withinDailyCap` (apps/api/src/lib/copy-mirror.ts)
   * compares that follower-wide count against the single deployment cap, and
   * docs/deployment/copy-mirror-env-reference.md states the scope the same way:
   * "Mirrored orders per follower per day."
   *
   * Stating it as per-follow is a consent defect, not a wording nit. A user
   * arming four traders reads four independent 20-order budgets, sizes each
   * follow as though it had 20 of its own, and in fact gets 20 shared between
   * them. One busy trader spends the lot before noon and every candidate from
   * the other three is skipped as `daily-cap` for the rest of the day, with all
   * four switches still reading On.
   */
  test("states the daily cap as one budget shared by every armed follow", () => {
    const facts = Object.fromEntries(summary.facts.map((f) => [f.label, f.value]));

    expect(facts["Daily cap"]).toContain("Up to 20 mirrored orders a day");
    // The exact claim that made the user over-budget by four times.
    expect(facts["Daily cap"]).not.toContain("mirrored orders a day for this follow.");
    // What the worker enforces has to be the thing the user is told.
    expect(facts["Daily cap"]).toContain("shared by every follow");
    expect(facts["Daily cap"]).toContain("Alpaca and Hyperliquid");
    // And the consequence, which is the part the user budgets against.
    expect(facts["Daily cap"]).toContain("your other follows");
  });

  test("the shared-budget scope holds on a re-point and under a default cap", () => {
    // The scope is a fact about the worker, so it cannot depend on which control
    // opened the dialog, on which venue the follow points at, or on whether the
    // number came from configuration or from the compiled-in default.
    const repoint = buildArmingSummary({
      trader: "Example Trader",
      account: "Hyperliquid perps",
      destinationProvider: "hyperliquid",
      sizingMode: "usd",
      sizingValue: 250,
      limits: LIMITS,
      variant: "repoint",
      previousAccount: "Live account LIVE-9876",
    });
    const fromDefaults = buildArmingSummary({
      trader: "Example Trader",
      account: "Live account LIVE-9876",
      destinationProvider: "alpaca",
      sizingMode: "pct",
      sizingValue: 5,
      limits: resolveMirrorLimits(unknownStatus()),
    });

    for (const built of [repoint, fromDefaults]) {
      const value = built.facts.find((f) => f.label === "Daily cap")?.value ?? "";
      expect(value).not.toContain("mirrored orders a day for this follow.");
      expect(value).toContain("shared by every follow");
    }

    // The default caption still rides on the end of the shared-budget sentence,
    // so a fallback number is not mistaken for configuration.
    expect(
      fromDefaults.facts.find((f) => f.label === "Daily cap")?.value,
    ).toContain("built-in default");
  });
});

// ============================================
// 3. Stopping tells the truth
// ============================================

describe("the stop confirmation says what stopping does and does not do", () => {
  test("disarming halts new orders and closes nothing", () => {
    const summary = buildStopSummary({ kind: "disarm", trader: "Example Trader" });
    const joined = summary.points.join(" ");

    expect(summary.title).toContain("Example Trader");
    expect(joined).toContain("No new orders will be placed");
    expect(joined).toContain("stay open");
    expect(joined).toContain("does not sell, close or unwind");
    // The one nuance the worker really has: a close already staged is exempt
    // from the consent re-read and still drains, and it can only shrink.
    expect(joined).toContain("already queued can still go through");
    expect(joined).toContain("never opens one");
    expect(summary.confirmLabel).toBe("Stop automatic orders");
  });

  test("unfollowing additionally says the follow itself is deleted", () => {
    const summary = buildStopSummary({ kind: "unfollow", trader: "Example Trader" });
    const joined = summary.points.join(" ");

    expect(joined).toContain("deleted");
    expect(joined).toContain("sizing rule");
    expect(joined).toContain("stay open");
    expect(summary.confirmLabel).toBe("Unfollow and stop new orders");
  });

  test("clearing the account says the disarm out loud, and that the follow stays", () => {
    const summary = buildStopSummary({ kind: "clear-account", trader: "Example Trader" });
    const joined = summary.points.join(" ");

    expect(summary.title).toContain("Example Trader");
    // The disarm is the part the user did not ask for and would not otherwise
    // learn about until the toast, so it leads.
    expect(joined).toContain("turns auto-mirror off");
    expect(joined).toContain("No new orders will be placed");
    // And what it does NOT do: delete the follow, or re-arm on the way back.
    expect(joined).toContain("The follow itself stays, with its sizing rule");
    expect(joined).toContain("does not switch automatic orders back on");
    expect(joined).not.toContain("deleted");
    expect(joined).toContain("stay open");
    expect(summary.confirmLabel).toBe("Clear account and stop automatic orders");
  });

  test("the three stops are told apart, not given one generic warning", () => {
    const titles = new Set(
      (["disarm", "unfollow", "clear-account"] as const).map(
        (kind) => buildStopSummary({ kind, trader: "Example Trader" }).title,
      ),
    );
    const labels = new Set(
      (["disarm", "unfollow", "clear-account"] as const).map(
        (kind) => buildStopSummary({ kind, trader: "Example Trader" }).confirmLabel,
      ),
    );

    expect(titles.size).toBe(3);
    expect(labels.size).toBe(3);
  });

  test("none of them claims the positions are closed", () => {
    for (const kind of ["disarm", "unfollow", "clear-account"] as const) {
      const joined = buildStopSummary({ kind, trader: "Example Trader" }).points.join(" ");
      expect(joined).not.toContain("closes your positions");
      expect(joined).not.toContain("will be closed");
      // The two sentences every stop owes the user, whatever else it does.
      expect(joined).toContain("stay open");
      expect(joined).toContain("already queued can still go through");
    }
  });

  test("the stop dialog's confirm control is what stops", () => {
    let confirmed = 0;
    const summary = buildStopSummary({ kind: "disarm", trader: "Example Trader" });
    const dialog = StopMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary,
      onConfirm: () => {
        confirmed += 1;
      },
    });

    const cancel = findByAriaLabel(dialog, "Cancel, keep this follow as it is");
    expect(cancel).toBeDefined();
    expect(hasClickHandler(cancel)).toBe(false);
    expect(confirmed).toBe(0);

    click(findByAriaLabel(dialog, summary.confirmLabel));
    expect(confirmed).toBe(1);
    // Every point survives into the rendered dialog, not just the first.
    for (const point of summary.points) {
      expect(elementText(dialog)).toContain(point);
    }
  });
});

describe("destination stop confirmation stays scoped to one venue", () => {
  for (const destination of ["stock", "perp"] as const) {
    const otherVenue = destination === "stock" ? "Perps" : "Stocks";
    const orderNoun = destination === "stock" ? "stock" : "perp";

    for (const kind of ["disarm", "clear-account"] as const) {
      test(`${kind}ing ${destination} leaves the other venue unchanged`, () => {
        const summary = buildDestinationStopSummary({
          kind,
          destination,
          trader: "Example Trader",
          account: destination === "stock" ? "Live account LIVE-9876" : "Hyperliquid testnet perps",
          sizingMode: "usd",
          sizingValue: 250,
        });
        const joined = [summary.title, ...summary.points].join(" ");

        expect(joined).toContain(
          `This stops only automatic ${orderNoun} orders from Example Trader.`,
        );
        expect(joined).toContain(`${otherVenue} are unchanged and may remain active.`);
        expect(joined).not.toContain("No new orders will be placed from Example Trader.");
      });
    }
  }
});

// ============================================
// 4. Sizing named in words
// ============================================

describe("sizing modes are named in words", () => {
  test("keeps sizing and mirror controls comfortable on mobile", () => {
    const sizing = SizingModeTabs({ value: "pct", onChange: () => {} });
    const inlineMirror = InlineMirrorSwitch({
      displayName: "Example Trader",
      armed: false,
      interactive: true,
      reason: null,
      accountMode: "PAPER",
      onRequestArm: () => {},
      onRequestDisarm: () => {},
    });

    const sizingHtml = renderToStaticMarkup(sizing);
    const mirrorHtml = renderToStaticMarkup(inlineMirror);
    const autoHtml = renderToStaticMarkup(
      AutoMirrorSwitch({
        armed: false,
        interactive: true,
        reason: null,
        onRequestArm: () => {},
        onRequestDisarm: () => {},
      }),
    );
    expect(sizingHtml).toContain("h-11 xl:h-7");
    expect(sizingHtml).not.toContain("sm:h-7");
    expect(mirrorHtml).toContain("h-11 xl:h-7");
    expect(mirrorHtml).not.toContain("sm:h-7");
    expect(autoHtml).toContain("h-11 xl:h-7");
    expect(autoHtml).not.toContain("sm:h-7");
  });

  test("keeps the narrow follow selector stacked and interactive", () => {
    const changes: SizingMode[] = [];
    const sizing = SizingModeTabs({
      value: "pct",
      stackOnNarrow: true,
      onChange: (mode) => changes.push(mode),
    });
    const elements = flattenElements(sizing);
    const group = elements.find((element) => element.props.role === "group");
    const selected = findByTitle(sizing, SIZING_MODE_PRESENTATION.pct.aria);
    const selectedRule = elements.find(
      (element) => element.props["data-sizing-mode-rule"] === "true",
    );
    const dollars = findByTitle(sizing, SIZING_MODE_PRESENTATION.usd.aria);

    expect(group?.props.className).toContain("grid-cols-2");
    expect(selected?.props["data-state"]).toBe("active");
    expect(selectedRule?.props["data-sizing-mode-rule"]).toBe("true");

    click(dollars);
    expect(changes).toEqual(["usd"]);
  });

  // Opt in with a Playwright module path; no browser dependency is added to the app.
  test.skipIf(!process.env.RST_PLAYWRIGHT_MODULE)("renders coherent sizing dividers across sm and xl", async () => {
    const { chromium } = await import(process.env.RST_PLAYWRIGHT_MODULE!);
    const { compile } = await import("tailwindcss");
    const theme = await Bun.file(new URL(import.meta.resolve("tailwindcss/theme.css"))).text();
    const preflight = await Bun.file(new URL(import.meta.resolve("tailwindcss/preflight.css"))).text();
    const compiler = await compile(`${theme}\n${preflight}\n@tailwind utilities;`);
    const trees = [false, true].map(stackOnNarrow => SizingModeTabs({ value: "pct", stackOnNarrow, onChange: () => {} }));
    const classes = trees.flatMap(tree => flattenElements(tree).flatMap(e => String(e.props.className ?? "").split(/\s+/)));
    const css = compiler.build(classes);
    const bundle = await Bun.build({
      entrypoints: ["sizing-browser-fixture"], target: "browser", format: "iife",
      plugins: [{ name: "sizing-browser-fixture", setup(build) {
        build.onResolve({ filter: /^sizing-browser-fixture$/ }, () => ({ path: `${import.meta.dir}/sizing-browser-fixture.jsx` }));
        build.onLoad({ filter: /sizing-browser-fixture\.jsx$/ }, () => ({
          loader: "jsx", resolveDir: import.meta.dir,
          contents: `import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { SizingModeTabs } from './sizing-mode-tabs';
            function Fixture() {
              const [value, setValue] = React.useState('pct');
              return React.createElement(SizingModeTabs, {value, onChange: setValue, stackOnNarrow: window.stacked});
            }
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));`,
        }));
      } }],
    });
    expect(bundle.success, String(bundle.logs)).toBe(true);
    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    try {
      for (const stacked of [false, true]) {
        for (const width of [375, 639, 640, 1024, 1279, 1280]) {
          const page = await browser.newPage({ viewport: { width, height: 480 } });
          await page.setContent(`<style>${css}\nbody { background: #06151c; color: #8da5ad; }</style><div id="root"></div><script>window.stacked=${stacked}</script>`);
          await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
          await page.getByRole("button").first().waitFor();
          const layout = await page.getByRole("group").evaluate((group: HTMLElement) => ({
            display: getComputedStyle(group).display,
            frame: ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].map(key => getComputedStyle(group)[key as any]),
            buttons: [...group.querySelectorAll("button")].map(button => {
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              return { x: rect.x, y: rect.y, height: rect.height, top: style.borderTopWidth, left: style.borderLeftWidth };
            }),
          }));
          const grid = stacked && width < 640;
          expect(layout.display).toBe(grid ? "grid" : "inline-flex");
          expect(new Set(layout.buttons.map((button: any) => button.y)).size).toBe(grid ? 2 : 1);
          expect(layout.buttons.map((button: any) => button.top)).toEqual(grid ? ["0px", "0px", "1px", "1px"] : ["0px", "0px", "0px", "0px"]);
          expect(layout.buttons.map((button: any) => button.left)).toEqual(grid ? ["0px", "1px", "0px", "1px"] : width >= 1280 ? ["0px", "1px", "1px", "1px"] : ["0px", "0px", "0px", "0px"]);
          expect(layout.frame).toEqual(width >= 1280 ? ["1px", "1px", "1px", "1px"] : ["0px", "0px", "1px", "0px"]);
          expect(layout.buttons.every((button: any) => button.height === (width >= 1280 ? 28 : 44))).toBe(true);
          if (grid) {
            expect(layout.buttons[0].x).toBe(layout.buttons[2].x);
            expect(layout.buttons[1].x).toBe(layout.buttons[3].x);
          }
          const dollars = page.getByTitle(SIZING_MODE_PRESENTATION.usd.aria, { exact: true });
          await dollars.click();
          await page.waitForFunction((label: string) => document.querySelector('[aria-pressed="true"]')?.textContent === label, SIZING_MODE_PRESENTATION.usd.label);
          expect(await dollars.getAttribute("aria-pressed")).toBe("true");
          if (process.env.RST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.RST_SCREENSHOT_DIR}/sizing-${stacked}-${width}.png` });
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }, 60_000);

  test("restores the compact terminal treatment at xl", () => {
    const sizingHtml = renderToStaticMarkup(
      SizingModeTabs({ value: "pct", onChange: () => {} }),
    );
    const mirrorHtml = renderToStaticMarkup(
      InlineMirrorSwitch({
        displayName: "Example Trader",
        armed: false,
        interactive: true,
        reason: null,
        accountMode: "PAPER",
        onRequestArm: () => {},
        onRequestDisarm: () => {},
      }),
    );
    const autoHtml = renderToStaticMarkup(
      AutoMirrorSwitch({
        armed: false,
        interactive: true,
        reason: null,
        onRequestArm: () => {},
        onRequestDisarm: () => {},
      }),
    );

    expect(sizingHtml).toContain("xl:rounded-md");
    expect(sizingHtml).toContain("xl:border-border");
    expect(sizingHtml).toContain("xl:bg-transparent");
    expect(sizingHtml).toContain("xl:p-0");
    expect(mirrorHtml).toContain("xl:h-7");
    expect(mirrorHtml).toContain("xl:border-border");
    expect(mirrorHtml).toContain("xl:bg-transparent");
    expect(mirrorHtml).toContain("xl:text-foreground");
    expect(autoHtml).toContain("xl:border-0");
  });

  test("below xl, the sizing basis is brighter text over a gold rule, not a gold fill", () => {
    // DESIGN.md: gold is a seasoning. On a phone the selector is a flat tab
    // strip on a hairline, like every other mobile strip; the terminal's
    // bordered, primary-filled control is restored at xl.
    const html = renderToStaticMarkup(
      SizingModeTabs({ value: "pct", onChange: () => {} }),
    );
    const selected =
      html.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";
    const idle = html.match(/<button[^>]*aria-pressed="false"[^>]*>/)?.[0] ?? "";

    expect(html).toContain("border-b border-[#1a3b46]");
    expect(html).not.toContain("bg-[#071b24]");
    expect(selected).toContain("text-white");
    expect(selected).toContain("font-semibold");
    expect(selected).toContain("xl:bg-primary/15");
    expect(selected).not.toContain("bg-[#e7c65d]");
    expect(selected).not.toContain("text-[#1c1a0f]");
    expect(idle).toContain("text-[#8da5ad]");
    expect(idle).not.toContain("border-[#2c4d57]");
    expect(html.match(/data-sizing-mode-rule="true"/g)).toHaveLength(1);
  });

  test("at xl, the selected basis is a primary tint, not a solid gold segment", () => {
    // The desktop half of the same DESIGN.md rule: four segments sit side by
    // side, so a solid `xl:bg-primary` selection flooded a quarter of the
    // control with the accent. It is now the chart-overlay tint recipe.
    const html = renderToStaticMarkup(
      SizingModeTabs({ value: "pct", onChange: () => {} }),
    );
    const selected =
      html.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";

    expect(selected).toContain("xl:bg-primary/15");
    expect(selected).toContain("xl:text-primary");
    expect(selected).not.toContain("xl:text-primary-foreground");
    // No solid accent fill survives at any breakpoint.
    expect(html).not.toMatch(/(?:^|["\s])(?:xl:)?bg-primary(?![-/])/);
  });

  test("no mode is labelled with a bare glyph", () => {
    for (const mode of SIZING_MODES) {
      const label = SIZING_MODE_PRESENTATION[mode].label;
      expect(label).not.toBe("%");
      expect(label).not.toBe("% eq");
      expect(label).not.toBe("$");
      expect(label).not.toBe("×");
      expect(label).toMatch(/^[A-Za-z][A-Za-z ]+$/);
    }
  });

  test("the selector paints those words", () => {
    const text = elementText(
      SizingModeTabs({ value: "pct", onChange: () => {} }),
    );
    expect(text).toBe("Buying powerDollars");
  });

  test("one table, so the two surfaces cannot caption a mode differently", () => {
    // Both the panel's manual-copy control and the manage-follows row read
    // SIZING_MODE_PRESENTATION, so "of buying power" vs "of margin buying
    // power" can no longer drift apart. This pins the caption the row paints.
    expect(SIZING_MODE_PRESENTATION.pct.caption).toBe("% of buying power");
    const { tree } = renderRow();
    expect(elementText(tree)).toContain("% of buying power");
  });

  test("a size reads as a sentence in the confirmation", () => {
    expect(describeSizePerOrder("pct", 5)).toBe("5% of your buying power");
    expect(describeSizePerOrder("pct_equity", 10)).toBe("10% of your net equity");
    expect(describeSizePerOrder("usd", 500)).toBe("$500.00 of notional");
    expect(describeSizePerOrder("ratio", 0.5)).toBe("0.5x the source trader's quantity");
  });
});

// ============================================
// 4a. The size sentence is stated in the destination venue's own base
// ============================================

/** The "Size per order" fact for one destination, as the dialog prints it. */
function sizeFact(
  destinationProvider: "alpaca" | "hyperliquid" | null,
  sizingMode: SizingMode = "pct",
  sizingValue = 10,
): string {
  const summary = buildArmingSummary({
    trader: "Example Trader",
    account: destinationProvider === "hyperliquid" ? "Hyperliquid perps" : "Live account LIVE-9876",
    destinationProvider,
    sizingMode,
    sizingValue,
    limits: LIMITS,
  });
  return summary.facts.find((fact) => fact.label === "Size per order")?.value ?? "";
}

describe("the size sentence names the base the destination venue really uses", () => {
  test("a pct follow does not read identically on Alpaca and on Hyperliquid", () => {
    // The bug: `describeSizePerOrder` took only the mode and the value, so a
    // follower arming one follow on each venue at pct = 10 read the same
    // "10% of your buying power" twice. Alpaca sizes that off margin-inflated
    // buying power; Hyperliquid sizes it off FREE CROSS COLLATERAL and takes
    // the result as the position's notional.
    const alpaca = sizeFact("alpaca");
    const perps = sizeFact("hyperliquid");

    expect(alpaca).toBe("10% of your buying power");
    expect(perps).not.toBe(alpaca);
    expect(perps).toContain("free collateral");
    expect(perps).not.toContain("10% of your buying power");
  });

  test("the perp sentence states the base and what the percent buys", () => {
    // Both halves matter: WHICH number is multiplied (free collateral, not
    // buying power) and WHAT the product is (the position's notional size, not
    // the margin posted against it).
    const perps = describeSizePerOrder("pct", 10, "hyperliquid");
    expect(perps).toContain("10%");
    expect(perps).toContain("free collateral");
    expect(perps).toContain("notional");
  });

  test("only pct differs by venue: the other three bases mean the same thing", () => {
    // pct_equity multiplies net equity on both (`account.equity` on Alpaca,
    // `accountValueUsd` on Hyperliquid), usd is a target notional on both, and
    // ratio scales the source trader's own quantity on both. Rewording those
    // would invent a difference the worker does not have.
    expect(describeSizePerOrder("pct_equity", 10, "hyperliquid")).toBe("10% of your net equity");
    expect(describeSizePerOrder("usd", 500, "hyperliquid")).toBe("$500.00 of notional");
    expect(describeSizePerOrder("ratio", 2, "hyperliquid")).toBe(
      "2x the source trader's quantity",
    );
  });

  test("the Alpaca sentence is untouched, on every mode", () => {
    // Buying power IS the base `computeMirrorQty` uses for pct on Alpaca, so
    // this venue's wording was never the defect.
    expect(describeSizePerOrder("pct", 10, "alpaca")).toBe("10% of your buying power");
    expect(describeSizePerOrder("pct_equity", 10, "alpaca")).toBe("10% of your net equity");
    expect(describeSizePerOrder("usd", 500, "alpaca")).toBe("$500.00 of notional");
    expect(describeSizePerOrder("ratio", 2, "alpaca")).toBe("2x the source trader's quantity");
  });

  test("the Manage follows row says it in the same words as the confirmation", () => {
    // The row prints the saved rule for a follow whose destination is not the
    // account open in the terminal. A Hyperliquid follow always takes that
    // branch (the snapshot is Alpaca-only), so this is the sentence a perp
    // follower reads every time they open Manage follows.
    const { tree } = renderRow(
      {
        credentialId: "perp-credential",
        credentialAccountLabel: "Hyperliquid perps",
        credentialProvider: "hyperliquid",
        sizingMode: "pct",
        sizingValue: 10,
      },
      { balancesCredentialId: "live-credential" },
    );
    const text = elementText(tree);

    expect(text).toContain("free collateral");
    expect(text).not.toContain("10% of your buying power");
  });
});

// ============================================
// 4b. Sizing value commits with the staged mode
// ============================================

describe("sizing value commit", () => {
  test("committing a value on a legacy usd follow migrates it to pct", () => {
    // The UI always saves as pct. A follow stored under a legacy mode (usd, ratio,
    // pct_equity) is silently migrated to pct on the user's next value commit.
    const { tree, spies } = renderRow({ sizingMode: "usd", sizingValue: 50 }, { valueDraft: "10" });

    commitSizingValue(tree);

    expect(spies.updates).toEqual([{ sizingMode: "pct", sizingValue: 10 }]);
  });

  test("committing the same value on a pct follow does nothing", () => {
    const { tree, spies } = renderRow({ sizingMode: "pct", sizingValue: 5 }, { valueDraft: "5" });

    commitSizingValue(tree);

    expect(spies.updates).toEqual([]);
  });

  test("a value outside pct bounds shows a validation error and commits nothing", () => {
    const { tree, spies } = renderRow({ sizingMode: "pct", sizingValue: 5 }, { valueDraft: "150" });

    commitSizingValue(tree);

    expect(spies.updates).toEqual([]);
    expect(elementText(tree)).toContain("Value must be between 0.01 and 100");
  });
});

// ============================================
// 5. Deployment status
// ============================================

function visibleStatus(overrides: Partial<MirrorStatus> = {}): MirrorStatus {
  return {
    visibility: "visible",
    enabled: true,
    allowLive: false,
    perpsEnabled: false,
    perpsMainnetAllowed: false,
    network: null,
    dailyCap: 20,
    maxOrderDollars: 1_000,
    defaults: { dailyCap: 20, maxOrderDollars: 1_000 },
    ...overrides,
  };
}

function unknownStatus(): MirrorStatus {
  return {
    visibility: "unknown",
    enabled: null,
    allowLive: null,
    perpsEnabled: null,
    perpsMainnetAllowed: null,
    network: null,
    dailyCap: null,
    maxOrderDollars: null,
    defaults: { dailyCap: 20, maxOrderDollars: 1_000 },
  };
}

describe("deployment status is reported honestly", () => {
  test("an unreported deployment says unknown, and does not read as off", () => {
    const notice = describeMirrorDeployment(unknownStatus());
    expect(notice?.kind).toBe("unknown");
    expect(notice?.headline).toContain("unknown");
    expect(notice?.headline).not.toContain("off");
    // "The API was never told" is not evidence the worker is off, so it must
    // not block a user from arming.
    expect(notice?.blockReason).toBeNull();
  });

  test("a deployment that reports auto-mirroring off blocks arming, with a reason", () => {
    const notice = describeMirrorDeployment(visibleStatus({ enabled: false }));
    expect(notice?.kind).toBe("off");
    expect(notice?.headline).toContain("turned off");
    expect(notice?.blockReason).toContain("would place no orders");
  });

  test("there is no confident On banner for something we cannot confirm", () => {
    expect(describeMirrorDeployment(visibleStatus({ enabled: true }))).toBeNull();
    expect(describeMirrorDeployment(null)).toBeNull();
  });

  test("the row disables its switch with the deployment's reason", () => {
    const reason = describeMirrorDeployment(visibleStatus({ enabled: false }))!.blockReason!;
    const { tree } = renderRow({}, { deploymentBlockReason: reason });

    const mounted = findByComponent(tree, AutoMirrorSwitch);
    expect(mounted?.props.interactive).toBe(false);
    expect(mounted?.props.reason).toBe(reason);
    // Painted, not only a tooltip: the switch and the reason render together.
    const painted = renderRowSwitch(tree);
    expect(elementText(painted)).toContain("would place no orders");
    expect(findByAriaLabel(painted, AUTO_MIRROR_LABEL)?.props.disabled).toBe(true);
  });

  test("an armed follow can still be stopped while the deployment is off", () => {
    const reason = describeMirrorDeployment(visibleStatus({ enabled: false }))!.blockReason!;
    const { tree, spies } = renderRow(
      { autoMirror: true },
      { deploymentBlockReason: reason },
    );

    flipRowSwitch(tree, false);
    expect(spies.consents).toEqual(["disarm"]);
  });
});

// ============================================
// 6. The disabled switch explains itself
// ============================================

describe("a disabled arming switch says why and what to do", () => {
  test("no account selected points at the account picker", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: false,
      credentialId: null,
    });
    expect(state.interactive).toBe(false);
    expect(state.reason).toContain("Choose a mirror account");
  });

  test("Manage follows blocks an unarmed Hyperliquid follow until its global cap loads", () => {
    const { tree } = renderRow(
      { credentialId: "perp-credential", credentialProvider: "hyperliquid" },
      { globalPerpMaxLeverage: null },
    );
    const mounted = findByComponent(tree, AutoMirrorSwitch);

    expect(mounted?.props.interactive).toBe(false);
    expect(mounted?.props.reason).toContain("global copy-trading leverage cap");
  });

  test("Manage follows still lets an armed Hyperliquid follow request disarm without its cap", () => {
    const { tree, spies } = renderRow(
      {
        autoMirror: true,
        credentialId: "perp-credential",
        credentialProvider: "hyperliquid",
      },
      { globalPerpMaxLeverage: null },
    );

    flipRowSwitch(tree, false);

    expect(spies.consents).toEqual(["disarm"]);
  });

  test("Manage follows keeps Alpaca arming available while the perp cap is unavailable", () => {
    const { tree } = renderRow(
      { credentialId: "live-credential", credentialProvider: "alpaca" },
      { globalPerpMaxLeverage: null },
    );
    const mounted = findByComponent(tree, AutoMirrorSwitch);

    expect(mounted?.props.interactive).toBe(true);
  });

  test("the row paints that reason where the caption used to be", () => {
    const { tree } = renderRow({ credentialId: null, credentialAccountLabel: null });
    const painted = renderRowSwitch(tree);
    expect(elementText(painted)).toContain("Choose a mirror account above first");
    expect(findByAriaLabel(painted, AUTO_MIRROR_LABEL)?.props.disabled).toBe(true);
  });

  test("an unsupported source names the source", () => {
    const state = autoMirrorSwitchState({
      supported: false,
      pending: false,
      autoMirror: false,
      credentialId: "live-credential",
      targetLabel: "Politician",
    });
    expect(state.interactive).toBe(false);
    expect(state.reason).toContain("Politician");
  });

  test("an out-of-range sizing value blocks arming and says so", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: false,
      credentialId: "live-credential",
      sizingInvalid: true,
    });
    expect(state.interactive).toBe(false);
    expect(state.reason).toContain("outside the accepted range");
  });

  test("a usable switch carries no reason", () => {
    expect(
      autoMirrorSwitchState({
        supported: true,
        pending: false,
        autoMirror: false,
        credentialId: "live-credential",
      }),
    ).toEqual({ interactive: true, reason: null });
  });

  test("a usable switch keeps the off-by-default real-orders caption", () => {
    const painted = renderRowSwitch(renderRow().tree);
    expect(elementText(painted)).toBe(
      `Auto-mirror${AUTO_MIRROR_ARMED_CAPTION}`,
    );
    expect(AUTO_MIRROR_ARMED_CAPTION).toContain("Auto-places real orders");
    expect(AUTO_MIRROR_ARMED_CAPTION).toContain("Off by default");
    expect(findByAriaLabel(painted, AUTO_MIRROR_LABEL)?.props.disabled).toBe(false);
  });
});

// ============================================
// 6b. Which sources auto-mirror actually supports
// ============================================

describe("auto-mirror is offered only where the worker supports it", () => {
  test("labels external callers without assuming their source", () => {
    expect(followTargetTypeLabel("x_author")).toBe("Caller");
    expect(followTargetTypeLabel("user")).toBe("User");
    expect(followTargetTypeLabel("politician")).toBe("Politician");
  });

  test("user and caller follows can be armed", () => {
    for (const targetType of ["user", "x_author"] as const) {
      const { tree } = renderRow({ targetType });
      expect(findByComponent(tree, AutoMirrorSwitch)?.props.interactive).toBe(true);
    }
  });

  test("a politician follow is never armed and says why", () => {
    // autoMirror true in the row on purpose: even a stale flag must not paint
    // this switch as On for a source the worker will not mirror.
    const { tree } = renderRow({ targetType: "politician", autoMirror: true });
    const mounted = findByComponent(tree, AutoMirrorSwitch);

    expect(mounted?.props.armed).toBe(false);
    expect(mounted?.props.interactive).toBe(false);
    expect(String(mounted?.props.reason)).toContain("Politician");
    expect(elementText(renderRowSwitch(tree))).toContain("not available for Politician");
  });
});

// ============================================
// 6c. Re-pointing an armed follow is a consent decision
// ============================================

describe("moving an armed follow to another account is confirmed first", () => {
  test("the picker offers every saved account by name, plus No account", () => {
    // Replaces the `accountOptionLabel(account)` source-string assertion that
    // used to live in copy-trade-follow.test.ts: read off the rendered row, so
    // it fails if the options stop being labelled rather than if the call
    // expression is reworded.
    const { tree } = renderRow();
    const values = flattenElements(tree)
      .filter((element) => typeof element.props.value === "string" && element.props.children)
      .map((element) => element.props.value);

    expect(values).toContain("none");
    for (const account of ACCOUNTS) expect(values).toContain(account.id);
    expect(elementText(tree)).toContain("No account");
    expect(elementText(tree)).toContain("Paper account PAPER-1234");
    expect(elementText(tree)).toContain("Hyperliquid perps");
  });

  test("picking a different account on an armed follow asks instead of mutating", () => {
    // The bug: this Select called onUpdate straight out of onValueChange, and
    // the API keeps auto-mirror on for any non-null credential. So one click
    // moved live automation from a Paper Alpaca account to a Live one, or onto
    // leveraged Hyperliquid perps, under "Follow settings updated".
    const { tree, spies } = renderRow({ autoMirror: true });

    pickAccount(tree, "perp-credential");

    expect(spies.updates).toEqual([]);
    expect(spies.asks).toEqual([{ kind: "repoint", credentialId: "perp-credential" }]);
  });

  test("Paper to Live is asked about too, not only a change of venue", () => {
    const { tree, spies } = renderRow({
      autoMirror: true,
      credentialId: "paper-credential",
      credentialAccountLabel: "Paper account PAPER-1234",
      credentialAccountType: "PAPER",
    });

    pickAccount(tree, "live-credential");

    expect(spies.updates).toEqual([]);
    expect(spies.asks).toEqual([{ kind: "repoint", credentialId: "live-credential" }]);
  });

  test("an unarmed follow still re-points in one click, with nothing armed", () => {
    // Nothing is running, so there is no consent to re-grant. Adding a dialog
    // here would only train people to click through the one that matters.
    const { tree, spies } = renderRow({ autoMirror: false });

    pickAccount(tree, "perp-credential");

    expect(spies.consents).toEqual([]);
    expect(spies.updates).toEqual([{ credentialId: "perp-credential" }]);
  });

  test("clearing the account on an armed follow is a stop, so it asks too", () => {
    // The API turns an explicit null credential into `autoMirror: false`
    // regardless of what the client asked for, so this picker is the last
    // remaining one-click stop of live automation. It is a stop like any other
    // and carries the same misreading (that the positions went with it), so it
    // goes through the same confirmation rather than a post-hoc toast.
    const { tree, spies } = renderRow({ autoMirror: true });

    pickAccount(tree, "none");

    expect(spies.updates).toEqual([]);
    expect(spies.asks).toEqual([{ kind: "clear-account" }]);
  });

  test("clearing it on an unarmed follow stays direct, there is nothing to stop", () => {
    const { tree, spies } = renderRow({ autoMirror: false });

    pickAccount(tree, "none");

    expect(spies.consents).toEqual([]);
    expect(spies.updates).toEqual([{ credentialId: null }]);
  });

  test("a follow with no account at all is not asked about clearing it again", () => {
    const { tree, spies } = renderRow({ autoMirror: true, credentialId: null });

    pickAccount(tree, "none");

    expect(spies.consents).toEqual([]);
    expect(spies.updates).toEqual([]);
  });

  test("re-selecting the account already in use mutates nothing at all", () => {
    const { tree, spies } = renderRow({ autoMirror: true });

    pickAccount(tree, "live-credential");

    expect(spies.consents).toEqual([]);
    expect(spies.updates).toEqual([]);
  });

  test("a politician follow with a stale armed flag is not treated as armed", () => {
    // The row refuses to paint this follow as armed, so it must not claim a
    // destination change on it is a live-automation decision either.
    const { tree, spies } = renderRow({ targetType: "politician", autoMirror: true });

    pickAccount(tree, "perp-credential");

    expect(spies.consents).toEqual([]);
    expect(spies.updates).toEqual([{ credentialId: "perp-credential" }]);
  });
});

describe("the re-point confirmation names the account being moved to", () => {
  const summary = buildArmingSummary({
    trader: "Example Trader",
    account: accountOptionLabel(ACCOUNTS[2]),
    destinationProvider: "hyperliquid",
    sizingMode: "pct",
    sizingValue: 5,
    limits: LIMITS,
    variant: "repoint",
    previousAccount: "Live account LIVE-9876",
  });
  const facts = Object.fromEntries(summary.facts.map((f) => [f.label, f.value]));

  test("shows the new account, the old one, and the venue in words", () => {
    expect(facts["New account"]).toBe("Hyperliquid perps");
    expect(facts["Moving from"]).toBe("Live account LIVE-9876");
    expect(facts.Venue).toContain("Hyperliquid");
    expect(facts.Venue).toContain("leveraged");
    // Still the same standing order and the same caps, restated: the user is
    // agreeing to automation again, about a different account.
    //
    // The sizing rule is restated in the units of the account being moved TO,
    // which is exactly why it is restated here at all: this re-point carries an
    // unchanged "5" from Alpaca buying power onto Hyperliquid free collateral,
    // two bases that place very different orders off the same balance. This
    // assertion previously pinned "5% of your buying power" against a
    // Hyperliquid destination, which is the misstatement itself.
    expect(facts["Size per order"]).toBe(
      "5% of your free collateral (account value minus the margin already committed), not of buying power, taken as the position's notional size",
    );
    expect(facts["Daily cap"]).toContain("20");
  });

  test("says the follow stays armed rather than implying it was turned off", () => {
    expect(summary.standingOrder).toContain("stays armed");
    expect(summary.standingOrder).toContain("not asked again");
    expect(summary.title).toContain("different account");
    expect(summary.confirmLabel).toBe("Move automatic orders");
  });

  test("says the old account's positions are not moved, and what happens to queued orders", () => {
    // Both halves are read off the worker: `decideFollowConsent` drops a staged
    // delivery whose credential no longer matches, and both venue gates exempt
    // a close from that check.
    expect(summary.stopCaveat).toContain("stay there");
    expect(summary.stopCaveat).toContain("nothing is moved, sold or closed");
    expect(summary.stopCaveat).toContain("dropped rather than re-aimed");
    expect(summary.stopCaveat).toContain("except a queued close");
  });

  test("a re-point onto Hyperliquid carries the perp disclosure", () => {
    expect(summary.showPerpDisclosure).toBe(true);
    const dialog = ArmMirrorDialog({
      open: true,
      onOpenChange: () => {},
      summary,
      onConfirm: () => {},
    });
    expect(findByComponent(dialog, PerpMirrorDisclosure)).toBeDefined();
    // The account is painted, not merely computed.
    expect(elementText(dialog)).toContain("Hyperliquid perps");
    expect(elementText(dialog)).toContain("Move automatic orders");
  });

  test("the plain arming summary is unchanged by the variant existing", () => {
    const arm = buildArmingSummary({
      trader: "Example Trader",
      account: "Live account LIVE-9876",
      destinationProvider: "alpaca",
      sizingMode: "pct",
      sizingValue: 5,
      limits: LIMITS,
    });
    const armFacts = Object.fromEntries(arm.facts.map((f) => [f.label, f.value]));
    expect(armFacts.Account).toBe("Live account LIVE-9876");
    expect(armFacts["Moving from"]).toBeUndefined();
    expect(armFacts.Venue).toBeUndefined();
    expect(arm.standingOrder).toBe(ARMING_STANDING_ORDER);
    expect(arm.stopCaveat).toBe(ARMING_STOP_CAVEAT);
    expect(arm.confirmLabel).toBe("Turn on automatic orders");
  });
});

// ============================================
// 6d. The per-order projection is about the follow's own account
// ============================================

describe("the row's dollar projection belongs to the follow's own account", () => {
  test("a percent projection is not drawn from another account's balance", () => {
    // The bug: `buyingPower` / `equity` are the TERMINAL's active account, and
    // the row printed a percentage of them beside a follow pointed somewhere
    // else. Terminal on Paper with $2,000, follow armed on a $200,000 Live
    // account: the row read "About $8.00 per order" and the worker placed $800.
    const { tree } = renderRow(
      { sizingMode: "pct", sizingValue: 0.4, credentialId: "live-credential" },
      { balancesCredentialId: "paper-credential", buyingPower: 2_000, equity: 2_000 },
    );

    const text = elementText(tree);
    expect(text).not.toContain("$8.00");
    expect(text).not.toContain("per order at current balance");
  });

  test("it names the account the size is measured against instead", () => {
    // Printing nothing at all would read as "no size configured", so the row
    // still states the rule and whose balance it is measured against.
    const { tree } = renderRow(
      { sizingMode: "pct", sizingValue: 0.4, credentialId: "live-credential" },
      { balancesCredentialId: "paper-credential", buyingPower: 2_000, equity: 2_000 },
    );

    const text = elementText(tree);
    expect(text).toContain(describeSizePerOrder("pct", 0.4));
    expect(text).toContain("Live account LIVE-9876");
  });

  test("the projection is drawn when the balances ARE the follow's account", () => {
    const { tree } = renderRow(
      { sizingMode: "pct", sizingValue: 0.4, credentialId: "live-credential" },
      { balancesCredentialId: "live-credential", buyingPower: 200_000, equity: 200_000 },
    );

    expect(elementText(tree)).toContain("About $800.00 per order at current balance");
  });

  test("the ceiling verdict is not claimed off another account's balance", () => {
    // The inverse mis-statement: terminal on a $200,000 Live account, follow
    // pointed at a $2,000 Paper one. The row announced a $100,000 order and a
    // skip that never happens, while the worker sizes $1,000 on the paper
    // account and places it.
    const { tree } = renderRow(
      { sizingMode: "pct", sizingValue: 50, credentialId: "paper-credential" },
      { balancesCredentialId: "live-credential", buyingPower: 200_000, equity: 200_000 },
    );

    const text = elementText(tree);
    expect(text).not.toContain("the worker will skip it");
    expect(text).not.toContain("$100,000.00");
  });

  test("a Hyperliquid follow gets no Alpaca-derived dollar projection", () => {
    // Perp sizing scales free cross collateral with leverage, not Alpaca
    // buying power, so the number was not merely off by an account, it was off
    // by a venue, and it rendered directly beneath the perp disclosure.
    const { tree } = renderRow(
      {
        sizingMode: "pct",
        sizingValue: 5,
        credentialId: "perp-credential",
        credentialAccountLabel: null,
        credentialProvider: "hyperliquid",
      },
      { balancesCredentialId: "live-credential", buyingPower: 200_000, equity: 200_000 },
    );

    const text = elementText(tree);
    // No dollar figure at all, in either branch: the row used to reach the
    // ceiling branch here and announce "About $10,000.00 per order".
    expect(text).not.toContain("About $");
    expect(text).toContain("Hyperliquid perps");
  });

  test("dollar sizing still states its own number on any account", () => {
    // `usd` names its dollars outright and every venue uses that same figure as
    // the target notional, so it does not depend on which account is open.
    const { tree } = renderRow(
      { sizingMode: "usd", sizingValue: 50, credentialId: "live-credential" },
      { balancesCredentialId: "paper-credential", buyingPower: 2_000, equity: 2_000 },
    );

    expect(elementText(tree)).toContain("About $50.00 per order at current balance");
  });
});

// ============================================
// 7. Feedback distinguishes arming from editing a size
// ============================================

describe("the success toast distinguishes arming from editing a size", () => {
  test("arming, stopping and a plain edit each read differently", () => {
    const armed = followUpdateToast({ autoMirror: true });
    const stopped = followUpdateToast({ autoMirror: false });
    const edited = followUpdateToast({});

    expect(new Set([armed, stopped, edited]).size).toBe(3);
    expect(armed).toContain("placed automatically");
    expect(stopped).toContain("stay open");
    expect(edited).toBe("Follow settings updated");
  });

  test("unfollowing repeats that positions are untouched", () => {
    expect(UNFOLLOW_TOAST).toContain("stay open");
  });

  test("clearing the account reports the disarm the server did on its own", () => {
    // "No account" is allowed through without a dialog only because the API
    // force-disarms on a null credential. That makes the disarm a thing the
    // user did not ask for, so the toast has to be the one that says it: the
    // generic "Follow settings updated" hid it entirely.
    const cleared = followUpdateToast({ credentialId: null });

    expect(cleared).toBe(MIRROR_ACCOUNT_CLEARED_TOAST);
    expect(cleared).not.toBe("Follow settings updated");
    expect(cleared).toContain("auto-mirror off");
    expect(cleared).toContain("stay open");
  });

  test("pointing at an account is not reported as a disarm", () => {
    expect(followUpdateToast({ credentialId: "perp-credential" })).toBe(
      "Follow settings updated",
    );
    expect(
      followUpdateToast({ autoMirror: true, credentialId: "perp-credential" }),
    ).toContain("placed automatically");
  });

  test("saving sizing on an off destination reports settings saved, not stopped", () => {
    expect(
      followUpdateToast({
        destinations: {
          stock: {
            enabled: false,
            credentialId: "alpaca-credential",
            sizingMode: "usd",
            sizingValue: 123.45,
          },
        },
      }),
    ).toBe("Follow settings updated");
  });
});

// ============================================
// 8. Unfollowing from a feed or leaderboard row
// ============================================

const FOLLOW_TARGET = {
  type: "user",
  key: "trader-key",
  label: "Example Trader",
} as const;

const TYPED_DESTINATIONS = {
  stock: {
    enabled: false,
    credentialId: null,
    sizingMode: "pct",
    sizingValue: 5,
  },
  perp: {
    enabled: false,
    credentialId: null,
    sizingMode: "pct",
    sizingValue: 5,
  },
} as const;

const UNFOLLOW_SUMMARY = buildStopSummary({
  kind: "unfollow",
  trader: FOLLOW_TARGET.label,
});

interface FollowButtonSpies {
  follows: number;
  unfollows: number;
  confirming: boolean[];
}

function renderFollowButton(
  overrides: Partial<Parameters<typeof FollowButtonView>[0]> = {},
): { tree: ReactNode; spies: FollowButtonSpies } {
  const spies: FollowButtonSpies = { follows: 0, unfollows: 0, confirming: [] };
  const tree = FollowButtonView({
    target: FOLLOW_TARGET,
    isFollowing: true,
    armed: "armed",
    confirmingUnfollow: false,
    onConfirmingUnfollowChange: (open) => spies.confirming.push(open),
    onFollow: () => {
      spies.follows += 1;
    },
    onUnfollow: () => {
      spies.unfollows += 1;
    },
    ...overrides,
  });
  return { tree, spies };
}

/** Render the stop dialog the button mounted, with the props it really passed. */
function renderMountedStopDialog(tree: ReactNode): ReactNode {
  const mounted = findByComponent(tree, StopMirrorDialog);
  if (!mounted) throw new Error("the button mounted no StopMirrorDialog");
  return StopMirrorDialog(mounted.props as Parameters<typeof StopMirrorDialog>[0]);
}

describe("unfollowing from a feed or leaderboard row is gated the same way", () => {
  test("an armed follow is not deleted by the tap, the tap asks", () => {
    // The bug: this button called the unfollow mutation straight out of its
    // onClick, so one tap on "Following" hard-deleted an armed follow along
    // with its sizing rule and its mirror account, and never said that the
    // positions the mirror opened stay open.
    const { tree, spies } = renderFollowButton({ armed: "armed" });

    click(findByTitle(tree, "Unfollow Example Trader"));

    expect(spies.unfollows).toBe(0);
    expect(spies.confirming).toEqual([true]);
  });

  test("armed-ness we cannot prove is treated as armed", () => {
    const { tree, spies } = renderFollowButton({ armed: "unknown" });

    click(findByTitle(tree, "Unfollow Example Trader"));

    expect(spies.unfollows).toBe(0);
    expect(spies.confirming).toEqual([true]);
  });

  test("an unarmed follow stays a one-tap unfollow", () => {
    // The judgement call: an unarmed follow tears down no automation, and
    // Following is the feed's most-tapped control. A dialog on every one of
    // those taps would only train the user to dismiss the one that matters.
    const { tree, spies } = renderFollowButton({ armed: "unarmed" });

    click(findByTitle(tree, "Unfollow Example Trader"));

    expect(spies.unfollows).toBe(1);
    expect(spies.confirming).toEqual([]);
    expect(findByComponent(tree, StopMirrorDialog)).toBeUndefined();
  });

  test("following is never gated, whatever the armed state says", () => {
    for (const armed of ["armed", "unarmed", "unknown"] as const) {
      const { tree, spies } = renderFollowButton({ isFollowing: false, armed });

      click(findByTitle(tree, "Follow Example Trader"));

      expect(spies.follows).toBe(1);
      expect(spies.confirming).toEqual([]);
    }
  });

  test("the confirmation's own control is the only thing that unfollows", () => {
    const { tree, spies } = renderFollowButton({
      armed: "armed",
      confirmingUnfollow: true,
    });
    const dialog = renderMountedStopDialog(tree);

    const cancel = findByAriaLabel(dialog, "Cancel, keep this follow as it is");
    expect(cancel).toBeDefined();
    expect(hasClickHandler(cancel)).toBe(false);
    expect(spies.unfollows).toBe(0);

    click(findByAriaLabel(dialog, UNFOLLOW_SUMMARY.confirmLabel));
    expect(spies.unfollows).toBe(1);
  });

  test("it reuses the shared unfollow copy instead of wording its own", () => {
    const { tree } = renderFollowButton({ armed: "armed", confirmingUnfollow: true });
    expect(findByComponent(tree, StopMirrorDialog)?.props.summary).toEqual(
      UNFOLLOW_SUMMARY,
    );

    const text = elementText(renderMountedStopDialog(tree));
    expect(text).toContain("Unfollow Example Trader?");
    for (const point of UNFOLLOW_SUMMARY.points) {
      expect(text).toContain(point);
    }
  });

  test("armed-ness is read off the follows list the surface already holds", () => {
    const follows = [
      {
        targetType: "x_author",
        targetKey: "source_author:x:42",
        membershipKeys: ["source_alias:x:old%20name"],
        autoMirror: true,
      },
      { targetType: "user", targetKey: "other-key", autoMirror: false },
    ];

    expect(followArmedState(follows, {
      type: "x_author",
      key: "source_alias:x:old%20name",
    })).toBe("armed");
    expect(followArmedState(follows, { type: "user", key: "other-key" })).toBe("unarmed");
    // Same key, different source: a different follow, and not proof of anything.
    expect(followArmedState(follows, { type: "x_author", key: "trader-key" })).toBe(
      "unknown",
    );
    // No list loaded yet is "unknown", never "unarmed".
    expect(followArmedState(undefined, { type: "user", key: "trader-key" })).toBe(
      "unknown",
    );

    const dualArmedState = followArmedState(
      [
        {
          targetType: "user",
          targetKey: "trader-key",
          autoMirror: false,
          destinations: {
            stock: {
              ...TYPED_DESTINATIONS.stock,
              enabled: true,
              credentialId: "stock-credential",
            },
            perp: {
              ...TYPED_DESTINATIONS.perp,
              enabled: true,
              credentialId: "perp-credential",
            },
          },
        },
      ],
      FOLLOW_TARGET,
    );
    expect(dualArmedState).toBe("armed");
    const dualArmedButton = renderFollowButton({ armed: dualArmedState });
    click(findByTitle(dualArmedButton.tree, "Unfollow Example Trader"));
    expect(dualArmedButton.spies.unfollows).toBe(0);
    expect(dualArmedButton.spies.confirming).toEqual([true]);

    // The legacy projection is intentionally false when both typed venues are
    // enabled, and must not override an explicitly typed all-off state either.
    expect(
      followArmedState(
        [
          {
            targetType: "user",
            targetKey: "trader-key",
            autoMirror: true,
            destinations: TYPED_DESTINATIONS,
          },
        ],
        FOLLOW_TARGET,
      ),
    ).toBe("unarmed");

    const malformedTypedRow = {
      targetType: "user",
      targetKey: "trader-key",
      autoMirror: true,
      destinations: { stock: TYPED_DESTINATIONS.stock },
    } as unknown as FollowArmedLookupRow;
    expect(followArmedState([malformedTypedRow], FOLLOW_TARGET)).toBe("unknown");
    const explicitlyMissingTypedRow = {
      targetType: "user",
      targetKey: "trader-key",
      autoMirror: true,
      destinations: undefined,
    } as unknown as FollowArmedLookupRow;
    expect(followArmedState([explicitlyMissingTypedRow], FOLLOW_TARGET)).toBe("unknown");

    expect(unfollowNeedsConfirmation("armed")).toBe(true);
    expect(unfollowNeedsConfirmation("unknown")).toBe(true);
    expect(unfollowNeedsConfirmation("unarmed")).toBe(false);
  });
});

describe("per-follow copy leverage cap", () => {
  test("renders inheritance before a Hyperliquid credential is selected", () => {
    const { tree } = renderRow(
      { credentialId: null, perpMaxLeverage: null },
      { accounts: [], globalPerpMaxLeverage: 2 },
    );

    const trigger = findByAriaLabel(tree, "Perp leverage cap");
    expect(trigger).toBeDefined();
    expect(elementText(tree)).toContain("Use global (2x)");
  });

  test("offers only integer caps up to the current global value", () => {
    const { tree } = renderRow(
      { perpMaxLeverage: null },
      { globalPerpMaxLeverage: 2 },
    );
    const options = flattenElements(tree)
      .filter((element) => element.type === SelectItem)
      .map((element) => element.props.value);

    expect(options.filter((value) => ["global", "1", "2"].includes(String(value)))).toEqual([
      "global",
      "1",
      "2",
    ]);
  });

  test("saves a lower cap and clears it back to inherited null", () => {
    const { tree, spies } = renderRow({ perpMaxLeverage: 2 }, { globalPerpMaxLeverage: 2 });
    const selects = flattenElements(tree).filter((element) => element.type === Select);
    const onValueChange = selects[1]?.props.onValueChange;
    expect(typeof onValueChange).toBe("function");

    (onValueChange as (next: string) => void)("1");
    (onValueChange as (next: string) => void)("global");

    expect(spies.updates).toEqual([{ perpMaxLeverage: 1 }, { perpMaxLeverage: null }]);
  });
});

// ============================================
// The automatic exit on a Hyperliquid follow
// ============================================

/**
 * Commit one exit box the way a user does, with Enter.
 *
 * Found by the accessible name the row gave it, so this reaches the handler the
 * row actually wired rather than a stand-in for it.
 */
function commitExit(tree: ReactNode, leg: "stopLoss" | "takeProfit"): void {
  const input = findByAriaLabel(tree, PERP_PROTECTION_PRESENTATION[leg].aria);
  const handler = input?.props.onKeyDown;
  if (typeof handler !== "function") {
    throw new Error(`row rendered no ${leg} input with an onKeyDown`);
  }
  (handler as (event: { key: string }) => void)({ key: "Enter" });
}

const HYPERLIQUID_FOLLOW = {
  credentialId: "hyperliquid-credential",
  credentialAccountLabel: "Hyperliquid testnet perps",
  credentialAccountType: "LIVE" as const,
  credentialProvider: "hyperliquid" as const,
};

describe("the automatic exit a follower attaches to mirrored perps", () => {
  test("is not offered at all on an Alpaca destination", () => {
    // The worker only attaches one on Hyperliquid. Showing the control beside an
    // Alpaca account would advertise a feature that does nothing there, which is
    // the same class of mistake as the daily cap and the buying-power wording.
    const { tree } = renderRow();
    expect(findByAriaLabel(tree, PERP_PROTECTION_PRESENTATION.stopLoss.aria)).toBeUndefined();
    expect(findByAriaLabel(tree, PERP_PROTECTION_PRESENTATION.takeProfit.aria)).toBeUndefined();
  });

  test("offers both levels on a Hyperliquid destination, bounded as the router bounds them", () => {
    const { tree } = renderRow(HYPERLIQUID_FOLLOW);
    const stop = findByAriaLabel(tree, PERP_PROTECTION_PRESENTATION.stopLoss.aria);
    const target = findByAriaLabel(tree, PERP_PROTECTION_PRESENTATION.takeProfit.aria);

    expect(stop?.props.min).toBe(PERP_PROTECTION_BOUNDS.stopLossPct.min);
    expect(stop?.props.max).toBe(PERP_PROTECTION_BOUNDS.stopLossPct.max);
    expect(target?.props.min).toBe(PERP_PROTECTION_BOUNDS.takeProfitPct.min);
    expect(target?.props.max).toBe(PERP_PROTECTION_BOUNDS.takeProfitPct.max);
  });

  test("saves a typed level as a percent of margin", () => {
    const { tree, spies } = renderRow(HYPERLIQUID_FOLLOW, {
      protectionDraft: { stopLoss: "25", takeProfit: "" },
    });
    commitExit(tree, "stopLoss");
    expect(spies.updates).toEqual([{ perpStopLossPct: 25 }]);
  });

  test("emptying a saved level sends an explicit null, the only thing that removes it", () => {
    // Absent means "leave it alone" all the way down to the column. A row that
    // sent nothing here would leave a live stop in place behind an empty box.
    const { tree, spies } = renderRow(
      { ...HYPERLIQUID_FOLLOW, perpStopLossPct: 25 },
      { protectionDraft: { stopLoss: "", takeProfit: "" } },
    );
    commitExit(tree, "stopLoss");
    expect(spies.updates).toEqual([{ perpStopLossPct: null }]);
  });

  test("never sends a level the router would refuse, and puts the saved one back", () => {
    // 100% of margin is past liquidation, so the stop could never fire. Sending
    // it would fail; showing it as saved would be worse.
    const { tree, spies } = renderRow(
      { ...HYPERLIQUID_FOLLOW, perpStopLossPct: 25 },
      { protectionDraft: { stopLoss: "100", takeProfit: "" } },
    );
    commitExit(tree, "stopLoss");
    expect(spies.updates).toEqual([]);
    expect(spies.protectionDrafts).toEqual([{ leg: "stopLoss", next: "25" }]);
  });

  test("gives the perp disclosure the follow's real exit, so it stops claiming there is none", () => {
    const { tree } = renderRow({ ...HYPERLIQUID_FOLLOW, perpStopLossPct: 25 });
    const disclosure = findByComponent(tree, PerpMirrorDisclosure);
    expect(disclosure?.props.protection).toEqual({
      takeProfitPct: null,
      stopLossPct: 25,
    });
  });

  test("the arming confirmation states the exit the follow will attach", () => {
    const summary = buildArmingSummary({
      trader: "Example Trader",
      account: "Hyperliquid testnet perps",
      destinationProvider: "hyperliquid",
      sizingMode: "usd",
      sizingValue: 250,
      perpProtection: { takeProfitPct: 50, stopLossPct: 25 },
      limits: LIMITS,
    });
    const exit = summary.facts.find((fact) => fact.label === "Automatic exit");

    expect(exit?.value).toContain("-25%");
    expect(exit?.value).toContain("+50%");
    // The BASE is named every time. "25%" read as a price move is twenty times
    // the risk at 20x, and the follower does not choose the leverage.
    expect(exit?.value).toContain("margin");
    expect(exit?.value).not.toContain("—");
  });

  test("the arming confirmation says there is no exit rather than leaving the line out", () => {
    // A missing line reads as "not applicable". The truth is that nothing will
    // ever close this position, and for a signal-sourced copy that is permanent.
    const summary = buildArmingSummary({
      trader: "Example Trader",
      account: "Hyperliquid testnet perps",
      destinationProvider: "hyperliquid",
      sizingMode: "usd",
      sizingValue: 250,
      limits: LIMITS,
    });
    const exit = summary.facts.find((fact) => fact.label === "Automatic exit");

    expect(exit?.value).toBe(NO_PERP_PROTECTION_SENTENCE);
    expect(exit?.value).toContain("never happens");
  });

  test("says nothing about a perp exit on an Alpaca confirmation", () => {
    const summary = buildArmingSummary({
      trader: "Example Trader",
      account: "Live account LIVE-9876",
      destinationProvider: "alpaca",
      sizingMode: "usd",
      sizingValue: 250,
      perpProtection: { takeProfitPct: 50, stopLossPct: 25 },
      limits: LIMITS,
    });
    expect(summary.facts.find((fact) => fact.label === "Automatic exit")).toBeUndefined();
    expect(summary.perpProtection).toBeNull();
  });

  test("the save toast says the change only reaches positions opened from now on", () => {
    // The trigger prices are derived at mirror time from that position's own
    // entry and leverage; nothing re-reads the follow for a position already
    // open. "Follow settings updated" would leave a follower believing they had
    // just moved a live stop.
    const toast = followUpdateToast({ perpStopLossPct: 25 });
    expect(toast).toContain("from now on");
    expect(toast).toContain("already open");
    expect(toast).not.toBe("Follow settings updated");
  });
});
