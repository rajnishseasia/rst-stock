/**
 * Font-size class stacks for the dense fields inside the two trade tickets.
 *
 * iOS Safari zooms the whole viewport when a focused text input renders below
 * 16px, and it does not zoom back out on blur. The ticket fields are
 * deliberately compact (`text-sm` / `text-xs`), so on a phone every tap into a
 * size, price or TP/SL field left the user stranded at a magnified layout.
 *
 * The fix is per field rather than a `viewport` export with
 * `maximumScale: 1`, which would disable pinch-zoom for the entire app.
 *
 * Breakpoint choice: the compact size is restored at `xl`, not `md`, because
 * `xl` is where the desktop terminal replaces the mobile shell. Restoring at
 * `md` would put a 12px field back on every tablet-width phone/tablet that is
 * still rendering the mobile ticket.
 *
 * The explicit `md:` step is not redundant: the shared `Input` primitive sets
 * `md:text-xs/relaxed` in its own base classes, so a bare `text-base` would be
 * silently undone from 768px up.
 */

/** For fields whose desktop size is `text-sm` (perp size + price inputs). */
export const TICKET_INPUT_TEXT_SM = "text-base md:text-base xl:text-sm";

/**
 * For fields whose desktop size is the `Input` primitive's own
 * `text-xs/relaxed` (TP/SL rows in both tickets).
 */
export const TICKET_INPUT_TEXT_XS = "text-base md:text-base xl:text-xs/relaxed";

/** The font-size utility every ticket field must start at, below `xl`. */
export const NO_ZOOM_BASE_CLASS = "text-base";

/**
 * Smallest font size iOS Safari will focus without zooming the viewport, in
 * CSS pixels. `text-base` is exactly this.
 */
export const IOS_NO_ZOOM_MIN_PX = 16;
