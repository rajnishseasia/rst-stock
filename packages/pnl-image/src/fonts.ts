/**
 * Font Registration
 *
 * Registers the bundled DejaVu Sans faces (regular + bold) under one family
 * so canvas font strings like "bold 96px DejaVu Sans" resolve consistently
 * across environments (Docker images often ship no system fonts).
 */

import { GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FONT_FAMILY = "DejaVu Sans";

let registered = false;

/**
 * Locate the bundled assets/fonts directory. The relative path works from
 * both src/ (dev, bun runs TS directly) and dist/ (built output), since both
 * sit next to assets/ in the package root. The env var and node_modules
 * fallbacks cover bundlers that relocate the module (e.g. tsdown output).
 */
function resolveFontsDir(): string {
  const candidates = [
    process.env.PNL_IMAGE_ASSETS_DIR
      ? join(process.env.PNL_IMAGE_ASSETS_DIR, "fonts")
      : null,
    join(dirname(fileURLToPath(import.meta.url)), "../assets/fonts"),
    join(process.cwd(), "node_modules/@trade-bot/pnl-image/assets/fonts"),
  ].filter((dir): dir is string => dir !== null);

  for (const dir of candidates) {
    if (existsSync(join(dir, "DejaVuSans.ttf"))) return dir;
  }

  throw new Error(
    `@trade-bot/pnl-image: fonts not found. Searched: ${candidates.join(", ")}. ` +
      "Set PNL_IMAGE_ASSETS_DIR to the package's assets directory.",
  );
}

export function ensureFontsRegistered(): void {
  if (registered) return;
  const fontsDir = resolveFontsDir();
  GlobalFonts.registerFromPath(join(fontsDir, "DejaVuSans.ttf"), FONT_FAMILY);
  GlobalFonts.registerFromPath(join(fontsDir, "DejaVuSans-Bold.ttf"), FONT_FAMILY);
  registered = true;
}
