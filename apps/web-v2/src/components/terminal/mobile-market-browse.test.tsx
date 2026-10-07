import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import superjson from "superjson";

const realTrpcModule = (await import(
  "@/lib/trpc?mobile-market-browse-test" as string,
)) as typeof import("@/lib/trpc");
const { trpc } = realTrpcModule;

// Bun's module mocks are process-global. Re-publish the real client under the
// bare specifier before loading this component, so a preceding suite's tRPC
// mock cannot leave this provider and the component on different instances.
mock.module("@/lib/trpc", () => ({ trpc }));

const mobileMarketBrowseModule = (await import(
  "./mobile-market-browse?mobile-market-browse-test" as string,
)) as typeof import("./mobile-market-browse");
const {
  MobileMarketBrowse,
  marketBrowseRowAriaLabel,
  mobileBrowseStatus,
  marketVenuePresentation,
} = mobileMarketBrowseModule;

function renderBrowse() {
  const queryClient = new QueryClient();
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: "http://127.0.0.1:9/trpc",
        transformer: superjson,
      }),
    ],
  });

  return renderToStaticMarkup(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileMarketBrowse
          query="SOL"
          filter="all"
          onFilterChange={() => {}}
          suggestions={[
            { symbol: "SOL", name: "Solana", venues: ["stocks", "perps"] },
          ]}
          isSearching={false}
          availability={{ stocks: true, perps: true }}
          isSignedIn={false}
          onSelect={() => {}}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

describe("mobileBrowseStatus", () => {
  test("does not expose market quote status on the People tab", () => {
    expect(
      mobileBrowseStatus("people", {
        isSignedIn: true,
        isUpdating: false,
        hasDataError: false,
      }),
    ).toBeNull();
  });

  test("reports quote readiness on a market tab when signed in", () => {
    expect(
      mobileBrowseStatus("all", {
        isSignedIn: true,
        isUpdating: false,
        hasDataError: false,
      }),
    ).toEqual({ label: "Quotes ready", dotClassName: "bg-[#65c7b6]" });
  });
});

describe("marketVenuePresentation", () => {
  test("separates the two venues without carrying a long asset-type word", () => {
    // The badge is the label. There is no "Equity" / "Perpetual" string here
    // any more, because printing one beside a STOCK or PERP badge spent the
    // row's only free line restating the chip next to it.
    expect(marketVenuePresentation("stocks")).toEqual({
      label: "Stock",
      groupLabel: "Stocks",
      accent: "teal",
    });
    expect(marketVenuePresentation("perps")).toEqual({
      label: "Perp",
      groupLabel: "Perps",
      accent: "gold",
    });
  });
});

describe("marketBrowseRowAriaLabel", () => {
  test("includes a stock's live result name when one is available", () => {
    expect(
      marketBrowseRowAriaLabel({
        symbol: "AAPL",
        venue: "stocks",
        name: "Apple Inc",
      }),
    ).toBe("AAPL stock, Apple Inc");
  });

  test("keeps a perp's canonical display symbol and venue", () => {
    expect(
      marketBrowseRowAriaLabel({
        symbol: "kPEPE",
        venue: "perps",
        name: "",
      }),
    ).toBe("kPEPE perp");
  });
});

describe("MobileMarketBrowse layout", () => {
  test("fits the market filters in one row of equal 44px cells, with a scroll fallback", () => {
    const markup = renderBrowse();
    const filterGroup = markup.match(
      /<div[^>]*aria-label="Search category"[^>]*class="([^"]+)"/,
    )?.[1];

    expect(filterGroup).toContain("overflow-x-auto");
    expect(filterGroup).toContain("touch-pan-x");
    // Equal cells share the row instead of forcing a horizontal scroll at
    // 375px; no fixed minimum width per tab any more.
    for (const filter of ["all", "stocks", "people"]) {
      expect(markup).toMatch(
        new RegExp(`data-market-filter="${filter}"[^>]*class="[^"]*min-h-11`),
      );
      expect(markup).toMatch(
        new RegExp(`data-market-filter="${filter}"[^>]*class="[^"]*flex-1`),
      );
    }
    expect(markup).not.toContain("min-w-[5.25rem]");
  });

  test("marks the active filter with brighter text over a gold rule, not a gold fill", () => {
    // DESIGN.md: gold is a seasoning. The row is a flat strip on a hairline,
    // like the Traders strip; no filter is a gold-filled pill.
    const markup = renderBrowse();
    const filterGroup = markup.match(
      /<div[^>]*aria-label="Search category"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const active =
      markup.match(/<button[^>]*data-market-filter="all"[^>]*>/)?.[0] ?? "";
    const idle =
      markup.match(/<button[^>]*data-market-filter="stocks"[^>]*>/)?.[0] ?? "";

    expect(filterGroup).toContain("border-b");
    expect(filterGroup).not.toContain("rounded-xl");
    expect(filterGroup).not.toContain("bg-[#061720]");
    expect(active).toContain('aria-pressed="true"');
    expect(active).toContain('data-state="active"');
    expect(active).toContain("text-white");
    expect(active).toContain("font-semibold");
    expect(active).not.toContain("bg-[#e7c65d]");
    expect(active).not.toContain("text-[#071219]");
    expect(idle).toContain('aria-pressed="false"');
    expect(idle).toContain("text-[#8da5ad]");
    expect(idle).not.toContain("bg-[");
    expect(markup.match(/data-market-filter-rule="true"/g)).toHaveLength(1);
  });

  test("drops the browse caption row and keeps the quote status with the rankings", () => {
    const markup = renderBrowse();

    expect(markup).not.toContain("Market discovery");
    expect(markup).not.toContain("Live instruments, ranked by venue");
    // A search still names its result count on one compact line.
    expect(markup).toContain('data-mobile-market-search-summary="true"');
    expect(markup).toContain("matching instruments");
  });

  test("keeps venue-qualified quote rows in a flat, shell-owned list", () => {
    const markup = renderBrowse();

    expect(markup).toContain('data-market-section="Stocks"');
    expect(markup).toContain('data-market-venue="stocks"');
    expect(markup).toContain("Solana");
    if (markup.includes('data-market-filter="perps"')) {
      expect(markup).toContain('data-market-section="Perps"');
      expect(markup).toContain('data-market-venue="perps"');
    }
    expect(markup).not.toContain("overflow-y-auto");
    expect(markup).not.toContain(
      "bg-[linear-gradient(145deg,#0a2029,#071a23)]",
    );
    expect(markup).not.toContain("shadow-[0_12px_30px_rgba(0,0,0,0.16)]");
  });

  test("spends the row's second line on data, not on a word that restates the badge", () => {
    const markup = renderBrowse();

    // The badge already says STOCK / PERP. The words that used to sit beside
    // it are gone from the rows and from the badge's tooltip alike.
    expect(markup).not.toContain("Perpetual");
    expect(markup).not.toContain("Equity");
    expect(markup).not.toContain("40x max");

    // What replaced them shares the SAME single line, at the same 16px
    // leading the lone detail string used to occupy, so the row carries more
    // and is not taller. The row's own floor is unchanged at 56px.
    const metricLine = markup.match(
      /data-market-row-metrics="true" class="([^"]+)"/,
    )?.[1];
    expect(metricLine).toContain("leading-4");
    expect(metricLine).toContain("overflow-hidden");
    expect(metricLine).toContain("min-w-0");
    expect(markup).toContain("min-h-14");
  });
});
