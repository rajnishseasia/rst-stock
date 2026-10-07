import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const fillsResult = {
  data: { fills: [] as Array<Record<string, unknown>> },
  isLoading: false,
  error: null as { message: string } | null,
};

mock.module("@/lib/trpc", () => ({
  trpc: {
    positions: {
      listPerpFills: {
        useQuery: () => fillsResult,
      },
    },
  },
}));

const fillsModule = (await import(
  "./perp-fills-panel?narrow-pane-test" as string
)) as typeof import("./perp-fills-panel");
const { PerpFillsPanel } = fillsModule;

describe("PerpFillsPanel narrow realized activity", () => {
  test("keeps a filled row's long time and signed amount in a contained layout", () => {
    fillsResult.data = {
      fills: [
        {
          time: new Date(2026, 8, 13, 12, 34, 56).getTime(),
          coin: "BTC",
          side: "sell",
          px: "50000",
          sz: "0.125",
          closedPnl: "-1234.56",
          fee: "0.5",
          dir: "Close Long",
          oid: 42,
          hash: "0xabc",
          tid: 42,
          orderType: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<PerpFillsPanel enabled />);
    const text = markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    expect(markup).toContain("@container/perpfills");
    expect(markup).toContain("@[560px]/perpfills:grid-cols-2");
    expect(markup).not.toMatch(/min-w-\[\d+px\]/);
    expect(text).toMatch(
      /Sep 13(?:\s+at|,)\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M/,
    );
    for (const value of [
      "BTC",
      "Time",
      "Size",
      "Price",
      "Fee",
      "PnL",
      "50,000.00",
      "$6,250.00",
      "$0.50",
      "-$1,234.56",
    ]) {
      expect(text).toContain(value);
    }
  });
});
