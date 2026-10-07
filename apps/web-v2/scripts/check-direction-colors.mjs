#!/usr/bin/env node
/**
 * Standalone lint: keeps direction color a single brand ramp in
 * apps/web-v2/src/components. Two rules:
 *
 * 1. No emerald or rose classes. The brand maps only green/red 400-600
 *    per theme (brand-tokens.css); emerald/rose bypass that mapping and
 *    reintroduce a second green/red hue.
 * 2. No green/red shades outside 400-600. Shades like green-950 or
 *    red-200 fall through to Tailwind's raw palette, which is not
 *    theme-mapped. Tinted surfaces belong to bg-gain-tint/bg-loss-tint or a
 *    color-mix() over var(--color-green-500)/var(--color-red-500).
 *
 * Run manually: bun apps/web-v2/scripts/check-direction-colors.mjs
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

// Any emerald/rose palette step, including opacity-suffixed uses.
const OFF_BRAND_FAMILY = /(?:emerald|rose)-(?:950|900|800|700|600|500|400|300|200|100|50)\b/g;
// Green/red steps outside the theme-mapped 400-600 window.
const OFF_RAMP_SHADE = /(?:green|red)-(?:950|900|800|700|300|200|100|50)\b/g;

// Known legacy occurrences that predate the ban. Shrink this list, never grow
// it. Empty since DirectionBadge was re-tokened in the feed PR.
const BASELINE = new Map([]);

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
    for (const pattern of [OFF_BRAND_FAMILY, OFF_RAMP_SHADE]) {
      for (const match of line.matchAll(pattern)) {
        const idx = allowed.indexOf(match[0]);
        if (idx !== -1) {
          allowed.splice(idx, 1);
          continue;
        }
        violations.push(`${rel}:${i + 1}  ${match[0]}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(
    "Off-ramp direction colors in src/components. Use green/red 400-600, bg-gain-tint/bg-loss-tint, or color-mix over var(--color-green-500)/var(--color-red-500):\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  "check-direction-colors: direction color stays on the brand green/red ramp.",
);
