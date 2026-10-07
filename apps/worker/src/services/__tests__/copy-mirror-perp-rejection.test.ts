/**
 * Unit tests for the copy-mirror Hyperliquid rejection classifier.
 *
 * This decides whether a failed placement is allowed to be written REJECTED. A
 * wrong "terminal" here drops a live, filled, leveraged position out of the
 * reconciler forever, so the cases that matter are the ambiguous ones: every one
 * of those must resolve to "reconcile", never to a terminal write.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyPerpPreparationFailure,
  classifyPerpRejection,
  isDuplicateOrderIdentityMessage,
} from "../copy-mirror-perp-rejection";

describe("isDuplicateOrderIdentityMessage", () => {
  it("recognizes the venue's cloid wording in either order", () => {
    expect(isDuplicateOrderIdentityMessage("Cloid already used")).toBe(true);
    expect(isDuplicateOrderIdentityMessage("Duplicate cloid")).toBe(true);
    expect(isDuplicateOrderIdentityMessage("cloid is already in use for this asset")).toBe(true);
  });

  it("recognizes the client-order-id wording the database and Alpaca use", () => {
    expect(
      isDuplicateOrderIdentityMessage(
        'duplicate key value violates unique constraint "orders_client_order_id_unique"',
      ),
    ).toBe(true);
    expect(isDuplicateOrderIdentityMessage("client_order_id must be unique")).toBe(true);
    expect(isDuplicateOrderIdentityMessage("client order id already exists")).toBe(true);
  });

  it("does not fire on ordinary rejections that merely mention an order", () => {
    expect(isDuplicateOrderIdentityMessage("Order must have minimum value of $10")).toBe(false);
    expect(isDuplicateOrderIdentityMessage("Insufficient margin to place order")).toBe(false);
    expect(isDuplicateOrderIdentityMessage("")).toBe(false);
  });
});

describe("classifyPerpRejection", () => {
  it("keeps a duplicate-cloid rejection reconcilable, because it says an order EXISTS", () => {
    // The money case. The re-place path reuses the deterministic cloid, so this
    // is the one rejection that may be describing a live filled position. The
    // old code wrote REJECTED here, and the sync poller only scans
    // PENDING/SYNCING/SUBMITTED/PARTIAL, so the row left reconciliation for good.
    const verdict = classifyPerpRejection("Order has duplicate cloid");
    expect(verdict.disposition).toBe("reconcile");
    expect(verdict.reason).toBe("duplicate-client-order-id");
  });

  it("beats the duplicate check against an overlapping definitive pattern", () => {
    // "Invalid ..." is on the definitive list; the duplicate rule must still win
    // so a duplicate worded as an invalid order is never pulled terminal.
    const verdict = classifyPerpRejection("Invalid order: cloid already used");
    expect(verdict.disposition).toBe("reconcile");
    expect(verdict.reason).toBe("duplicate-client-order-id");
  });

  it("marks the venue answers that definitively mean the order was never accepted", () => {
    for (const message of [
      "Order must have minimum value of $10",
      "Insufficient margin to place order",
      "Order price cannot be more than 95% away from the reference price",
      "Invalid size",
      "Order has zero size",
      "Price is not divisible by tick size",
      "Reduce only order would increase position",
      "Unknown asset",
      "This market is delisted",
    ]) {
      const verdict = classifyPerpRejection(message);
      expect(verdict.disposition).toBe("terminal");
      expect(verdict.reason).toBe("venue-rejected");
    }
  });

  it("fails closed on a message it does not recognize", () => {
    // Wrongly REJECTED hides real money forever; wrongly PENDING costs one
    // reconciler pass, which then retires the row itself. So an unfamiliar venue
    // string is handed to the component that can actually read the venue.
    const verdict = classifyPerpRejection("some new hyperliquid error nobody has seen");
    expect(verdict.disposition).toBe("reconcile");
    expect(verdict.reason).toBe("unrecognized-rejection");
  });

  it("fails closed on an empty message", () => {
    expect(classifyPerpRejection("").disposition).toBe("reconcile");
  });
});

describe("classifyPerpRejection: halted markets", () => {
  it("retries a CLOSE refused because the market is momentarily shut", () => {
    // A halt lifts. Retiring the close completes the one-shot delivery, so when
    // trading resumes the follower still holds the position with nothing left to
    // exit it.
    for (const message of [
      "Order rejected: market is halted",
      "asset not trading right now",
      "trading is closed for this market",
    ]) {
      const verdict = classifyPerpRejection(message, { reduceOnly: true });
      expect(verdict.disposition).toBe("retry");
      expect(verdict.reason).toBe("market-unavailable-retryable");
    }
  });

  it("keeps an OPEN terminal on the same messages", () => {
    // Refusing to ENTER a halted market is the correct outcome, not a deferral.
    for (const message of ["market is halted", "trading is closed for this market"]) {
      expect(classifyPerpRejection(message, { reduceOnly: false }).disposition).toBe("terminal");
      expect(classifyPerpRejection(message).disposition).toBe("terminal");
    }
  });

  it("keeps DELISTED terminal even for a close", () => {
    // Delisting does not lift, so retrying forever would wedge the queue on a
    // market that no longer exists.
    expect(classifyPerpRejection("asset is delisted", { reduceOnly: true }).disposition)
      .toBe("terminal");
  });

  it("keeps the duplicate carve-out ahead of the halt exemption", () => {
    expect(
      classifyPerpRejection("cloid already in use while halted", { reduceOnly: true }).disposition,
    ).toBe("reconcile");
  });
});

describe("classifyPerpPreparationFailure", () => {
  it("is terminal by default, because nothing was ever sent", () => {
    const verdict = classifyPerpPreparationFailure("failed to sign order payload");
    expect(verdict.disposition).toBe("terminal");
    expect(verdict.reason).toBe("not-submitted");
  });

  it("still carves out a duplicate-identity cause no matter which class carried it", () => {
    const verdict = classifyPerpPreparationFailure("cloid already in use");
    expect(verdict.disposition).toBe("reconcile");
    expect(verdict.reason).toBe("duplicate-client-order-id");
  });

  it("retries instead of retiring when the intent is a reduce-only CLOSE", () => {
    // "Safe to retire" is only true of the ORDER. Retiring it also completes the
    // delivery, and a close is one-shot: the follower's position stays open with
    // nothing left to exit it. This class covers request formatting (never going
    // to work) and signing (fails while the signer is down, works once it is
    // back), and the message does not reliably tell them apart.
    const verdict = classifyPerpPreparationFailure("failed to sign order payload", {
      reduceOnly: true,
    });
    expect(verdict.disposition).toBe("retry");
    expect(verdict.reason).toBe("not-submitted-retryable");
  });

  it("keeps the duplicate carve-out ahead of the close exemption", () => {
    // Evidence of a LIVE order beats "retry": the reconciler owns it from here.
    const verdict = classifyPerpPreparationFailure("cloid already in use", {
      reduceOnly: true,
    });
    expect(verdict.disposition).toBe("reconcile");
  });

  it("leaves OPENS terminal, so a malformed entry is not retried forever", () => {
    expect(
      classifyPerpPreparationFailure("failed to sign order payload", { reduceOnly: false })
        .disposition,
    ).toBe("terminal");
  });
});
