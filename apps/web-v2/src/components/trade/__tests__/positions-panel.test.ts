import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyStopPriceOverrides,
  updateStopPriceInPositions,
} from "../position-stop-loss-overrides";
import {
  resolveStopLossSave,
  STOP_LOSS_PRICE_INPUT_PROPS,
} from "../stop-loss-save";
import { closedOrdersRefetchInterval } from "../closed-orders-polling";

// ---------------------------------------------------------------------------
// Mocks. PositionsPanel is a real "use client" component with real hooks
// (useState/useEffect/useRef), so it has to be rendered through
// `renderToStaticMarkup` for its own hooks to run (there is no DOM/testing
// library in this repo to click through interactions - see the note on the
// one remaining source check at the bottom of this file). Its trpc calls are
// mocked so a render captures the options each hook was given, which lets a
// test invoke a captured callback (e.g. a mutation's onSuccess) directly and
// observe the real side effects, the same pattern already used by
// use-manage-follows.test.tsx and perp-portfolio-panel.test.ts.
// ---------------------------------------------------------------------------

type CloseVariables = { credentialId: string; symbol: string; idempotencyKey: string };
type CloseData = { success: boolean; message?: string };
type CloseMutationOptions = {
  onSuccess: (data: CloseData, variables: CloseVariables) => void;
  onError: (error: { message: string }) => void;
};

let capturedCloseOptions: CloseMutationOptions | null = null;
let capturedClosedOrdersOptions: Record<string, unknown> | null = null;

const accountInvalidateCalls: unknown[] = [];
let positionsRefetchCount = 0;

function resetSpies(): void {
  accountInvalidateCalls.length = 0;
  positionsRefetchCount = 0;
}

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  isSuccess: false,
  variables: undefined as unknown,
  reset: () => {},
};

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
}));

type PositionFixture = {
  symbol: string;
  assetClass: string;
  exchange: string;
  qty: number;
  qtyAvailable: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number;
  lastDayPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  unrealizedIntradayPL: number;
  unrealizedIntradayPLPercent: number;
  changeToday: number;
  stopLossOrders: { id: string; stopPrice: number; qty: number; type: string }[];
  takeProfitOrders: { id: string; limitPrice: number; qty: number }[];
  trailingStopOrders: {
    id: string;
    trailPercent: number | null;
    trailPrice: number | null;
    stopPrice: number | null;
    qty: number;
  }[];
};

const SAMPLE_POSITIONS: PositionFixture[] = [
  {
    symbol: "AAPL",
    assetClass: "us_equity",
    exchange: "NASDAQ",
    qty: 10,
    qtyAvailable: 10,
    side: "long" as const,
    avgEntryPrice: 150,
    currentPrice: 160,
    lastDayPrice: 158,
    marketValue: 1600,
    costBasis: 1500,
    unrealizedPL: 100,
    unrealizedPLPercent: 6.67,
    unrealizedIntradayPL: 20,
    unrealizedIntradayPLPercent: 1.25,
    changeToday: 1.25,
    stopLossOrders: [],
    takeProfitOrders: [],
    trailingStopOrders: [],
  },
];

const POPULATED_SAMPLE_POSITIONS: PositionFixture[] = [
  {
    ...SAMPLE_POSITIONS[0]!,
    stopLossOrders: [{ id: "stop-1", stopPrice: 145.25, qty: 4, type: "stop" }],
    takeProfitOrders: [{ id: "tp-1", limitPrice: 185.75, qty: 3 }],
  },
];

let positionsQueryData = SAMPLE_POSITIONS;

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      positions: {
        list: {
          cancel: async () => {},
          getData: () => undefined,
          setData: () => {},
          invalidate: async () => {},
        },
        account: {
          invalidate: (args: unknown) => {
            accountInvalidateCalls.push(args);
          },
        },
      },
    }),
    positions: {
      list: {
        useQuery: () => ({
          data: positionsQueryData,
          isLoading: false,
          error: null,
          refetch: async () => {
            positionsRefetchCount += 1;
          },
        }),
      },
      closedOrders: {
        useQuery: (_input: unknown, options: Record<string, unknown>) => {
          capturedClosedOrdersOptions = options;
          return {
            data: [],
            isLoading: false,
            error: null,
            isFetching: false,
            isPlaceholderData: false,
            refetch: async () => {},
          };
        },
      },
      close: {
        useMutation: (options: CloseMutationOptions) => {
          capturedCloseOptions = options;
          return noopMutation;
        },
      },
      updateStopLoss: { useMutation: () => noopMutation },
      cancelExitOrder: { useMutation: () => noopMutation },
      updateTakeProfit: { useMutation: () => noopMutation },
      createExitStrategy: { useMutation: () => noopMutation },
    },
    pnlImage: {
      generateOpenPosition: { useMutation: () => noopMutation },
      generateClosedOrder: { useMutation: () => noopMutation },
    },
  },
}));

const { PositionsPanel } = await import("../positions-panel");
const { renderToStaticMarkup } = await import("react-dom/server");
const React = await import("react");

function renderPanel(props: Partial<Parameters<typeof PositionsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    React.createElement(PositionsPanel, {
      isSignedIn: true,
      activeCredentialId: "cred-1",
      ...props,
    }),
  );
}

function renderPanelWithPositions(
  positions: PositionFixture[],
  props: Partial<Parameters<typeof PositionsPanel>[0]> = {},
) {
  const previousPositions = positionsQueryData;
  positionsQueryData = positions;
  try {
    return renderPanel(props);
  } finally {
    positionsQueryData = previousPositions;
  }
}

function buttonWithText(markup: string, text: string): string {
  return markup.match(new RegExp(`<button[^>]*>${text}<\\/button>`))?.[0] ?? "";
}

function buttonWithTitle(markup: string, title: string): string {
  return markup.match(new RegExp(`<button[^>]*title="${title}"[^>]*>`))?.[0] ?? "";
}

function buttonWithAriaLabel(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

describe("positions panel layout", () => {
  test("renders the perp-style compact table when embedded, the full card layout otherwise", () => {
    const embeddedMarkup = renderPanel({ embedded: true });
    const fullMarkup = renderPanel({ embedded: false });

    // The compact primary header only paints embedded. Full entry, value, SL
    // and TP numbers are shown in a labeled summary below each position.
    expect(embeddedMarkup).toContain("Symbol</span>");
    expect(embeddedMarkup).toContain("uPnL</span>");
    expect(embeddedMarkup).toContain("Stop loss</span>");
    expect(embeddedMarkup).toContain("Take profit</span>");
    expect(embeddedMarkup).toContain("Value</span>");
    expect(fullMarkup).not.toContain("uPnL</span>");

    // The scrollable, chrome-less card body only applies embedded, so the
    // stock panel can scroll independently inside the terminal shell.
    expect(embeddedMarkup).toContain(
      "xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain p-0",
    );
    expect(fullMarkup).not.toContain("overflow-y-auto overscroll-contain");

    // Header controls sit side-by-side embedded, and stack otherwise.
    expect(embeddedMarkup).toContain("flex-row");
    expect(fullMarkup).toContain("flex-col");
    expect(fullMarkup).not.toContain("flex-row");

    // The position is a semantic article. Its disclosure is a real control,
    // so chart and close buttons are not nested inside a role=button row.
    expect(embeddedMarkup).toContain("<article");
    expect(embeddedMarkup).not.toContain('role="button"');
    const disclosure = buttonWithAriaLabel(
      embeddedMarkup,
      "Open AAPL position details",
    );
    expect(disclosure).not.toBe("");
    expect(disclosure).toContain('aria-expanded="false"');
    expect(disclosure).toContain("h-11");
    expect(disclosure).toContain("w-11");
    expect(disclosure).toContain("xl:h-6");
    expect(disclosure).toContain("xl:w-6");
    expect(embeddedMarkup).toContain('aria-label="View AAPL chart"');
    expect(embeddedMarkup).not.toContain('title="Exits"');
    expect(embeddedMarkup).toContain('title="Close position"');
    expect(embeddedMarkup).toContain('aria-label="Edit stop loss for AAPL"');
    expect(embeddedMarkup).toContain('aria-label="Edit take profit for AAPL"');
  });

  test("keeps the visible SL/TP edit actions adjacent and touch-friendly", () => {
    const embeddedMarkup = renderPanel({ embedded: true });

    for (const label of [
      "Edit stop loss for AAPL",
      "Edit take profit for AAPL",
    ]) {
      const button = buttonWithAriaLabel(embeddedMarkup, label);
      expect(button).not.toBe("");
      expect(button).toContain("h-11");
      expect(button).toContain("w-11");
      expect(button).toContain("xl:h-6");
      expect(button).toContain("xl:w-6");
    }
  });

  test("keeps embedded scrolling desktop-only so the mobile account owns one scroll region", () => {
    const embeddedMarkup = renderPanel({ embedded: true });

    // The mobile account wraps this panel in the page scroller. Keeping the
    // inner flex height/scroll classes behind xl prevents the stock venue
    // surface from becoming a second, clipped scrollbar on a 390px phone.
    expect(embeddedMarkup).toContain("xl:h-full xl:min-h-0 xl:overflow-hidden");
    expect(embeddedMarkup).toContain(
      "xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain p-0",
    );
    expect(embeddedMarkup).not.toContain(
      'class="space-y-4 h-full min-h-0 overflow-hidden"',
    );
    expect(embeddedMarkup).not.toContain(
      "min-h-0 flex-1 overflow-y-auto overscroll-contain p-0",
    );
  });

  test("reflows secondary exit columns in a narrow container so Close stays reachable", () => {
    const embeddedMarkup = renderPanel({ embedded: true });

    // A 320px phone keeps a four-cell primary row. Full entry, value, stop-loss,
    // and take-profit values remain labeled in the summary below it.
    expect(embeddedMarkup).toContain("@container/stockpos");
    expect(embeddedMarkup).toContain(
      "grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_44px_44px]",
    );
    expect(embeddedMarkup).toContain("Stop loss");
    expect(embeddedMarkup).toContain("Take profit");
    expect(embeddedMarkup).toContain('title="Close position"');
  });

  test("uses a shrink-to-fit grid strategy below a 360px stock container", () => {
    const embeddedMarkup = renderPanel({ embedded: true });
    const narrowGrid =
      "@max-[359px]/stockpos:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_44px_44px]";

    // The Account workspace leaves roughly 266px for this panel on a 320px
    // phone. The narrow container rule removes the 80/72px track minimums and
    // keeps both action tracks at 44px, so the row's content cannot force a
    // horizontal overflow. The header and every row must share the strategy.
    expect(embeddedMarkup.split(narrowGrid).length - 1).toBe(2);

    // The narrow rule is container-scoped rather than viewport-scoped: it also
    // protects any embedded stock panel that happens to live in a sub-360px
    // desktop pane, while the existing xl rule keeps desktop actions compact.
    expect(embeddedMarkup).toContain(narrowGrid);
    expect(embeddedMarkup).toContain(
      "xl:grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_24px_24px]",
    );

    // Disclosure and Close remain full mobile touch targets even when their
    // grid tracks are the only fixed-width columns left.
    const disclosure = buttonWithAriaLabel(
      embeddedMarkup,
      "Open AAPL position details",
    );
    expect(disclosure).toContain("h-11");
    expect(disclosure).toContain("w-11");
    expect(buttonWithTitle(embeddedMarkup, "Close position")).toContain("h-11");
  });

  test("keeps embedded position controls touch-sized on mobile with pane-aware compact sizing", () => {
    const embeddedMarkup = renderPanel({ embedded: true });

    for (const label of ["Open", "Closed", "Date", "P&amp;L", "Value"]) {
      const button = buttonWithText(embeddedMarkup, label);
      expect(button).not.toBe("");
      expect(button).toContain("h-11");
      expect(button).toContain("@[560px]/card-header:h-7");
      expect(button).toContain("@[560px]/card-header:px-2.5");
      expect(button).toContain("@[560px]/card-header:py-1");
    }

    const closeButton = buttonWithTitle(embeddedMarkup, "Close position");
    expect(closeButton).toContain("h-11");
    expect(closeButton).toContain("w-11");
    expect(closeButton).toContain("xl:h-6");
    expect(closeButton).toContain("xl:w-6");
  });
});

describe("stock exit order display", () => {
  test("renders populated stop-loss and take-profit prices", () => {
    const markup = renderPanelWithPositions(POPULATED_SAMPLE_POSITIONS, {
      embedded: true,
    });

    expect(markup).toContain("$145.25");
    expect(markup).toContain("$185.75");
  });

  test("keeps the empty-order summary state distinct", () => {
    const markup = renderPanelWithPositions(SAMPLE_POSITIONS, { embedded: true });

    expect(markup).toContain("Stop loss</span>");
    expect(markup).toContain("Take profit</span>");
    expect(markup).not.toContain("$145.25");
    expect(markup).not.toContain("$185.75");
  });
});

describe("positions panel account summary", () => {
  test("keeps account summary out of the positions panel", () => {
    const markup = renderPanel();

    expect(markup).not.toContain("Account Summary");
    expect(markup).not.toContain(">Portfolio<");
    expect(markup).not.toContain(">Buying Power<");
    expect(markup).not.toContain(">Portfolio Value<");
    expect(markup).not.toContain(">Cash<");
    expect(markup).not.toContain("account.cash");
  });
});

describe("closing a position refreshes header account balances", () => {
  test("invalidates the header account query for the account that closed, using the mutation's own variables", () => {
    renderPanel();
    expect(capturedCloseOptions).not.toBeNull();
    resetSpies();

    // The real bug this guards: the header's account balances (buying
    // power/portfolio value) went stale after a close because nothing told
    // that query to refetch. `variables.credentialId` (not some captured
    // outer value) is what must be invalidated, since a user can switch
    // accounts while a close is in flight.
    capturedCloseOptions!.onSuccess(
      { success: true, message: "Closing order submitted" },
      { credentialId: "cred-77", symbol: "AAPL", idempotencyKey: "idem-1" },
    );

    expect(accountInvalidateCalls).toEqual([{ credentialId: "cred-77" }]);
    expect(positionsRefetchCount).toBe(1);
  });

  test("also invalidates on a non-success response (e.g. broker rejected the close)", () => {
    renderPanel();
    resetSpies();

    capturedCloseOptions!.onSuccess(
      { success: false, message: "Order rejected" },
      { credentialId: "cred-9", symbol: "MSFT", idempotencyKey: "idem-2" },
    );

    expect(accountInvalidateCalls).toEqual([{ credentialId: "cred-9" }]);
    expect(positionsRefetchCount).toBe(1);
  });
});

describe("closedOrdersRefetchInterval", () => {
  test("polls every 15s while the Closed tab is visible, and not otherwise", () => {
    expect(closedOrdersRefetchInterval(true)).toBe(15000);
    expect(closedOrdersRefetchInterval(false)).toBe(false);
  });

  test("the panel wires the closed-orders query's poll interval to it", () => {
    renderPanel();
    expect(capturedClosedOrdersOptions).not.toBeNull();
    // showClosed defaults to false on first render, so polling starts off.
    expect(capturedClosedOrdersOptions!.refetchInterval).toBe(
      closedOrdersRefetchInterval(false),
    );
    expect(capturedClosedOrdersOptions!.refetchInterval).toBe(false);
  });
});

describe("resolveStopLossSave", () => {
  test("rejects malformed input the same way normalizeStopLossInput does, with no echo", () => {
    expect(resolveStopLossSave("abc", { side: "long", currentPrice: 100 })).toEqual({
      success: false,
      error: "Use digits and a decimal point only.",
    });
  });

  test("cleans up sanitized/rounded money text and reports the clean value", () => {
    const result = resolveStopLossSave(" $101...234 ", {
      side: "short",
      currentPrice: 50,
    });
    expect(result).toEqual({ success: true, value: 101.24, echoValue: "101.24" });
  });

  test("rejects a long stop that is not below the live price, but still echoes the cleaned number", () => {
    // Same malformed text as above, but on the wrong side for a LONG at this
    // price - this is the case the old test could not tell apart from a
    // clean rejection, since it only checked that the two function names
    // appeared somewhere in the file.
    const result = resolveStopLossSave(" $101...234 ", {
      side: "long",
      currentPrice: 50,
    });
    expect(result).toEqual({
      success: false,
      error: "For a long, set the stop BELOW the current price.",
      echoValue: "101.24",
    });
  });

  test("rejects a short stop that is not above the live price", () => {
    const result = resolveStopLossSave("95.50", { side: "short", currentPrice: 100 });
    expect(result).toEqual({
      success: false,
      error: "For a short, set the stop ABOVE the current price.",
    });
  });

  test("accepts an already-clean price with no echo needed", () => {
    const result = resolveStopLossSave("95.50", { side: "long", currentPrice: 100 });
    expect(result).toEqual({ success: true, value: 95.5, echoValue: undefined });
  });

  test("fails closed for long and short positions when market price is invalid", () => {
    for (const side of ["long", "short"] as const) {
      for (const currentPrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(resolveStopLossSave("95.50", { side, currentPrice })).toEqual({
          success: false,
          error: "Cannot validate exit price without a valid current market price.",
        });
      }
    }
  });
});

describe("stop-loss price input contract", () => {
  test("stays free-text with a decimal keypad, not a native number input", () => {
    // The old regression this guards: normalizeStopLossInput (exercised
    // above via resolveStopLossSave) deliberately tolerates money-formatted
    // text like " $101...234 " - a native `type="number"` input rejects
    // the "$" and repeated "." before that tolerant parsing ever runs, so
    // this field must stay text-mode with a decimal-friendly keypad. Both
    // the "edit an existing stop" and "add a new stop" inputs in
    // positions-panel.tsx share this exact object.
    expect(STOP_LOSS_PRICE_INPUT_PROPS).toEqual({ type: "text", inputMode: "decimal" });
  });
});

describe("stop-loss overrides", () => {
  test("overrides only the matching stop-loss order price", () => {
    const positions = [
      {
        symbol: "AAPL",
        stopLossOrders: [
          { id: "stop-1", stopPrice: 190, qty: 1, type: "stop" },
          { id: "stop-2", stopPrice: 180, qty: 1, type: "stop" },
        ],
      },
      {
        symbol: "MSFT",
        stopLossOrders: [{ id: "stop-3", stopPrice: 400, qty: 1, type: "stop" }],
      },
    ];

    const updated = applyStopPriceOverrides(positions, { "stop-2": 181.25 });

    expect(updated[0].stopLossOrders[0].stopPrice).toBe(190);
    expect(updated[0].stopLossOrders[1].stopPrice).toBe(181.25);
    expect(updated[1].stopLossOrders[0].stopPrice).toBe(400);
  });

  test("returns undefined cache data unchanged", () => {
    expect(updateStopPriceInPositions(undefined, "missing", 99)).toBeUndefined();
  });
});

// The server-side renderer cannot click the state-backed save buttons. Direct
// validation and dispatch behavior is covered in stock-exit-save.test.ts;
// these assertions tie all four real handlers to that tested seam.
describe("positions panel save-handler wiring", () => {
  test("wires every stop-loss and take-profit save path through the tested dispatch helpers", () => {
    const positionsPanelSource = readFileSync(
      new URL("../positions-panel.tsx", import.meta.url),
      "utf8",
    );

    for (const helper of [
      "dispatchStopLossEdit(",
      "dispatchStopLossSave(",
      "dispatchTakeProfitEdit(",
      "dispatchTakeProfitSave(",
    ]) {
      expect(positionsPanelSource).toContain(helper);
    }
    expect(positionsPanelSource).not.toContain("parseFloat(");
    expect(positionsPanelSource).not.toContain("resolveStopLossSave(");
  });
});
