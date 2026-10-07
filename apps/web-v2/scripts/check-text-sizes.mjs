#!/usr/bin/env node
/**
 * Standalone lint: bans NEW arbitrary Tailwind font sizes (text-[11px],
 * text-[0.625rem], ...) in apps/web-v2/src/components. Sub-12px type must use
 * the registered tokens (text-2xs = 11px, text-3xs = 10px) so the app keeps a
 * single small-type scale instead of six spellings of "tiny".
 *
 * Run manually: bun apps/web-v2/scripts/check-text-sizes.mjs
 * Deliberately NOT wired into CI, turbo, or any lint command.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const componentsDir = fileURLToPath(
  new URL("../src/components", import.meta.url),
);
const repoRelative = (abs) =>
  relative(join(componentsDir, "..", "..", "..", ".."), abs);

// Matches arbitrary-value font-size utilities in px/rem/em, including
// variant-prefixed uses (xl:text-[13px]) via the plain substring match.
const ARBITRARY_SIZE = /text-\[[0-9][0-9.]*(?:px|rem|em)\]/g;

// Known legacy occurrences that predate the ban and have no token equivalent
// (13px/15px sit between text-xs and text-sm). Shrink this list, never grow it.
const BASELINE = new Map([
  ["apps/web-v2/src/components/feed/signal-content.tsx", ["text-[13px]"]],
  [
    "apps/web-v2/src/components/landing/trade-demo-section.tsx",
    ["text-[15px]"],
  ],
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) yield path;
  }
}

const violations = [];
for (const file of walk(componentsDir)) {
  const rel = repoRelative(file);
  const allowed = [...(BASELINE.get(rel) ?? [])];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(ARBITRARY_SIZE)) {
      const idx = allowed.indexOf(match[0]);
      if (idx !== -1) {
        allowed.splice(idx, 1);
        continue;
      }
      violations.push(`${rel}:${i + 1}  ${match[0]}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    "Arbitrary font sizes are banned in src/components. Use text-2xs (11px), text-3xs (10px), or a standard token instead:\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("check-text-sizes: no new arbitrary font sizes in src/components.");
