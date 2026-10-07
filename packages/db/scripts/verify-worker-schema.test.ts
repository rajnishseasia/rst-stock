import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./verify-worker-schema.ts", import.meta.url), "utf8");

describe("worker schema verification", () => {
  it("runs the migration 0042 destination, 0041 cap, and 0039 wallet-copy cursor gates in order", () => {
    const orderCheck = source.indexOf("await assertWorkerSchemaCompatibility(db)");
    const canonicalCheck = source.indexOf(
      "await assertWorkerCanonicalIngestionCompatibility(db)",
    );
    const copyMirrorIndexCheck = source.indexOf(
      "await assertWorkerCopyMirrorCompatibility(db)",
    );
    const copyMirrorDestinationCheck = source.indexOf(
      "await assertWorkerCopyMirrorDestinationsCompatibility(db)",
    );
    const copyTradeLeverageCheck = source.indexOf(
      "await assertWorkerCopyTradeLeverageCompatibility(db)",
    );
    const copyTradeCapsCheck = source.indexOf(
      "await assertWorkerCopyTradeCapsCompatibility(db)",
    );
    const walletCopyCursorCheck = source.indexOf(
      "await assertWorkerWalletCopyCursorCompatibility(db)",
    );

    expect(orderCheck).toBeGreaterThan(-1);
    expect(canonicalCheck).toBeGreaterThan(orderCheck);
    expect(copyMirrorIndexCheck).toBeGreaterThan(canonicalCheck);
    expect(copyMirrorDestinationCheck).toBeGreaterThan(copyMirrorIndexCheck);
    expect(copyTradeLeverageCheck).toBeGreaterThan(copyMirrorDestinationCheck);
    expect(copyTradeCapsCheck).toBeGreaterThan(copyTradeLeverageCheck);
    expect(walletCopyCursorCheck).toBeGreaterThan(copyTradeCapsCheck);
  });
});
