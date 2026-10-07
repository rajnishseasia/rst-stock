import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { click, elementText, findByAriaLabel } from "@/testing/element-tree";
import { PerpCopyChip, StockCopyChip } from "./signal-ticker-chips";
import { PERPS_ENABLED } from "@/lib/perps-config";

/** 44px minimum touch target; see signal-content.test.tsx. */
const TOUCH_TARGET = /min-h-(11|12|\[44px\]|\[2\.75rem\])/;

const QUOTE = { last: "123.45", change: "1.10", changePercent: "0.90" };

function classNameOf(element: { props: Record<string, unknown> } | undefined) {
  return typeof element?.props.className === "string"
    ? element.props.className
    : "";
}

describe("equity ticker chip", () => {
  test("tapping the ticker charts it, and never copies", () => {
    // The reported bug: a symbol tap used to be a trade-form prefill. Identity
    // and intent are now separate controls.
    let charts = 0;
    let copies = 0;
    const chip = StockCopyChip({
      symbol: "NVDA",
      showPrice: false,
      active: false,
      onViewChart: () => {
        charts += 1;
      },
      onCopy: () => {
        copies += 1;
      },
    });

    expect(elementText(chip)).toContain("$NVDA");
    click(findByAriaLabel(chip, "View $NVDA live chart"));

    expect(charts).toBe(1);
    expect(copies).toBe(0);
  });

  test("the Copy control still hands the caller the equity payload", () => {
    const copied: unknown[] = [];
    let charts = 0;
    const chip = StockCopyChip({
      symbol: "NVDA",
      showPrice: false,
      active: false,
      onViewChart: () => {
        charts += 1;
      },
      onCopy: () => copied.push({ symbol: "NVDA", signalId: "row-1" }),
    });

    expect(elementText(chip)).toContain("Copy");
    click(findByAriaLabel(chip, "Copy NVDA to the trade form"));

    expect(copied).toEqual([{ symbol: "NVDA", signalId: "row-1" }]);
    expect(charts).toBe(0);
  });

  test("the price rides the chart half, so a price tap is still identity", () => {
    const chip = StockCopyChip({
      symbol: "NVDA",
      quote: QUOTE,
      showPrice: true,
      active: false,
      onViewChart: () => {},
      onCopy: () => {},
    });

    expect(elementText(findByAriaLabel(chip, "View $NVDA live chart"))).toContain(
      "$123.45",
    );
    expect(
      elementText(findByAriaLabel(chip, "Copy NVDA to the trade form")),
    ).not.toContain("$123.45");
  });

  test("shows the live price and signed change when the pills are on", () => {
    const markup = renderToStaticMarkup(
      <StockCopyChip
        symbol="NVDA"
        quote={QUOTE}
        showPrice
        active={false}
        onViewChart={() => {}}
        onCopy={() => {}}
      />,
    );

    expect(markup).toContain("$123.45");
    expect(markup).toContain("+0.90%");
  });

  test("hides the price pill when the quote is a zero placeholder", () => {
    // A failed snapshot lookup comes back as a zero-valued quote; "$0.00" would
    // read as a real price.
    const markup = renderToStaticMarkup(
      <StockCopyChip
        symbol="NVDA"
        quote={{ last: "0", change: "0", changePercent: "0" }}
        showPrice
        active={false}
        onViewChart={() => {}}
        onCopy={() => {}}
      />,
    );

    expect(markup).toContain("$NVDA");
    expect(markup).not.toContain("$0.00");
  });

  test("both halves keep a 44px touch target in the embedded shell", () => {
    const chip = StockCopyChip({
      symbol: "NVDA",
      showPrice: false,
      active: false,
      embedded: true,
      onViewChart: () => {},
      onCopy: () => {},
    });

    expect(classNameOf(findByAriaLabel(chip, "View $NVDA live chart"))).toMatch(
      TOUCH_TARGET,
    );
    expect(
      classNameOf(findByAriaLabel(chip, "Copy NVDA to the trade form")),
    ).toMatch(TOUCH_TARGET);
  });
});

describe("perp ticker chip", () => {
  const payload = { coin: "kPEPE", side: "short", leverage: 20 } as const;

  test("reads as a leveraged Hyperliquid call, not an equity call", () => {
    const markup = renderToStaticMarkup(
      <PerpCopyChip
        coin="kPEPE"
        payload={payload}
        active={false}
        onViewChart={() => {}}
      />,
    );

    expect(markup).toContain("$kPEPE");
    expect(markup).toContain("Perp");
    expect(markup).toContain("Hyperliquid perp");
    expect(markup).toContain("20x Short");
  });

  test("charting a perp is labeled as a perp chart, distinct from the equity one", () => {
    // SOL is Solana on Hyperliquid and ReneSola on Nasdaq: one aria-label for
    // both would name two different destinations.
    const chip = PerpCopyChip({
      coin: "SOL",
      payload: { coin: "SOL", side: "long" },
      active: false,
      onViewChart: () => {},
    });

    expect(findByAriaLabel(chip, "View $SOL perp live chart")).toBeDefined();
    expect(findByAriaLabel(chip, "View $SOL live chart")).toBeUndefined();
  });

  test("tapping the coin charts it and never seeds a leveraged ticket", () => {
    let charts = 0;
    let copies = 0;
    const chip = PerpCopyChip({
      coin: "kPEPE",
      payload,
      active: false,
      onViewChart: () => {
        charts += 1;
      },
      onCopy: () => {
        copies += 1;
      },
    });

    click(findByAriaLabel(chip, "View $kPEPE perp live chart"));

    expect(charts).toBe(1);
    expect(copies).toBe(0);
  });

  test("labels its copy action for the perps form, not the trade form", () => {
    const chip = PerpCopyChip({
      coin: "kPEPE",
      payload,
      active: false,
      onViewChart: () => {},
      onCopy: () => {},
    });

    expect(
      findByAriaLabel(chip, "Copy kPEPE perp into the perps trade form"),
    ).toBeDefined();
    // The equity chip's label must never appear on a perp row.
    expect(findByAriaLabel(chip, "Copy kPEPE to the trade form")).toBeUndefined();
  });

  test("copy routes to the perp handler when perps are configured", () => {
    let copies = 0;
    const chip = PerpCopyChip({
      coin: "kPEPE",
      payload,
      active: false,
      onViewChart: () => {},
      onCopy: () => {
        copies += 1;
      },
    });

    const button = findByAriaLabel(
      chip,
      "Copy kPEPE perp into the perps trade form",
    );

    if (PERPS_ENABLED) {
      click(button);
      expect(copies).toBe(1);
    } else {
      // Perps unconfigured in this build: the chip is inert and explains why.
      expect(button?.props.disabled).toBe(true);
      expect(button?.props.onClick).toBeUndefined();
      expect(elementText(chip)).toContain("Enable perps to copy");
    }
  });

  test("with no copy handler the copy half is disabled but the chart half still works", () => {
    let charts = 0;
    const chip = PerpCopyChip({
      coin: "BTC",
      payload,
      active: false,
      onViewChart: () => {
        charts += 1;
      },
    });
    const button = findByAriaLabel(
      chip,
      "Copy BTC perp into the perps trade form",
    );

    expect(button?.props.disabled).toBe(true);
    expect(elementText(chip)).toContain("Enable perps to copy");

    click(findByAriaLabel(chip, "View $BTC perp live chart"));
    expect(charts).toBe(1);
  });

  test("the stock escape hatch is a separate action with a real touch target", () => {
    let stockTrades = 0;
    const chip = PerpCopyChip({
      coin: "SOL",
      payload: { coin: "SOL", side: "long" },
      active: false,
      embedded: true,
      onViewChart: () => {},
      onTradeStock: () => {
        stockTrades += 1;
      },
    });

    expect(elementText(chip)).toContain("Trade stock");
    expect(stockTrades).toBe(0);

    // Named for screen readers: "Trade stock" alone repeats on every perp chip.
    click(findByAriaLabel(chip, "Prefill the stock trade form with SOL"));
    expect(stockTrades).toBe(1);

    const markup = renderToStaticMarkup(
      <PerpCopyChip
        coin="SOL"
        payload={{ coin: "SOL", side: "long" }}
        active={false}
        embedded
        onViewChart={() => {}}
        onTradeStock={() => {}}
      />,
    );
    expect(markup).toContain("Prefill the stock trade form with SOL");
    // It used to be a 10px link with no minimum height, the only action in the
    // feed that never got the mobile treatment (F2).
    expect(markup.slice(markup.indexOf("Prefill the stock trade form"))).toMatch(
      TOUCH_TARGET,
    );
  });

  test("omits the stock action when the coin has no equity listing", () => {
    const markup = renderToStaticMarkup(
      <PerpCopyChip
        coin="HYPE"
        payload={{ coin: "HYPE", side: "long" }}
        active={false}
        onViewChart={() => {}}
      />,
    );

    expect(markup).not.toContain("Trade stock");
  });

  test("shows the Hyperliquid mark with magnitude-scaled precision", () => {
    // A sub-cent coin must not collapse to "$0.00" (CLAUDE.md M16 exception).
    const markup = renderToStaticMarkup(
      <PerpCopyChip
        coin="kPEPE"
        payload={payload}
        markPx="0.0071234"
        prevDayPx="0.0070000"
        active={false}
        onViewChart={() => {}}
      />,
    );

    expect(markup).not.toContain("$0.00<");
    expect(markup).toContain("0.007");
  });

  test("the cluster wraps instead of side-scrolling the feed", () => {
    // Every child used to be shrink-0 inside a non-wrapping row, so a perp card
    // could scroll the whole feed sideways (F2).
    const markup = renderToStaticMarkup(
      <PerpCopyChip
        coin="kPEPE"
        payload={payload}
        markPx="0.0071234"
        prevDayPx="0.0070000"
        active={false}
        embedded
        onViewChart={() => {}}
        onTradeStock={() => {}}
      />,
    );

    const wrapper = markup.slice(0, markup.indexOf(">"));
    expect(wrapper).toContain("flex-wrap");
    expect(wrapper).not.toContain("shrink-0");
  });
});
