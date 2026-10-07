import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("worker startup schema gate", () => {
  it("checks migration compatibility before Redis and poller startup", () => {
    const schemaCheck = source.indexOf("await assertWorkerSchemaCompatibility(db)");
    const copyMirrorIndexCheck = source.indexOf("await assertWorkerCopyMirrorCompatibility(db)");
    const copyTradeLeverageCheck = source.indexOf(
      "await assertWorkerCopyTradeLeverageCompatibility(db)",
    );
    const walletCopyCursorCheck = source.indexOf(
      "await assertWorkerWalletCopyCursorCompatibility(db)",
    );
    const copyTradeCapsCheck = source.indexOf(
      "await assertWorkerCopyTradeCapsCompatibility(db)",
    );
    const redisStartup = source.indexOf("await getRedisClient(logger)");
    const firstPollerImport = source.indexOf('await import("./services/discord-poller")');

    expect(schemaCheck).toBeGreaterThan(-1);
    expect(copyMirrorIndexCheck).toBeGreaterThan(schemaCheck);
    expect(copyTradeLeverageCheck).toBeGreaterThan(copyMirrorIndexCheck);
    expect(walletCopyCursorCheck).toBeGreaterThan(copyTradeLeverageCheck);
    expect(copyTradeCapsCheck).toBeGreaterThan(walletCopyCursorCheck);
    expect(redisStartup).toBeGreaterThan(schemaCheck);
    expect(redisStartup).toBeGreaterThan(copyMirrorIndexCheck);
    expect(redisStartup).toBeGreaterThan(copyTradeLeverageCheck);
    expect(redisStartup).toBeGreaterThan(walletCopyCursorCheck);
    expect(redisStartup).toBeGreaterThan(copyTradeCapsCheck);
    expect(firstPollerImport).toBeGreaterThan(schemaCheck);
    expect(firstPollerImport).toBeGreaterThan(copyMirrorIndexCheck);
    expect(firstPollerImport).toBeGreaterThan(copyTradeLeverageCheck);
    expect(firstPollerImport).toBeGreaterThan(walletCopyCursorCheck);
    expect(firstPollerImport).toBeGreaterThan(copyTradeCapsCheck);
    expect(source).toContain("through 0041");
  });

  it("wires the external Discord poller behind its exact opt-in gate", () => {
    expect(source).toContain('EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED === "true"');
    expect(source).toContain("ExternalDiscordSignalPoller");
  });

  it("routes wallet fills into the single durable copy-mirror executor", () => {
    expect(source).toContain("copyMirrorPoller.stageExternalCandidates(candidates)");
    expect(source).toContain("new HlWalletCopyPoller(");
  });
});
