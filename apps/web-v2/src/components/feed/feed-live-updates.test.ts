import { describe, expect, test } from "bun:test";

import {
  FEED_POLL_BASE_MS,
  FEED_POLL_MAX_MS,
  acknowledgedGroups,
  feedPollIntervalMs,
  isFeedUnavailable,
  pendingSignalCount,
  resolveAcknowledgedKey,
} from "./feed-live-updates";

describe("feedPollIntervalMs", () => {
  test("keeps the live 10s cadence while only page 1 is loaded", () => {
    expect(feedPollIntervalMs(1)).toBe(FEED_POLL_BASE_MS);
  });

  test("holds requests-per-tick flat as the reader pages deeper", () => {
    // React Query refetches every loaded page, so N pages at N x base is the
    // same request rate as one page at base.
    for (const pages of [1, 2, 3, 4, 5]) {
      const requestsPerSecond = pages / (feedPollIntervalMs(pages) / 1000);
      expect(requestsPerSecond).toBeCloseTo(1 / (FEED_POLL_BASE_MS / 1000), 6);
    }
  });

  test("never slows past the ceiling", () => {
    expect(feedPollIntervalMs(50)).toBe(FEED_POLL_MAX_MS);
  });

  test("treats junk page counts as a single page", () => {
    expect(feedPollIntervalMs(0)).toBe(FEED_POLL_BASE_MS);
    expect(feedPollIntervalMs(-3)).toBe(FEED_POLL_BASE_MS);
    expect(feedPollIntervalMs(Number.NaN)).toBe(FEED_POLL_BASE_MS);
  });
});

describe("pendingSignalCount", () => {
  const keys = ["e", "d", "c", "b", "a"];

  test("counts the groups that arrived above the acknowledged one", () => {
    expect(pendingSignalCount(keys, "c")).toBe(2);
    expect(pendingSignalCount(keys, "e")).toBe(0);
  });

  test("reports nothing pending before anything is acknowledged", () => {
    expect(pendingSignalCount(keys, null)).toBe(0);
  });

  test("fails open when the frontier no longer describes the list", () => {
    // Hiding an author or narrowing to perps can drop the acknowledged group.
    // Reporting zero shows everything; the alternative hides signals forever.
    expect(pendingSignalCount(keys, "gone")).toBe(0);
    expect(pendingSignalCount([], "c")).toBe(0);
  });
});

describe("acknowledgedGroups", () => {
  const groups = [{ key: "e" }, { key: "d" }, { key: "c" }];

  test("withholds exactly the pending head of the list", () => {
    expect(acknowledgedGroups(groups, 2)).toEqual([{ key: "c" }]);
  });

  test("renders everything when nothing is pending", () => {
    expect(acknowledgedGroups(groups, 0)).toEqual(groups);
    expect(acknowledgedGroups(groups, -1)).toEqual(groups);
  });

  test("an acknowledged key inside the list always leaves a row rendered", () => {
    // pendingSignalCount can only return an index that exists, so the pill can
    // never empty the feed.
    const keys = groups.map((group) => group.key);
    for (const key of keys) {
      const pending = pendingSignalCount(keys, key);
      expect(acknowledgedGroups(groups, pending).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAcknowledgedKey: the frontier recovers from filtering", () => {
  test("re-anchors when the acknowledged group is filtered out", () => {
    // The bug. A reader scrolled away who narrows or mutes callers can remove
    // the very group their frontier points at. pendingSignalCount fails open to
    // 0, so nothing is hidden, but the key stayed invalid across every later
    // poll: pending was permanently 0 and each new signal was prepended UNDER
    // the reader instead of being held behind the pill.
    expect(
      resolveAcknowledgedKey({
        orderedKeys: ["c", "d"],
        acknowledgedKey: "a",
        atTopOfFeed: false,
      }),
    ).toBe("c");
  });

  test("leaves a still-present key alone when the reader is scrolled away", () => {
    // The whole point of the frontier: groups above "b" stay behind the pill.
    expect(
      resolveAcknowledgedKey({
        orderedKeys: ["a", "b", "c"],
        acknowledgedKey: "b",
        atTopOfFeed: false,
      }),
    ).toBe("b");
  });

  test("adopts the head at the top of the feed, and on first run", () => {
    expect(
      resolveAcknowledgedKey({
        orderedKeys: ["a", "b"],
        acknowledgedKey: "b",
        atTopOfFeed: true,
      }),
    ).toBe("a");
    expect(
      resolveAcknowledgedKey({
        orderedKeys: ["a", "b"],
        acknowledgedKey: null,
        atTopOfFeed: false,
      }),
    ).toBe("a");
  });

  test("an empty list does not clear a frontier a later poll still needs", () => {
    expect(
      resolveAcknowledgedKey({
        orderedKeys: [],
        acknowledgedKey: "a",
        atTopOfFeed: false,
      }),
    ).toBe("a");
  });
});

describe("isFeedUnavailable: an empty feed must not mean an empty world", () => {
  test("a request that FAILED outright is unavailable, not empty", () => {
    // The gap the `degraded` flag could not cover: a failed request returns no
    // pages, so there is nothing to carry the flag, and the feed said "No
    // signals found yet" -- telling the reader the traders they follow had gone
    // quiet when we simply could not reach the API.
    expect(isFeedUnavailable({ requestFailed: true, pages: undefined })).toBe(true);
    expect(isFeedUnavailable({ requestFailed: true, pages: [] })).toBe(true);
  });

  test("a page the API flagged degraded is still unavailable", () => {
    expect(
      isFeedUnavailable({
        requestFailed: false,
        pages: [{ degraded: false }, { degraded: true }],
      }),
    ).toBe(true);
  });

  test("a healthy but genuinely empty feed is NOT unavailable", () => {
    // The real "nobody has posted" case still has to reach the empty state.
    expect(isFeedUnavailable({ requestFailed: false, pages: [] })).toBe(false);
    expect(
      isFeedUnavailable({ requestFailed: false, pages: [{ degraded: false }] }),
    ).toBe(false);
    expect(isFeedUnavailable({ requestFailed: false, pages: [{}] })).toBe(false);
  });
});
