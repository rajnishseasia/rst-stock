/**
 * Better Auth JWT plugin wiring for Privy custom auth (perps).
 *
 * Tests the REAL modules: the pure options builder and the real better-auth
 * `jwt()` plugin instantiated with those options, asserting the endpoints the
 * web client / Privy dashboard depend on actually exist on the plugin.
 */

import { describe, expect, test } from "bun:test";
import { jwt } from "better-auth/plugins/jwt";
import {
  buildPerpsJwtOptions,
  PERPS_JWT_EXPIRATION,
} from "../lib/auth/jwt-options.js";

const BASE_URL = "https://app.example.com";

describe("buildPerpsJwtOptions", () => {
  test("uses ES256 keys (Privy custom auth rejects the EdDSA default)", () => {
    const options = buildPerpsJwtOptions(BASE_URL);
    expect(options.jwks?.keyPairConfig).toEqual({ alg: "ES256" });
  });

  test("issuer and audience are the Better Auth baseURL", () => {
    const options = buildPerpsJwtOptions(BASE_URL);
    expect(options.jwt?.issuer).toBe(BASE_URL);
    expect(options.jwt?.audience).toBe(BASE_URL);
    expect(options.jwt?.expirationTime).toBe(PERPS_JWT_EXPIRATION);
  });

  test("L1: a comma-separated WEB_URL list yields the FIRST origin as iss/aud", () => {
    const options = buildPerpsJwtOptions(
      "https://app.example.com, https://staging.example.com,https://other.example.com",
    );
    expect(options.jwt?.issuer).toBe("https://app.example.com");
    expect(options.jwt?.audience).toBe("https://app.example.com");
  });

  test("L3: the JWT payload is EMPTY (no session-user PII baked into tokens)", async () => {
    const options = buildPerpsJwtOptions(BASE_URL);
    const definePayload = options.jwt?.definePayload;
    expect(definePayload).toBeDefined();
    const payload = await definePayload!({
      user: {
        id: "user_123",
        email: "pii@example.com",
        name: "P. I. Individual",
        image: "https://example.com/pii.png",
      },
      session: { id: "session_456" },
    } as never);
    expect(payload).toEqual({});
  });

  test("JWT subject is the Better Auth userId", async () => {
    const options = buildPerpsJwtOptions(BASE_URL);
    const getSubject = options.jwt?.getSubject;
    expect(getSubject).toBeDefined();
    const subject = await getSubject!({
      user: { id: "user_123" },
      session: { id: "session_456" },
    } as never);
    expect(subject).toBe("user_123");
  });

  test("keeps existing session responses untouched (no set-auth-jwt header)", () => {
    expect(buildPerpsJwtOptions(BASE_URL).disableSettingJwtHeader).toBe(true);
  });
});

describe("jwt plugin instantiated with the perps options", () => {
  const plugin = jwt(buildPerpsJwtOptions(BASE_URL));

  test("registers as the better-auth jwt plugin", () => {
    expect(plugin.id).toBe("jwt");
  });

  test("exposes the /token endpoint (short-lived JWT for the session)", () => {
    expect(plugin.endpoints.getToken).toBeDefined();
    expect(plugin.endpoints.getToken.path).toBe("/token");
    expect(plugin.endpoints.getToken.options.method).toBe("GET");
  });

  test("exposes the /jwks endpoint (public keys for Privy verification)", () => {
    expect(plugin.endpoints.getJwks).toBeDefined();
    expect(plugin.endpoints.getJwks.path).toBe("/jwks");
    expect(plugin.endpoints.getJwks.options.method).toBe("GET");
  });

  test("declares the jwks model so the drizzle adapter maps our jwks table", () => {
    expect(plugin.schema?.jwks).toBeDefined();
    expect(Object.keys(plugin.schema!.jwks.fields)).toEqual(
      expect.arrayContaining(["publicKey", "privateKey", "createdAt", "expiresAt"]),
    );
  });
});
