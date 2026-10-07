import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "../..");

const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const dbPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/db/package.json"), "utf8"),
) as { scripts?: Record<string, string> };

// Railway applies migrations via the worker service's preDeployCommand:
//
//   bun run db:validate && bun run db:migrate:production && bun run db:verify-worker-schema
//
// That string lives in Railway's service settings, NOT in this repo. Railway
// deprecated config-as-code (railway.json / railway.toml) and refuses to read
// it -- setting `railwayConfigFile` returns "Config as Code is deprecated. Use
// Infrastructure as Code (.railway/railway.ts) instead." A committed
// railway.json is therefore inert, and one existed long enough for the worker
// to crash-loop against an unmigrated schema on 2026-08-31 while a test
// asserted it was authoritative.
//
// So this file cannot verify the command itself. What it can do is guarantee
// the repo still provides every script that command invokes, so renaming one
// cannot silently break production's pre-deploy.
describe("Railway worker migration contract", () => {
  test("no inert config-as-code file claims to configure the deploy", () => {
    expect(existsSync(resolve(repoRoot, "railway.json"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "railway.toml"))).toBe(false);
    expect(existsSync(resolve(here, "railway.json"))).toBe(false);
  });

  test("every script Railway's preDeployCommand invokes still exists", () => {
    expect(rootPackage.scripts?.["db:validate"]).toBe("bun --filter @trade-bot/db db:validate");
    expect(rootPackage.scripts?.["db:migrate:production"]).toBe(
      "bun --filter @trade-bot/db db:migrate:production",
    );
    expect(rootPackage.scripts?.["db:verify-worker-schema"]).toBe(
      "bun --filter @trade-bot/db db:verify-worker-schema",
    );
    expect(dbPackage.scripts?.["db:validate"]).toBeString();
    expect(dbPackage.scripts?.["db:migrate:production"]).toBe("bun scripts/run-drizzle.ts migrate");
    expect(dbPackage.scripts?.["db:verify-worker-schema"]).toBe(
      "bun scripts/verify-worker-schema.ts",
    );
  });
});
