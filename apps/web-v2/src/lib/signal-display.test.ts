import { describe, expect, test } from "bun:test";
import {
  MAX_TICKER_CHIPS,
  capTickerChips,
  normalizeAuthorName,
  stripTweetShift,
} from "./signal-display";

describe("capTickerChips", () => {
  test("caps a long ticker list at the first three", () => {
    const tickers = [
      "INTC",
      "BTC",
      "MU",
      "SKHY",
      "EWY",
      "IREN",
      "VRT",
      "SMSN",
      "TBF",
      "CRWV",
      "HYPE",
      "PYPL",
      "HIMS",
      "RSP",
    ];
    expect(MAX_TICKER_CHIPS).toBe(3);
    expect(capTickerChips(tickers)).toEqual(["INTC", "BTC", "MU"]);
  });

  test("returns the whole list untouched when at or under the cap", () => {
    expect(capTickerChips(["AMD"])).toEqual(["AMD"]);
    expect(capTickerChips(["AMD", "NVDA", "TSLA"])).toEqual([
      "AMD",
      "NVDA",
      "TSLA",
    ]);
    expect(capTickerChips([])).toEqual([]);
  });

  test("preserves order and works over object entries", () => {
    const entries = [
      { signalId: "1", symbol: "AAA" },
      { signalId: "2", symbol: "BBB" },
      { signalId: "3", symbol: "CCC" },
      { signalId: "4", symbol: "DDD" },
    ];
    expect(capTickerChips(entries)).toEqual([
      { signalId: "1", symbol: "AAA" },
      { signalId: "2", symbol: "BBB" },
      { signalId: "3", symbol: "CCC" },
    ]);
  });
});

describe("stripTweetShift", () => {
  test("drops the label plus a bullet / pipe / dash separator", () => {
    expect(stripTweetShift("Serenity • TweetShift")).toBe("Serenity");
    expect(stripTweetShift("Serenity·TweetShift")).toBe("Serenity");
    expect(stripTweetShift("Serenity | TweetShift")).toBe("Serenity");
    expect(stripTweetShift("Serenity - TweetShift")).toBe("Serenity");
  });

  test("removes the label at the start or end of the string", () => {
    expect(stripTweetShift("TweetShift")).toBe("");
    expect(stripTweetShift("TweetShift $AMD is up")).toBe("$AMD is up");
    expect(stripTweetShift("$AMD is up TweetShift")).toBe("$AMD is up");
  });

  test("leaves a mid-sentence occurrence alone by default (body-safe)", () => {
    // An unanchored strip mauled real tweet content, so bodies only lose the
    // label when it is separator-glued or sits at an edge.
    expect(stripTweetShift("Relayed via https://tweetshift.com/docs today")).toBe(
      "Relayed via https://tweetshift.com/docs today",
    );
    expect(stripTweetShift("non-TweetShift tools are fine")).toBe(
      "non-TweetShift tools are fine",
    );
    expect(stripTweetShift("I think TweetShift is down again")).toBe(
      "I think TweetShift is down again",
    );
  });

  test("strips anywhere when explicitly asked (author names)", () => {
    expect(
      stripTweetShift("$AMD moving TweetShift alert", { anywhere: true }),
    ).toBe("$AMD moving alert");
  });

  test("is case-insensitive", () => {
    expect(stripTweetShift("Serenity • tweetshift")).toBe("Serenity");
    expect(stripTweetShift("TWEETSHIFT alert")).toBe("alert");
    expect(stripTweetShift("alert TWEETSHIFT")).toBe("alert");
  });

  test("leaves strings without the label unchanged", () => {
    expect(stripTweetShift("Trader")).toBe("Trader");
    expect(stripTweetShift("$AMD is moving")).toBe("$AMD is moving");
  });
});

describe("normalizeAuthorName", () => {
  test("renames a Shardi variant carrying leading emoji / punctuation", () => {
    // X display names routinely lead with an emoji, which a start-anchored
    // match would let escape the rename.
    expect(normalizeAuthorName("\u{1F680} Don't Follow Shardi B If You Hate Money")).toBe(
      "Shardi",
    );
    expect(normalizeAuthorName('"Don\u2019t Follow Shardi B"')).toBe("Shardi");
  });

  test("keeps the relay label out of the author name wherever it sits", () => {
    expect(normalizeAuthorName("Serenity TweetShift alerts")).toBe(
      "Serenity alerts",
    );
  });

  test("renames every Don't-follow-Shardi variant to Shardi", () => {
    expect(
      normalizeAuthorName("Don't Follow Shardi B If You Hate Money"),
    ).toBe("Shardi");
    // Curly apostrophe variant.
    expect(
      normalizeAuthorName("Don’t Follow Shardi B If You Hate Money"),
    ).toBe("Shardi");
    // Missing apostrophe + different casing.
    expect(normalizeAuthorName("dont follow shardi")).toBe("Shardi");
    // Still collapses when the relay glued a TweetShift suffix on.
    expect(
      normalizeAuthorName("Don't Follow Shardi B If You Hate Money • TweetShift"),
    ).toBe("Shardi");
  });

  test("strips TweetShift from non-Shardi authors", () => {
    expect(normalizeAuthorName("Serenity • TweetShift")).toBe("Serenity");
    expect(normalizeAuthorName("Trader")).toBe("Trader");
  });

  test("does not rename unrelated authors that merely mention Shardi", () => {
    expect(normalizeAuthorName("Shardi B")).toBe("Shardi B");
    expect(normalizeAuthorName("Follow Shardi")).toBe("Follow Shardi");
  });

  test("falls back to the original when stripping empties the name", () => {
    expect(normalizeAuthorName("TweetShift")).toBe("TweetShift");
  });
});
