import { afterEach, describe, expect, mock, test } from "bun:test";

const flushCalls: number[] = [];
mock.module("@sentry/node", () => ({
  flush: async (timeoutMs: number) => {
    flushCalls.push(timeoutMs);
    return true;
  },
}));

const {
  SENTRY_FLUSH_TIMEOUT_MS,
  flushSentryIfCaptured,
  hasPendingSentryCapture,
  markSentryCapture,
  resetSentryFlushState,
} = await import("../lib/sentry-flush.js");

afterEach(() => {
  flushCalls.length = 0;
  resetSentryFlushState();
});

describe("flushSentryIfCaptured", () => {
  // The common case: most requests capture nothing and must not pay for a
  // flush on the way out.
  test("does nothing when nothing was captured", async () => {
    await flushSentryIfCaptured();
    expect(flushCalls).toEqual([]);
  });

  test("flushes once after a capture", async () => {
    markSentryCapture();
    await flushSentryIfCaptured();
    expect(flushCalls).toEqual([SENTRY_FLUSH_TIMEOUT_MS]);
  });

  test("clears the pending flag so the next request does not reflush", async () => {
    markSentryCapture();
    await flushSentryIfCaptured();
    await flushSentryIfCaptured();
    expect(flushCalls).toHaveLength(1);
  });

  test("honours an explicit timeout", async () => {
    markSentryCapture();
    await flushSentryIfCaptured(50);
    expect(flushCalls).toEqual([50]);
  });

  // A capture landing mid-flush must not be erased by that flush completing,
  // or it waits for an unrelated future error to carry it out.
  test("a capture during an in-flight flush stays pending", async () => {
    markSentryCapture();
    const inFlight = flushSentryIfCaptured();
    markSentryCapture();
    await inFlight;

    expect(hasPendingSentryCapture()).toBe(true);
  });

  // This runs while a response is already on its way out. A reporting failure
  // must never become a failure to respond.
  test("never throws when the flush fails", async () => {
    mock.module("@sentry/node", () => ({
      flush: async () => {
        throw new Error("sentry unreachable");
      },
    }));

    markSentryCapture();
    await expect(flushSentryIfCaptured()).resolves.toBeUndefined();
    expect(hasPendingSentryCapture()).toBe(false);
  });
});
