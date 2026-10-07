/**
 * A PARTIAL mirrored close must NOT retire the follower's stop.
 *
 * The first implementation cancelled the legs on any placed close. That is wrong
 * for the ordinary case, not an exotic one, because a mirrored close is partial
 * by design in two separate ways:
 *
 *  1. THE SOURCE SCALES OUT. `decidePerpReduceOnlyMirror` sizes a close
 *     proportionally (`proportionalDecimal(sourceSize, mirroredExposure,
 *     sourcePositionSize)`), so a trader selling half their position produces a
 *     close for half of the follower's mirrored exposure. Any trader who scales
 *     out generates a run of partial closes.
 *
 *  2. THE ATTRIBUTION CEILING. A copied close may only ever reduce the part the
 *     mirror opened: `min(mirroredExposure, position.size)`. A follower holding
 *     10 SOL of which the mirror opened 4 gets a close for 4 even when the
 *     source closes in full.
 *
 * In both cases exposure survives the close. Cancelling the stop there removes
 * protection from a live leveraged position, which is the exact risk the
 * follower configured the stop to bound, and it is strictly worse than the
 * baseline: before this feature they had no stop, after it they had one right up
 * until the moment part of their position was left uncovered.
 *
 * The rule this pins: retire the legs only when the close takes the whole
 * attributed exposure. Otherwise leave them resting over what remains.
 */
import { describe, expect, it } from "bun:test";

import { perpProtectionRetiresOnClose } from "../copy-mirror-perp-protection";

describe("perpProtectionRetiresOnClose", () => {
  it("retires the legs when the close takes the whole mirrored exposure", () => {
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4",
        mirroredExposureSizeDecimal: "4",
      }),
    ).toBe(true);
  });

  it("keeps the legs when the source only scaled out of part of the position", () => {
    // Source sold half. The mirror closes half. Half the follower's mirrored
    // exposure is still open and still wants the stop it was given.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "2",
        mirroredExposureSizeDecimal: "4",
      }),
    ).toBe(false);
  });

  it("keeps the legs when the attribution ceiling clamped the close", () => {
    // The follower holds more than the mirror opened. Even a full source close
    // only retires the mirror's share, so this is the same partial case wearing
    // different clothes.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4",
        mirroredExposureSizeDecimal: "10",
      }),
    ).toBe(false);
  });

  it("retires on a close that exceeds the recorded exposure rather than leaving legs stranded", () => {
    // Defensive: if the recorded exposure has drifted below what was actually
    // closed, the position is gone. Leaving triggers resting over nothing is the
    // hazard the cancel path exists for.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "6",
        mirroredExposureSizeDecimal: "4",
      }),
    ).toBe(true);
  });

  it("compares at a common scale instead of by string equality", () => {
    // "4.0000" and "4" are the same size. A string compare would call this
    // partial and leave the legs resting over a closed position.
    //
    // A COMMON scale, not the coin's. This took a `sizeDecimals` it never read
    // and claimed to compare at it; the two are not the same test, and the
    // exact one is the safer of the pair. See the test below.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4.0000",
        mirroredExposureSizeDecimal: "4",
      }),
    ).toBe(true);
  });

  it("keeps the legs when a residue survives below the coin's own precision", () => {
    // The reading the unused `sizeDecimals` would have licensed: truncate both
    // operands to the coin's size precision, and 4.005 closed by 4.00 reads as
    // a full close. It is not one. Retiring strips a stop off whatever is left,
    // and this module's whole bias is that an unretired leg is an annoyance
    // while an unprotected leveraged position is a loss.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4.00",
        mirroredExposureSizeDecimal: "4.005",
      }),
    ).toBe(false);
  });

  it("keeps the legs when the exposure cannot be read, rather than guessing", () => {
    // Unknown is not "fully closed". Cancelling on an unreadable exposure would
    // strip a stop from a position that may be entirely intact.
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4",
        mirroredExposureSizeDecimal: undefined,
      }),
    ).toBe(false);
    expect(
      perpProtectionRetiresOnClose({
        closeSizeCoin: "4",
        mirroredExposureSizeDecimal: "not-a-number",
      }),
    ).toBe(false);
  });
});
