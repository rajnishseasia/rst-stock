/**
 * Preflight gates, with one question in focus: which refusals may CONSUME a
 * reduce-only close?
 *
 * A skip outcome completes the delivery, and a close is a one-shot instruction.
 * Consuming one strands the follower in a leveraged position with the single
 * order that would have exited it already spent. So config refusals, which a
 * person can lift, must hold the close; data faults, which never become true
 * later, must still consume it or the queue wedges forever.
 */

import { describe, expect, it } from "bun:test";

import { networkFromEnv } from "@trade-bot/hyperliquid";

import {
  assessPerpMirrorPreflight,
  type PerpMirrorPreflightInput,
} from "../copy-mirror-perp-preflight";

const BASE: PerpMirrorPreflightInput = {
  cand: {
    followerUserId: "follower-1",
    sourceItemId: "user:close-1",
    symbol: "BTC",
    side: "sell",
    sizingMode: "usd",
    sizingValue: 100,
    assetType: "PERP",
    perpSide: "short",
    perpReduceOnly: true,
    // A PROVEN network is required now, so the baseline candidate carries the
    // one this process is configured for. Omitting it is its own refusal, which
    // the cases below cover.
    sourceVenueNetwork: networkFromEnv(),
  } as never,
  existing: undefined,
  perpsEnabled: true,
  networkExplicit: true,
  isMainnet: false,
  mainnetAllowed: true,
  liveAllowed: true,
  now: new Date("2026-08-10T12:00:00.000Z"),
};

// An OPEN also has to clear the staleness bound, which closes are exempt from,
// so it needs a source timestamp the close fixture deliberately does without.
const asOpen = (input: PerpMirrorPreflightInput): PerpMirrorPreflightInput => ({
  ...input,
  cand: {
    ...input.cand,
    perpReduceOnly: false,
    side: "buy",
    perpSide: "long",
    sourceEventAt: input.now.toISOString(),
  } as never,
});

describe("perp preflight: config refusals must not consume a close", () => {
  const configRefusals: ReadonlyArray<[string, Partial<PerpMirrorPreflightInput>]> = [
    ["perps switched off", { perpsEnabled: false }],
    ["network left unset", { networkExplicit: false }],
    ["mainnet opt-in withdrawn", { isMainnet: true, mainnetAllowed: false }],
    ["live opt-in withdrawn", { isMainnet: true, mainnetAllowed: true, liveAllowed: false }],
  ];

  for (const [label, patch] of configRefusals) {
    it(`defers a reduce-only close when the ${label}`, () => {
      const result = assessPerpMirrorPreflight({ ...BASE, ...patch });
      expect(result.action).toBe("defer");
    });

    it(`still skips an OPEN when the ${label}`, () => {
      // Withdrawing config must stop new exposure. That half is unchanged.
      const result = assessPerpMirrorPreflight({ ...asOpen(BASE), ...patch });
      expect(result.action).toBe("skip");
    });
  }

  it("reads reduce-only off the stored row when a PENDING order is resuming", () => {
    // A resume trusts the persisted row over the candidate, because the row is
    // what actually reached the venue.
    const result = assessPerpMirrorPreflight({
      ...BASE,
      cand: { ...BASE.cand, perpReduceOnly: false } as never,
      existing: { status: "PENDING", reduceOnly: true },
      perpsEnabled: false,
    });
    expect(result.action).toBe("defer");
  });
});

describe("perp preflight: a candidate staged on another network", () => {
  it("defers a close whose source network is not the active one", () => {
    // A delivery is durable and can be executed after the deployment moved
    // networks. With no order row inserted yet there is nothing for the resume
    // guard to compare, so the client and the row would both be built from
    // whatever is configured now, and the close could be consumed against the
    // wrong chain while the exposure it was meant to exit stays open.
    const previous = process.env.HYPERLIQUID_NETWORK;
    process.env.HYPERLIQUID_NETWORK = "mainnet";
    try {
      const result = assessPerpMirrorPreflight({
        ...BASE,
        cand: { ...BASE.cand, sourceVenueNetwork: "testnet" } as never,
      });
      expect(result).toMatchObject({ action: "defer", outcome: "perp-network-mismatch" });
    } finally {
      if (previous === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previous;
    }
  });

  it("skips an OPEN in the same situation", () => {
    const previous = process.env.HYPERLIQUID_NETWORK;
    process.env.HYPERLIQUID_NETWORK = "mainnet";
    try {
      const result = assessPerpMirrorPreflight({
        ...asOpen(BASE),
        cand: { ...asOpen(BASE).cand, sourceVenueNetwork: "testnet" } as never,
      });
      expect(result).toMatchObject({ action: "skip", outcome: "perp-network-mismatch" });
    } finally {
      if (previous === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previous;
    }
  });

  it("lets a candidate with NO recorded network through, deliberately", () => {
    // A pre-migration source order has venueNetwork NULL and its synthetic fill
    // child preserves it, so the candidate omits the field. Requiring proof here
    // would refuse every such mirror and defer their closes indefinitely, to
    // defend against a mismatch that only arises after an operator switches
    // networks. Unlike the exposure queries, this does not feed a number that
    // sizes an order, so absence is tolerated and the residual is covered by the
    // deployment rule about draining before a switch.
    const result = assessPerpMirrorPreflight({
      ...BASE,
      cand: { ...BASE.cand, sourceVenueNetwork: undefined } as never,
    });
    expect(result.action).toBe("proceed");
  });
});

describe("perp preflight: data faults still consume a close", () => {
  it("skips a non-canonical coin even for a close", () => {
    // Holding this would wedge the delivery queue on a symbol that will never
    // resolve. It is not a configuration anyone can change back.
    const result = assessPerpMirrorPreflight({
      ...BASE,
      cand: { ...BASE.cand, symbol: "BTC-PERP" } as never,
    });
    expect(result).toEqual({ action: "skip", outcome: "unsupported-perp-coin" });
  });

  it("skips a close with no resolved side", () => {
    const result = assessPerpMirrorPreflight({
      ...BASE,
      cand: { ...BASE.cand, perpSide: null } as never,
    });
    expect(result).toEqual({ action: "skip", outcome: "no-qty" });
  });
});

describe("perp preflight: the happy path is untouched", () => {
  it("proceeds and reports the intent", () => {
    expect(assessPerpMirrorPreflight(BASE)).toEqual({
      action: "proceed",
      perpSide: "short",
      isReduceOnlyIntent: true,
    });
    expect(assessPerpMirrorPreflight(asOpen(BASE))).toEqual({
      action: "proceed",
      perpSide: "long",
      isReduceOnlyIntent: false,
    });
  });
});
