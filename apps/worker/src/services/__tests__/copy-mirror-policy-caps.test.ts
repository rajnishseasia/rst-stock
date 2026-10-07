import { describe, expect, it } from "bun:test";

import {
  CopyMirrorPoller,
  mirrorCoinCapAllows,
  netReservedMirroredEquityQty,
  resolveEffectiveMirrorCap,
} from "../copy-mirror";

describe("copy-mirror execution-time caps", () => {
  it("uses the tighter staged/current cap and treats null as unlimited", () => {
    expect(resolveEffectiveMirrorCap(100, "40.00")).toEqual({ ok: true, value: 40 });
    expect(resolveEffectiveMirrorCap(40, null)).toEqual({ ok: true, value: 40 });
    expect(resolveEffectiveMirrorCap(null, "40.00")).toEqual({ ok: true, value: 40 });
  });

  it("fails closed when a persisted current cap is malformed", () => {
    expect(resolveEffectiveMirrorCap(100, "not-a-number")).toEqual({ ok: false });
    expect(resolveEffectiveMirrorCap(100, "0")).toEqual({ ok: false });
  });

  it("counts filled exposure plus requested open reservations", () => {
    expect(netReservedMirroredEquityQty([
      {
        tradeAction: "Buy",
        status: "FILLED",
        quantity: 7,
        executedQuantity: 5,
      },
      {
        tradeAction: "Buy",
        status: "PENDING",
        quantity: 3,
        executedQuantity: 0,
      },
      {
        tradeAction: "Sell",
        status: "PENDING",
        quantity: 5,
        executedQuantity: 0,
      },
    ])).toBe(8);
  });

  it("rejects a concurrent reservation once current plus reserved reaches the cap", () => {
    expect(mirrorCoinCapAllows({ currentExposure: 8, requestedExposure: 2, maxCoinSize: 10 })).toBe(true);
    expect(mirrorCoinCapAllows({ currentExposure: 8, requestedExposure: 3, maxCoinSize: 10 })).toBe(false);
  });

  it("nets reduce-only closes by their stored side and scopes exposure to the destination", async () => {
    const db = {
      query: {
        orders: {
          findMany: async () => [
            {
              id: "long-open",
              brokerAccountId: "target-wallet",
              brokerCredentialId: "target-credential",
              reduceOnly: false,
              direction: "long",
              status: "FILLED",
              quantityDecimal: "1",
              executedSizeDecimal: "1",
            },
            {
              id: "long-close",
              brokerAccountId: "target-wallet",
              brokerCredentialId: "target-credential",
              reduceOnly: true,
              direction: "short",
              status: "FILLED",
              quantityDecimal: null,
              executedSizeDecimal: "0.25",
            },
            {
              id: "short-open",
              brokerAccountId: "target-wallet",
              brokerCredentialId: "target-credential",
              reduceOnly: false,
              direction: "short",
              status: "FILLED",
              quantityDecimal: "2",
              executedSizeDecimal: "2",
            },
            {
              id: "short-close",
              brokerAccountId: "target-wallet",
              brokerCredentialId: "target-credential",
              reduceOnly: true,
              direction: "long",
              status: "FILLED",
              quantityDecimal: null,
              executedSizeDecimal: "0.5",
            },
            {
              id: "other-destination",
              brokerAccountId: "other-wallet",
              brokerCredentialId: "other-credential",
              reduceOnly: false,
              direction: "long",
              status: "FILLED",
              quantityDecimal: "100",
              executedSizeDecimal: "100",
            },
          ],
        },
      },
    };
    const poller = new CopyMirrorPoller(db as never);

    const result = await (poller as any).checkPerpCoinCap({
      followerUserId: "follower",
      symbol: "BTC",
      brokerAccountId: "target-wallet",
      brokerCredentialId: "target-credential",
      requestedSizeCoin: "0.75",
      maxCoinSize: 1.5,
    }, db);

    // Target exposure is -0.75 (1 - .25 - 2 + .5), so a .75 open exactly
    // reaches the 1.5 cap. The opposite-side reduce-only close must add back
    // exposure; treating every close as short would reject this valid boundary.
    expect(result).toBe("allowed");
  });
});
