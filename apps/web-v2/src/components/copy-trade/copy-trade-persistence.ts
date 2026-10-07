/**
 * Pure parsing for the copy-trade panel's two localStorage-persisted settings
 * (no React, no IO): the source filter and the sizing control. Extracted so
 * the actual decision - what a stored value resolves to, including a garbled
 * or stale one - is directly testable, rather than pinned only by checking
 * that the key-name strings appear somewhere in the component's source.
 *
 * The read/write itself stays in copy-trade-panel.tsx's two mount effects:
 * `window.localStorage.getItem(KEY)` in, one of these parsers, `setState` if
 * non-null out. That three-line wiring has no branch of its own to test.
 */

import { SIZING_MODE_PRESENTATION, type SizingMode } from "./mirror-sizing";

/** The single source-filter selection (see copy-trade-panel.tsx for the full type). */
export type SourceFilter = "all" | "x_signal" | "user" | "following";

export interface Sizing {
  mode: SizingMode;
  value: number;
}

/**
 * Resolve a raw `localStorage.getItem("copy-trade:sources")` read to a valid
 * `SourceFilter`, or null when it is missing, stale, or was never a value
 * this panel writes (e.g. a future/older build's source name).
 */
export function parseStoredSourceFilter(raw: string | null): SourceFilter | null {
  return raw === "all" || raw === "x_signal" || raw === "user" || raw === "following"
    ? raw
    : null;
}

/**
 * Resolve a raw `localStorage.getItem("copy-trade:sizing")` read to a valid
 * `Sizing`, or null only when the storage key is missing.
 *
 * Unknown modes, malformed data, and out-of-range values fail closed at zero
 * exposure. The legacy default argument is accepted for call-site
 * compatibility but intentionally never activates an untrusted stored size.
 */
export function parseStoredSizing(raw: string | null, _legacyDefaultValue?: number): Sizing | null {
  if (raw === null) return null;
  if (!raw) return { mode: "pct", value: 0 };
  try {
    const parsed = JSON.parse(raw);
    const storedMode = parsed?.mode;
    const isRecognizedMode =
      storedMode === "usd" ||
      storedMode === "pct" ||
      storedMode === "pct_equity" ||
      storedMode === "ratio";
    const mode: SizingMode = isRecognizedMode ? storedMode : "pct";
    if (!isRecognizedMode) return { mode, value: 0 };

    const bounds = SIZING_MODE_PRESENTATION[mode];
    const value = typeof parsed?.value === "number" ? parsed.value : Number.NaN;
    return {
      mode,
      value:
        Number.isFinite(value) && value >= bounds.min && value <= bounds.max ? value : 0,
    };
  } catch {
    return { mode: "pct", value: 0 };
  }
}
