/**
 * Copy-mirror perp observability: behavior tests.
 *
 * These lock in the operator-facing distinctions that a silent perp path cost
 * us: every placement intent and outcome has a line, and the three config faults
 * (opted out / reconciler off / network unset) are distinguishable, so an
 * operator is never sent to the wrong variable.
 */

import { describe, expect, it } from "bun:test";
import {
  describePerpConfigFault,
  describePerpPlacementIntent,
  describePerpPlacementOutcome,
  type PerpPlacementIntent,
  type PerpPlacementOutcome,
} from "../copy-mirror-perp-observability";

const INTENTS: PerpPlacementIntent[] = ["open", "resume", "close"];
const OUTCOMES: PerpPlacementOutcome[] = ["placed", "duplicate", "syncing", "rejected"];

describe("perp placement intent lines", () => {
  it("gives every placement call site its own distinct, loud line", () => {
    const lines = INTENTS.map((intent) => describePerpPlacementIntent(intent));
    for (const line of lines) {
      expect(line.level).toBe("warn");
      expect(line.message).toContain("PLACING Hyperliquid perp mirror");
    }
    // Distinguishable: an operator reading the log must be able to tell a fresh
    // open from a resumed PENDING row from a reduce-only close.
    expect(new Set(lines.map((line) => line.message)).size).toBe(INTENTS.length);
  });
});

describe("perp placement outcome lines", () => {
  it("covers every outcome placePerpMirrorOrder can return", () => {
    for (const outcome of OUTCOMES) {
      const line = describePerpPlacementOutcome(outcome);
      expect(line.message.startsWith("[copy-mirror]")).toBe(true);
      expect(["info", "warn", "error"]).toContain(line.level);
    }
    expect(new Set(OUTCOMES.map((o) => describePerpPlacementOutcome(o).message)).size).toBe(
      OUTCOMES.length,
    );
  });

  it("matches the equity path's loud PLACED wording so both venues read alike", () => {
    const placed = describePerpPlacementOutcome("placed");
    expect(placed.level).toBe("warn");
    expect(placed.message).toContain("PLACED");
  });

  it("keeps a routine duplicate skip at info, not warn", () => {
    expect(describePerpPlacementOutcome("duplicate").level).toBe("info");
  });
});

describe("perp config faults", () => {
  it("names the flag when perps are simply opted out", () => {
    const fault = describePerpConfigFault({
      perpsEnabled: false,
      reconcilerEnabled: true,
      networkExplicit: true,
    });
    expect(fault?.outcome).toBe("perps-disabled");
    expect(fault?.envVar).toBe("COPY_TRADE_AUTOMIRROR_PERPS_ENABLED");
    expect(fault?.level).toBe("info");
  });

  it("reports an unset network as its own, louder fault", () => {
    // The venue package defaults an unset network to mainnet, so this is a
    // real-money misconfiguration and must not read as "perps are off".
    const fault = describePerpConfigFault({
      perpsEnabled: true,
      reconcilerEnabled: true,
      networkExplicit: false,
    });
    expect(fault?.outcome).toBe("perps-network-unset");
    expect(fault?.envVar).toBe("HYPERLIQUID_NETWORK");
    expect(fault?.level).toBe("warn");
    expect(fault?.message).toContain("mainnet");
  });

  it("reports a missing reconciler as its own fault, pointing at the sync flag", () => {
    // The operator DID set the perps flag, so reporting this as "perps are off"
    // would send them to the wrong variable while leveraged mirroring stays dead.
    const fault = describePerpConfigFault({
      perpsEnabled: true,
      reconcilerEnabled: false,
      networkExplicit: true,
    });
    expect(fault?.outcome).toBe("perps-sync-disabled");
    expect(fault?.envVar).toBe("HYPERLIQUID_SYNC_ENABLED");
    expect(fault?.level).toBe("warn");
  });

  it("never collapses the three faults into the same outcome string", () => {
    const off = describePerpConfigFault({
      perpsEnabled: false,
      reconcilerEnabled: false,
      networkExplicit: false,
    });
    const noReconciler = describePerpConfigFault({
      perpsEnabled: true,
      reconcilerEnabled: false,
      networkExplicit: false,
    });
    const unset = describePerpConfigFault({
      perpsEnabled: true,
      reconcilerEnabled: true,
      networkExplicit: false,
    });
    // Flag-off wins when several are true: the operator opted out, which is not
    // a misconfiguration to page anyone about.
    expect(off?.outcome).toBe("perps-disabled");
    expect(noReconciler?.outcome).toBe("perps-sync-disabled");
    expect(unset?.outcome).toBe("perps-network-unset");
    expect(new Set([off?.outcome, noReconciler?.outcome, unset?.outcome]).size).toBe(3);
  });

  it("returns null when the perp path is properly configured", () => {
    expect(
      describePerpConfigFault({
        perpsEnabled: true,
        reconcilerEnabled: true,
        networkExplicit: true,
      }),
    ).toBeNull();
  });
});

// Startup readiness for "perps on, reconciler off" used to live here as a
// warning. It is now a refusal, and its tests live beside the gate that owns it:
// copy-mirror-perp-sync-gate.test.ts.
