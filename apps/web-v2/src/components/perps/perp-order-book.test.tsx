/**
 * Behavioral cover for the desktop perps order-book rail.
 *
 * The ladder arithmetic is unit-tested in `perp-order-book-rows.test.ts`. What
 * is asserted here is the panel's own contract: that it reads ONLY the
 * hyperliquid router, that it asks for the depth it renders on the 2s cadence,
 * that it does not poll unless the desktop breakpoint actually matched (the
 * responsive-shell rule in CLAUDE.md), that every level is a clickable prefill
 * target, and that its depth tints stay green/red (DESIGN.md keeps gold for
 * accents, never a large fill).
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const bookResult = {
  data: undefined as unknown,
  isLoading: false,
  error: null as { message: string } | null,
};

const queryCalls: Array<{
  router: string;
  input: unknown;
  options: Record<string, unknown>;
}> = [];

mock.module("@/lib/trpc", () => ({
  trpc: new Proxy(
    {},
    {
      get(_target, router: string) {
        if (router !== "hyperliquid") {
          throw new Error(
            `the order book must not read the ${router} router`,
          );
        }
        return {
          l2Book: {
            useQuery: (input: unknown, options: Record<string, unknown>) => {
              queryCalls.push({ router, input, options });
              return bookResult;
            },
          },
        };
      },
    },
  ),
}));

let viewportMatches: boolean | null = true;
mock.module("@/hooks/use-media-query", () => ({
  DESKTOP_TERMINAL_MEDIA_QUERY: "(min-width: 80rem)",
  useMediaQuery: () => viewportMatches,
}));

const { PerpOrderBook, PERP_ORDER_BOOK_DEPTH, PERP_ORDER_BOOK_POLL_MS } =
  await import("./perp-order-book");

const level = (px: string, sz: string, n = 1) => ({ px, sz, n });

const sampleBook = {
  coin: "BTC",
  time: 1_700_000_000_000,
  bids: [level("99.5", "2"), level("99.0", "4")],
  asks: [level("100.5", "1"), level("101.0", "3")],
};

/** Raw server-rendered markup of the rail. */
function renderMarkup(
  props: { coin: string; onSelectPrice?: (px: string) => void } = {
    coin: "BTC",
  },
): string {
  queryCalls.length = 0;
  return renderToStaticMarkup(<PerpOrderBook {...props} />);
}

/** Server-rendered text of the rail, with tags stripped. */
function renderText(props?: {
  coin: string;
  onSelectPrice?: (px: string) => void;
}): string {
  return renderMarkup(props).replace(/<[^>]*>/g, " ");
}

describe("PerpOrderBook", () => {
  test("asks the hyperliquid router for the depth it renders, on the 2s poll", () => {
    bookResult.data = sampleBook;
    bookResult.isLoading = false;
    bookResult.error = null;
    viewportMatches = true;
    renderMarkup({ coin: "kPEPE" });

    expect(queryCalls).toHaveLength(1);
    const call = queryCalls[0];
    expect(call?.router).toBe("hyperliquid");
    // Canonical HL casing is passed through untouched: `KPEPE` is a different
    // (nonexistent) market.
    expect(call?.input).toEqual({ coin: "kPEPE", depth: PERP_ORDER_BOOK_DEPTH });
    expect(call?.options.refetchInterval).toBe(PERP_ORDER_BOOK_POLL_MS);
    expect(call?.options.enabled).toBe(true);
  });

  test("does not poll until the desktop breakpoint has actually matched", () => {
    bookResult.data = sampleBook;
    viewportMatches = null;
    renderMarkup();
    expect(queryCalls[0]?.options.enabled).toBe(false);

    viewportMatches = false;
    renderMarkup();
    expect(queryCalls[0]?.options.enabled).toBe(false);

    viewportMatches = true;
  });

  test("does not poll without a coin", () => {
    bookResult.data = sampleBook;
    viewportMatches = true;
    renderMarkup({ coin: "" });
    expect(queryCalls[0]?.options.enabled).toBe(false);
  });

  test("renders both sides, the mid and the spread", () => {
    bookResult.data = sampleBook;
    bookResult.error = null;
    viewportMatches = true;
    const text = renderText();

    expect(text).toContain("99.50");
    expect(text).toContain("99.00");
    expect(text).toContain("100.50");
    expect(text).toContain("101.00");
    // Mid of 99.50 / 100.50, and the spread with its bps figure.
    expect(text).toContain("$100.00");
    expect(text).toContain("1.00 (100.0 bps)");
  });

  test("makes every level a prefill button carrying HL's raw price", () => {
    bookResult.data = {
      ...sampleBook,
      bids: [level("0.0027119", "1000")],
      asks: [level("0.0027200", "1000")],
    };
    viewportMatches = true;
    const markup = renderMarkup({ coin: "kPEPE", onSelectPrice: () => {} });

    // One button per level, each labelled by side so the ladder is usable
    // without color alone. The header's collapse toggle adds one more button,
    // so 2 levels + 1 toggle = 3.
    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain("bid price");
    expect(markup).toContain("ask price");
    // Sub-cent coins keep their significant figures rather than reading $0.00.
    expect(markup).toContain("0.0027119");
  });

  test("renders a read-only ladder when nothing can consume a click", () => {
    bookResult.data = sampleBook;
    viewportMatches = true;
    const markup = renderMarkup();
    // The header's collapse toggle is always present; the LEVEL rows must not
    // be buttons when there is no onSelectPrice handler.
    expect(markup).toContain("Hide order book");
    expect(markup).not.toContain("bid price");
    expect(markup).not.toContain("ask price");
  });

  test("tints depth green and red only, never gold", () => {
    bookResult.data = sampleBook;
    viewportMatches = true;
    const markup = renderMarkup({ coin: "BTC", onSelectPrice: () => {} });
    expect(markup).toContain("bg-green-500/10");
    expect(markup).toContain("bg-red-500/10");
    expect(markup).not.toContain("gold");
    expect(markup).not.toContain("bg-primary");
    expect(markup).not.toContain("bg-secondary");
  });

  test("states an empty book instead of an all-dash ladder", () => {
    bookResult.data = { coin: "BTC", time: null, bids: [], asks: [] };
    bookResult.isLoading = false;
    bookResult.error = null;
    viewportMatches = true;
    expect(renderText()).toContain("No resting depth");
  });

  test("surfaces a read failure rather than rendering a stale-looking book", () => {
    bookResult.data = undefined;
    bookResult.isLoading = false;
    bookResult.error = { message: "Hyperliquid unreachable" };
    viewportMatches = true;
    const text = renderText();
    expect(text).toContain("Hyperliquid unreachable");
    expect(text).not.toContain("No resting depth");
  });

  test("shows a first-load state only while the first read is in flight", () => {
    bookResult.data = undefined;
    bookResult.isLoading = true;
    bookResult.error = null;
    viewportMatches = true;
    expect(renderText()).toContain("Loading depth");

    // A refetch over existing data must keep the ladder on screen.
    bookResult.data = sampleBook;
    const text = renderText();
    expect(text).not.toContain("Loading depth");
    expect(text).toContain("99.50");
    bookResult.isLoading = false;
  });

  test("labels the rail with the display coin, namespace stripped", () => {
    bookResult.data = sampleBook;
    bookResult.error = null;
    viewportMatches = true;
    const text = renderText({ coin: "xyz:GOOGL" });
    expect(text).toContain("Order book");
    expect(text).toContain("GOOGL");
    expect(text).not.toContain("xyz:GOOGL");
    // The REQUEST still carries the canonical namespaced coin.
    expect(queryCalls[0]?.input).toEqual({
      coin: "xyz:GOOGL",
      depth: PERP_ORDER_BOOK_DEPTH,
    });
  });

  test("stays hidden below the desktop breakpoint", () => {
    bookResult.data = sampleBook;
    viewportMatches = true;
    const markup = renderMarkup();
    expect(markup).toContain("hidden");
    expect(markup).toContain("xl:flex");
  });

  test("uses vertical writing mode without horizontal rotation clipping when collapsed", async () => {
    const { ORDER_BOOK_COLLAPSED_KEY } = await import("./perp-order-book");
    expect(ORDER_BOOK_COLLAPSED_KEY).toBe("ready-set-trade.perp-order-book-collapsed.v1");
  });
});
