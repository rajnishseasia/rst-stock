import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SignalContent,
  SignalSourceLink,
  SignalTimestamp,
  cleanSignalContent,
  shouldShowSignalActions,
  signalActionClassName,
  signalContentToggleLabel,
} from "./signal-content";

/**
 * A 44px (min-h-11) minimum height is the mobile touch-target floor. Accepts the
 * equivalent spellings so a later restyle can express it differently without
 * silently dropping it.
 */
const TOUCH_TARGET = /min-h-(11|12|\[44px\]|\[2\.75rem\])/;

function render(props: Parameters<typeof SignalContent>[0]) {
  return renderToStaticMarkup(<SignalContent {...props} />);
}

describe("signal body", () => {
  test("renders the tweet text", () => {
    expect(render({ content: "long NVDA into earnings" })).toContain(
      "long NVDA into earnings",
    );
  });

  test("a short signal with no link and no image renders no action row", () => {
    const markup = render({ content: "long NVDA" });

    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("View original");
    expect(markup).not.toContain("View image");
  });

  test("renders the original-post link separately for the timestamp row", () => {
    const markup = renderToStaticMarkup(
      <SignalSourceLink url="https://x.com/someone/status/12345" />,
    );

    expect(markup).toContain('href="https://x.com/someone/status/12345"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("View original");
  });

  test("does not render an external link for paste.trade", () => {
    const markup = renderToStaticMarkup(
      <SignalSourceLink url="https://paste.trade/p/123" />,
    );

    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("paste.trade");
  });

  test("offers the tweet image as its own new-tab link", () => {
    const markup = render({
      content: "long NVDA",
      imageUrl: "https://example.com/chart.png",
    });

    expect(markup).toContain('href="https://example.com/chart.png"');
    expect(markup).toContain("View image");
    expect(markup).not.toContain("View original");
  });

  test("embedded actions keep a 44px touch target below xl", () => {
    const markup = renderToStaticMarkup(
      <SignalSourceLink
        url="https://x.com/someone/status/12345"
        embedded
      />,
    );

    const anchor = markup.slice(markup.indexOf("<a "));
    expect(anchor).toMatch(TOUCH_TARGET);
    // The dense terminal size is an xl-only override, never the mobile size.
    expect(anchor).toContain("xl:");
  });
});

describe("cleanSignalContent", () => {
  test("strips a long leading xxx run and following whitespace", () => {
    expect(cleanSignalContent("xxxxxxxx $BFLY Holding nicely")).toBe(
      "$BFLY Holding nicely",
    );
  });

  test("strips multiple consecutive xxx runs", () => {
    expect(cleanSignalContent("xxxx xxxx  $TSLA moon")).toBe("$TSLA moon");
  });

  test("leaves content unchanged when there is no leading xxx", () => {
    expect(cleanSignalContent("long NVDA into earnings")).toBe(
      "long NVDA into earnings",
    );
  });

  test("does not strip short runs that could be ticker symbols (XXX = 3 chars)", () => {
    expect(cleanSignalContent("XXX breakout")).toBe("XXX breakout");
  });

  test("keeps an uppercase 4-character leading identifier (XXXX)", () => {
    expect(cleanSignalContent("XXXX breakout")).toBe("XXXX breakout");
  });

  test("keeps uppercase runs up to the 5-character ticker ceiling", () => {
    expect(cleanSignalContent("XXXXX long here")).toBe("XXXXX long here");
  });

  test("strips an uppercase run past the ticker ceiling (6 or more)", () => {
    expect(cleanSignalContent("XXXXXX $TSLA moon")).toBe("$TSLA moon");
  });

  test("leaves a word that merely starts with x characters", () => {
    expect(cleanSignalContent("xxxxtreme volume today")).toBe(
      "xxxxtreme volume today",
    );
  });

  test("returns an empty string when content is only xxx", () => {
    expect(cleanSignalContent("xxxxxxxxxx")).toBe("");
  });

  test("strips xxx from the rendered signal body", () => {
    expect(render({ content: "xxxxxxxxxxxxxxxx $AAPL up big" })).toContain(
      "$AAPL up big",
    );
  });
});

describe("signal body helpers", () => {
  test("the toggle names the action it will perform", () => {
    expect(signalContentToggleLabel(false)).toBe("View more");
    expect(signalContentToggleLabel(true)).toBe("View less");
  });

  test("the action row appears only when there is something to act on", () => {
    const none = {
      overflowing: false,
      expanded: false,
      imageUrl: null,
    };

    expect(shouldShowSignalActions(none)).toBe(false);
    expect(shouldShowSignalActions({ ...none, overflowing: true })).toBe(true);
    expect(shouldShowSignalActions({ ...none, expanded: true })).toBe(true);
    expect(
      shouldShowSignalActions({ ...none, imageUrl: "https://x.com/c.png" }),
    ).toBe(true);
  });

  test("only the embedded action carries the mobile touch target", () => {
    expect(signalActionClassName(true)).toMatch(TOUCH_TARGET);
    expect(signalActionClassName(false)).not.toMatch(TOUCH_TARGET);
  });

  test("gives an embedded signal timestamp a 44px touch target", () => {
    const markup = renderToStaticMarkup(
      <SignalTimestamp timestamp="2026-08-31T12:00:00.000Z" embedded />,
    );
    const button = markup.slice(markup.indexOf("<button "));

    expect(button).toMatch(TOUCH_TARGET);
  });
});
