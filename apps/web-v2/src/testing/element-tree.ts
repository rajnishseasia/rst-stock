/**
 * Tiny React element-tree walker for behavioral component tests.
 *
 * `renderToStaticMarkup` proves what a component PAINTS, but the markup carries
 * no handlers, and this app has no DOM test environment. For leaf components
 * that use no hooks, calling the component function returns its element tree, so
 * these helpers let a test find a control by its accessible name and invoke the
 * handler the component actually wired to it. That replaces the source-string
 * assertions the audit (H7) tells us to delete.
 *
 * Not a general-purpose renderer: it never runs hooks and never resolves a
 * composite element's own output, only the children handed to it.
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

type AnyProps = Record<string, unknown>;

export type TestElement = ReactElement<AnyProps>;

/** Every element in a tree, depth-first, parents before children. */
export function flattenElements(node: ReactNode): TestElement[] {
  const found: TestElement[] = [];

  const visit = (current: ReactNode) => {
    for (const child of Children.toArray(current)) {
      if (!isValidElement(child)) continue;
      const element = child as TestElement;
      found.push(element);
      visit(element.props.children as ReactNode);
    }
  };

  visit(node);
  return found;
}

/** First element whose `aria-label` matches exactly. */
export function findByAriaLabel(
  node: ReactNode,
  label: string,
): TestElement | undefined {
  return flattenElements(node).find(
    (element) => element.props["aria-label"] === label,
  );
}

/** First element carrying a matching `title` attribute. */
export function findByTitle(
  node: ReactNode,
  title: string,
): TestElement | undefined {
  return flattenElements(node).find((element) => element.props.title === title);
}

/** Concatenated text of every string/number leaf in a tree. */
export function elementText(node: ReactNode): string {
  let text = "";

  const visit = (current: ReactNode) => {
    for (const child of Children.toArray(current)) {
      if (typeof child === "string" || typeof child === "number") {
        text += String(child);
        continue;
      }
      if (isValidElement(child)) {
        visit((child as TestElement).props.children as ReactNode);
      }
    }
  };

  visit(node);
  return text;
}

/** Invokes an element's click handler, failing loudly when there isn't one. */
export function click(element: TestElement | undefined): void {
  const handler = element?.props.onClick;
  if (typeof handler !== "function") {
    throw new Error("Element has no onClick handler");
  }
  (handler as (event: unknown) => void)({
    stopPropagation() {},
    preventDefault() {},
  });
}
