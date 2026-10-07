/**
 * PNL Card Layout Constants
 *
 * Card size matches the bundled background art (1536x1024) so frontend
 * previews can keep using aspect-[1536/1024].
 *
 * The background art keeps all focal content (subject, bull, money, charts,
 * world map) in the left ~55% of the frame; the right side is intentionally
 * a clean dark-teal expanse. All statistics therefore render inside a column
 * on the right so nothing ever overlaps a face or focal object.
 */

export const CARD_WIDTH = 1536;
export const CARD_HEIGHT = 1024;
export const JPEG_QUALITY = 90;

/**
 * Stats column on the clean right side of the artwork.
 * Left edge sits well clear of the subject/charts; right edge keeps a
 * generous margin from the frame.
 */
export const PANEL_LEFT = 884;
export const CONTENT_RIGHT = 1480;
export const PANEL_WIDTH = CONTENT_RIGHT - PANEL_LEFT;

export const COLORS = {
  /** Dark teal pulled from the artwork's right-side shadow, for the veil. */
  veil: "6, 16, 20",
  textPrimary: "#f5f8f7",
  textMuted: "#9fb4b0",
  brand: "#d8b15a",
  profit: "#46e6a0",
  loss: "#ff6258",
  // Status pill / direction chip backgrounds (semi-transparent over the veil).
  chipLong: "rgba(70, 230, 160, 0.16)",
  chipShort: "rgba(255, 98, 88, 0.16)",
  chipNeutral: "rgba(216, 177, 90, 0.16)",
} as const;
