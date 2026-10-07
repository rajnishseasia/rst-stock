import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeCurrentRisk,
  computeEstimatedNotional,
  hasActiveTrailingRunner,
  plainOrderTypeForEntry,
  resolveExitPlanRouting,
  resolveLimitAwareBasis,
  resolveQuickTradeIntent,
  resolveTpFraction,
  riskReadoutSuffix,
  shouldRunAutoSizer,
  stopLossSectionCaption,
} from "../trade-form-submit-plan";
import { computeReviewMetrics, shouldReviewOrder } from "../review-metrics";
import {
  ReviewOrderDialog,
  ReviewRow,
  type ReviewOrderDialogOrder,
} from "../review-order-dialog";
import { BinaryToggle } from "@/components/ui/binary-toggle";
import {
  ATTACH_PREF_KEY,
  TP_PREF_KEY,
  useExitPlanPreferences,
} from "../use-exit-plan-prefs";
import {
  elementText,
  flattenElements,
} from "@/testing/element-tree";

// ============================================================================
// Mocks: @/lib/trpc and @/lib/auth-client so the real TradeForm component (and
// the real useTradeQuotes hook it calls) can be rendered with
// renderToStaticMarkup. The queries below feed FIRST-RENDER state only - the
// component has no DOM test environment available to it here, so any
// behaviour that only becomes reachable via a useEffect (symbol-commit
// timers, localStorage hydration, signal-prefill) or a click handler is out
// of reach for this file and is covered by the "kept" source-string checks at
// the bottom, called out individually.
// ============================================================================

interface MockPosition {
  symbol: string;
  assetClass: string;
  side: "long" | "short";
  qtyAvailable: number;
}

// Mutable so individual tests can swap the held position before rendering.
let mockPositions: MockPosition[] = [
  { symbol: "AAPL", assetClass: "us_equity", side: "long", qtyAvailable: 10 },
];

// Mutable so the rendered ticket can exercise the confirmed missing-broker
// state, not only the ready state used by most of these tests.
let mockHasCredentials = true;
let mockCredentialProviders: Array<"alpaca" | "hyperliquid"> = ["alpaca"];
const credentialsQueryInputs: unknown[] = [];

type MutationName = "submit" | "submitBracket" | "submitWithExitPlan";
const capturedMutationInputs: Record<MutationName, unknown[]> = {
  submit: [],
  submitBracket: [],
  submitWithExitPlan: [],
};

function clearCapturedMutationInputs() {
  for (const inputs of Object.values(capturedMutationInputs)) inputs.length = 0;
}

function noopMutation(name?: MutationName) {
  const capture = (input: unknown) => {
    if (name) capturedMutationInputs[name].push(input);
  };
  return {
    mutate: (input: unknown) => capture(input),
    mutateAsync: async (input: unknown) => {
      capture(input);
      return { success: true, message: "ok" };
    },
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
    reset: () => {},
  };
}

function query<T>(data: T) {
  return {
    data,
    isLoading: false,
    isSuccess: true,
    isFetching: false,
    error: null as { message: string } | null,
    refetch: async () => ({ data }),
  };
}

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

// Bun keeps module mocks for the whole test process, so preserve the complete
// real export surface before replacing only the session hook. Components that
// happen to load after this file (for example signal-feed.tsx) must still be
// able to import signInWithGoogle and the other auth helpers.
const realAuthClient = (await import("@/lib/auth-client")) as Record<
  string,
  unknown
>;

mock.module("@/lib/auth-client", () => ({
  ...realAuthClient,
  useSession: () => ({
    data: { user: { id: "u1", email: "trader@example.com" } },
  }),
}));

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      orders: {
        listAlpacaOrders: { invalidate: async () => {} },
        list: {
          cancel: async () => {},
          getData: () => undefined,
          setData: () => {},
          invalidate: async () => {},
        },
      },
      positions: { list: { invalidate: async () => {} } },
    }),
    orders: {
      submit: { useMutation: () => noopMutation("submit") },
      submitBracket: { useMutation: () => noopMutation("submitBracket") },
      submitWithExitPlan: {
        useMutation: () => noopMutation("submitWithExitPlan"),
      },
      submitOCO: { useMutation: () => noopMutation() },
    },
    userSettings: {
      hasApiCredentials: {
        useQuery: (input: { provider?: "alpaca" | "hyperliquid" }) => {
          credentialsQueryInputs.push(input);
          return query({
            hasCredentials:
              mockHasCredentials &&
              (!input.provider || mockCredentialProviders.includes(input.provider)),
          });
        },
      },
    },
    quotes: {
      getStockQuote: {
        useQuery: () =>
          query({
            symbol: "AAPL",
            last: "150.00",
            bid: "149.90",
            ask: "150.10",
            low: "148.00",
            high: "152.00",
          }),
      },
      getOptionQuote: { useQuery: () => query(undefined) },
      listOptionContracts: { useQuery: () => query([]) },
    },
    positions: {
      list: { useQuery: () => query(mockPositions) },
      account: {
        useQuery: () =>
          query({ portfolioValue: 10000, nonMarginableBuyingPower: 5000 }),
      },
    },
  },
}));

// ============================================================================
// react/jsx-runtime interception: proves the "Attach exit plan" checkbox's
// onChange really calls persistAttachPreference(e.target.checked) - the one
// piece of exit-plan-preference wiring that used to be a
// tradeFormSource.toContain("persistAttachPreference(e.target.checked)")
// check. React strips event handlers out of renderToStaticMarkup's
// serialized HTML, so there is nothing in the markup string to assert on;
// this instead intercepts the jsx-runtime calls TradeForm's OWN JSX makes
// (never react-dom's internals) during a real renderToStaticMarkup pass to
// capture the real onChange closure, then invokes it exactly like a click
// would and checks the real localStorage side effect. This is the same
// technique already proven in landing-auth.test.ts. mock.module replaces
// react/jsx-runtime for the whole bun:test process, so - same as that file -
// every call is forwarded to the real jsx/jsxs/jsxDEV; this changes nothing
// for any other test in the suite.
// ============================================================================

const realJsxRuntime = (await import("react/jsx-runtime")) as {
  Fragment: unknown;
  jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
  jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
};
const trueJsx = realJsxRuntime.jsx;
const trueJsxs = realJsxRuntime.jsxs;
const trueFragment = realJsxRuntime.Fragment;

// Bun's transpiler (or a dependency's own build) may go through either the
// production or the dev jsx-runtime, so both are instrumented.
let trueJsxDEV: ((...args: unknown[]) => unknown) | undefined;
try {
  const realDevRuntime = (await import("react/jsx-dev-runtime")) as {
    jsxDEV: (...args: unknown[]) => unknown;
  };
  trueJsxDEV = realDevRuntime.jsxDEV;
} catch {
  trueJsxDEV = undefined;
}

/** The real onChange closure the checkbox is given on its most recent render. */
let capturedAttachOnChange:
  | ((e: { target: { checked: boolean } }) => void)
  | null = null;

let capturedReviewOnConfirm:
  | ((order: Record<string, unknown>) => void)
  | null = null;

function recordAttachCheckbox(type: unknown, props: unknown) {
  if (props && typeof props === "object") {
    const componentProps = props as Record<string, unknown>;
    if (
      "order" in componentProps &&
      "metrics" in componentProps &&
      "fallbackOptionType" in componentProps &&
      typeof componentProps.onConfirm === "function"
    ) {
      capturedReviewOnConfirm = componentProps.onConfirm as (
        order: Record<string, unknown>,
      ) => void;
    }
  }

  if (
    type === "input" &&
    props &&
    typeof props === "object" &&
    (props as Record<string, unknown>)["aria-label"] ===
      "Attach exit plan (broker-managed stop)"
  ) {
    capturedAttachOnChange = (
      props as { onChange: (e: { target: { checked: boolean } }) => void }
    ).onChange;
  }
}

mock.module("react/jsx-runtime", () => ({
  Fragment: trueFragment,
  jsx: (type: unknown, props: unknown, key?: unknown) => {
    recordAttachCheckbox(type, props);
    return trueJsx(type, props, key);
  },
  jsxs: (type: unknown, props: unknown, key?: unknown) => {
    recordAttachCheckbox(type, props);
    return trueJsxs(type, props, key);
  },
}));

if (trueJsxDEV) {
  const jsxDEV = trueJsxDEV;
  mock.module("react/jsx-dev-runtime", () => ({
    Fragment: trueFragment,
    jsxDEV: (type: unknown, props: unknown, ...rest: unknown[]) => {
      recordAttachCheckbox(type, props);
      return jsxDEV(type, props, ...rest);
    },
  }));
}

const { TradeForm, tradeFormSchema } = await import("../trade-form");
const { AdvancedOrdersPanel } = await import("../advanced-orders-panel");

describe("auth-client mock isolation", () => {
  it("preserves sign-in exports used by other components", async () => {
    const authClient = await import("@/lib/auth-client");

    expect(typeof authClient.signInWithGoogle).toBe("function");
  });
});

/** Renders the real TradeForm on its default first paint (no interaction, no
 *  effects - renderToStaticMarkup never runs useEffect). AAPL is passed as
 *  `initialSymbol` because that alone (unlike the other `initial*` props,
 *  which are only applied via an effect) seeds react-hook-form's
 *  `defaultValues` directly, so the mocked AAPL quote/position data above
 *  actually matches on the very first render. */
function renderTradeForm(
  props: Partial<Parameters<typeof TradeForm>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(TradeForm, {
      initialSymbol: "AAPL",
      activeCredentialId: "cred-1",
      activeAccountType: "PAPER",
      ...props,
    }),
  );
}

const MANUAL_SOURCE_ID = "x_signal:12345678-1234-4123-8123-123456789012";
const MANUAL_SOURCE_SIGNAL_ID = "12345678-1234-4123-8123-123456789012";

function stockSubmissionData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol: "AAPL",
    assetType: "EQUITY",
    orderType: "Market",
    entryOrderType: "Market",
    timeInForce: "day",
    action: "Buy",
    direction: "long",
    maxRisk: "100",
    quantity: "1",
    stopMarketPrice: "",
    priceTrigger: "",
    limitPrice: "",
    optionsDateYear: "",
    optionsDateMonth: "",
    optionsDateDay: "",
    optionsStrike: "",
    optionsLimitPrice: "",
    optionType: "call",
    entryPriceRef: "",
    takeProfits: [],
    trailingEnabled: false,
    trailingPercent: "5",
    trailingQty: "",
    skipPresetTp: false,
    forceThreeContracts: false,
    notes: "",
    ...overrides,
  };
}

function renderManualSourceTradeForm() {
  clearCapturedMutationInputs();
  capturedReviewOnConfirm = null;
  renderTradeForm({
    signalId: MANUAL_SOURCE_SIGNAL_ID,
    copySourceItemId: MANUAL_SOURCE_ID,
    copySourceSymbol: "AAPL",
    copySourceSide: "buy",
  });
  expect(capturedReviewOnConfirm).not.toBeNull();
  return capturedReviewOnConfirm!;
}

describe("manual copy source submits through the real TradeForm handler", () => {
  it("passes the supported source into the ordinary stock mutation", async () => {
    const confirm = renderManualSourceTradeForm();

    confirm(stockSubmissionData());
    await Promise.resolve();

    expect(capturedMutationInputs.submit).toHaveLength(1);
    expect(capturedMutationInputs.submit[0]).toMatchObject({
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "long",
      copySourceItemId: MANUAL_SOURCE_ID,
    });
    expect(capturedMutationInputs.submitWithExitPlan).toHaveLength(0);
    expect(capturedMutationInputs.submitBracket).toHaveLength(0);
  });

  it("passes the source with the protective stop into the Smart Exit mutation", async () => {
    const confirm = renderManualSourceTradeForm();

    confirm(
      stockSubmissionData({
        orderType: "OCO",
        stopMarketPrice: "140",
      }),
    );
    await Promise.resolve();

    expect(capturedMutationInputs.submitWithExitPlan).toHaveLength(1);
    expect(capturedMutationInputs.submitWithExitPlan[0]).toMatchObject({
      symbol: "AAPL",
      direction: "long",
      stopMarketPrice: 140,
      copySourceItemId: MANUAL_SOURCE_ID,
    });
    expect(capturedMutationInputs.submit).toHaveLength(0);
    expect(capturedMutationInputs.submitBracket).toHaveLength(0);
  });

  it("omits the source from a normal option mutation while preserving the option route", async () => {
    const confirm = renderManualSourceTradeForm();

    confirm(
      stockSubmissionData({
        assetType: "OPTION",
        action: "BuyToOpen",
        orderType: "Market",
        optionsDateYear: "27",
        optionsDateMonth: "07",
        optionsDateDay: "19",
        optionsStrike: "250",
        optionType: "call",
      }),
    );
    await Promise.resolve();

    expect(capturedMutationInputs.submit).toHaveLength(1);
    const optionInput = capturedMutationInputs.submit[0] as Record<string, unknown>;
    expect(optionInput).toMatchObject({
      assetType: "OPTION",
      tradeAction: "BuyToOpen",
      optionExpiration: "270719",
    });
    expect(optionInput.copySourceItemId).toBeUndefined();
    expect(capturedMutationInputs.submitWithExitPlan).toHaveLength(0);
    expect(capturedMutationInputs.submitBracket).toHaveLength(0);
  });
});

describe("tradeFormSchema validations (real schema, not a copy)", () => {
  const base = {
    symbol: "aapl",
    assetType: "EQUITY" as const,
    entryOrderType: "Market" as const,
    timeInForce: "day" as const,
    action: "Buy" as const,
    direction: "long" as const,
    quantity: "1",
    trailingEnabled: false,
    skipPresetTp: false,
    forceThreeContracts: false,
  };

  it("should fail validation if limit price is missing on a Limit order", () => {
    const result = tradeFormSchema.safeParse({
      ...base,
      orderType: "Limit",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Limit price is required for Limit and StopLimit orders",
      );
    }
  });

  it("should pass standard market equity order", () => {
    const result = tradeFormSchema.safeParse({
      ...base,
      orderType: "Market",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.symbol).toBe("AAPL");
    }
  });

  it("should fail validation if options details are missing for OPTION asset type", () => {
    const result = tradeFormSchema.safeParse({
      ...base,
      assetType: "OPTION",
      orderType: "Market",
      action: "BuyToOpen",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Options contract details are required",
      );
    }
  });

  it("should fail OCO validation if no take profits or stop loss are provided", () => {
    const result = tradeFormSchema.safeParse({
      ...base,
      orderType: "OCO",
      timeInForce: "gtc",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path[0])).toContain(
        "takeProfits",
      );
    }
  });

  it("should fail OCO limit-entry validation if no entry price is provided", () => {
    const result = tradeFormSchema.safeParse({
      ...base,
      orderType: "OCO",
      entryOrderType: "Limit",
      timeInForce: "gtc",
      stopMarketPrice: "190",
      takeProfits: [{ price: "210", quantity: "1" }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Entry price is required for limit entries",
      );
    }
  });
});

describe("exit plan refines (real schema)", () => {
  const okOco = {
    symbol: "aapl",
    assetType: "EQUITY" as const,
    orderType: "OCO" as const,
    entryOrderType: "Market" as const,
    timeInForce: "gtc" as const,
    action: "Buy" as const,
    direction: "long" as const,
    quantity: "10",
    skipPresetTp: false,
    forceThreeContracts: false,
  };

  it("accepts a stop-only OCO (no take-profit, no trailing)", () => {
    const stopOnly = tradeFormSchema.safeParse({
      ...okOco,
      stopMarketPrice: "140",
      trailingEnabled: false,
    });
    expect(stopOnly.success).toBe(true);

    // Contrast: with NONE of stop/TP/trailing present the same ticket is
    // rejected - proving the stop alone is what makes the first case valid.
    const nothingAttached = tradeFormSchema.safeParse({
      ...okOco,
      trailingEnabled: false,
    });
    expect(nothingAttached.success).toBe(false);
  });

  it("uses the loosened error message that mentions stop-loss", () => {
    const result = tradeFormSchema.safeParse({
      ...okOco,
      trailingEnabled: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        "Add a stop loss, a take-profit level, or enable the trailing runner",
      );
      // The stale, pre-fix message must never come back from the schema.
      expect(messages).not.toContain(
        "Add a take-profit level or enable the trailing runner",
      );
    }
  });

  it("rejects trailing-only OCO when a fixed stop is also set with no TP", () => {
    // Alpaca rejects two separate sell orders against the same shares, so a
    // fixed stop can't ride alongside a bare trailing runner.
    const result = tradeFormSchema.safeParse({
      ...okOco,
      stopMarketPrice: "140",
      trailingEnabled: true,
      trailingPercent: "5",
      trailingQty: "10",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Trailing already carries its own stop. Add a take-profit target, or turn off Trailing stop runner to use just the fixed stop.",
      );
    }
  });
});

describe("attach-exit-plan follow-up fixes: trailing-only OCO (real schema)", () => {
  it("allows a trailing-only OCO submit without a fixed stop", () => {
    const result = tradeFormSchema.safeParse({
      symbol: "aapl",
      assetType: "EQUITY",
      orderType: "OCO",
      entryOrderType: "Market",
      timeInForce: "gtc",
      action: "Buy",
      direction: "long",
      quantity: "10",
      trailingEnabled: true,
      trailingPercent: "5",
      trailingQty: "10",
      skipPresetTp: false,
      forceThreeContracts: false,
    });
    expect(result.success).toBe(true);
  });

  it("no longer requires a fixed stop for OCO on its own", () => {
    // Historical message: OCO used to hard-require stopMarketPrice. A
    // trailing-only ticket (no stop at all) must not trip that anymore.
    const result = tradeFormSchema.safeParse({
      symbol: "aapl",
      assetType: "EQUITY",
      orderType: "OCO",
      entryOrderType: "Market",
      timeInForce: "gtc",
      action: "Buy",
      direction: "long",
      quantity: "10",
      trailingEnabled: false,
      skipPresetTp: false,
      forceThreeContracts: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).not.toContain(
        "Stop Loss is required for OCO",
      );
    }
  });
});

describe("stop-only OCO submit routing (resolveExitPlanRouting)", () => {
  const base = {
    orderType: "OCO" as const,
    assetType: "EQUITY" as const,
    trailingEnabled: false,
  };

  it("routes a stop-only submit through the exit plan (not the plain path)", () => {
    const routing = resolveExitPlanRouting({
      ...base,
      stopMarketPrice: "140",
    });
    expect(routing.useExitPlan).toBe(true);
    // Stop-only: no trailing leg should ship to the server.
    expect(routing.trailingStop).toBeUndefined();
  });

  it("does not route a naked OCO (no stop, no TP, no trailing) through the exit plan", () => {
    const routing = resolveExitPlanRouting(base);
    expect(routing.useExitPlan).toBe(false);
  });

  it("only sends trailingStop when the runner is actually fully configured", () => {
    const configured = resolveExitPlanRouting({
      ...base,
      trailingEnabled: true,
      trailingPercent: "5",
      trailingQty: "10",
    });
    expect(configured.trailingStop).toEqual({ trailPercent: 5 });

    // Enabled but missing a quantity or percent must NOT ship a trailing leg -
    // this was the bug: trailingStop used to be hardcoded to { trailPercent }.
    expect(
      resolveExitPlanRouting({
        ...base,
        trailingEnabled: true,
        trailingPercent: "5",
        trailingQty: "0",
      }).trailingStop,
    ).toBeUndefined();
    expect(
      resolveExitPlanRouting({
        ...base,
        trailingEnabled: true,
        trailingPercent: "0",
        trailingQty: "10",
      }).trailingStop,
    ).toBeUndefined();
  });
});

describe("plain order risk sizing copy", () => {
  it("makes the absence of broker-managed exits explicit for a plain equity order", () => {
    expect(stopLossSectionCaption("Market", false)).toBe(
      "No broker-managed exits",
    );
    expect(stopLossSectionCaption("OCO", false)).toBe(
      "Broker-managed protection after fill",
    );
    expect(stopLossSectionCaption("Market", true)).toBe(
      "Options do not support attached exits",
    );
  });

  it("does not render the manual size-to-risk button", () => {
    const html = renderTradeForm();
    expect(html).not.toContain("Size to $ risk");
  });
});

describe("attach-exit-plan toggle + non-OCO sizing UI", () => {
  it("renders an 'Attach exit plan' checkbox on the stop-loss card, defaulting to OCO", () => {
    const html = renderTradeForm();
    expect(html).toContain("Attach exit plan");
    expect(html).toContain('aria-label="Attach exit plan (broker-managed stop)"');
    expect(html).toContain('type="checkbox"');
  });

  it("never downgrades a Limit ticket into a Market ticket when the exit plan is turned off", () => {
    // The checkbox's onChange and the "Continue without exit plan" shortcut
    // both restore this order type - proven directly, not via a source regex.
    expect(plainOrderTypeForEntry("Limit")).toBe("Limit");
    expect(plainOrderTypeForEntry("Market")).toBe("Market");
  });

  it("no longer renders the old 'Add stop & targets' button", () => {
    const html = renderTradeForm();
    expect(html).not.toContain("Add stop &amp; targets");
    expect(html).not.toContain("Add stop & targets");
  });

  it("shows the stop-loss card content on the default attached (OCO) ticket", () => {
    const html = renderTradeForm();
    expect(html).toContain("Stop loss");
    expect(html).not.toContain("sizing only");
  });

  it("runs the risk-budget auto-sizer for every non-option order, not just OCO", () => {
    // The old gate returned early unless orderType === "OCO". The predicate
    // below no longer takes orderType as an input at all, which is exactly
    // the regression this pins: it now runs for Market/Limit/OCO alike.
    expect(
      shouldRunAutoSizer({
        assetType: "EQUITY",
        userEditedQty: false,
        forceThreeContracts: false,
      }),
    ).toBe(true);
    expect(
      shouldRunAutoSizer({
        assetType: "OPTION",
        userEditedQty: false,
        forceThreeContracts: false,
      }),
    ).toBe(false);
    expect(
      shouldRunAutoSizer({
        assetType: "EQUITY",
        userEditedQty: true,
        forceThreeContracts: false,
      }),
    ).toBe(false);
    expect(
      shouldRunAutoSizer({
        assetType: "EQUITY",
        userEditedQty: false,
        forceThreeContracts: true,
      }),
    ).toBe(false);
  });
});

describe("auto-exit initialization regressions", () => {
  it("sizes market-entry auto-exit tickets from the live price, not a stale hidden anchor", () => {
    // Market entries must ALWAYS use the live sizingPrice, ignoring any
    // leftover entryPriceRef/limitPrice anchor - that anchor is a calculator
    // seed for OCO bookkeeping and goes stale as the quote moves. This is the
    // exact defect: a stale/hidden anchor made sizeByRisk return 0, leaving
    // quantity stuck at 1 on first load.
    expect(
      resolveLimitAwareBasis({
        entryOrderType: "Market",
        watchEntry: "999",
        limitPrice: "999",
        sizingPrice: 42,
      }),
    ).toBe(42);

    // Limit entries prefer the explicit anchor when it is usable...
    expect(
      resolveLimitAwareBasis({
        entryOrderType: "Limit",
        watchEntry: "10",
        limitPrice: "",
        sizingPrice: 42,
      }),
    ).toBe(10);

    // ...but fall back to the live price when the anchor is not (unset/zero).
    expect(
      resolveLimitAwareBasis({
        entryOrderType: "Limit",
        watchEntry: "0",
        limitPrice: "",
        sizingPrice: 42,
      }),
    ).toBe(42);
  });

  it("splits the take-profit share of the position the same way on auto-fill and on resize", () => {
    // tpFraction: nothing when the user opted out, half when a trailing
    // runner takes the rest, the whole position when trailing is off.
    expect(resolveTpFraction({ tpActive: false, trailingActive: true })).toBe(
      0,
    );
    expect(resolveTpFraction({ tpActive: true, trailingActive: true })).toBe(
      0.5,
    );
    expect(resolveTpFraction({ tpActive: true, trailingActive: false })).toBe(
      1,
    );
  });
});

describe("order review risk disclosure (main-form live readout)", () => {
  it("includes the trailing runner's initial risk in the live risk readout", () => {
    const withoutRunner = computeCurrentRisk({
      trailingEnabled: false,
      quantity: "10",
      sizingPrice: 150,
      stopMarketPrice: "140",
      direction: "long",
      isOption: false,
    });
    // 10 shares * $10/share = $100 stop-out risk, no runner.
    expect(withoutRunner).toBe(100);

    const withRunner = computeCurrentRisk({
      trailingEnabled: true,
      trailingQty: "5",
      trailingPercent: "5",
      quantity: "10",
      takeProfits: [{ quantity: "5" }],
      sizingPrice: 150,
      stopMarketPrice: "140",
      direction: "long",
      isOption: false,
    });
    // Fixed-stop leg: 5 TP shares * $10 = $50. Runner leg (its own initial
    // risk, not the fixed stop): 5 shares * $150 * 5% = $37.50. Total $87.50 -
    // strictly more than pricing all 10 shares against the fixed stop alone
    // ($100) would suggest, and it must include the runner's own number.
    expect(withRunner).toBe(50 + 37.5);
  });

  it("labels the readout 'at entry' only when a trailing runner is actually active", () => {
    expect(riskReadoutSuffix(true)).toBe(" at entry");
    expect(riskReadoutSuffix(false)).toBe(" if stopped");
    expect(
      hasActiveTrailingRunner({
        trailingEnabled: true,
        trailingQty: "5",
        trailingPercent: "5",
      }),
    ).toBe(true);
    expect(
      hasActiveTrailingRunner({
        trailingEnabled: true,
        trailingQty: "0",
        trailingPercent: "5",
      }),
    ).toBe(false);
  });
});

describe("ReviewOrderDialog (real component, rendered without a DOM)", () => {
  // ReviewOrderDialog has no hooks of its own, so it can be called directly
  // as a plain function to get its real element tree back - the same
  // technique this repo already uses in mirror-consent.test.tsx - instead of
  // regexing the trade-form.tsx source that used to compute these numbers
  // inline. The dialog's real content sits behind a Radix AlertDialog portal,
  // which react-dom/server cannot render, so `ReviewRow` is walked directly.
  const baseOrder: ReviewOrderDialogOrder = {
    symbol: "aapl",
    assetType: "EQUITY",
    action: "Buy",
    direction: "long",
    quantity: "10",
    orderType: "OCO",
    timeInForce: "day",
    entryOrderType: "Market",
    stopMarketPrice: "140",
    trailingEnabled: false,
    skipPresetTp: false,
    forceThreeContracts: false,
  };

  function rows(order: ReviewOrderDialogOrder | null, metrics: ReturnType<typeof computeReviewMetrics>) {
    const tree = ReviewOrderDialog({
      order,
      metrics,
      isSubmitting: false,
      submitToneClass: "",
      fallbackOptionType: "call",
      onOpenChange: () => {},
      onConfirm: () => {},
    });
    return flattenElements(tree).filter((el) => el.type === ReviewRow);
  }

  it("only shows stop-loss dollar risk when the reviewed order has a stop", () => {
    const withoutStop = computeReviewMetrics(
      { ...baseOrder, stopMarketPrice: "" },
      "150",
      10000,
    );
    // No stop and no trailing runner -> nothing to size a stop-out risk from.
    expect(withoutStop?.riskIfStopped ?? null).toBeNull();

    const withStop = computeReviewMetrics(baseOrder, "150", 10000);
    expect(withStop?.riskIfStopped).not.toBeNull();

    const tree = ReviewOrderDialog({
      order: baseOrder,
      metrics: withoutStop,
      isSubmitting: false,
      submitToneClass: "",
      fallbackOptionType: "call",
      onOpenChange: () => {},
      onConfirm: () => {},
    });
    expect(elementText(tree)).not.toContain("Risk if stopped");
    expect(elementText(tree)).not.toContain("Est. risk at entry");
  });

  it("does not disclose stale exit legs or stop risk for a plain (non-OCO) order", () => {
    const plainOrder: ReviewOrderDialogOrder = { ...baseOrder, orderType: "Market" };
    // A plain order still surfaces the estimated position size (qty * live
    // quote, since this is a Market entry), but never a stop-out risk figure.
    expect(computeReviewMetrics(plainOrder, "150", 10000)).toEqual({
      positionSize: 1500,
      riskIfStopped: null,
      riskPctOfPortfolio: null,
      riskExceedsBudget: false,
      hasTrailingRunner: false,
    });

    const withTrailing = { ...baseOrder, trailingEnabled: true, trailingQty: "10", trailingPercent: "5" };
    const trailingRows = rows(withTrailing, computeReviewMetrics(withTrailing, "150", 10000));
    expect(trailingRows.some((r) => r.props.label === "Trailing runner")).toBe(
      true,
    );

    const plainRows = rows(
      { ...plainOrder, trailingEnabled: true, trailingQty: "10", trailingPercent: "5" },
      null,
    );
    // A plain order never shows the OCO-only rows, even if legacy sizing
    // fields happen to be populated on the object.
    expect(plainRows.some((r) => r.props.label === "Trailing runner")).toBe(
      false,
    );
    expect(plainRows.some((r) => r.props.label === "Stop loss")).toBe(false);
  });

  it("shows stop trigger and protective stop as separate rows", () => {
    const order = { ...baseOrder, priceTrigger: "141", stopMarketPrice: "140" };
    const rowList = rows(order, computeReviewMetrics(order, "150", 10000));
    const stopTrigger = rowList.find((r) => r.props.label === "Stop trigger");
    const stopLoss = rowList.find((r) => r.props.label === "Stop loss");
    expect(stopTrigger?.props.value).toBe("141");
    expect(stopLoss?.props.value).toBe("140");
  });

  it("removed the trailing-runner info callout and the redundant prefill warning", () => {
    const withTrailing = { ...baseOrder, trailingEnabled: true, trailingQty: "10", trailingPercent: "5" };
    const tree = ReviewOrderDialog({
      order: withTrailing,
      metrics: computeReviewMetrics(withTrailing, "150", 10000),
      isSubmitting: false,
      submitToneClass: "",
      fallbackOptionType: "call",
      onOpenChange: () => {},
      onConfirm: () => {},
    });
    const text = elementText(tree);
    expect(text).not.toContain("has a dynamic floor");
    expect(text).not.toContain(
      "This ticket was prefilled from a signal or copy action.",
    );
  });
});

describe("shouldReviewOrder (real function, not a source regex)", () => {
  it("gates risky or prefilled orders behind the review dialog", () => {
    const notRisky = { assetType: "EQUITY" as const, direction: "long" as const, action: "Buy" };
    expect(
      shouldReviewOrder(notRisky, {
        embedded: false,
        activeAccountType: "PAPER",
        isPrefilledOrder: false,
      }),
    ).toBe(false);
    expect(
      shouldReviewOrder(notRisky, {
        embedded: false,
        activeAccountType: "LIVE",
        isPrefilledOrder: false,
      }),
    ).toBe(true);
    expect(
      shouldReviewOrder(
        { assetType: "OPTION", direction: "long", action: "BuyToOpen" },
        { embedded: false, activeAccountType: "PAPER", isPrefilledOrder: false },
      ),
    ).toBe(true);
    expect(
      shouldReviewOrder(
        { assetType: "EQUITY", direction: "short", action: "SellShort" },
        { embedded: false, activeAccountType: "PAPER", isPrefilledOrder: false },
      ),
    ).toBe(true);
    expect(
      shouldReviewOrder(
        { assetType: "EQUITY", direction: "long", action: "Sell" },
        { embedded: false, activeAccountType: "PAPER", isPrefilledOrder: false },
      ),
    ).toBe(true);
    expect(
      shouldReviewOrder(notRisky, {
        embedded: false,
        activeAccountType: "PAPER",
        isPrefilledOrder: true,
      }),
    ).toBe(true);
    expect(
      shouldReviewOrder(notRisky, {
        embedded: true,
        activeAccountType: "PAPER",
        isPrefilledOrder: false,
      }),
    ).toBe(true);
  });
});

describe("embedded trade ticket visual intent (real render)", () => {
  it("keeps embedded tickets focused on trade controls instead of account status", () => {
    const html = renderTradeForm({ embedded: true });
    expect(html).not.toContain("Order Settings");
    expect(html).not.toContain("Live</span>");
    expect(html).not.toContain("Paper</span>");
  });

  it("shows an explicit market-vs-limit entry control before time in force", () => {
    const html = renderTradeForm();
    const entryControlIndex = html.indexOf('aria-label="Entry price type"');
    const tifIndex = html.indexOf(">TIF<");
    expect(entryControlIndex).toBeGreaterThan(-1);
    expect(tifIndex).toBeGreaterThan(-1);
    expect(entryControlIndex).toBeLessThan(tifIndex);
    expect(html).toContain(">Mkt<");
    expect(html).toContain(">Limit<");
  });

  it("keeps the entry-type toggle neutral, reserving green/red for direction", () => {
    const marketActive = renderToStaticMarkup(
      createElement(BinaryToggle, {
        ariaLabel: "Entry price type",
        value: "Market",
        onChange: () => {},
        options: [
          { value: "Market", label: "Mkt", tone: "neutral" },
          { value: "Limit", label: "Limit", tone: "neutral" },
        ],
      }),
    );
    // The active (Market) chip must use the neutral fill, never the
    // green/red solid fills reserved for the Buy/Sell direction toggle.
    expect(marketActive).toContain("bg-background text-foreground");
    expect(marketActive).not.toContain("bg-green-500");
    expect(marketActive).not.toContain("bg-red-500");
  });

  it("uses solid green and red fills for buy/long and sell/short states", () => {
    const buyActive = renderToStaticMarkup(
      createElement(BinaryToggle, {
        ariaLabel: "Equity side",
        value: "Buy",
        onChange: () => {},
        options: [
          { value: "Buy", label: "Buy", tone: "positive" },
          { value: "Sell", label: "Sell", tone: "negative" },
        ],
      }),
    );
    expect(buyActive).toContain("bg-green-500 text-black");

    const sellActive = renderToStaticMarkup(
      createElement(BinaryToggle, {
        ariaLabel: "Equity side",
        value: "Sell",
        onChange: () => {},
        options: [
          { value: "Buy", label: "Buy", tone: "positive" },
          { value: "Sell", label: "Sell", tone: "negative" },
        ],
      }),
    );
    expect(sellActive).toContain("bg-red-500 text-white");

    // The real ticket wires the SAME green/black fill onto its own default
    // (Buy) state, proving trade-form.tsx actually consumes this convention
    // rather than defining its own.
    const html = renderTradeForm();
    expect(html).toContain("bg-green-500 text-black");
  });

  it("multiplies the estimated notional by the 100-share option-contract size", () => {
    const equityInput = {
      quantity: "2",
      isOptions: false,
      entryOrderType: "Market" as const,
      orderType: "Market" as const,
      currentQuoteLast: "150",
    };
    expect(computeEstimatedNotional(equityInput)).toBe(300);
    expect(computeEstimatedNotional({ ...equityInput, isOptions: true })).toBe(
      30000,
    );

    // The real ticket wires the same formula: qty 1 * $150 last = $150.
    const html = renderTradeForm();
    expect(html).toContain("$150.00");
  });

  it("uses a scrollable body with a pinned submit footer", () => {
    const html = renderTradeForm();
    expect(html).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(html).toContain("shrink-0 border-t bg-background/95");
  });

  it("renders a single unified layout with no variant/scroll switches", () => {
    const html = renderTradeForm();
    expect(html).toContain("terminal-trade-ticket relative flex min-h-0 flex-1 flex-col overflow-hidden");
    expect(html).toContain(
      "h-full min-h-0 min-w-0 max-w-full flex-col touch-pan-y overflow-hidden",
    );
  });

  it("keeps the amount header free of the manual sizing action", () => {
    const html = renderTradeForm();
    expect(html).toContain("mb-2 flex items-center justify-between gap-2");
    expect(html).not.toContain("Size to $ risk");
  });

  it("keeps the stock ticket footer in the bounded column when the broker banner is shown", () => {
    mockHasCredentials = false;
    try {
      const html = renderTradeForm();

      // The warning occupies a sibling slot above the form. The outer wrapper
      // therefore must participate in the height calculation, and the form
      // must consume the remaining space rather than claiming a second 100%.
      expect(html).toContain(
        "h-full min-h-0 min-w-0 max-w-full flex-col touch-pan-y overflow-hidden",
      );
      expect(html).toContain(
        "pb-[calc(env(safe-area-inset-bottom)+0.75rem)]",
      );
      expect(html).not.toContain(
        "pt-[calc(env(safe-area-inset-top)+0.75rem)]",
      );
      expect(html).toContain(
        "terminal-trade-ticket relative flex min-h-0 flex-1 flex-col overflow-hidden",
      );
    } finally {
      mockHasCredentials = true;
    }
  });

  it("renders the missing-broker CTA as a settings link, not a form submit", () => {
    mockHasCredentials = false;
    try {
      const html = renderTradeForm();

      expect(html).toMatch(
        /<a[^>]*href="\/settings"[^>]*>Connect Broker to Trade<\/a>/,
      );
      expect(html).not.toMatch(
        /<button[^>]*type="submit"[^>]*>Connect Broker to Trade<\/button>/,
      );
    } finally {
      mockHasCredentials = true;
    }
  });

  it("keeps Alpaca booleans false for an HL-only credential", () => {
    mockHasCredentials = true;
    mockCredentialProviders = ["hyperliquid"];
    credentialsQueryInputs.length = 0;
    try {
      const tradeHtml = renderTradeForm();
      const advancedHtml = renderToStaticMarkup(createElement(AdvancedOrdersPanel));

      expect(tradeHtml).toContain("Connect Broker to Trade");
      expect(advancedHtml).toContain("Configure Alpaca in Settings to use OCO orders");
      expect(advancedHtml).not.toContain("Submit One-Cancels-Other orders via Alpaca");
      expect(credentialsQueryInputs).toEqual([
        { provider: "alpaca" },
        { provider: "alpaca" },
      ]);
    } finally {
      mockCredentialProviders = ["alpaca"];
      credentialsQueryInputs.length = 0;
    }
  });
});

describe("trade action button group (real render + real BinaryToggle)", () => {
  it("renders the equity side as a button group, not a dropdown", () => {
    const html = renderTradeForm();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Equity side"');
  });

  it("only enables normal equity Sell when a long equity position is available", () => {
    mockPositions = [
      { symbol: "AAPL", assetClass: "us_equity", side: "long", qtyAvailable: 10 },
    ];
    const withPosition = renderTradeForm();
    const sellButtonWithPosition = withPosition.slice(
      withPosition.indexOf('aria-label="Equity side"'),
    );
    expect(sellButtonWithPosition).not.toContain(
      "Requires an available long equity position",
    );

    mockPositions = [];
    const withoutPosition = renderTradeForm();
    expect(withoutPosition).toContain(
      "Requires an available long equity position",
    );
    // Restore the shared fixture for any test that runs after this one.
    mockPositions = [
      { symbol: "AAPL", assetClass: "us_equity", side: "long", qtyAvailable: 10 },
    ];
  });

  it("does not enable Sell for a short position or a fully-reserved long position", () => {
    mockPositions = [
      { symbol: "AAPL", assetClass: "us_equity", side: "short", qtyAvailable: 10 },
    ];
    expect(renderTradeForm()).toContain(
      "Requires an available long equity position",
    );

    mockPositions = [
      { symbol: "AAPL", assetClass: "us_equity", side: "long", qtyAvailable: 0 },
    ];
    expect(renderTradeForm()).toContain(
      "Requires an available long equity position",
    );

    mockPositions = [
      { symbol: "AAPL", assetClass: "us_equity", side: "long", qtyAvailable: 10 },
    ];
  });
});

describe("exit-plan preference persistence (real hook, not a source read)", () => {
  // useExitPlanPreferences has no DOM dependency beyond `window.localStorage`
  // (there is no DOM test environment here at all), so a minimal fake
  // localStorage stands in for it, scoped tightly with try/finally so it
  // never leaks into other test files that assert `window` is undefined
  // (see lib/recent-markets.test.ts).
  function fakeLocalStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
  }

  function mountPrefs(hydrateAttach = true) {
    const sets: Array<[string, unknown]> = [];
    let captured: ReturnType<typeof useExitPlanPreferences> | null = null;
    function Harness() {
      captured = useExitPlanPreferences((name, value) => {
        sets.push([name, value]);
      }, hydrateAttach);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    return { prefs: captured!, sets };
  }

  it("persists the attach-exit-plan toggle for future ordinary trade tickets", () => {
    const storage = fakeLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: storage };
    try {
      const { prefs } = mountPrefs();
      prefs.persistAttachPreference(true);
      expect(storage.getItem(ATTACH_PREF_KEY)).toBe("true");
      prefs.persistAttachPreference(false);
      expect(storage.getItem(ATTACH_PREF_KEY)).toBe("false");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("persists the take-profit preference (on/off + preferred R) across trades", () => {
    const storage = fakeLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: storage };
    try {
      const { prefs, sets } = mountPrefs();
      prefs.persistTakeProfitPreference({ enabled: true, r: 1.2 });
      expect(JSON.parse(storage.getItem(TP_PREF_KEY)!)).toEqual({
        enabled: true,
        r: 1.2,
      });

      // Removing the TP (an explicit user action) flips skipPresetTp on for
      // THIS ticket and remembers "off" for the next one.
      prefs.persistAutoTpPreference(false);
      expect(sets).toContainEqual(["skipPresetTp", true]);
      expect(JSON.parse(storage.getItem(TP_PREF_KEY)!).enabled).toBe(false);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("exit-plan attachment preference and review", () => {
  it("keeps stops and targets visible instead of rendering a collapse control", () => {
    const html = renderTradeForm();
    expect(html).not.toContain("Hide stops and targets");
    expect(html).not.toContain("Edit stops and targets");
  });
});

describe("quick-intent side toggle (real function, not a source regex)", () => {
  it("maps the option long/short toggle onto BuyToOpen/SellToOpen unconditionally", () => {
    expect(
      resolveQuickTradeIntent({
        assetType: "OPTION",
        side: "long",
        canSellLongEquity: false,
      }),
    ).toEqual({ direction: "long", action: "BuyToOpen" });
    expect(
      resolveQuickTradeIntent({
        assetType: "OPTION",
        side: "short",
        canSellLongEquity: false,
      }),
    ).toEqual({ direction: "short", action: "SellToOpen" });
  });

  it("maps equity buy to Buy regardless of held position, and blocks sell without an available long", () => {
    expect(
      resolveQuickTradeIntent({
        assetType: "EQUITY",
        side: "buy",
        canSellLongEquity: false,
      }),
    ).toEqual({ direction: "long", action: "Buy" });

    // The old bug this guards: a quick-toggle sell used to arm regardless of
    // whether the account actually held a sellable long position. Returning
    // null here is exactly what used to be a bare `return;` inline in the
    // component (make no change to the form at all).
    expect(
      resolveQuickTradeIntent({
        assetType: "EQUITY",
        side: "sell",
        canSellLongEquity: false,
      }),
    ).toBeNull();
    expect(
      resolveQuickTradeIntent({
        assetType: "EQUITY",
        side: "sell",
        canSellLongEquity: true,
      }),
    ).toEqual({ direction: "long", action: "Sell" });
  });

  it("wires the real Attach-exit-plan checkbox onChange to persist the preference in real storage", () => {
    // The decision half of this preference (nextAction/canSellLongEquity) is
    // covered above via the pure function. This half is pure wiring - does
    // the checkbox's real onChange actually call persistAttachPreference
    // with e.target.checked - which the jsx-runtime interception above (the
    // same technique landing-auth.test.ts uses) captures directly off a real
    // render, then invokes like a real click would.
    capturedAttachOnChange = null;
    renderTradeForm();
    expect(capturedAttachOnChange).not.toBeNull();
    const onChange = capturedAttachOnChange!;

    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    };
    try {
      onChange({ target: { checked: false } });
      expect(store.get(ATTACH_PREF_KEY)).toBe("false");

      onChange({ target: { checked: true } });
      expect(store.get(ATTACH_PREF_KEY)).toBe("true");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

// ============================================================================
// Kept as source-string checks. Each of these pins a click/onChange handler's
// side effects (a ref reset, or the order two statements run in) that only
// ever executes through real user interaction. This repo's test setup has no
// DOM/jsdom environment and no `act`/fireEvent - only `renderToStaticMarkup`
// (a single static pass with no effects) and the `testing/element-tree`
// walker (which never runs hooks), so a stateful, hook-driven component like
// TradeForm cannot be re-rendered here to observe a ref flip or a state
// transition after an interaction.
//
// Every assertion below was re-checked against that bar specifically (not
// assumed): the quick-intent side toggle and the Attach-exit-plan checkbox's
// persistence call turned out to be provably wirable via the same
// react/jsx-runtime interception landing-auth.test.ts uses (capture the real
// handler off a real render, invoke it, assert the real side effect), so
// those two have been extracted/converted above and no longer read this
// file's source. What is left below all pins either (a) a userEditedQtyRef
// mutation - a plain mutable ref never attached to any JSX element, so there
// is no prop to capture it through, and its effect is only observable via a
// later effect this render technique cannot run - or (b) UI only reachable
// once the form is already in a state (trailing + fixed stop + no TP; a
// submitted, invalid-stop ticket) that is itself only reachable via
// useEffect/handleSubmit, not via any prop this file's renderTradeForm() can
// seed on first paint.
// ============================================================================

const tradeFormSource = readFileSync(
  new URL("../trade-form.tsx", import.meta.url),
  "utf8",
);

describe("interactive handlers not reachable without a DOM (kept as source checks)", () => {
  it("resets the userEditedQty flag when the stop input changes, so the auto-sizer resumes", () => {
    expect(tradeFormSource).toMatch(
      /name="stopMarketPrice"[\s\S]*?onChange=\{\(e\) => \{[\s\S]*?userEditedQtyRef\.current = false;/,
    );
  });

  it("releases the auto-sizer latch when the LOD/HOD stop shortcut is used", () => {
    expect(tradeFormSource).toMatch(
      /userEditedQtyRef\.current = false;\s*setValue\("stopMarketPrice", String\(bar\)/,
    );
  });

  it("offers one-tap fixes when trailing + fixed stop + no TP are all set", () => {
    expect(tradeFormSource).toContain("Turn off trailing");
    expect(tradeFormSource).toContain("Remove fixed stop");
    expect(tradeFormSource).toMatch(/>\s*Add take-profit\s*</);

    const removeStopIdx = tradeFormSource.indexOf("Remove fixed stop");
    expect(removeStopIdx).toBeGreaterThan(-1);
    const removeStopBlock = tradeFormSource.slice(
      Math.max(0, removeStopIdx - 800),
      removeStopIdx + 200,
    );
    expect(removeStopBlock).toContain('setValue("stopMarketPrice", ""');
    expect(removeStopBlock).toContain("userEditedQtyRef.current = false");
  });

  it("keeps the ticket valid when the TP is removed while trailing is enabled", () => {
    const removeTpIdx = tradeFormSource.search(
      /replaceTps\(\[\]\);\s+persistAutoTpPreference\(false\);/,
    );
    expect(removeTpIdx).toBeGreaterThan(-1);
    const removeTpBlock = tradeFormSource.slice(removeTpIdx, removeTpIdx + 900);
    expect(removeTpBlock).toContain('setValue("stopMarketPrice", ""');
    expect(removeTpBlock).toContain("userEditedQtyRef.current = false");
  });

  it("blocks submission of a wrong-side exit-plan stop before the review dialog opens", () => {
    expect(tradeFormSource).toContain("validateStopLossDirection");
    expect(tradeFormSource).toContain("stopDirectionError");
    const guardIndex = tradeFormSource.indexOf("if (stopDirectionError)");
    const reviewIndex = tradeFormSource.indexOf("openOrderReview(data)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(reviewIndex);
  });
});
