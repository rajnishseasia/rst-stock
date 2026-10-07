import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PortfolioHistoryCard } from "../portfolio-history-chart";

const portfolioHistory = {
  baseValue: 2000,
  period: "1M",
  points: [
    {
      t: Date.UTC(2026, 4, 1),
      equity: 2000,
      pnl: 0,
      pnlPct: 0,
    },
    {
      t: Date.UTC(2026, 5, 1),
      equity: 1891.84,
      pnl: -108.16,
      pnlPct: -5.408,
    },
  ],
};

function renderPortfolioCard(collapsed: boolean) {
  return renderToStaticMarkup(
    <PortfolioHistoryCard
      data={portfolioHistory}
      period="1M"
      onPeriodChange={() => {}}
      collapsed={collapsed}
      onToggleCollapse={() => {}}
    />
  );
}

function expectPortfolioTitle(markup: string) {
  expect(markup).toMatch(
    /<div data-slot="card-title"[^>]*>Portfolio<\/div>/
  );
}

function expectSelectedPeriod(markup: string, period: string) {
  expect(markup).toMatch(
    new RegExp(
      `<button[^>]*aria-pressed="true"[^>]*>\\s*${period}\\s*</button>`
    )
  );
}

describe("PortfolioHistoryCard", () => {
  test("renders the complete expanded portfolio card", () => {
    const markup = renderPortfolioCard(false);

    expectPortfolioTitle(markup);
    expect(markup).toContain("$1,891.84");
    expect(markup).toContain("-$108.16");
    expectSelectedPeriod(markup, "1M");
    expect(markup).toContain('aria-label="Collapse Portfolio"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Portfolio equity history");
    expect(markup).toContain("[overflow-wrap:anywhere]");
    expect(markup).toContain("@md/card-header:flex-row");
  });

  test("keeps the portfolio header and controls visible while collapsed", () => {
    const markup = renderPortfolioCard(true);

    expectPortfolioTitle(markup);
    expect(markup).toContain("$1,891.84");
    expect(markup).toContain("-$108.16");
    expectSelectedPeriod(markup, "1M");
    expect(markup).toContain('aria-label="Expand Portfolio"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Portfolio equity history");
  });
});

describe("the empty curve does not tell a connected user to connect", () => {
  const renderEmpty = (isConnected: boolean) =>
    renderToStaticMarkup(
      <PortfolioHistoryCard
        data={{ baseValue: 0, period: "1M", points: [] }}
        period="1M"
        onPeriodChange={() => {}}
        collapsed={false}
        onToggleCollapse={() => {}}
        isConnected={isConnected}
      />
    );

  test("a CONNECTED account with no fills gets no Connect action", () => {
    // A brand new account has no fills, so a successful empty history is its
    // normal first state, not evidence that nothing is connected. Offering
    // "Connect Alpaca" sent that user to Settings for something already done.
    const markup = renderEmpty(true);

    expect(markup).toContain("No portfolio history yet");
    expect(markup).not.toContain("Connect Alpaca");
  });

  test("an account with NO credential still gets the offer", () => {
    // The case the action exists for has to survive.
    const markup = renderEmpty(false);

    expect(markup).toContain("No portfolio history yet");
    expect(markup).toContain("Connect Alpaca");
  });
});
