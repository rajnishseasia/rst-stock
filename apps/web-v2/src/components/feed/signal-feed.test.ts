import { describe, expect, test } from "bun:test";
import {
  feedRevealScrollBehavior,
  signalAuthorClassName,
  signalFeedCardContentClassName,
  signalFeedScrollerClassName,
} from "./signal-feed";
import {
  cleanAuthorName,
  hasValidStockQuote,
  isPostSpecificUrl,
  safeExternalPostUrl,
  normalizeSignalContent,
  parseSignalMetadata,
  signalFeedCardClassName,
  signalGroupKey,
} from "./signal-feed-utils";

describe("new signal reveal scrolling", () => {
  test("uses non-animated scrolling when reduced motion is preferred", () => {
    expect(feedRevealScrollBehavior(true)).toBe("auto");
  });

  test("keeps smooth scrolling by default", () => {
    expect(feedRevealScrollBehavior(false)).toBe("smooth");
  });
});

describe("embedded signal author controls", () => {
  test("keeps the author control at the mobile 44px touch-target floor", () => {
    expect(signalAuthorClassName(true)).toMatch(/min-h-11/);
  });

  test("does not add mobile-only height to the desktop feed author control", () => {
    expect(signalAuthorClassName(false)).not.toMatch(/min-h-11/);
  });
});

describe("embedded signal feed layout", () => {
  test("keeps the card body as a bounded flex column", () => {
    const className = signalFeedCardContentClassName();

    expect(className).toContain("flex");
    expect(className).toContain("flex-1");
    expect(className).toContain("min-h-0");
    expect(className).toContain("flex-col");
  });

  test("keeps the observer root as a bounded full-height scroller", () => {
    const className = signalFeedScrollerClassName(true);

    expect(className).toContain("h-full");
    expect(className).toContain("flex-1");
    expect(className).toContain("min-h-0");
    expect(className).toContain("overflow-y-auto");
  });
});

/**
 * Pure display helpers for the X signal feed.
 *
 * The card itself is covered behaviorally by its real modules, not by reading
 * signal-feed.tsx as a string (audit H7):
 *   - body + secondary actions: signal-content.test.tsx
 *   - ticker chips (equity and perp): signal-ticker-chips.test.tsx
 *   - copy payload routing:          signal-selection.test.ts
 *   - grouping / filtering pipeline: signal-groups.test.ts
 *   - chip price formatting:         signal-quote-format.test.ts
 */

describe("X signal display helpers", () => {
  test("prefers the immutable server author key across display-name changes", () => {
    expect(
      parseSignalMetadata({
        authorName: "New Name",
        canonicalAuthorKey: "source_author:x:42",
      }).authorKey,
    ).toBe("source_author:x:42");
  });

  test("source-qualifies a partially enriched legacy author without trusting a relay ID", () => {
    expect(
      parseSignalMetadata(
        { authorId: "42", authorName: "Shared Name" },
        "x",
      ).authorKey,
    ).toBe("source_alias:x:shared%20name");
    expect(
      parseSignalMetadata(
        {
          authorId: "relay-42",
          authorName: "TweetShift",
          canonicalAuthorKey: "source_author:discord:relay-42",
        },
        "discord",
      ).authorKey,
    ).toBeNull();
  });

  test("matches the server alias key for handle-only author metadata", () => {
    expect(
      parseSignalMetadata({ authorHandle: "Alice", authorSource: "x" }),
    ).toEqual({
      authorName: "Alice",
      authorAvatar: null,
      imageUrl: null,
      authorKey: "source_alias:x:alice",
    });
  });

  test("cleans TweetShift suffixes from author names", () => {
    expect(cleanAuthorName("Serenity • TweetShift")).toBe("Serenity");
    expect(cleanAuthorName("Trader")).toBe("Trader");
  });

  test("removes only one leading case-insensitive Tweeted label", () => {
    expect(normalizeSignalContent("Tweeted $AMD is moving")).toBe(
      "$AMD is moving",
    );
    expect(normalizeSignalContent("TWEETED:   Tweeted $TSLA again")).toBe(
      "Tweeted $TSLA again",
    );
    expect(normalizeSignalContent("$AMD was tweeted yesterday")).toBe(
      "$AMD was tweeted yesterday",
    );
    // Consume the whole label regardless of stray spacing/colons, matching the
    // worker's stripLeadingTweeted so legacy rows render without leftovers.
    expect(normalizeSignalContent("tweeted ::  $AMD")).toBe("$AMD");
  });

  test("parses author and image data from object metadata", () => {
    expect(
      parseSignalMetadata({
        authorName: "Serenity • TweetShift",
        authorAvatar: "https://example.com/avatar.png",
        imageUrl: "https://example.com/chart.png",
      }),
    ).toEqual({
      authorName: "Serenity",
      authorAvatar: "https://example.com/avatar.png",
      imageUrl: "https://example.com/chart.png",
      // Plan S2. The DISPLAY name loses the relay label; the KEY is derived
      // separately, from the raw name, by the server's rules.
      authorKey: "serenity",
    });
  });

  test("parses string metadata and rejects non-string values", () => {
    expect(
      parseSignalMetadata(
        JSON.stringify({
          authorName: "Trader",
          authorAvatar: 123,
          imageUrl: "https://example.com/chart.jpg",
        }),
      ),
    ).toEqual({
      authorName: "Trader",
      authorAvatar: null,
      imageUrl: "https://example.com/chart.jpg",
      authorKey: "trader",
    });

    expect(
      parseSignalMetadata({
        authorName: false,
        imageUrl: ["https://example.com/ignored.png"],
      }),
    ).toEqual({
      authorName: "Unknown",
      authorAvatar: null,
      imageUrl: null,
      authorKey: null,
    });
  });

  test("the follow key mirrors the SERVER's rules, not the display name", () => {
    // Plan S2. The server key is normalizeAuthorKey(cleanAuthorName(raw)), and
    // its cleanAuthorName strips only a TRAILING TweetShift suffix. The web's
    // display normalizer does more (strips the label anywhere, renames the
    // "Don't Follow Shardi ..." variants). Keying off the display name would
    // write follows under a key no feed item ever matches.
    expect(parseSignalMetadata({ authorName: "Serenity • TweetShift" }).authorKey).toBe(
      "serenity",
    );
    expect(
      parseSignalMetadata({ authorName: "Don't Follow Shardi B" }).authorKey,
    ).toBe("don't follow shardi b");
    // ... while the DISPLAY name is still the friendly one.
    expect(
      parseSignalMetadata({ authorName: "Don't Follow Shardi B" }).authorName,
    ).toBe("Shardi");
  });

  test("collapses whitespace and rejects unattributable authors", () => {
    expect(parseSignalMetadata({ authorName: "  Ann   Marie " }).authorKey).toBe(
      "ann marie",
    );
    expect(parseSignalMetadata({ authorName: "Unknown" }).authorKey).toBeNull();
    expect(parseSignalMetadata({ authorName: "   " }).authorKey).toBeNull();
    expect(parseSignalMetadata({}).authorKey).toBeNull();
  });

  test("accepts only absolute HTTP image URLs", () => {
    expect(
      parseSignalMetadata({ imageUrl: "http://example.com/chart.png" })
        .imageUrl,
    ).toBe("http://example.com/chart.png");
    expect(
      parseSignalMetadata({ imageUrl: "https://example.com/chart.png" })
        .imageUrl,
    ).toBe("https://example.com/chart.png");

    for (const imageUrl of [
      "javascript:alert(1)",
      "data:image/png;base64,abc",
      "ftp://example.com/chart.png",
      "stock-chart://example.com/chart.png",
      "/chart.png",
      "chart.png",
      "not a url",
      "https://",
      "   ",
    ]) {
      expect(parseSignalMetadata({ imageUrl }).imageUrl).toBeNull();
    }
  });

  test("falls back safely for malformed metadata", () => {
    expect(parseSignalMetadata("{bad json")).toEqual({
      authorName: "Unknown",
      authorAvatar: null,
      imageUrl: null,
      authorKey: null,
    });
  });
});

describe("X signal action wiring", () => {
  test("offers stock trading only for a positive equity quote", () => {
    expect(hasValidStockQuote({ last: "123.45" })).toBe(true);
    expect(hasValidStockQuote({ last: "0" })).toBe(false);
    expect(hasValidStockQuote({ last: null })).toBe(false);
    expect(hasValidStockQuote(undefined)).toBe(false);
  });
});

describe("isPostSpecificUrl", () => {
  test("a site-root URL is not post-specific", () => {
    // Every paste.trade row carries the board root, so grouping on it would
    // collapse every paste.trade signal into one card.
    expect(isPostSpecificUrl("https://paste.trade")).toBe(false);
    expect(isPostSpecificUrl("https://paste.trade/")).toBe(false);
    expect(isPostSpecificUrl("  https://paste.trade//  ")).toBe(false);
  });

  test("a URL with a real path or query is post-specific", () => {
    expect(isPostSpecificUrl("https://x.com/someone/status/12345")).toBe(true);
    expect(isPostSpecificUrl("https://paste.trade/p/abc")).toBe(true);
    expect(isPostSpecificUrl("https://paste.trade?post=7")).toBe(true);
  });

  test("blank / missing values are never post-specific", () => {
    expect(isPostSpecificUrl(null)).toBe(false);
    expect(isPostSpecificUrl(undefined)).toBe(false);
    expect(isPostSpecificUrl("   ")).toBe(false);
  });
});

describe("signalGroupKey", () => {
  const base = {
    timestamp: "2026-07-24T12:00:00.000Z",
    authorName: "Author A",
    content: "long ETH",
  };

  test("separate paste.trade posts sharing the board root do NOT collapse", () => {
    const a = signalGroupKey({ ...base, url: "https://paste.trade" });
    const b = signalGroupKey({
      ...base,
      url: "https://paste.trade",
      authorName: "Author B",
      content: "short BTC",
    });
    expect(a).not.toBe(b);
  });

  test("the per-ticker rows of ONE post still group together", () => {
    // Same post, two tickers: identical timestamp/author/content, so one card.
    const first = signalGroupKey({ ...base, url: "https://paste.trade" });
    const second = signalGroupKey({ ...base, url: "https://paste.trade" });
    expect(first).toBe(second);
  });

  test("a post-specific URL still groups its ticker rows by URL", () => {
    const url = "https://x.com/someone/status/12345";
    const first = signalGroupKey({ ...base, url });
    const second = signalGroupKey({ ...base, url, content: "different text" });
    expect(first).toBe(second);
    expect(first).toBe(`url::${url}`);
  });
});

describe("safeExternalPostUrl: only an absolute http(s) post link", () => {
  test("rejects a relative path that would point at our own app", () => {
    // `isPostSpecificUrl` accepts these, correctly, for GROUPING. Putting one in
    // an href presented an in-app URL as the caller's original site.
    expect(safeExternalPostUrl("/post/1")).toBeNull();
    expect(isPostSpecificUrl("/post/1")).toBe(true);
  });

  test("rejects non-web schemes", () => {
    // Both have a "path" and passed the identity predicate.
    expect(safeExternalPostUrl("mailto:user@example.com")).toBeNull();
    expect(safeExternalPostUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalPostUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects every paste.trade link", () => {
    expect(safeExternalPostUrl("https://paste.trade")).toBeNull();
    expect(safeExternalPostUrl("https://paste.trade/")).toBeNull();
    expect(safeExternalPostUrl("https://paste.trade/p/abc")).toBeNull();
    expect(safeExternalPostUrl("  https://paste.trade?post=7  ")).toBeNull();
  });

  test("accepts a real post link and returns it", () => {
    expect(safeExternalPostUrl("https://x.com/someone/status/12345")).toBe(
      "https://x.com/someone/status/12345",
    );
  });

  test("empty input is null", () => {
    expect(safeExternalPostUrl(null)).toBeNull();
    expect(safeExternalPostUrl(undefined)).toBeNull();
    expect(safeExternalPostUrl("   ")).toBeNull();
  });
});

describe("signalFeedCardClassName", () => {
  test("a bounded embed fills its box and clips, so the list scrolls inside", () => {
    const className = signalFeedCardClassName({
      embedded: true,
      collapsed: false,
      scrollsWithPage: false,
    });

    expect(className).toContain("h-full");
    expect(className).toContain("min-h-0");
    expect(className).toContain("overflow-hidden");
    expect(className).not.toContain("flex-1");
  });

  test("a page-scrolling embed grows but can never be squeezed below its content", () => {
    const className = signalFeedCardClassName({
      embedded: true,
      collapsed: false,
      scrollsWithPage: true,
    });

    expect(className).toContain("flex-1");
    expect(className).toContain("overflow-visible");
    expect(className).not.toContain("h-full");
    expect(className).not.toContain("min-h-0");
    expect(className).not.toContain("overflow-hidden");
  });

  test("the terminal panel keeps its fixed height unless collapsed", () => {
    expect(
      signalFeedCardClassName({ embedded: false, collapsed: false, scrollsWithPage: false }),
    ).toContain("h-[600px]");
    expect(
      signalFeedCardClassName({ embedded: false, collapsed: true, scrollsWithPage: false }),
    ).not.toContain("h-[600px]");
  });
});
