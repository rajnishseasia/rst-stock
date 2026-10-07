import { describe, it, expect } from "bun:test";
import { mapAlpacaStatus } from "../order-sync.js";

describe("mapAlpacaStatus", () => {
  it("maps terminal broker states to terminal local states", () => {
    expect(mapAlpacaStatus("filled", "SUBMITTED")).toBe("FILLED");
    expect(mapAlpacaStatus("canceled", "SUBMITTED")).toBe("CANCELLED");
    expect(mapAlpacaStatus("rejected", "SUBMITTED")).toBe("REJECTED");
    expect(mapAlpacaStatus("expired", "SUBMITTED")).toBe("EXPIRED");
  });

  it("keeps pending_cancel non-terminal so a late fill still syncs (audit M5)", () => {
    // A cancel request in flight can lose the race to a fill. Marking the
    // local row CANCELLED froze it, so the later fill never reached the user.
    expect(mapAlpacaStatus("pending_cancel", "SUBMITTED")).toBe("SUBMITTED");
    expect(mapAlpacaStatus("pending_cancel", "PARTIAL")).toBe("SUBMITTED");
    // The eventual terminal state still lands on the next poll.
    expect(mapAlpacaStatus("canceled", "SUBMITTED")).toBe("CANCELLED");
    expect(mapAlpacaStatus("filled", "SUBMITTED")).toBe("FILLED");
  });

  it("keeps suspended non-terminal so a later fill still syncs", () => {
    // Alpaca defines `suspended` as merely "not eligible for trading" for now,
    // with no no-further-updates clause like `rejected` carries. Mapping it to
    // REJECTED dropped the row from OrderSyncPoller's scan set permanently, so
    // if Alpaca later un-suspended the order and it filled, nothing ever
    // re-read it: the source-fill gate saw a phantom "unfilled" and completed
    // the delivery, and a mirrored BUY that suspended-then-filled left the
    // follower's own exposure tracker at zero, refusing the paired close.
    expect(mapAlpacaStatus("suspended", "SUBMITTED")).toBe("SUBMITTED");
    expect(mapAlpacaStatus("suspended", "PARTIAL")).toBe("SUBMITTED");
    // The eventual terminal state still lands on the next poll.
    expect(mapAlpacaStatus("filled", "SUBMITTED")).toBe("FILLED");
    expect(mapAlpacaStatus("rejected", "SUBMITTED")).toBe("REJECTED");
  });

  it("maps live broker states to SUBMITTED", () => {
    for (const status of [
      "new",
      "accepted",
      "pending_new",
      "accepted_for_bidding",
      "pending_replace",
      "replaced",
      "stopped",
      "calculated",
      "done_for_day",
    ]) {
      expect(mapAlpacaStatus(status, "PENDING")).toBe("SUBMITTED");
    }
  });

  it("maps partial fills and preserves the current status for unknown values", () => {
    expect(mapAlpacaStatus("partially_filled", "SUBMITTED")).toBe("PARTIAL");
    expect(mapAlpacaStatus("some_future_status", "PARTIAL")).toBe("PARTIAL");
  });
});
