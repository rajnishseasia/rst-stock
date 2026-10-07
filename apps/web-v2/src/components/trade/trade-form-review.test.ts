import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SubmissionAttemptGuard,
  visiblePerpSubmitError,
} from "./perp-submission-state";
import { checkHip3Guard } from "../../lib/hyperliquid-activate";
import {
  shouldReviewOrder,
  RISK_BUDGET_LABEL,
  type ReviewMetrics,
} from "./review-metrics";
import {
  ReviewOrderDialog,
  ReviewRow,
  type ReviewOrderDialogOrder,
} from "./review-order-dialog";
import { AlertDialogCancel } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/format";

/**
 * Minimal shape of a React element as produced by JSX/`React.createElement` -
 * enough to walk the tree `ReviewOrderDialog` returns without ever mounting
 * it. Its content sits behind a Radix Portal (`AlertDialogContent` renders
 * one internally), and `react-dom/server` never renders portal contents at
 * all - `renderToStaticMarkup` would just observe an empty tree, exactly as
 * `ui/alert-dialog.test.ts` documents. Calling `ReviewOrderDialog` as a plain
 * function (it holds no hooks) and reading the element tree it returns is
 * the one way to exercise its real, computed output here.
 */
interface Elementish {
  type?: unknown;
  props?: { children?: unknown; [key: string]: unknown };
}

function isElementish(node: unknown): node is Elementish {
  return typeof node === "object" && node !== null && "props" in node;
}

/** Every string/number leaf under `node`, concatenated - the text a user
 *  would actually see, in document order. */
function flattenText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isElementish(node)) return flattenText(node.props?.children);
  return "";
}

/** First element in the tree whose `type` is `target` (reference equality),
 *  found by walking `props.children` - never invokes any component itself,
 *  so it's safe even for elements (like Radix's own primitives) that hold
 *  hooks. */
function findByType(node: unknown, target: unknown): Elementish | undefined {
  if (node == null || typeof node === "boolean") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, target);
      if (found) return found;
    }
    return undefined;
  }
  if (isElementish(node)) {
    if (node.type === target) return node;
    return findByType(node.props?.children, target);
  }
  return undefined;
}

/** Every `ReviewRow` in the tree, as its actual `label`/`value` props -
 *  the row's own render body is never invoked, so this reads the exact
 *  binding the dialog wired up, not a coincidental text match. */
function collectReviewRows(node: unknown): { label: string; value: unknown }[] {
  const rows: { label: string; value: unknown }[] = [];
  function walk(n: unknown) {
    if (n == null || typeof n === "boolean") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (isElementish(n)) {
      if (n.type === ReviewRow && n.props) {
        rows.push({ label: n.props.label as string, value: n.props.value });
      }
      walk(n.props?.children);
    }
  }
  walk(node);
  return rows;
}

function rowValue(node: unknown, label: string): unknown {
  return collectReviewRows(node).find((r) => r.label === label)?.value;
}

/** A fully populated OCO option order - exercises every conditional row the
 *  dialog can show (entry/limit, stop trigger, stop loss, contract, take
 *  profit, trailing runner) in one fixture. */
const fullOrder: ReviewOrderDialogOrder = {
  symbol: "aapl",
  assetType: "OPTION",
  action: "SellToOpen",
  direction: "short",
  quantity: "3",
  orderType: "OCO",
  timeInForce: "gtc",
  entryOrderType: "Limit",
  entryPriceRef: "150.25",
  limitPrice: "150.00",
  priceTrigger: "149.00",
  stopMarketPrice: "148.50",
  optionsDateYear: "26",
  optionsDateMonth: "09",
  optionsDateDay: "18",
  optionsStrike: "150",
  optionType: "put",
  takeProfits: [{ quantity: "1", price: "160" }],
  trailingEnabled: true,
  trailingQty: "2",
  trailingPercent: "5",
  skipPresetTp: false,
  forceThreeContracts: false,
};

function renderDialog(overrides: {
  order: ReviewOrderDialogOrder | null;
  metrics?: ReviewMetrics | null;
  isSubmitting?: boolean;
  accountType?: "PAPER" | "LIVE";
  accountLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onConfirm?: (order: ReviewOrderDialogOrder) => void;
}) {
  return ReviewOrderDialog({
    order: overrides.order,
    metrics: overrides.metrics ?? null,
    isSubmitting: overrides.isSubmitting ?? false,
    submitToneClass: "tone-x",
    fallbackOptionType: "call",
    accountType: overrides.accountType,
    accountLabel: overrides.accountLabel,
    onOpenChange: overrides.onOpenChange ?? (() => {}),
    onConfirm: overrides.onConfirm ?? (() => {}),
  });
}

describe("shouldReviewOrder", () => {
  const safeOrder = {
    assetType: "EQUITY" as const,
    direction: "long" as const,
    action: "Buy",
  };
  const safeContext = {
    embedded: false,
    activeAccountType: "PAPER" as const,
    isPrefilledOrder: false,
  };

  test("gates every high-stakes order behind review: LIVE account, options, shorts, sells, embedded tickets, and prefilled orders", () => {
    expect(
      shouldReviewOrder(safeOrder, { ...safeContext, activeAccountType: "LIVE" }),
    ).toBe(true);
    expect(
      shouldReviewOrder({ ...safeOrder, assetType: "OPTION" }, safeContext),
    ).toBe(true);
    expect(
      shouldReviewOrder({ ...safeOrder, direction: "short" }, safeContext),
    ).toBe(true);
    expect(
      shouldReviewOrder({ ...safeOrder, action: "SellShort" }, safeContext),
    ).toBe(true);
    expect(
      shouldReviewOrder(safeOrder, { ...safeContext, embedded: true }),
    ).toBe(true);
    expect(
      shouldReviewOrder(safeOrder, { ...safeContext, isPrefilledOrder: true }),
    ).toBe(true);
  });

  test("does not require review for a plain low-risk paper equity buy", () => {
    expect(shouldReviewOrder(safeOrder, safeContext)).toBe(false);
  });
});

describe("ReviewOrderDialog", () => {
  test("renders the confirmation title and every order-detail row bound to the reviewed order", () => {
    const tree = renderDialog({ order: fullOrder });

    expect(flattenText(tree)).toContain("Review order before submitting");
    expect(rowValue(tree, "Symbol")).toBe("AAPL");
    expect(rowValue(tree, "Asset")).toBe("Option");
    expect(rowValue(tree, "Action")).toBe("SellToOpen");
    expect(rowValue(tree, "Direction")).toBe("short");
    expect(rowValue(tree, "Quantity")).toBe("3");
    expect(rowValue(tree, "Order type")).toBe("OCO");
    expect(rowValue(tree, "Time in force")).toBe("GTC");
    // Limit entry: shows the entry/limit anchor, preferring entryPriceRef.
    expect(rowValue(tree, "Entry / limit")).toBe("150.25");
    expect(rowValue(tree, "Contract")).toBe("260918 150 PUT");
    expect(rowValue(tree, "Take profit")).toBe("1 @ 160");
    expect(rowValue(tree, "Trailing runner")).toBe("2 @ 5%");
  });

  test("shows stop trigger and protective stop as two separate rows, not one", () => {
    const tree = renderDialog({ order: fullOrder });

    // The bug this guards: a stop-order's entry trigger and its protective
    // exit stop are different prices from different fields. Collapsing them
    // into one row (or reading the wrong field for either) silently shows
    // the trader the wrong number for one of the two.
    expect(rowValue(tree, "Stop trigger")).toBe(fullOrder.priceTrigger);
    expect(rowValue(tree, "Stop loss")).toBe(fullOrder.stopMarketPrice);
    expect(rowValue(tree, "Stop trigger")).not.toBe(rowValue(tree, "Stop loss"));
  });

  test("shows the selected Alpaca account in the review", () => {
    const tree = renderDialog({
      order: fullOrder,
      accountType: "LIVE",
      accountLabel: "Main brokerage",
    });

    expect(rowValue(tree, "Account")).toBe(
      "Alpaca · Live · Main brokerage",
    );
  });

  test("omits the entry/limit, stop, contract, and exit-plan rows a plain market order has nothing to show for", () => {
    const marketOrder: ReviewOrderDialogOrder = {
      symbol: "spy",
      assetType: "EQUITY",
      action: "Buy",
      direction: "long",
      quantity: "10",
      orderType: "Market",
      timeInForce: "day",
      entryOrderType: "Market",
      trailingEnabled: false,
      skipPresetTp: false,
      forceThreeContracts: false,
    };
    const tree = renderDialog({ order: marketOrder });

    const rows = collectReviewRows(tree).map((r) => r.label);
    expect(rows).not.toContain("Entry / limit");
    expect(rows).not.toContain("Stop trigger");
    expect(rows).not.toContain("Stop loss");
    expect(rows).not.toContain("Contract");
    expect(rows).not.toContain("Take profit");
    expect(rows).not.toContain("Trailing runner");
  });

  test("shows the dollar-impact metrics, labels risk correctly for a trailing runner, and warns when risk exceeds budget", () => {
    const metrics: ReviewMetrics = {
      positionSize: 4500,
      riskIfStopped: 150,
      riskPctOfPortfolio: 0.015,
      riskExceedsBudget: true,
      hasTrailingRunner: true,
    };
    const text = flattenText(renderDialog({ order: fullOrder, metrics }));

    expect(text).toContain(formatUsd(metrics.positionSize));
    expect(text).toContain(formatUsd(metrics.riskIfStopped));
    expect(text).toContain("1.5% of acct");
    // Trailing runner: the fixed stop only protects the take-profit legs, so
    // the "at entry" framing (not "if stopped") is what matches reality.
    expect(text).toContain("Est. risk at entry");
    expect(text).not.toContain("Risk if stopped");
    expect(text).toContain(RISK_BUDGET_LABEL);
    expect(text).toContain("Reduce the quantity or widen your stop");
  });

  test("hides the metrics section and risk warning when there is nothing to size or risk is within budget", () => {
    const withinBudget: ReviewMetrics = {
      positionSize: 1000,
      riskIfStopped: 20,
      riskPctOfPortfolio: 0.002,
      riskExceedsBudget: false,
      hasTrailingRunner: false,
    };
    const withinBudgetText = flattenText(
      renderDialog({ order: fullOrder, metrics: withinBudget }),
    );
    expect(withinBudgetText).toContain("Risk if stopped");
    expect(withinBudgetText).not.toContain("Reduce the quantity or widen your stop");

    const noMetricsText = flattenText(
      renderDialog({ order: fullOrder, metrics: null }),
    );
    expect(noMetricsText).not.toContain("Est. position size");
    expect(noMetricsText).not.toContain("Risk if stopped");
  });

  test("flags elevated-risk orders (option, short, or sell) with the confirm-carefully banner, and not a safe long buy", () => {
    const bannerText = "elevated risk characteristics";
    expect(flattenText(renderDialog({ order: fullOrder }))).toContain(bannerText);

    const safeLongBuy: ReviewOrderDialogOrder = {
      symbol: "spy",
      assetType: "EQUITY",
      action: "Buy",
      direction: "long",
      quantity: "10",
      orderType: "Market",
      timeInForce: "day",
      entryOrderType: "Market",
      trailingEnabled: false,
      skipPresetTp: false,
      forceThreeContracts: false,
    };
    expect(flattenText(renderDialog({ order: safeLongBuy }))).not.toContain(
      bannerText,
    );
  });

  test("Confirm Submit hands the exact reviewed order back to the caller; closing forwards through untouched", () => {
    const onConfirm = mock((_order: ReviewOrderDialogOrder) => {});
    const onOpenChange = mock((_open: boolean) => {});
    const tree = renderDialog({ order: fullOrder, onConfirm, onOpenChange });

    // Wired straight through - not wrapped, not swapped for a different
    // handler - so the dialog's open/close behavior stays exactly Radix's.
    expect((tree as Elementish).props?.onOpenChange).toBe(onOpenChange);
    expect((tree as Elementish).props?.open).toBe(true);

    const cancelButton = findByType(tree, AlertDialogCancel);
    expect(cancelButton).toBeDefined();
    expect(flattenText(cancelButton)).toContain("Cancel");

    const confirmButton = findByType(tree, Button);
    expect(confirmButton).toBeDefined();
    expect(flattenText(confirmButton)).toBe("Confirm Submit");
    expect(confirmButton?.props?.disabled).toBe(false);

    // Pulled out of the optional chain before calling: invoking the result of a
    // short-circuit would throw TypeError rather than fail the assertion, which
    // is a worse failure mode in a test than a clear "this is not a function".
    const onClick = confirmButton?.props?.onClick;
    expect(typeof onClick).toBe("function");
    (onClick as () => void)();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(fullOrder);
  });

  test("stays closed with no order details and a disabled confirm button when nothing is pending", () => {
    const onConfirm = mock((_order: ReviewOrderDialogOrder) => {});
    const tree = renderDialog({ order: null, onConfirm });

    expect((tree as Elementish).props?.open).toBe(false);
    expect(collectReviewRows(tree)).toEqual([]);

    const confirmButton = findByType(tree, Button);
    expect(confirmButton?.props?.disabled).toBe(true);
    const disabledOnClick = confirmButton?.props?.onClick;
    expect(typeof disabledOnClick).toBe("function");
    (disabledOnClick as () => void)();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("shows Submitting... and disables the confirm button while the order is in flight", () => {
    const tree = renderDialog({ order: fullOrder, isSubmitting: true });
    const confirmButton = findByType(tree, Button);

    expect(flattenText(confirmButton)).toBe("Submitting...");
    expect(confirmButton?.props?.disabled).toBe(true);
  });
});

describe("TradeForm embedded chrome", () => {
  // Read once - both tests below guard a fact about trade-form.tsx (over
  // 3000 lines, six tRPC queries, session/auth context, and several sibling
  // hooks) that first-render markup can't observe, so both stay source
  // checks rather than fake conversions. See each test for why.
  const source = readFileSync(new URL("./trade-form.tsx", import.meta.url), "utf8");

  test("keeps quote freshness out of the embedded trade ticket chrome", () => {
    // This pins an ABSENCE across the whole component, not a decision or a
    // renderable value: that quote freshness display was deliberately pulled
    // out of the embedded ticket (see the "Polish the terminal visual
    // system" PR) and must not creep back in. lib/quote-freshness.ts and its
    // own behavior (getQuoteFreshness, quoteFreshnessClass) are unit tested
    // directly in lib/quote-freshness.test.ts; what's asserted here is
    // narrower and can't be: that trade-form.tsx itself never calls into
    // that module again. Rendering the full component to observe that
    // absence would mean reconstructing a mock for every tRPC procedure and
    // hook it depends on, which risks a render that silently throws (and
    // hides the very regression this test exists to catch) far more than it
    // risks the source-text check going stale - so this stays a source
    // check rather than a fake conversion.
    expect(source).not.toContain("getQuoteFreshness");
    expect(source).not.toContain("quoteFreshness.label");
    expect(source).not.toContain("quoteFreshnessClass(quoteFreshness.tone)");
  });

});

describe("Perp submission coordination", () => {
  test("keeps perp submission failures visible inside the review dialog", () => {
    expect(visiblePerpSubmitError("Wallet rejected the request", false)).toBe(
      "Wallet rejected the request",
    );
    expect(visiblePerpSubmitError("Wallet rejected the request", true)).toBeNull();
    expect(visiblePerpSubmitError(null, false)).toBeNull();
  });

  test("cancels a reviewed perp order while asynchronous submission is pending", () => {
    const guard = new SubmissionAttemptGuard();
    const firstAttempt = guard.begin();

    expect(guard.isCurrent(firstAttempt)).toBe(true);
    guard.cancel();
    expect(guard.isCurrent(firstAttempt)).toBe(false);

    const retryAttempt = guard.begin();
    expect(guard.isCurrent(retryAttempt)).toBe(true);
    expect(guard.isCurrent(firstAttempt)).toBe(false);
  });
});

describe("checkHip3Guard", () => {
  test("skips for a standard (non-HIP-3) coin", () => {
    const result = checkHip3Guard(
      "BTC",
      { venue: "perps", walletAddress: "0xabc", network: "mainnet" },
      { address: "0xabc", subjectMismatch: false, subjectVerified: true },
    );
    expect(result).toEqual({ action: "skip" });
  });

  test("proceeds when all guards pass", () => {
    const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = checkHip3Guard(
      "kBTC:BTC",
      { venue: "perps", walletAddress: addr, network: "mainnet" },
      { address: addr, subjectMismatch: false, subjectVerified: true },
    );
    expect(result).toEqual({ action: "proceed" });
  });

  test("throws when account context is not loaded", () => {
    const result = checkHip3Guard(
      "kBTC:BTC",
      { venue: "perps", walletAddress: null, network: null },
      { address: "0xabc", subjectMismatch: false, subjectVerified: true },
    );
    expect(result.action).toBe("throw");
  });

  test("throws when the embedded wallet is missing", () => {
    const result = checkHip3Guard(
      "kBTC:BTC",
      { venue: "perps", walletAddress: "0xabc", network: "mainnet" },
      { address: null, subjectMismatch: false, subjectVerified: true },
    );
    expect(result.action).toBe("throw");
  });

  test("throws on subject mismatch", () => {
    const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = checkHip3Guard(
      "kBTC:BTC",
      { venue: "perps", walletAddress: addr, network: "mainnet" },
      { address: addr, subjectMismatch: true, subjectVerified: false },
    );
    expect(result.action).toBe("throw");
  });

  test("throws when wallet address does not match the account", () => {
    const result = checkHip3Guard(
      "kBTC:BTC",
      { venue: "perps", walletAddress: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      { address: "0x2222222222222222222222222222222222222222", subjectMismatch: false, subjectVerified: true },
    );
    expect(result.action).toBe("throw");
  });
});
