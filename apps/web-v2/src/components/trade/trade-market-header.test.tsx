import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StockTradeMarketHeader } from "./trade-market-header";

describe("StockTradeMarketHeader", () => {
  test("identifies a stock ticket", () => {
    const html = renderToStaticMarkup(
      <StockTradeMarketHeader symbol="IREN" />,
    );

    expect(html).toContain("IREN");
    expect(html).toContain("Stock");
  });

});
