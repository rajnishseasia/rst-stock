import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildCallerProfileHref,
  CallerSourceLink,
  callerSourceLinkLabel,
} from "./leaderboard-row-cells";

describe("outbound source link on a leaderboard row", () => {
  test("links out in a new tab, without leaking a referrer", () => {
    const markup = renderToStaticMarkup(
      <CallerSourceLink
        url="https://x.com/alice/status/1"
        displayName="Alice"
      />,
    );

    expect(markup).toContain('href="https://x.com/alice/status/1"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
  });

  test("renders nothing when the caller has no linkable call", () => {
    // The server emits null for a caller whose retained calls carry only a
    // board-root URL. A disabled or dead link would be worse than no link.
    expect(
      renderToStaticMarkup(<CallerSourceLink url={null} displayName="Alice" />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <CallerSourceLink url={undefined} displayName="Alice" />,
      ),
    ).toBe("");
  });

  test("rejects unsafe and non-post source URLs at the render boundary", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<p>unsafe</p>",
      "/lb/x/not-a-source",
      "https://paste.trade/",
      "https://user:password@example.com/a/status/1",
    ]) {
      expect(
        renderToStaticMarkup(
          <CallerSourceLink url={url} displayName="Alice" />,
        ),
      ).toBe("");
    }
  });

  test("the accessible name carries the caller, not just 'link'", () => {
    const markup = renderToStaticMarkup(
      <CallerSourceLink url="https://x.com/a/status/1" displayName="Alice" />,
    );

    expect(markup).toContain(
      'aria-label="Read Alice&#x27;s latest call on the original site"',
    );
  });

  test("keeps a 44px touch target on the phone and the dense pill from sm up", () => {
    const markup = renderToStaticMarkup(
      <CallerSourceLink url="https://x.com/a/status/1" displayName="Alice" />,
    );

    expect(markup).toContain("h-11");
    expect(markup).toContain("sm:h-7");
  });

  test("a blank display name still produces a usable label", () => {
    expect(callerSourceLinkLabel("   ")).toBe(
      "Read this caller's latest call on the original site",
    );
  });

  test("encodes canonical profile keys as one safe route segment", () => {
    expect(
      buildCallerProfileHref(
        { key: "source_author:x:author/42?display=Jane Q. O'Neil" },
        "30d",
        7,
      ),
    ).toEqual({
      pathname:
        "/lb/x/source_author%3Ax%3Aauthor%2F42%3Fdisplay%3DJane%20Q.%20O'Neil",
      query: { h: "7" },
    });
  });
});
