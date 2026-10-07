/**
 * Background Art Loading
 *
 * Resolves and caches the bundled background JPEGs. A random `profit-N.jpg`
 * is chosen for winning cards; losing cards use a random `loss-N.jpg`, falling
 * back to the profit set until dedicated loss art is supplied. Drop additional
 * `profit-N.jpg` / `loss-N.jpg` files into assets/backgrounds to add variants —
 * they're picked up automatically, no code change needed.
 */

import { Image } from "@napi-rs/canvas";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BackgroundKind = "profit" | "loss";

const imageCache = new Map<string, Promise<Image>>();
let dirCache: string | null = null;
const fileListCache = new Map<BackgroundKind, string[]>();

function loadBundledJpeg(path: string): Promise<Image> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = (error) => reject(error);
    image.src = readFileSync(path);
  });
}

/**
 * Locate the bundled assets/backgrounds directory. Mirrors the font resolver:
 * the relative path works from both src/ (dev) and dist/ (built), with env
 * and node_modules fallbacks for bundlers that relocate the module.
 */
function resolveBackgroundsDir(): string {
  if (dirCache) return dirCache;
  const candidates = [
    process.env.PNL_IMAGE_ASSETS_DIR
      ? join(process.env.PNL_IMAGE_ASSETS_DIR, "backgrounds")
      : null,
    join(dirname(fileURLToPath(import.meta.url)), "../assets/backgrounds"),
    join(process.cwd(), "node_modules/@trade-bot/pnl-image/assets/backgrounds"),
  ].filter((dir): dir is string => dir !== null);

  for (const dir of candidates) {
    if (existsSync(dir) && readdirSync(dir).some((f) => /^profit-\d+\.jpg$/i.test(f))) {
      dirCache = dir;
      return dir;
    }
  }

  throw new Error(
    `@trade-bot/pnl-image: backgrounds not found. Searched: ${candidates.join(", ")}. ` +
      "Set PNL_IMAGE_ASSETS_DIR to the package's assets directory.",
  );
}

/** Files matching `${kind}-N.jpg`, sorted, cached per kind. */
function listBackgrounds(kind: BackgroundKind): string[] {
  const cached = fileListCache.get(kind);
  if (cached) return cached;
  const dir = resolveBackgroundsDir();
  const pattern = new RegExp(`^${kind}-\\d+\\.jpg$`, "i");
  const files = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort();
  fileListCache.set(kind, files);
  return files;
}

/** Pick a random background for the kind, falling back to profit art for losses. */
export function loadBackground(kind: BackgroundKind): Promise<Image> {
  const dir = resolveBackgroundsDir();
  let files = listBackgrounds(kind);
  if (files.length === 0) files = listBackgrounds("profit"); // loss fallback
  if (files.length === 0) {
    throw new Error("@trade-bot/pnl-image: no profit-N.jpg backgrounds found");
  }

  const file = files[Math.floor(Math.random() * files.length)]!;
  const path = join(dir, file);
  const cached = imageCache.get(path);
  if (cached) return cached;

  const promise = loadBundledJpeg(path);
  imageCache.set(path, promise);
  return promise;
}
