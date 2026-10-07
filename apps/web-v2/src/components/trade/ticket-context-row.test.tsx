import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TicketContextRow } from "./ticket-context-row";

describe("TicketContextRow", () => {
  test("paints every label and value", () => {
    const html = renderToStaticMarkup(
      <TicketContextRow
        cells={[
          { label: "Balance", value: "$1,240.00" },
          { label: "Position", value: "Long 0.5 @ 3,120.40" },
        ]}
      />,
    );
    expect(html).toContain("Balance");
    expect(html).toContain("$1,240.00");
    expect(html).toContain("Position");
    expect(html).toContain("Long 0.5 @ 3,120.40");
  });

  test("emits a static column count Tailwind can see", () => {
    // An interpolated `grid-cols-${n}` compiles to nothing, so a one-cell row
    // would silently render at half width.
    const two = renderToStaticMarkup(
      <TicketContextRow
        cells={[
          { label: "Balance", value: "$1.00" },
          { label: "Position", value: "None" },
        ]}
      />,
    );
    const one = renderToStaticMarkup(
      <TicketContextRow cells={[{ label: "Buying power", value: "$1.00" }]} />,
    );
    expect(two).toContain("grid-cols-2");
    expect(one).toContain("grid-cols-1");
    expect(one).not.toContain("grid-cols-2");
  });

  test("carries the explanation of what the number is", () => {
    const html = renderToStaticMarkup(
      <TicketContextRow
        cells={[
          {
            label: "Balance",
            value: "$1.00",
            title: "Total USDC collateral on Hyperliquid.",
          },
        ]}
      />,
    );
    expect(html).toContain('title="Total USDC collateral on Hyperliquid."');
  });
});
