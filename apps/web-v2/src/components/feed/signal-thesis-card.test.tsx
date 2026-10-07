import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignalThesisCard } from "./signal-thesis-card";
import type { SignalThesis } from "./signal-thesis";

function thesis(overrides: Partial<SignalThesis> = {}): SignalThesis {
  return {
    authorName: "Alice",
    authorAvatar: null,
    timestamp: "2026-03-10T10:00:00.000Z",
    url: null,
    imageUrl: null,
    direction: null,
    ...overrides,
  };
}

function render(props: Parameters<typeof SignalThesisCard>[0]) {
  return renderToStaticMarkup(<SignalThesisCard {...props} />);
}

describe("the thesis on the chart screen", () => {
  test("renders the caller and the body they wrote", () => {
    const markup = render({
      thesis: thesis(),
      content: "NVDA into earnings, sizing small",
    });

    expect(markup).toContain("Alice");
    expect(markup).toContain("NVDA into earnings, sizing small");
  });

  test("a call with no stated direction shows NO direction badge", () => {
    // The single most important assertion in this file. The classifier resolves
    // absent direction metadata to "buy", so anything reading `side` here would
    // print a confident Long under a chart one tap from an order ticket.
    const markup = render({ thesis: thesis(), content: "watching NVDA" });

    expect(markup).not.toContain(">Long<");
    expect(markup).not.toContain(">Short<");
  });

  test("a stated direction is shown, and shown as the caller stated it", () => {
    expect(render({ thesis: thesis({ direction: "short" }), content: "x" })).toContain(
      ">Short<",
    );
    expect(render({ thesis: thesis({ direction: "long" }), content: "x" })).toContain(
      ">Long<",
    );
  });

  test("carries the outbound source link through to the chart screen", () => {
    const markup = render({
      thesis: thesis({ url: "https://x.com/alice/status/1" }),
      content: "long NVDA",
    });

    expect(markup).toContain('href="https://x.com/alice/status/1"');
    expect(markup).toContain('rel="noreferrer"');
  });

  test("the author is a real control when there is somewhere to open", () => {
    const withHandler = render({
      thesis: thesis(),
      content: "x",
      onOpenCaller: () => {},
    });
    const withoutHandler = render({ thesis: thesis(), content: "x" });

    expect(withHandler).toContain("<button");
    expect(withHandler).toMatch(/min-h-11/);
    // No handler, no affordance: a name that looks tappable and is not is worse
    // than plain text.
    expect(withoutHandler.slice(0, withoutHandler.indexOf("Alice"))).not.toContain(
      "<button",
    );
  });

  test("a blank author name falls back rather than rendering an empty label", () => {
    expect(render({ thesis: thesis({ authorName: "   " }), content: "x" })).toContain(
      "Unknown",
    );
  });
});
