import { describe, expect, test } from "bun:test";

import {
  ERROR_MESSAGE_MAX_CHARS,
  describeError,
  scrubErrorMessage,
} from "../log-safe-error";

describe("scrubErrorMessage", () => {
  test("masks credentials a driver quoted back at us", () => {
    // The logger's own redaction is KEY-based, so it cannot help with a secret
    // embedded in a message string. This is the only thing that catches it.
    const scrubbed = scrubErrorMessage(
      "connect failed: postgresql://postgres:hunter2@db.example.com:5432/tradebot",
    );
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("[REDACTED]@db.example.com");
  });

  test("leaves an ordinary message intact", () => {
    // A broad secret heuristic would chew up real diagnostics, which is the
    // failure this module exists to avoid. Only user:pass@host is targeted.
    const message = "Request failed with status code 422";
    expect(scrubErrorMessage(message)).toBe(message);
    expect(scrubErrorMessage("no snapshot found for KOSPI")).toBe(
      "no snapshot found for KOSPI",
    );
    // A URL without credentials keeps its host: that is the useful part.
    expect(
      scrubErrorMessage("GET https://api.alpaca.markets/v2/orders/505085728820"),
    ).toBe("GET https://api.alpaca.markets/v2/orders/505085728820");
  });

  test("bounds a pathological message", () => {
    expect(scrubErrorMessage("x".repeat(5_000))).toHaveLength(
      ERROR_MESSAGE_MAX_CHARS,
    );
  });
});

describe("describeError", () => {
  test("names the error, which is the field that classifies it", () => {
    expect(describeError(new TypeError("getaddrinfo ENOTFOUND paste.trade"))).toEqual({
      errorName: "TypeError",
      errorMessage: "getaddrinfo ENOTFOUND paste.trade",
    });
    expect(
      describeError(new DOMException("The operation was aborted.", "AbortError")),
    ).toMatchObject({ errorName: "AbortError" });
  });

  test("keeps the message of a non-Error throw instead of stringifying it away", () => {
    // Broker SDKs reject with plain objects carrying a `message`. Falling back
    // to String(error) on those yields the uniquely unhelpful "[object Object]".
    expect(describeError({ message: "qty must be > 0", status: 422 })).toEqual({
      errorName: "object",
      errorMessage: "qty must be > 0",
    });
  });

  test("still describes a throw with no message at all", () => {
    expect(describeError("plain string")).toEqual({
      errorName: "string",
      errorMessage: "plain string",
    });
    expect(describeError({ status: 500 })).toEqual({
      errorName: "object",
      errorMessage: "[object Object]",
    });
  });

  test("scrubs and bounds through the same path as a raw message", () => {
    const described = describeError(
      new Error("postgresql://postgres:hunter2@db.example.com:5432/tradebot is down"),
    );
    expect(described.errorMessage).not.toContain("hunter2");
    expect(describeError(new Error("y".repeat(5_000))).errorMessage).toHaveLength(
      ERROR_MESSAGE_MAX_CHARS,
    );
  });
});
