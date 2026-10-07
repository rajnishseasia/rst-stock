import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DegradedNotice } from "./degraded-notice";

type AnyElement = ReactElement<Record<string, unknown>>;

function findElement(
  node: ReactNode,
  matches: (props: Record<string, unknown>) => boolean,
): AnyElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as AnyElement;
  if (matches(element.props)) return element;
  return findElement(element.props.children as ReactNode, matches);
}

describe("DegradedNotice", () => {
  test("says what is missing in plain words and offers a touch-sized retry", () => {
    const html = renderToStaticMarkup(
      <DegradedNotice
        message="Some signals could not be loaded."
        onRetry={() => {}}
      />,
    );
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";

    expect(html).toContain('role="status"');
    expect(html).toContain("Some signals could not be loaded.");
    expect(html).toContain(">Retry</button>");
    expect(button).toContain("min-h-11");
    expect(button).toContain('type="button"');
  });

  test("renders the message alone when there is nothing to retry", () => {
    const html = renderToStaticMarkup(
      <DegradedNotice message="Some signals could not be loaded." />,
    );

    expect(html).toContain("Some signals could not be loaded.");
    expect(html).not.toContain("<button");
  });

  test("runs the caller's retry handler", () => {
    let retries = 0;
    const tree = DegradedNotice({
      message: "Some signals could not be loaded.",
      onRetry: () => {
        retries += 1;
      },
    });
    const button = findElement(
      tree,
      (props) => props.type === "button" && typeof props.onClick === "function",
    );

    expect(button).not.toBeNull();
    const onClick = button?.props.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick?.();
    expect(retries).toBe(1);
  });

  test("marks an in-flight retry busy and disables a second tap", () => {
    const html = renderToStaticMarkup(
      <DegradedNotice
        message="Some signals could not be loaded."
        onRetry={() => {}}
        retrying
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Retrying");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
