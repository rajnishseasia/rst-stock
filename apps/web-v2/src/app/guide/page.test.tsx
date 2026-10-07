import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GuidePage from "./page";

describe("guide mobile shortcuts", () => {
  test("links the overview to current sections without duplicating the desktop contents", () => {
    const markup = renderToStaticMarkup(createElement(GuidePage));
    const mobileNav = markup.match(
      /<nav[^>]*aria-label="Mobile guide shortcuts"[^>]*>[\s\S]*?<\/nav>/,
    )?.[0] ?? "";

    const mobileNavClasses =
      mobileNav.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(mobileNav).not.toBe("");
    expect(mobileNavClasses).not.toContain("hidden");
    expect(mobileNavClasses).toContain("lg:hidden");

    const expectedShortcuts = [
      ["Perps", "perps"],
      ["Copy Trading", "copy-trading"],
      ["AI Chat", "ai-chat"],
    ];
    const shortcutLinks = Array.from(
      mobileNav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g),
      ([, attributes, content]) => [
        content.match(/<span>([^<]+)<\/span>/)?.[1],
        attributes.match(/\bhref="([^"]+)"/)?.[1],
      ],
    );

    expect(shortcutLinks).toEqual(
      expectedShortcuts.map(([label, sectionId]) => [label, `#${sectionId}`]),
    );

    for (const [, sectionId] of expectedShortcuts) {
      expect(markup).toContain(`id="${sectionId}"`);
    }

    expect(markup.match(/Table of Contents/g)).toHaveLength(1);
    expect(markup).toContain('class="hidden lg:block w-64 shrink-0"');
  });
});
