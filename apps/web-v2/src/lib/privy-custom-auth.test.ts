import { afterEach, describe, expect, test } from "bun:test";

import {
  bindBetterAuthUserId,
  clearBetterAuthJwtCache,
  fetchBetterAuthJwt,
  getPrivyCustomAuthSubject,
  getBetterAuthTokenUrl,
  isPrivyCustomAuthEnabled,
  parseBetterAuthTokenResponse,
} from "./privy-custom-auth";

const originalFetch = globalThis.fetch;

function mockFetch(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  globalThis.fetch = implementation as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearBetterAuthJwtCache();
  bindBetterAuthUserId(undefined);
});

function fakeJwt(sub: string, exp = Math.floor(Date.now() / 1000) + 900): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp, sub })}.signature`;
}

describe("isPrivyCustomAuthEnabled", () => {
  test("defaults on in production when Privy is configured", () => {
    expect(isPrivyCustomAuthEnabled("app_123", undefined, "production")).toBe(
      true,
    );
  });

  test("off without a Privy app id (perps not configured at all)", () => {
    expect(isPrivyCustomAuthEnabled(undefined, "true", "production")).toBe(false);
    expect(isPrivyCustomAuthEnabled("", "true", "production")).toBe(false);
  });

  test("stays off by default outside production", () => {
    expect(isPrivyCustomAuthEnabled("app_123", undefined, "development")).toBe(
      false,
    );
    expect(isPrivyCustomAuthEnabled("app_123", undefined, "test")).toBe(false);
  });

  test("supports explicit enable and rollback values", () => {
    expect(isPrivyCustomAuthEnabled("app_123", "true", "development")).toBe(true);
    expect(isPrivyCustomAuthEnabled("app_123", "false", "production")).toBe(false);
    expect(isPrivyCustomAuthEnabled("app_123", "", "production")).toBe(false);
    expect(isPrivyCustomAuthEnabled("app_123", "1", "production")).toBe(false);
    expect(isPrivyCustomAuthEnabled("app_123", "TRUE", "production")).toBe(false);
  });
});

describe("getPrivyCustomAuthSubject", () => {
  test("reads customUserId from the custom_auth linked account", () => {
    const user = {
      linkedAccounts: [
        { type: "wallet", address: "0xabc" },
        { type: "custom_auth", customUserId: "better-auth-user-1" },
      ],
    };
    expect(getPrivyCustomAuthSubject(user)).toBe("better-auth-user-1");
  });

  test("undefined when there is no custom_auth account (legacy modal session)", () => {
    expect(
      getPrivyCustomAuthSubject({ linkedAccounts: [{ type: "wallet" }] }),
    ).toBeUndefined();
    expect(getPrivyCustomAuthSubject({ linkedAccounts: [] })).toBeUndefined();
  });

  test("undefined for missing/loading users and malformed subjects", () => {
    expect(getPrivyCustomAuthSubject(null)).toBeUndefined();
    expect(getPrivyCustomAuthSubject(undefined)).toBeUndefined();
    expect(getPrivyCustomAuthSubject({})).toBeUndefined();
    expect(
      getPrivyCustomAuthSubject({
        linkedAccounts: [{ type: "custom_auth", customUserId: "" }],
      }),
    ).toBeUndefined();
    expect(
      getPrivyCustomAuthSubject({
        linkedAccounts: [{ type: "custom_auth", customUserId: 42 }],
      }),
    ).toBeUndefined();
  });
});

describe("parseBetterAuthTokenResponse", () => {
  test("returns the token string from a well-formed body", () => {
    expect(parseBetterAuthTokenResponse({ token: "eyJhbGciOi.abc.def" })).toBe(
      "eyJhbGciOi.abc.def",
    );
  });

  test("returns undefined for malformed payloads instead of throwing", () => {
    expect(parseBetterAuthTokenResponse(null)).toBeUndefined();
    expect(parseBetterAuthTokenResponse(undefined)).toBeUndefined();
    expect(parseBetterAuthTokenResponse("token")).toBeUndefined();
    expect(parseBetterAuthTokenResponse(42)).toBeUndefined();
    expect(parseBetterAuthTokenResponse({})).toBeUndefined();
    expect(parseBetterAuthTokenResponse({ token: "" })).toBeUndefined();
    expect(parseBetterAuthTokenResponse({ token: 123 })).toBeUndefined();
  });
});

describe("getBetterAuthTokenUrl", () => {
  test("uses the app origin for browser-side requests", () => {
    expect(getBetterAuthTokenUrl("https://www.readysettrade.app")).toBe(
      "https://www.readysettrade.app/api/auth/token",
    );
  });

  test("falls back to the relative rewrite path outside the browser", () => {
    expect(getBetterAuthTokenUrl()).toBe("/api/auth/token");
    expect(getBetterAuthTokenUrl("not a URL")).toBe("/api/auth/token");
  });
});

describe("fetchBetterAuthJwt", () => {
  test("does not reuse a cached token after the session signs out", async () => {
    const userAToken = fakeJwt("user-a");
    const userBToken = fakeJwt("user-b");
    let attempts = 0;
    mockFetch(async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ token: attempts === 1 ? userAToken : userBToken }),
        { status: 200 },
      );
    });

    bindBetterAuthUserId("user-a");
    await expect(fetchBetterAuthJwt()).resolves.toBe(userAToken);

    // The session hook can report signed-out before Privy has finished
    // resynchronizing its own session. The old user's fresh JWT must not be
    // returned during that window.
    bindBetterAuthUserId(undefined);
    await expect(fetchBetterAuthJwt()).resolves.toBeUndefined();

    bindBetterAuthUserId("user-b");
    await expect(fetchBetterAuthJwt()).resolves.toBe(userBToken);
    expect(attempts).toBe(3);
  });

  test("does not repopulate the cache with a response racing sign-out", async () => {
    const userAToken = fakeJwt("user-a");
    const userBToken = fakeJwt("user-b");
    let resolveResponse!: (response: Response) => void;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    bindBetterAuthUserId("user-a");
    const pending = fetchBetterAuthJwt();
    bindBetterAuthUserId(undefined);
    resolveResponse(new Response(JSON.stringify({ token: userAToken }), { status: 200 }));
    await expect(pending).resolves.toBeUndefined();

    let attempts = 0;
    bindBetterAuthUserId("user-b");
    mockFetch(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ token: userBToken }), { status: 200 });
    });
    await expect(fetchBetterAuthJwt()).resolves.toBe(userBToken);
    expect(attempts).toBe(1);
  });

  test("includes the session cookie and disables token caching", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const token = fakeJwt("test-user");
    bindBetterAuthUserId("test-user");
    mockFetch(async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(fetchBetterAuthJwt()).resolves.toBe(token);
    expect(request?.input).toBe("/api/auth/token");
    expect(request?.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  test("retries transient failures but not unauthorized sessions", async () => {
    let attempts = 0;
    const token = fakeJwt("retry-user");
    bindBetterAuthUserId("retry-user");
    mockFetch(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : new Response(JSON.stringify({ token }), {
            status: 200,
          });
    });

    await expect(fetchBetterAuthJwt()).resolves.toBe(token);
    expect(attempts).toBe(2);

    attempts = 0;
    clearBetterAuthJwtCache();
    mockFetch(async () => {
      attempts += 1;
      return new Response(null, { status: 401 });
    });

    await expect(fetchBetterAuthJwt()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });

  test("returns undefined for malformed success responses", async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(fetchBetterAuthJwt()).resolves.toBeUndefined();
  });
});
