import { describe, expect, it, vi } from "bun:test";
import { isTransientHttpError, retryAsync } from "../lib/retry.js";

describe("retryAsync", () => {
  it("retries transient failures and returns the eventual result", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockResolvedValueOnce("quote");

    await expect(
      retryAsync(operation, {
        attempts: 3,
        baseDelayMs: 0,
        shouldRetry: isTransientHttpError,
      })
    ).resolves.toBe("quote");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent HTTP failures", async () => {
    const error = { response: { status: 404 } };
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      retryAsync(operation, {
        attempts: 3,
        baseDelayMs: 0,
        shouldRetry: isTransientHttpError,
      })
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
