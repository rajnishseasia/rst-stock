import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPostbuild } from "./postbuild.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

async function createBuildDir() {
  const cwd = await mkdtemp(path.join(tmpdir(), "trade-bot-api-postbuild-"));
  tempDirs.push(cwd);

  await mkdir(path.join(cwd, "dist"), { recursive: true });
  await writeFile(path.join(cwd, "dist", "index.js"), "export default {};\n");

  return cwd;
}

describe("API postbuild", () => {
  test("resolves the Alpaca SDK from the Vercel API entrypoint location", () => {
    const requireFromVercelEntry = createRequire(new URL("./index.js", import.meta.url));

    // Separators normalized: resolve() returns an OS-native path, so on Windows
    // the module id appears as @alpacahqlpaca-trade-api and a forward-slash
    // assertion fails even though resolution succeeded.
    const resolved = requireFromVercelEntry
      .resolve("@alpacahq/alpaca-trade-api")
      .split(path.sep)
      .join("/");

    expect(resolved).toContain("@alpacahq/alpaca-trade-api");
  });

  test("copies the bundled entry to the Vercel Hono root entrypoint", async () => {
    const cwd = await createBuildDir();

    await runPostbuild({ cwd, env: { VERCEL: "1" } });

    await expect(readFile(path.join(cwd, "index.js"), "utf8")).resolves.toBe(
      "export default {};\n",
    );
  });

  test("removes source files only for API deployments", async () => {
    const cwd = await createBuildDir();
    const srcDir = path.join(cwd, "src");
    await mkdir(srcDir);
    await writeFile(path.join(srcDir, "index.ts"), "export default {};\n");

    await runPostbuild({ cwd, env: { VERCEL: "1", API_DEPLOY: "true" } });

    await expect(access(srcDir)).rejects.toThrow();
  });

  test("keeps source files outside explicit API deployments", async () => {
    const cwd = await createBuildDir();
    const srcDir = path.join(cwd, "src");
    await mkdir(srcDir);
    await writeFile(path.join(srcDir, "index.ts"), "export default {};\n");

    await runPostbuild({ cwd, env: { VERCEL: "1" } });

    await access(srcDir);
  });
});
