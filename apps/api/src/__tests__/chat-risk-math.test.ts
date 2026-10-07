import { describe, it, expect } from "bun:test";
import { computeRiskReward } from "../lib/chat/tools/lib/risk-math.js";

describe("computeRiskReward", () => {
  it("computes risk, reward, and R:R for a long with an explicit quantity", () => {
    const r = computeRiskReward({
      side: "long",
      entry: 50,
      stop: 48,
      target: 56,
      quantity: 100,
    });
    expect(r.valid).toBe(true);
    expect(r.riskPerShare).toBe(2); // |50 - 48|
    expect(r.rewardPerShare).toBe(6); // |56 - 50|
    expect(r.totalRisk).toBe(200); // 2 * 100
    expect(r.totalReward).toBe(600); // 6 * 100
    expect(r.riskRewardRatio).toBe(3); // 6 / 2
    expect(r.breakEven).toBe(50);
    expect(r.quantity).toBe(100);
  });

  it("sizes quantity from a risk budget when quantity is omitted", () => {
    const r = computeRiskReward({
      side: "long",
      entry: 100,
      stop: 95,
      maxRisk: 500,
    });
    // risk/share = 5, budget 500 => 100 shares
    expect(r.suggestedQuantityByRisk).toBe(100);
    expect(r.quantity).toBe(100);
    expect(r.totalRisk).toBe(500);
  });

  it("floors the risk-sized quantity to whole shares", () => {
    const r = computeRiskReward({
      side: "long",
      entry: 100,
      stop: 97, // risk/share = 3
      maxRisk: 100, // 100 / 3 = 33.33 -> 33
    });
    expect(r.suggestedQuantityByRisk).toBe(33);
  });

  it("handles a short: reward is below entry, stop above", () => {
    const r = computeRiskReward({
      side: "short",
      entry: 20,
      stop: 22,
      target: 14,
      quantity: 50,
    });
    expect(r.valid).toBe(true);
    expect(r.riskPerShare).toBe(2);
    expect(r.rewardPerShare).toBe(6);
    expect(r.riskRewardRatio).toBe(3);
    expect(r.totalRisk).toBe(100);
  });

  it("flags a long whose stop is not below entry", () => {
    const r = computeRiskReward({ side: "long", entry: 50, stop: 52, quantity: 10 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("stop must be below");
    // Numbers are still returned so the UI can show partial figures.
    expect(r.riskPerShare).toBe(2);
  });

  it("flags a short whose target is not below entry", () => {
    const r = computeRiskReward({
      side: "short",
      entry: 20,
      stop: 22,
      target: 25,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("target must be below");
  });

  it("applies the options contract multiplier to dollar figures", () => {
    const r = computeRiskReward({
      side: "long",
      entry: 5,
      stop: 4,
      target: 8,
      quantity: 2,
      contractMultiplier: 100,
    });
    expect(r.riskPerShare).toBe(100); // 1 * 100
    expect(r.rewardPerShare).toBe(300); // 3 * 100
    expect(r.totalRisk).toBe(200); // 100 * 2
    expect(r.riskRewardRatio).toBe(3);
  });

  it("rejects non-positive entry/stop with clear errors", () => {
    const r = computeRiskReward({ side: "long", entry: 0, stop: -1 });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.quantity).toBeNull();
    expect(r.totalRisk).toBeNull();
  });

  it("omits reward fields when no target is supplied", () => {
    const r = computeRiskReward({ side: "long", entry: 10, stop: 9, quantity: 10 });
    expect(r.rewardPerShare).toBeNull();
    expect(r.riskRewardRatio).toBeNull();
    expect(r.totalReward).toBeNull();
  });
});
