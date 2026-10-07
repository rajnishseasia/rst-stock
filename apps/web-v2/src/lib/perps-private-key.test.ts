import { describe, expect, test } from "bun:test";

import {
  isValidPrivateKey,
  normalizeImportedPrivateKey,
} from "./perps-private-key";

// A throwaway 32-byte hex key. Never a real secret. 64 hex chars.
const KEY64 = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("isValidPrivateKey", () => {
  test("accepts a bare 64-char hex key (no 0x prefix)", () => {
    // Regression: the old regex required a leading '0', so a bare key that did
    // not start with 0 was wrongly rejected.
    expect(isValidPrivateKey(KEY64)).toBe(true);
    expect(isValidPrivateKey("ffffffffffffffffffffffffffffffff" + "ffffffffffffffffffffffffffffffff")).toBe(true);
  });

  test("accepts a 0x-prefixed 64-char hex key", () => {
    expect(isValidPrivateKey(`0x${KEY64}`)).toBe(true);
  });

  test("accepts uppercase / mixed-case hex", () => {
    expect(isValidPrivateKey(KEY64.toUpperCase())).toBe(true);
    expect(isValidPrivateKey(`0X${KEY64}`)).toBe(false); // uppercase 0X prefix is not accepted
  });

  test("trims surrounding whitespace before validating", () => {
    expect(isValidPrivateKey(`  0x${KEY64}\n`)).toBe(true);
    expect(isValidPrivateKey(`\t${KEY64} `)).toBe(true);
  });

  test("rejects a too-short (63) or too-long (65) hex string", () => {
    expect(isValidPrivateKey(KEY64.slice(0, 63))).toBe(false);
    expect(isValidPrivateKey(`${KEY64}a`)).toBe(false);
    // Regression: a lone leading '0' + 64 hex (65 chars, no real 0x) must fail.
    expect(isValidPrivateKey(`0${KEY64}`)).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(isValidPrivateKey(`0x${KEY64.slice(0, 63)}z`)).toBe(false);
    expect(isValidPrivateKey("not-a-key")).toBe(false);
    expect(isValidPrivateKey("")).toBe(false);
  });
});

describe("normalizeImportedPrivateKey", () => {
  test("prefixes a bare key with 0x", () => {
    const matchesExpectedKey = normalizeImportedPrivateKey(KEY64) === `0x${KEY64}`;
    expect(matchesExpectedKey).toBe(true);
  });

  test("leaves an already-0x-prefixed key intact", () => {
    const matchesExpectedKey =
      normalizeImportedPrivateKey(`0x${KEY64}`) === `0x${KEY64}`;
    expect(matchesExpectedKey).toBe(true);
  });

  test("trims whitespace, then normalizes", () => {
    const matchesExpectedKey =
      normalizeImportedPrivateKey(`  ${KEY64}\n`) === `0x${KEY64}`;
    expect(matchesExpectedKey).toBe(true);
  });

  test("throws a user-facing error on an invalid key", () => {
    expect(() => normalizeImportedPrivateKey("nope")).toThrow(
      /valid 32-byte hex private key/,
    );
    expect(() => normalizeImportedPrivateKey(KEY64.slice(0, 10))).toThrow(
      /valid 32-byte hex private key/,
    );
  });
});
