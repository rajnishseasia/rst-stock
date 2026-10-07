import { describe, expect, it } from "bun:test";
import {
  mirrorDestinationForAsset,
  readMirrorDestination,
} from "../copy-mirror-destinations";

const row = {
  autoMirror: false,
  credentialId: null,
  sizingMode: "pct",
  sizingValue: "5.00",
  stockAutoMirror: true,
  stockCredentialId: "alpaca-paper",
  stockSizingMode: "usd",
  stockSizingValue: "125.00",
  perpAutoMirror: true,
  perpCredentialId: "hl-live",
  perpSizingMode: "ratio",
  perpSizingValue: "2.00",
  destinationPolicyInitialized: true,
};

describe("copy mirror destinations", () => {
  it("maps each asset type to its independent destination and sizing", () => {
    expect(mirrorDestinationForAsset("EQUITY")).toBe("stock");
    expect(mirrorDestinationForAsset("OPTION")).toBe("stock");
    expect(mirrorDestinationForAsset("PERP")).toBe("perp");
    expect(readMirrorDestination(row, "stock")).toEqual({
      enabled: true,
      credentialId: "alpaca-paper",
      sizingMode: "usd",
      sizingValue: 125,
    });
    expect(readMirrorDestination(row, "perp")).toEqual({
      enabled: true,
      credentialId: "hl-live",
      sizingMode: "ratio",
      sizingValue: 2,
    });
  });

  it("falls back to the legacy single destination only for legacy-shaped rows", () => {
    expect(readMirrorDestination({
      autoMirror: true,
      credentialId: "legacy-account",
      sizingMode: "pct",
      sizingValue: "7.00",
    }, "stock", { legacyProvider: "alpaca" })).toEqual({
      enabled: true,
      credentialId: "legacy-account",
      sizingMode: "pct",
      sizingValue: 7,
    });
  });

  it("does not fall back when a migrated destination is explicitly off", () => {
    expect(readMirrorDestination({
      autoMirror: true,
      credentialId: "legacy-account",
      sizingMode: "pct",
      sizingValue: "7.00",
      stockAutoMirror: false,
      stockCredentialId: "alpaca-paper",
      stockSizingMode: "pct",
      stockSizingValue: "5.00",
    }, "stock").enabled).toBe(false);
  });

  it("keeps a pre-migration selected credential visible while its legacy consent is off", () => {
    expect(readMirrorDestination({
      autoMirror: false,
      credentialId: "legacy-account",
      sizingMode: "usd",
      sizingValue: "25.00",
    }, "stock", { legacyProvider: "alpaca" })).toEqual({
      enabled: false,
      credentialId: "legacy-account",
      sizingMode: "usd",
      sizingValue: 25,
    });
  });

  it("does not use a legacy Hyperliquid credential as a stock destination", () => {
    expect(readMirrorDestination({
      autoMirror: true,
      credentialId: "legacy-hl",
      sizingMode: "pct",
      sizingValue: "5.00",
    }, "stock", { legacyProvider: "hyperliquid" }).enabled).toBe(false);
    expect(readMirrorDestination({
      autoMirror: true,
      credentialId: "legacy-hl",
      sizingMode: "pct",
      sizingValue: "5.00",
    }, "perp", { legacyProvider: "hyperliquid" }).enabled).toBe(true);
  });

  it("never enables a typed destination with malformed persisted sizing", () => {
    expect(readMirrorDestination({
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: "alpaca-paper",
      stockSizingMode: "bogus",
      stockSizingValue: "90.00",
    }, "stock")).toEqual({
      enabled: false,
      credentialId: "alpaca-paper",
      sizingMode: "pct",
      sizingValue: 5,
    });
    expect(readMirrorDestination({
      destinationPolicyInitialized: true,
      perpAutoMirror: true,
      perpCredentialId: "hl-live",
      perpSizingMode: "usd",
      perpSizingValue: "NaN",
    }, "perp").enabled).toBe(false);
  });

  it("treats an uninitialized typed policy as disabled even when legacy consent is on", () => {
    expect(readMirrorDestination({
      destinationPolicyInitialized: false,
      autoMirror: true,
      credentialId: "legacy-account",
      sizingMode: "pct",
      sizingValue: "7.00",
      stockAutoMirror: false,
      stockCredentialId: null,
      stockSizingMode: "pct",
      stockSizingValue: "5.00",
    }, "stock", { legacyProvider: "alpaca" }).enabled).toBe(false);
  });
});
