import { describe, expect, test } from "bun:test";
import {
  PERP_CLOSE_BACKGROUND_POLL_MS,
  PERP_CLOSE_FAST_POLL_MS,
  PERP_CLOSE_SLOW_POLL_AFTER_MS,
  perpClosePollInterval,
  perpCloseSlowNoticeDelay,
  resolvePerpClose,
} from "./perp-close-reconciliation";

describe("perp close reconciliation", () => {
  test("shows the slow-close notice four seconds after submission starts", () => {
    const startedAt = 1_000;
    expect(perpCloseSlowNoticeDelay(startedAt, startedAt)).toBe(4_000);
    expect(perpCloseSlowNoticeDelay(startedAt, startedAt + 3_999)).toBe(1);
    expect(perpCloseSlowNoticeDelay(startedAt, startedAt + 4_000)).toBe(0);
  });

  test("polls quickly for 30 seconds, then falls back to background polling", () => {
    const startedAt = 1_000;
    expect(perpClosePollInterval(startedAt, startedAt)).toBe(
      PERP_CLOSE_FAST_POLL_MS,
    );
    expect(
      perpClosePollInterval(
        startedAt,
        startedAt + PERP_CLOSE_SLOW_POLL_AFTER_MS - 1,
      ),
    ).toBe(PERP_CLOSE_FAST_POLL_MS);
    expect(
      perpClosePollInterval(
        startedAt,
        startedAt + PERP_CLOSE_SLOW_POLL_AFTER_MS,
      ),
    ).toBe(PERP_CLOSE_BACKGROUND_POLL_MS);
  });

  test("treats a missing position as a completed full close", () => {
    expect(
      resolvePerpClose({ initialSize: "2.5", currentSize: null }),
    ).toBe("closed");
  });

  test("detects a partial fill from reduced venue exposure", () => {
    expect(
      resolvePerpClose({ initialSize: "2.5", currentSize: "0.75" }),
    ).toBe("partial");
  });

  test("keeps accepted and ambiguous orders pending while exposure is unchanged", () => {
    for (const orderStatus of ["PENDING", "SYNCING", "SUBMITTED", "FILLED"]) {
      expect(
        resolvePerpClose({
          initialSize: "2.5",
          currentSize: "2.5",
          orderStatus,
        }),
      ).toBe("pending");
    }
  });

  test("unlocks only after a definitive failed terminal status", () => {
    for (const orderStatus of ["REJECTED", "CANCELLED", "EXPIRED"]) {
      expect(
        resolvePerpClose({
          initialSize: "2.5",
          currentSize: "2.5",
          orderStatus,
        }),
      ).toBe("failed");
    }
  });
});
