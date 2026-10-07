/**
 * Unit tests for the copy-mirror consent and staleness guards.
 *
 * Every case here is about refusing to place a leveraged order the follower did
 * not (or no longer does) authorize, so the interesting inputs are the MISSING
 * and AMBIGUOUS ones. Each of those must produce a skip rather than a value that
 * permits an order.
 */

import { describe, expect, it } from "bun:test";
import {
  assessPerpIntentFreshness,
  decideFollowConsent,
  decidePerpMirrorConsent,
  hasExhaustedDeliveryAttempts,
  isDexAbstractionReady,
  requiresDexAbstraction,
  resolvePerpIntentMaxAgeMs,
  DEFAULT_PERP_INTENT_MAX_AGE_MS,
  MIRROR_MAX_DELIVERY_ATTEMPTS,
} from "../copy-mirror-consent";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const MAX_AGE = 15 * 60_000;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

describe("assessPerpIntentFreshness", () => {
  it("accepts a recent source event", () => {
    const result = assessPerpIntentFreshness({
      sourceEventAt: iso(-60_000),
      now: NOW,
      maxAgeMs: MAX_AGE,
    });
    expect(result).toEqual({ fresh: true, ageMs: 60_000 });
  });

  it("accepts an event exactly on the bound and refuses one past it", () => {
    expect(
      assessPerpIntentFreshness({ sourceEventAt: iso(-MAX_AGE), now: NOW, maxAgeMs: MAX_AGE })
        .fresh,
    ).toBe(true);

    const stale = assessPerpIntentFreshness({
      sourceEventAt: iso(-MAX_AGE - 1),
      now: NOW,
      maxAgeMs: MAX_AGE,
    });
    expect(stale).toEqual({ fresh: false, reason: "too-old", ageMs: MAX_AGE + 1 });
  });

  it("refuses an intent with no timestamp instead of treating it as fresh", () => {
    for (const value of [undefined, null, "", "   ", "not-a-date"]) {
      expect(
        assessPerpIntentFreshness({ sourceEventAt: value, now: NOW, maxAgeMs: MAX_AGE }),
      ).toEqual({ fresh: false, reason: "unknown-age", ageMs: null });
    }
  });

  it("tolerates small clock skew but refuses a wildly future timestamp", () => {
    expect(
      assessPerpIntentFreshness({ sourceEventAt: iso(5_000), now: NOW, maxAgeMs: MAX_AGE }),
    ).toEqual({ fresh: true, ageMs: 0 });

    expect(
      assessPerpIntentFreshness({
        sourceEventAt: iso(6 * 60 * 60_000),
        now: NOW,
        maxAgeMs: MAX_AGE,
      }),
    ).toEqual({ fresh: false, reason: "unknown-age", ageMs: null });
  });

  it("refuses everything when the bound itself is unusable", () => {
    expect(
      assessPerpIntentFreshness({ sourceEventAt: iso(-1_000), now: NOW, maxAgeMs: 0 }).fresh,
    ).toBe(false);
    expect(
      assessPerpIntentFreshness({ sourceEventAt: iso(-1_000), now: NOW, maxAgeMs: Number.NaN })
        .fresh,
    ).toBe(false);
  });
});

describe("resolvePerpIntentMaxAgeMs", () => {
  it("defaults when unset", () => {
    expect(resolvePerpIntentMaxAgeMs({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_PERP_INTENT_MAX_AGE_MS,
    );
  });

  it("takes a sane override", () => {
    expect(
      resolvePerpIntentMaxAgeMs({
        COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS: "60000",
      } as NodeJS.ProcessEnv),
    ).toBe(60_000);
  });

  it("falls back to the default rather than disabling the bound", () => {
    for (const raw of ["0", "-1", "abc", "", "999999999999"]) {
      expect(
        resolvePerpIntentMaxAgeMs({
          COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS: raw,
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_PERP_INTENT_MAX_AGE_MS);
    }
  });
});

describe("hasExhaustedDeliveryAttempts", () => {
  it("keeps retrying below the ceiling and gives up at it", () => {
    expect(hasExhaustedDeliveryAttempts(1)).toBe(false);
    expect(hasExhaustedDeliveryAttempts(MIRROR_MAX_DELIVERY_ATTEMPTS - 1)).toBe(false);
    expect(hasExhaustedDeliveryAttempts(MIRROR_MAX_DELIVERY_ATTEMPTS)).toBe(true);
    expect(hasExhaustedDeliveryAttempts(MIRROR_MAX_DELIVERY_ATTEMPTS + 5)).toBe(true);
  });

  it("treats an unreadable attempt count as exhausted", () => {
    expect(hasExhaustedDeliveryAttempts(Number.NaN)).toBe(true);
  });
});

describe("decideFollowConsent", () => {
  const FOLLOW_ID = "44444444-4444-4444-8444-444444444444";
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
  const base = {
    followerUserId: "follower-1",
    followId: FOLLOW_ID,
    credentialId: CREDENTIAL_ID,
  };
  const liveRow = {
    id: FOLLOW_ID,
    followerUserId: "follower-1",
    autoMirror: true,
    credentialId: CREDENTIAL_ID,
  };

  it("proceeds when the live row still authorizes this destination", () => {
    expect(decideFollowConsent({ ...base, follow: liveRow })).toEqual({ action: "proceed" });
  });

  it("stops the order when the follow row is gone (unfollowed)", () => {
    expect(decideFollowConsent({ ...base, follow: null })).toEqual({
      action: "skip",
      reason: "consent-withdrawn",
    });
  });

  it("stops the order when auto-mirror was turned off", () => {
    expect(
      decideFollowConsent({ ...base, follow: { ...liveRow, autoMirror: false } }),
    ).toEqual({ action: "skip", reason: "consent-withdrawn" });
  });

  it("stops the order when the destination account was changed", () => {
    expect(
      decideFollowConsent({
        ...base,
        follow: { ...liveRow, credentialId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toEqual({ action: "skip", reason: "consent-withdrawn" });
  });

  it("stops the order when the follow no longer names a destination", () => {
    expect(
      decideFollowConsent({ ...base, follow: { ...liveRow, credentialId: null } }),
    ).toEqual({ action: "skip", reason: "consent-withdrawn" });
  });

  it("refuses a delivery that carries no follow id, so consent cannot be shown", () => {
    for (const followId of [undefined, null, "", "  "]) {
      expect(decideFollowConsent({ ...base, followId, follow: liveRow })).toEqual({
        action: "skip",
        reason: "consent-unverifiable",
      });
    }
  });

  it("refuses a row that belongs to someone else or to another follow", () => {
    expect(
      decideFollowConsent({ ...base, follow: { ...liveRow, followerUserId: "other" } }),
    ).toEqual({ action: "skip", reason: "consent-unverifiable" });
    expect(
      decideFollowConsent({
        ...base,
        follow: { ...liveRow, id: "55555555-5555-4555-8555-555555555555" },
      }),
    ).toEqual({ action: "skip", reason: "consent-unverifiable" });
  });
});

/**
 * Withdrawing consent stops NEW exposure. It must never abandon exposure the
 * mirror already created: a follower who turns auto-mirror off would otherwise
 * keep the leveraged position the mirror opened, with the reduce-only delivery
 * that exits it skipped and consumed.
 */
describe("decidePerpMirrorConsent", () => {
  const FOLLOW_ID = "44444444-4444-4444-8444-444444444444";
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
  const base = {
    followerUserId: "follower-1",
    followId: FOLLOW_ID,
    credentialId: CREDENTIAL_ID,
  };
  const liveRow = {
    id: FOLLOW_ID,
    followerUserId: "follower-1",
    autoMirror: true,
    credentialId: CREDENTIAL_ID,
  };

  it("applies the full consent check to an OPEN", () => {
    expect(
      decidePerpMirrorConsent({ ...base, reduceOnly: false, follow: liveRow }),
    ).toEqual({ action: "proceed", reduceOnlyExempt: false });
    expect(
      decidePerpMirrorConsent({
        ...base,
        reduceOnly: false,
        follow: { ...liveRow, autoMirror: false },
      }),
    ).toEqual({ action: "skip", reason: "consent-withdrawn" });
  });

  it("lets a CLOSE through after auto-mirror was turned off", () => {
    expect(
      decidePerpMirrorConsent({
        ...base,
        reduceOnly: true,
        follow: { ...liveRow, autoMirror: false },
      }),
    ).toEqual({ action: "proceed", reduceOnlyExempt: true });
  });

  it("lets a CLOSE through after the follow was deleted outright", () => {
    expect(
      decidePerpMirrorConsent({ ...base, reduceOnly: true, follow: null }),
    ).toEqual({ action: "proceed", reduceOnlyExempt: true });
  });

  it("lets a CLOSE through when the follow was re-pointed at another account", () => {
    expect(
      decidePerpMirrorConsent({
        ...base,
        reduceOnly: true,
        follow: { ...liveRow, credentialId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toEqual({ action: "proceed", reduceOnlyExempt: true });
  });

  it("lets a CLOSE through when no follow row can be tied to it at all", () => {
    expect(
      decidePerpMirrorConsent({
        ...base,
        reduceOnly: true,
        followId: undefined,
        follow: undefined,
      }),
    ).toEqual({ action: "proceed", reduceOnlyExempt: true });
  });
});

describe("account-mode guards", () => {
  it("only main-DEX coins skip the account-mode question", () => {
    expect(requiresDexAbstraction("BTC")).toBe(false);
    expect(requiresDexAbstraction("xyz:GOOGL")).toBe(true);
  });

  it("recognizes exactly the modes that can already trade HIP-3", () => {
    expect(isDexAbstractionReady("unifiedAccount")).toBe(true);
    expect(isDexAbstractionReady("portfolioMargin")).toBe(true);
  });

  it("treats a default, unknown or unreadable mode as not ready", () => {
    for (const mode of ["default", "legacy", "", null, undefined]) {
      expect(isDexAbstractionReady(mode)).toBe(false);
    }
  });

  it("does not treat the discontinued dexAbstraction mode as HIP-3 ready: HL's own account-abstraction-modes docs warn 'Cross margin on HIP-3 DEXs does not behave intuitively for DEX abstraction users'", () => {
    expect(isDexAbstractionReady("dexAbstraction")).toBe(false);
  });
});
