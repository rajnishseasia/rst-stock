import { describe, expect, test } from "bun:test";
import {
  getSocialViewMeta,
  SOCIAL_VIEW_META,
  type SocialSubheaderAction,
} from "./social-feed-panel";

const VIEWS: SocialSubheaderAction[] = ["hot_symbols", "live_feed"];

describe("social view metadata", () => {
  test("returns the matching meta for each view", () => {
    for (const view of VIEWS) {
      expect(getSocialViewMeta(view)).toBe(SOCIAL_VIEW_META[view]);
    }
  });

  test("gives every view a distinct label, description, and empty state", () => {
    const labels = VIEWS.map((view) => getSocialViewMeta(view).label);
    const descriptions = VIEWS.map((view) => getSocialViewMeta(view).description);
    const emptyTitles = VIEWS.map((view) => getSocialViewMeta(view).emptyTitle);

    expect(new Set(labels).size).toBe(VIEWS.length);
    expect(new Set(descriptions).size).toBe(VIEWS.length);
    expect(new Set(emptyTitles).size).toBe(VIEWS.length);
  });

  test("gives every view a distinct icon so switching is visible", () => {
    const icons = VIEWS.map((view) => getSocialViewMeta(view).icon);
    expect(new Set(icons).size).toBe(VIEWS.length);
  });

  test("falls back to the hot-symbols view for an unknown focus", () => {
    expect(getSocialViewMeta("nope" as SocialSubheaderAction)).toBe(
      SOCIAL_VIEW_META.hot_symbols,
    );
  });
});
