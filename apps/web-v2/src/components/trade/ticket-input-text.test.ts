import { describe, expect, test } from "bun:test";

import {
  IOS_NO_ZOOM_MIN_PX,
  NO_ZOOM_BASE_CLASS,
  TICKET_INPUT_TEXT_SM,
  TICKET_INPUT_TEXT_XS,
} from "./ticket-input-text";

/** Tailwind font-size utilities used by the tickets, in CSS pixels. */
const FONT_SIZE_PX: Record<string, number> = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
};

/** Strip a `/leading` modifier: `text-xs/relaxed` -> `text-xs`. */
function sizeOf(utility: string): number | undefined {
  return FONT_SIZE_PX[utility.split("/")[0]];
}

/**
 * Resolve the font size a class stack produces at a given viewport width, the
 * way the cascade does: later (wider) breakpoints win, unprefixed is the floor.
 */
function resolveFontSizePx(stack: string, widthPx: number): number | undefined {
  const breakpoints: Record<string, number> = {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    "2xl": 1536,
  };
  let size: number | undefined;
  for (const token of stack.split(/\s+/).filter(Boolean)) {
    const [maybePrefix, ...rest] = token.split(":");
    if (rest.length === 0) {
      size = sizeOf(maybePrefix) ?? size;
      continue;
    }
    const min = breakpoints[maybePrefix];
    if (min === undefined || widthPx < min) continue;
    size = sizeOf(rest.join(":")) ?? size;
  }
  return size;
}

const MOBILE_SHELL_WIDTHS = [320, 375, 390, 430, 640, 768, 1024, 1279];
const DESKTOP_TERMINAL_WIDTHS = [1280, 1440, 1920];

describe("ticket input font sizes", () => {
  test("never focus below 16px anywhere the mobile shell renders", () => {
    // Below xl the app renders the mobile shell, so every width in this list
    // is a phone/tablet ticket. iOS Safari zooms the viewport on focus when the
    // field is smaller than 16px and does not zoom back out on blur.
    for (const stack of [TICKET_INPUT_TEXT_SM, TICKET_INPUT_TEXT_XS]) {
      for (const width of MOBILE_SHELL_WIDTHS) {
        expect({ stack, width, px: resolveFontSizePx(stack, width) }).toEqual({
          stack,
          width,
          px: IOS_NO_ZOOM_MIN_PX,
        });
      }
    }
  });

  test("restores the compact desktop size at xl, not before", () => {
    for (const width of DESKTOP_TERMINAL_WIDTHS) {
      expect(resolveFontSizePx(TICKET_INPUT_TEXT_SM, width)).toBe(14);
      expect(resolveFontSizePx(TICKET_INPUT_TEXT_XS, width)).toBe(12);
    }
  });

  test("keeps the xs stack on the Input primitive's own desktop leading", () => {
    // The primitive sets `md:text-xs/relaxed`. The xs stack has to hand that
    // exact size AND leading back at xl, or the terminal ticket shifts.
    expect(TICKET_INPUT_TEXT_XS).toContain("xl:text-xs/relaxed");
  });

  test("overrides the primitive's md step explicitly", () => {
    // `Input` and `Textarea` both shrink themselves at md. A bare `text-base`
    // would be silently undone from 768px up, which is still mobile-shell
    // territory.
    for (const stack of [TICKET_INPUT_TEXT_SM, TICKET_INPUT_TEXT_XS]) {
      expect(stack.startsWith(`${NO_ZOOM_BASE_CLASS} `)).toBe(true);
      expect(stack).toContain(`md:${NO_ZOOM_BASE_CLASS}`);
    }
  });
});
