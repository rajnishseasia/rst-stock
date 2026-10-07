import { describe, it, expect } from "bun:test";
import {
  checkAlpacaCredentials,
  resolveAlpacaHost,
  ALPACA_LIVE_HOST,
  ALPACA_PAPER_HOST,
} from "../lib/alpaca-credential-check.js";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: any, init?: any) =>
    handler(String(input), init)) as typeof fetch;
}

describe("resolveAlpacaHost", () => {
  it("uses the paper host for PAPER and SIM", () => {
    expect(resolveAlpacaHost({ accountType: "PAPER" })).toBe(ALPACA_PAPER_HOST);
    expect(resolveAlpacaHost({ accountType: "SIM" })).toBe(ALPACA_PAPER_HOST);
  });

  it("uses the live host for LIVE", () => {
    expect(resolveAlpacaHost({ accountType: "LIVE" })).toBe(ALPACA_LIVE_HOST);
  });
});

describe("checkAlpacaCredentials", () => {
  it("accepts valid keys and reports the account number", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const result = await checkAlpacaCredentials(
      { keyId: "PKTEST", secretKey: "shhh", accountType: "PAPER" },
      fakeFetch((url, init) => {
        seenUrl = url;
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(
          JSON.stringify({ account_number: "PA123", status: "ACTIVE" }),
          { status: 200 },
        );
      }),
    );

    expect(result).toEqual({ ok: true, accountNumber: "PA123", status: "ACTIVE" });
    expect(seenUrl).toBe(`${ALPACA_PAPER_HOST}/v2/account`);
    expect(seenHeaders["APCA-API-KEY-ID"]).toBe("PKTEST");
    expect(seenHeaders["APCA-API-SECRET-KEY"]).toBe("shhh");
  });

  it("validates LIVE keys against the live host", async () => {
    let seenUrl = "";
    await checkAlpacaCredentials(
      { keyId: "AKLIVE", secretKey: "shhh", accountType: "LIVE" },
      fakeFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
    );
    expect(seenUrl).toBe(`${ALPACA_LIVE_HOST}/v2/account`);
  });

  it("rejects bad keys with a message that calls out the Paper/Live mismatch", async () => {
    const result = await checkAlpacaCredentials(
      { keyId: "PKBAD", secretKey: "nope", accountType: "PAPER" },
      fakeFetch(() => new Response("unauthorized", { status: 401 })),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Alpaca rejected these API keys");
      expect(result.message).toContain("Paper");
      expect(result.message).toContain("Nothing was saved");
    }
  });

  it("treats 403 like 401 (rejected keys)", async () => {
    const result = await checkAlpacaCredentials(
      { keyId: "AKX", secretKey: "nope", accountType: "LIVE" },
      fakeFetch(() => new Response("forbidden", { status: 403 })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Live");
    }
  });

  it("distinguishes 'Alpaca unreachable' from 'keys rejected'", async () => {
    const result = await checkAlpacaCredentials(
      { keyId: "PKX", secretKey: "shhh", accountType: "PAPER" },
      fakeFetch(() => {
        throw new Error("fetch failed");
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Could not reach Alpaca");
      expect(result.message).not.toContain("rejected");
    }
  });

  it("reports unexpected statuses without claiming the keys are wrong", async () => {
    const result = await checkAlpacaCredentials(
      { keyId: "PKX", secretKey: "shhh", accountType: "PAPER" },
      fakeFetch(() => new Response("oops", { status: 500 })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("HTTP 500");
      expect(result.message).not.toContain("rejected these API keys");
    }
  });

  it("requires a Key ID without calling Alpaca", async () => {
    let called = false;
    const result = await checkAlpacaCredentials(
      { keyId: "  ", secretKey: "shhh", accountType: "PAPER" },
      fakeFetch(() => {
        called = true;
        return new Response("{}", { status: 200 });
      }),
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("API Key ID is required");
    }
  });

  it("requires a Secret Key without calling Alpaca", async () => {
    let called = false;
    const result = await checkAlpacaCredentials(
      { keyId: "PKX", secretKey: "", accountType: "PAPER" },
      fakeFetch(() => {
        called = true;
        return new Response("{}", { status: 200 });
      }),
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each(["not json", "null", "[]", "{}", '{"account_number":123}', '{"account_number":"  "}'])("refuses an unidentified 200 response: %s", async (body) => {
    const result = await checkAlpacaCredentials(
      { keyId: "PKX", secretKey: "shhh", accountType: "PAPER" },
      fakeFetch(() => new Response(body, { status: 200 })),
    );
    expect(result.ok).toBe(false);
  });
});
