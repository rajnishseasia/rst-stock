import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PerpRowBadge } from "./copy-trade-card-layout";

/**
 * A Hyperliquid perp fill reaches the copy-trade feed as a bare ticker with a
 * plain green BUY chip, which is exactly how an equity buy renders. The Copy
 * button is disabled for those rows now, but a disabled button with a tooltip
 * is not a label: the venue has to be visible on the card, because the tickers
 * collide with real listings (SOL is ReneSola on Nasdaq, APT collides too) and
 * a follower reading the row has no other cue that this was a leveraged perp.
 */
describe("copy-trade perp row badge", () => {
  test("labels a PERP row with its venue", () => {
    const html = renderToStaticMarkup(<PerpRowBadge assetType="PERP" />);
    expect(html).toContain("Perp");
    expect(html).toContain("Hyperliquid");
  });

  test("renders nothing for equity, option, and missing asset types", () => {
    expect(renderToStaticMarkup(<PerpRowBadge assetType="EQUITY" />)).toBe("");
    expect(renderToStaticMarkup(<PerpRowBadge assetType="OPTION" />)).toBe("");
    expect(renderToStaticMarkup(<PerpRowBadge assetType={null} />)).toBe("");
    expect(renderToStaticMarkup(<PerpRowBadge assetType={undefined} />)).toBe("");
  });
});
