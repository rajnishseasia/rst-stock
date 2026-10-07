import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runPostbuild({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (env.VERCEL !== "1") {
    return;
  }

  const bundledEntry = path.join(cwd, "dist", "index.js");
  const vercelEntry = path.join(cwd, "index.js");

  try {
    await fs.copyFile(bundledEntry, vercelEntry);
  } catch (error) {
    throw new Error(
      "[postbuild] Expected bundled API entry at dist/index.js before preparing the Vercel entrypoint.",
      { cause: error },
    );
  }

  console.log(
    "[postbuild] Copied bundled API entry to index.js for Vercel Hono detection.",
  );

  if (env.API_DEPLOY === "true") {
    console.log(
      "[postbuild] Vercel API deployment detected. Removing src/ to prevent source entrypoint detection.",
    );
    await fs.rm(path.join(cwd, "src"), { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runPostbuild();
}
