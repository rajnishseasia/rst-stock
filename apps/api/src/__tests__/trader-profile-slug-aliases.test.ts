/**
 * A public profile URL has to survive the several forms a link can be in.
 *
 * A trader whose X handle is on their own profile went to /lb/users/<handle>
 * and got "this profile is unavailable": the canonical slug is derived from the
 * identity, and the identity reports no handle whenever the linked-account row
 * is not visible, so the handle stored on the user row stopped resolving. These
 * tests pin every form that must resolve, and the line that must not be crossed:
 * a slug is never a follow key.
 */

import { describe, it, expect } from "bun:test";

import {
  anonymizeTrader,
  normalizeTraderSlug,
  traderKey,
  traderProfileSlug,
  traderProfileSlugAliases,
} from "../lib/trader-identity.js";

const userId = "user-abc";
const linked = {
  twitterLinked: true,
  name: "SOL Decoder",
  twitterName: "SOL Decoder",
  username: "SOL_Decoder",
  image: null,
};

describe("traderProfileSlugAliases", () => {
  it("resolves the X handle a trader knows themselves by, in any casing", () => {
    const aliases = traderProfileSlugAliases(userId, linked);
    expect(aliases).toContain(normalizeTraderSlug("SOL_Decoder"));
    expect(aliases).toContain(normalizeTraderSlug("@sol_decoder"));
  });

  it("still resolves the handle when the linked-account row did not come back", () => {
    // This is the exact failure the page reported: users.username holds the
    // handle, but twitterLinked is false, so the derived identity (and with it
    // the canonical slug) falls back to the pseudonym.
    const unlinked = { ...linked, twitterLinked: false };
    expect(traderProfileSlug(userId, null)).toBe(anonymizeTrader(userId).traderName);
    expect(traderProfileSlugAliases(userId, unlinked)).toContain(
      normalizeTraderSlug("SOL_Decoder"),
    );
  });

  it("keeps a pseudonym-era link working after the trader links X", () => {
    expect(traderProfileSlugAliases(userId, linked)).toContain(
      normalizeTraderSlug(anonymizeTrader(userId).traderName),
    );
  });

  it("keeps already-shared /lb/users/<traderKey> links working", () => {
    expect(traderProfileSlugAliases(userId, linked)).toContain(traderKey(userId));
  });

  it("includes the canonical slug, which the page redirects to", () => {
    expect(traderProfileSlugAliases(userId, linked)).toContain(
      normalizeTraderSlug(traderProfileSlug(userId, "SOL_Decoder")),
    );
  });

  it("has no aliases beyond the pseudonym and hash for an unlinked trader", () => {
    const anonymous = { twitterLinked: false, name: null, twitterName: null, username: null };
    expect(traderProfileSlugAliases(userId, anonymous).sort()).toEqual(
      [traderKey(userId), normalizeTraderSlug(anonymizeTrader(userId).traderName)].sort(),
    );
  });

  it("never returns a follow key by another name: the hash is one entry, not the slug", () => {
    // traderKey is collision-resistant and gates auto-mirror. The readable slug
    // is not, and must never be substituted for it. Pinning that they differ.
    const aliases = traderProfileSlugAliases(userId, linked);
    expect(traderProfileSlug(userId, "SOL_Decoder")).not.toBe(traderKey(userId));
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("normalizes slugs with internal spaces to match their space-stripped canonical slug", () => {
    expect(normalizeTraderSlug("Stoic Heron 724")).toBe("stoicheron724");
    expect(normalizeTraderSlug("Stoic%20Heron%20724")).toBe("stoic%20heron%20724");
  });
});
