import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SelfStandingRow } from "./leaderboard-row-cells";
import type { UserRow } from "./use-leaderboard-view";

const OWN_ROW: UserRow = {
  followTarget: { type: "user", key: "own-key", label: "SwiftFalcon412" },
  displayName: "SwiftFalcon412",
  avatar: "",
  realizedPnl: 1234.5,
  alpacaPnl: 1234.5,
  hyperliquidPnl: 0,
  winRate: 0.62,
  tradeCount: 21,
  lastTradeAt: null,
  hasHyperliquid: false,
};

describe("pinned self row", () => {
  test("renders the caller's rank, pseudonym and metrics", () => {
    const markup = renderToStaticMarkup(
      <SelfStandingRow presentation={{ kind: "ranked", rank: 12, row: OWN_ROW }} />,
    );

    expect(markup).toContain("SwiftFalcon412");
    expect(markup).toContain("12");
    expect(markup).toContain("+$1,234.50");
    expect(markup).toContain("62%");
    // Labelled, because the board is anonymized: without this the user has no
    // way to know which pseudonym is theirs.
    expect(markup).toContain("You");
  });

  test("carries no Follow control", () => {
    // A Follow on your own row would post a follow against your own traderKey.
    const markup = renderToStaticMarkup(
      <SelfStandingRow presentation={{ kind: "ranked", rank: 12, row: OWN_ROW }} />,
    );

    expect(markup).not.toContain("Follow");
  });

  test("still renders when the caller has no rank at all", () => {
    const markup = renderToStaticMarkup(
      <SelfStandingRow
        presentation={{ kind: "unranked", note: "You have no closed shared trades yet." }}
      />,
    );

    expect(markup).toContain("You have no closed shared trades yet.");
  });

  test("renders nothing when there is nothing to pin", () => {
    expect(renderToStaticMarkup(<SelfStandingRow presentation={{ kind: "hidden" }} />)).toBe(
      "",
    );
  });
});
