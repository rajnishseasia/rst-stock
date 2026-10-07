import { describe, expect, it } from "bun:test";

import {
  buildFailsafeCloseCandidate,
  deriveFailsafeExposures,
  matchingPosition,
  type FailsafeHistoryRow,
} from "../copy-mirror-position-failsafe";

const source = "0x1111111111111111111111111111111111111111";
const follower = "0x2222222222222222222222222222222222222222";

function row(overrides: Partial<FailsafeHistoryRow> = {}): FailsafeHistoryRow {
  return {
    followerUserId: "follower-1",
    followerWallet: follower,
    credentialId: "credential-1",
    venueNetwork: "mainnet",
    coin: "ZEC",
    direction: "long",
    reduceOnly: false,
    executedSizeDecimal: "3.45",
    clientOrderId: "copymirror:follower-1:user:open-1",
    candidate: {
      followerUserId: "follower-1",
      followId: "follow-1",
      credentialId: "credential-1",
      sourceItemId: "user:open-1",
      symbol: "ZEC",
      side: "buy",
      sizingMode: "usd",
      sizingValue: 100,
      assetType: "PERP",
      sourceOrderId: "source-order-1",
      copySourceLabel: "SOL Decoder",
    },
    ...overrides,
  };
}

describe("copy mirror position failsafe", () => {
  it("finds the remaining exposure and binds it to exact opening orders", () => {
    const exposures = deriveFailsafeExposures(
      [
        row(),
        row({
          direction: "short",
          reduceOnly: true,
          executedSizeDecimal: "1.00",
          clientOrderId: "copymirror:follower-1:user:partial-close",
          candidate: {
            ...row().candidate,
            sourceItemId: "user:partial-close",
            mirroredExposureClientOrderIds: [
              "copymirror:follower-1:user:open-1",
            ],
          },
        }),
      ],
      new Map([["source-order-1", source]]),
    );
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({
      followerWallet: follower,
      sourceWallet: source,
      coin: "ZEC",
      side: "long",
      size: "2.45",
      openingClientOrderIds: ["copymirror:follower-1:user:open-1"],
    });
  });

  it("does not report exposure after the mirror is fully closed", () => {
    expect(
      deriveFailsafeExposures(
        [
          row(),
          row({
            direction: "short",
            reduceOnly: true,
            executedSizeDecimal: "3.45",
            candidate: {
              ...row().candidate,
              mirroredExposureClientOrderIds: [
                "copymirror:follower-1:user:open-1",
              ],
            },
          }),
        ],
        new Map([["source-order-1", source]]),
      ),
    ).toEqual([]);
  });

  it("fails closed when source or follower wallet attribution is missing", () => {
    expect(deriveFailsafeExposures([row()], new Map())).toEqual([]);
    expect(
      deriveFailsafeExposures(
        [row({ followerWallet: "" })],
        new Map([["source-order-1", source]]),
      ),
    ).toEqual([]);
  });

  it("requires the same coin and direction in a venue snapshot", () => {
    const positions = [{ coin: "ZEC", side: "short" as const }] as never[];
    expect(matchingPosition(positions, "ZEC", "long")).toBeNull();
    expect(matchingPosition(positions, "ZEC", "short")).not.toBeNull();
  });

  it("builds an executable close and groups followers under one recovery identity", () => {
    const exposure = deriveFailsafeExposures(
      [row()],
      new Map([["source-order-1", source]]),
    )[0]!;
    const candidate = buildFailsafeCloseCandidate(
      exposure,
      "2026-09-08T05:52:00.000Z",
    );

    const siblingCandidate = buildFailsafeCloseCandidate(
      {
        ...exposure,
        followerUserId: "follower-2",
        followerWallet: "0x3333333333333333333333333333333333333333",
        exposureKey: "different-follower-exposure",
      },
      "2026-09-08T05:52:00.000Z",
    );

    expect(candidate).toMatchObject({
      sourceQtyDecimal: "3.45",
      sourcePositionSizeDecimal: "3.45",
      mirroredExposureSizeDecimal: "3.45",
      perpReduceOnly: true,
      side: "sell",
      perpSide: "short",
    });
    expect(candidate.sourceItemId).toStartWith("failsafe:v3:");
    expect(siblingCandidate.sourceItemId).toBe(candidate.sourceItemId);
  });
});
