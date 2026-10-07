import { describe, expect, test } from "bun:test";
import {
  collectFeedAuthors,
  dedupeSignalsById,
  filterGroupsByVenue,
  filterPerpGroups,
  groupFeedSignals,
  groupStatedDirection,
  normalizeFeedSignals,
  type RawFeedSignal,
} from "./signal-groups";

const TIMESTAMP = "2026-07-24T12:00:00.000Z";

function rawSignal(overrides: Partial<RawFeedSignal> = {}): RawFeedSignal {
  return {
    id: "row-1",
    symbol: "NVDA",
    content: "long NVDA into earnings",
    url: "https://x.com/someone/status/12345",
    timestamp: TIMESTAMP,
    metadata: { authorName: "Serenity" },
    ...overrides,
  };
}

describe("dedupeSignalsById", () => {
  test("drops a row id repeated across page boundaries", () => {
    const rows = [
      rawSignal({ id: "a" }),
      rawSignal({ id: "b" }),
      rawSignal({ id: "a" }),
    ];

    expect(dedupeSignalsById(rows).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("normalizeFeedSignals", () => {
  test("cleans the author, strips the relay label, and exposes the image", () => {
    const [row] = normalizeFeedSignals([
      rawSignal({
        content: "Tweeted $AMD is moving",
        metadata: {
          authorName: "Serenity • TweetShift",
          authorAvatar: "https://example.com/avatar.png",
          imageUrl: "https://example.com/chart.png",
        },
      }),
    ]);

    expect(row?.authorName).toBe("Serenity");
    expect(row?.authorAvatar).toBe("https://example.com/avatar.png");
    expect(row?.imageUrl).toBe("https://example.com/chart.png");
    expect(row?.content).toBe("$AMD is moving");
  });

  test("a non-http image url never reaches the card", () => {
    const [row] = normalizeFeedSignals([
      rawSignal({ metadata: { imageUrl: "javascript:alert(1)" } }),
    ]);

    expect(row?.imageUrl).toBeNull();
    expect(row?.authorName).toBe("Unknown");
  });

  test("keeps the row fields the card renders", () => {
    const [row] = normalizeFeedSignals([rawSignal({ id: "row-9" })]);

    expect(row?.id).toBe("row-9");
    expect(row?.symbol).toBe("NVDA");
    expect(row?.url).toBe("https://x.com/someone/status/12345");
  });
});

describe("groupFeedSignals", () => {
  test("one post naming three tickers renders as ONE card with three chips", () => {
    const rows = normalizeFeedSignals([
      rawSignal({ id: "a", symbol: "CBRS" }),
      rawSignal({ id: "b", symbol: "NVDA" }),
      rawSignal({ id: "c", symbol: "AMZN" }),
    ]);

    const groups = groupFeedSignals(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tickers.map((ticker) => ticker.symbol)).toEqual([
      "CBRS",
      "NVDA",
      "AMZN",
    ]);
    // Card identity is the first row seen, and every row id lights the ring.
    expect(groups[0]?.primaryId).toBe("a");
    expect([...(groups[0]?.signalIds ?? [])]).toEqual(["a", "b", "c"]);
  });

  test("the tweet's image and author ride on the card, not the ticker", () => {
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "a",
        metadata: {
          authorName: "Serenity",
          imageUrl: "https://example.com/chart.png",
        },
      }),
    ]);

    const group = groupFeedSignals(rows)[0];

    expect(group?.imageUrl).toBe("https://example.com/chart.png");
    expect(group?.authorName).toBe("Serenity");
    expect(group?.url).toBe("https://x.com/someone/status/12345");
  });

  test("separate paste.trade posts sharing the board root stay separate cards", () => {
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "a",
        symbol: "HYPE",
        url: "https://paste.trade",
        content: "long HYPE",
        metadata: { authorName: "Author A" },
      }),
      rawSignal({
        id: "b",
        symbol: "BTC",
        url: "https://paste.trade",
        content: "short BTC",
        metadata: { authorName: "Author B" },
      }),
    ]);

    const groups = groupFeedSignals(rows);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.authorName)).toEqual([
      "Author A",
      "Author B",
    ]);
  });

  test("a repeated ticker inside one post does not duplicate the chip", () => {
    const rows = normalizeFeedSignals([
      rawSignal({ id: "a", symbol: "NVDA" }),
      rawSignal({ id: "b", symbol: "NVDA" }),
    ]);

    const group = groupFeedSignals(rows)[0];

    expect(group?.tickers).toHaveLength(1);
    // The duplicate row still lights the selection ring.
    expect(group?.signalIds.has("b")).toBe(true);
  });

  test("a perp row carries its copy payload; an equity row carries none", () => {
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "perp",
        symbol: "KPEPE",
        url: "https://paste.trade/p/1",
        metadata: {
          authorName: "Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "short",
          leverage: 20,
          hlTicker: "kPEPE",
        },
      }),
      rawSignal({
        id: "equity",
        symbol: "NVDA",
        url: "https://paste.trade/p/2",
        metadata: { authorName: "Caller" },
      }),
    ]);

    const [perpGroup, equityGroup] = groupFeedSignals(rows);

    // Canonical HL casing survives so the chip copies the coin that exists.
    expect(perpGroup?.tickers[0]?.perp).toEqual({
      coin: "kPEPE",
      side: "short",
      leverage: 20,
    });
    expect(equityGroup?.tickers[0]?.perp).toBeNull();
  });

  test("a ticker carries the direction the caller STATED, and null when they did not", () => {
    // Plan S1. The chip's `direction` is what the chart screen attributes to a
    // named person, so it must be presence-gated. Note the perp row below: its
    // copy payload says side "long" (a Copy has to open something) while its
    // direction stays null, and those two disagreeing is the correct outcome.
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "stated",
        symbol: "NVDA",
        url: "https://x.com/a/status/1",
        metadata: { authorName: "Caller", direction: "short" },
      }),
      rawSignal({
        id: "silent",
        symbol: "AMD",
        url: "https://x.com/a/status/2",
        metadata: { authorName: "Caller" },
      }),
      rawSignal({
        id: "perp-silent",
        symbol: "BTC",
        url: "https://paste.trade/p/9",
        metadata: {
          authorName: "Caller",
          platform: "hyperliquid",
          instrument: "perp",
          hlTicker: "BTC",
        },
      }),
    ]);

    const [stated, silent, perpSilent] = groupFeedSignals(rows);

    expect(stated?.tickers[0]?.direction).toBe("short");
    expect(silent?.tickers[0]?.direction).toBeNull();
    expect(perpSilent?.tickers[0]?.perp?.side).toBe("long");
    expect(perpSilent?.tickers[0]?.direction).toBeNull();
  });

  test("a post naming two tickers keeps a direction per ticker", () => {
    // Metadata is stored per (post, ticker) row, so the second chip's direction
    // is read from its own row rather than inherited from the first.
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "a",
        symbol: "NVDA",
        metadata: { authorName: "Caller", direction: "long" },
      }),
      rawSignal({
        id: "b",
        symbol: "AMD",
        metadata: { authorName: "Caller", direction: "short" },
      }),
    ]);

    const [group] = groupFeedSignals(rows);

    expect(group?.tickers.map((ticker) => ticker.direction)).toEqual([
      "long",
      "short",
    ]);
  });
});

describe("groupStatedDirection", () => {
  test("a post where nobody stated a direction gets NO card badge", () => {
    // The load-bearing case: absence must stay absence. Inventing a side here
    // would put a fabricated claim beside a named author.
    expect(groupStatedDirection([])).toBeNull();
    expect(
      groupStatedDirection([{ direction: null }, { direction: null }]),
    ).toBeNull();
  });

  test("unanimous stated directions surface as the card's direction", () => {
    expect(
      groupStatedDirection([{ direction: "long" }, { direction: "long" }]),
    ).toBe("long");
    expect(groupStatedDirection([{ direction: "short" }])).toBe("short");
  });

  test("a mixed post (long one ticker, short another) claims nothing", () => {
    expect(
      groupStatedDirection([{ direction: "long" }, { direction: "short" }]),
    ).toBeNull();
    // Order must not matter: disagreement after agreement still voids it.
    expect(
      groupStatedDirection([
        { direction: "short" },
        { direction: "short" },
        { direction: "long" },
      ]),
    ).toBeNull();
  });

  test("silent tickers do not veto the stated ones", () => {
    // "Unanimous" is over the directions actually stated, so a post that
    // shorts BTC while merely mentioning NVDA still reads as a short.
    expect(
      groupStatedDirection([{ direction: null }, { direction: "short" }]),
    ).toBe("short");
    expect(
      groupStatedDirection([{ direction: "long" }, { direction: null }]),
    ).toBe("long");
  });
});

describe("filterPerpGroups", () => {
  function mixedGroups() {
    return groupFeedSignals(
      normalizeFeedSignals([
        rawSignal({
          id: "perp",
          symbol: "HYPE",
          url: "https://paste.trade/p/1",
          metadata: {
            authorName: "Caller",
            platform: "hyperliquid",
            instrument: "perp",
            direction: "long",
            hlTicker: "HYPE",
          },
        }),
        rawSignal({
          id: "equity-in-perp-post",
          symbol: "NVDA",
          url: "https://paste.trade/p/1",
          metadata: {
            authorName: "Caller",
            platform: "hyperliquid",
            instrument: "perp",
            direction: "long",
            hlTicker: "NVDA",
          },
          content: "long HYPE, also watching NVDA",
        }),
        rawSignal({
          id: "equity-only",
          symbol: "AMD",
          url: "https://paste.trade/p/2",
          metadata: { authorName: "Caller" },
        }),
      ]),
    );
  }

  test("the full feed keeps every card", () => {
    expect(filterPerpGroups(mixedGroups(), false)).toHaveLength(2);
  });

  test("the perps venue drops equity-only cards", () => {
    const groups = filterPerpGroups(mixedGroups(), true);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tickers.every((ticker) => ticker.perp)).toBe(true);
  });

  test("a mixed post shows no equity chip under the perps header", () => {
    // An equity chip here would flip the terminal back to the stocks venue.
    const rows = normalizeFeedSignals([
      rawSignal({
        id: "perp",
        symbol: "HYPE",
        url: "https://paste.trade/p/3",
        metadata: {
          authorName: "Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "HYPE",
        },
      }),
      rawSignal({
        id: "equity",
        symbol: "NVDA",
        url: "https://paste.trade/p/3",
        metadata: { authorName: "Caller" },
      }),
    ]);

    const [group] = filterPerpGroups(groupFeedSignals(rows), true);

    expect(group?.tickers.map((ticker) => ticker.symbol)).toEqual(["HYPE"]);
  });
});

describe("filterGroupsByVenue", () => {
  const groups = groupFeedSignals(
    normalizeFeedSignals([
      rawSignal({
        id: "perp",
        symbol: "BTC",
        url: "https://example.com/mixed",
        metadata: {
          instrument: "perp",
          platform: "hyperliquid",
          hlTicker: "BTC",
        },
      }),
      rawSignal({
        id: "stock",
        symbol: "GOOGL",
        url: "https://example.com/mixed",
      }),
    ]),
  );

  test("All keeps both ticker types", () => {
    expect(filterGroupsByVenue(groups, "all")[0]?.tickers).toHaveLength(2);
  });

  test("Stocks removes perp tickers", () => {
    const tickers = filterGroupsByVenue(groups, "stocks")[0]?.tickers ?? [];
    expect(tickers.map((ticker) => ticker.symbol)).toEqual(["GOOGL"]);
    expect(tickers.every((ticker) => ticker.perp == null)).toBe(true);
  });

  test("Perps removes stock tickers", () => {
    const tickers = filterGroupsByVenue(groups, "perps")[0]?.tickers ?? [];
    expect(tickers.map((ticker) => ticker.symbol)).toEqual(["BTC"]);
    expect(tickers.every((ticker) => ticker.perp != null)).toBe(true);
  });
});

describe("collectFeedAuthors", () => {
  test("keeps renamed canonical authors in one filter entry", () => {
    expect(
      collectFeedAuthors([
        { authorName: "Old Name", authorAvatar: null, authorKey: "source_author:x:42" },
        { authorName: "New Name", authorAvatar: null, authorKey: "source_author:x:42" },
      ]),
    ).toEqual([
      { name: "Old Name", avatar: null, count: 2, key: "source_author:x:42" },
    ]);
  });

  test("counts each author and sorts most-frequent first", () => {
    const authors = collectFeedAuthors([
      { authorName: "Zed", authorAvatar: null },
      { authorName: "Ann", authorAvatar: null },
      { authorName: "Ann", authorAvatar: "https://example.com/a.png" },
    ]);

    expect(authors).toEqual([
      { name: "Ann", avatar: "https://example.com/a.png", count: 2, key: null },
      { name: "Zed", avatar: null, count: 1, key: null },
    ]);
  });

  test("adopts the follow key from whichever row carries one", () => {
    // Plan S2. The key is what the Follow and the caller record are looked up
    // by, so an author whose first-seen row happened to lack one must still be
    // followable from a later row.
    const authors = collectFeedAuthors([
      { authorName: "Ann", authorAvatar: null, authorKey: null },
      { authorName: "Ann", authorAvatar: null, authorKey: "ann" },
    ]);

    expect(authors[0]?.key).toBe("ann");
  });

  test("ties break alphabetically", () => {
    const authors = collectFeedAuthors([
      { authorName: "Zed", authorAvatar: null },
      { authorName: "Ann", authorAvatar: null },
    ]);

    expect(authors.map((author) => author.name)).toEqual(["Ann", "Zed"]);
  });
});

// filterHiddenAuthors was replaced by applyCallerFilter (plan S2), which covers
// the same hide behavior plus the only-this-caller mode. Its coverage moved to
// caller-filter.test.ts rather than being dropped.

describe("a perp row whose coin cannot be named offers no chip at all", () => {
  // Failing closed has to mean CLOSED. `perpCopyPayload` returning null used to
  // mean only "this is not a perp", and the feed reads that as "render the
  // equity chip". A HIP-3 perp call whose hlTicker upstream dropped would then
  // hand the reader a Copy that prefills the Alpaca ticket for the colliding
  // listing (SOL is Solana on HL and ReneSola on Nasdaq), which is the same
  // wrong-venue order the coin guess was removed to prevent.

  function hip3Row() {
    return normalizeFeedSignals([
      rawSignal({
        id: "hip3-no-coin",
        symbol: "GOOGL",
        url: "https://paste.trade/p/44",
        metadata: {
          authorName: "Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "short",
          leverage: 20,
          hlTicker: null,
        },
      }),
    ]);
  }

  test("the card survives but carries no ticker chip", () => {
    const [group] = groupFeedSignals(hip3Row());

    expect(group).toBeDefined();
    expect(group?.tickers).toEqual([]);
  });

  test("it is not offered under the Stocks filter as an equity chip", () => {
    const groups = filterGroupsByVenue(groupFeedSignals(hip3Row()), "stocks");

    expect(groups.flatMap((group) => group.tickers)).toEqual([]);
  });

  test("a copyable perp in the same post still renders its chip", () => {
    const [group] = groupFeedSignals(
      normalizeFeedSignals([
        rawSignal({
          id: "hip3-no-coin",
          symbol: "GOOGL",
          url: "https://paste.trade/p/45",
          metadata: {
            authorName: "Caller",
            platform: "hyperliquid",
            instrument: "perp",
            hlTicker: null,
          },
        }),
        rawSignal({
          id: "hip3-with-coin",
          symbol: "NVDA",
          url: "https://paste.trade/p/45",
          metadata: {
            authorName: "Caller",
            platform: "hyperliquid",
            instrument: "perp",
            hlTicker: "xyz:NVDA",
          },
        }),
      ]),
    );

    expect(group?.tickers.map((ticker) => ticker.symbol)).toEqual(["NVDA"]);
    expect(group?.tickers[0]?.perp?.coin).toBe("xyz:NVDA");
  });
});
