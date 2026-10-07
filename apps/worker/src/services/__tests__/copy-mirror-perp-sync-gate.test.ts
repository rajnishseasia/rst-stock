/**
 * Perp reconciler precondition: behavior tests.
 *
 * The gate exists because "perps on, Hyperliquid reconciler off" is not a
 * degraded mode, it is an unsafe one: nothing would size a mirrored fill and
 * nothing would ever resolve a PENDING perp order against the venue. These tests
 * lock in that the gate REFUSES rather than warns, that it names both env vars,
 * and that it agrees exactly with the reconciler's own kill switch.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  HYPERLIQUID_SYNC_ENV_VAR,
  PERPS_AUTOMIRROR_ENV_VAR,
  evaluatePerpSyncGate,
  isPerpReconcilerEnabled,
  readPerpsAutoMirrorFlag,
  resetPerpSyncGateAnnouncement,
  takePerpSyncGateRefusal,
} from "../copy-mirror-perp-sync-gate";
import { isHyperliquidSyncEnabled } from "../hyperliquid-order-sync";
import { isPerpsAutoMirrorEnabled } from "../copy-mirror";

const PERPS_ON = { [PERPS_AUTOMIRROR_ENV_VAR]: "true" } as NodeJS.ProcessEnv;
const PERPS_ON_SYNC_KILLED = {
  [PERPS_AUTOMIRROR_ENV_VAR]: "true",
  [HYPERLIQUID_SYNC_ENV_VAR]: "false",
} as NodeJS.ProcessEnv;

const BOTH_ON = {
  [PERPS_AUTOMIRROR_ENV_VAR]: "true",
  [HYPERLIQUID_SYNC_ENV_VAR]: "true",
} as NodeJS.ProcessEnv;

beforeEach(() => {
  resetPerpSyncGateAnnouncement();
});

describe("perp sync gate", () => {
  it("refuses perp mirroring when perps are on but the reconciler was killed", () => {
    const decision = evaluatePerpSyncGate(PERPS_ON_SYNC_KILLED);
    expect(decision.perpsFlagSet).toBe(true);
    expect(decision.reconcilerEnabled).toBe(false);
    expect(decision.perpMirroringAllowed).toBe(false);
    expect(decision.refusal).not.toBeNull();
  });

  it("does not make an operator set a second flag: the perps opt-in alone is enough", () => {
    // The whole point of the reconciler defaulting on. Perps opt-in, nothing
    // else set, mirroring is allowed. Anything stricter would be a deployment
    // trap: perps silently not mirroring until someone found a second switch.
    expect(evaluatePerpSyncGate(PERPS_ON).perpMirroringAllowed).toBe(true);
    expect(evaluatePerpSyncGate(BOTH_ON).perpMirroringAllowed).toBe(true);
  });

  it("still refuses when the reconciler was deliberately killed", () => {
    expect(evaluatePerpSyncGate(PERPS_ON_SYNC_KILLED).perpMirroringAllowed).toBe(false);
  });

  it("never allows perps mirroring on the reconciler alone", () => {
    expect(evaluatePerpSyncGate({}).perpMirroringAllowed).toBe(false);
    expect(
      evaluatePerpSyncGate({ [HYPERLIQUID_SYNC_ENV_VAR]: "true" } as NodeJS.ProcessEnv)
        .perpMirroringAllowed,
    ).toBe(false);
  });

  it("treats only the exact string 'false' as the kill switch", () => {
    // Asymmetric on purpose, and the opposite way round from an opt-in flag: a
    // typo must leave a READ-ONLY reconciler running, because stopping it is
    // what breaks close sizing. So these near-misses all keep the gate OPEN.
    for (const value of ["FALSE", "False", "0", "no", "true", " false ", ""]) {
      expect(
        evaluatePerpSyncGate({
          [PERPS_AUTOMIRROR_ENV_VAR]: "true",
          [HYPERLIQUID_SYNC_ENV_VAR]: value,
        } as NodeJS.ProcessEnv).perpMirroringAllowed,
      ).toBe(true);
    }
  });

  it("names BOTH variables in the refusal so an operator knows what to set", () => {
    const refusal = evaluatePerpSyncGate(PERPS_ON_SYNC_KILLED).refusal;
    expect(refusal?.level).toBe("error");
    expect(refusal?.message).toContain(PERPS_AUTOMIRROR_ENV_VAR);
    expect(refusal?.message).toContain(HYPERLIQUID_SYNC_ENV_VAR);
    expect(refusal?.envVars).toEqual([PERPS_AUTOMIRROR_ENV_VAR, HYPERLIQUID_SYNC_ENV_VAR]);
    // Names only: a refusal line must never carry a config VALUE.
    expect(refusal?.message).not.toContain("=true\"");
  });

  it("does not treat perps simply being off as a fault", () => {
    expect(evaluatePerpSyncGate({}).refusal).toBeNull();
    expect(evaluatePerpSyncGate({ [HYPERLIQUID_SYNC_ENV_VAR]: "true" } as NodeJS.ProcessEnv).refusal)
      .toBeNull();
    expect(evaluatePerpSyncGate(BOTH_ON).refusal).toBeNull();
  });

  it("announces the refusal once, then stays quiet", () => {
    expect(takePerpSyncGateRefusal(PERPS_ON_SYNC_KILLED)).not.toBeNull();
    expect(takePerpSyncGateRefusal(PERPS_ON_SYNC_KILLED)).toBeNull();
    expect(takePerpSyncGateRefusal(PERPS_ON_SYNC_KILLED)).toBeNull();
  });

  it("never announces anything when the gate is open", () => {
    expect(takePerpSyncGateRefusal(BOTH_ON)).toBeNull();
    expect(takePerpSyncGateRefusal({})).toBeNull();
  });
});

describe("gate predicates agree with the reconciler's own kill switch", () => {
  it("matches isHyperliquidSyncEnabled across the whole value matrix", () => {
    // The gate duplicates the predicate to stay free of DB/venue imports. If the
    // two ever diverge, the gate could allow perp mirroring while the reconciler
    // is inert, which is exactly the state it exists to prevent.
    const values = [
      undefined, "true", "TRUE", "True", "1", "yes", " true ",
      "false", "FALSE", "False", " false ", "no", "0", "",
    ];
    for (const value of values) {
      const env = (value === undefined
        ? {}
        : { [HYPERLIQUID_SYNC_ENV_VAR]: value }) as NodeJS.ProcessEnv;
      expect(isPerpReconcilerEnabled(env)).toBe(isHyperliquidSyncEnabled(env));
    }
  });

  it("keeps the raw perps flag separate from the gated answer", () => {
    // The raw flag is what a log line uses to say WHICH variable is missing. It
    // must never be mistaken for permission to place an order.
    expect(readPerpsAutoMirrorFlag(PERPS_ON_SYNC_KILLED)).toBe(true);
    expect(isPerpsAutoMirrorEnabled(PERPS_ON_SYNC_KILLED)).toBe(false);
    expect(readPerpsAutoMirrorFlag(BOTH_ON)).toBe(true);
    expect(isPerpsAutoMirrorEnabled(BOTH_ON)).toBe(true);
  });
});
