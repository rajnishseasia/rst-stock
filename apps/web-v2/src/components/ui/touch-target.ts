/**
 * Touch-target sizing shared by the dense terminal controls that also render
 * inside the mobile shell.
 *
 * The terminal's default control height is 28px (`h-7`), which is fine for a
 * mouse and roughly half of what a finger needs. Rather than growing the
 * desktop chrome, these stacks give the control the full target below `sm` and
 * hand the compact height back from `sm` up.
 */

/** Minimum comfortable touch target, in CSS pixels (WCAG 2.5.5 / iOS HIG). */
export const TOUCH_TARGET_MIN_PX = 44;

/**
 * Height stack for a control whose desktop size is the terminal's `h-7` pill:
 * segmented controls, per-row Follow buttons, leaderboard filters.
 *
 * Established by copy-trade-panel.tsx's "Top Traders" button; this is the same
 * shape, factored out so the social surfaces cannot drift apart again.
 */
export const TOUCH_HEIGHT_COMPACT = "h-11 sm:h-7";
