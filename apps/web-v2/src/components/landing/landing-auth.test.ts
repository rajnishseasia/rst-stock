import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * LandingNav and CtaSection must start Google sign-in from their terminal
 * CTAs, never hand an anonymous visitor a direct link into the authenticated
 * app. This used to be a readFileSync + regex test; the audit rule in
 * CLAUDE.md bans that (it pins source text, not behavior, and cannot fail
 * when the markup is broken but the string still happens to appear).
 *
 * `renderToStaticMarkup` proves the "no /app link" half directly: the real
 * rendered markup is checked for the href, not the source that produced it.
 * It cannot prove the "starts sign-in" half on its own, because React does
 * not serialize event handlers into HTML output, so there is nothing in the
 * markup string to assert on.
 *
 * Both files are "use client" components with real hooks (useState,
 * useScroll, useReducedMotion, ...), so they cannot be called directly as
 * plain functions the way a hookless leaf component can (see
 * @/testing/element-tree) - React would throw "Invalid hook call" outside an
 * actual render pass. The repo also has no DOM test environment or React
 * test renderer, so there is no way to fireEvent.click on a real node.
 *
 * Instead, this intercepts the react/jsx-runtime calls the two files make
 * for their OWN authored JSX (never framer-motion's internals): every place
 * either file hands an `onClick` to a `<button>` or to `MagneticButton` is
 * captured with the real prop value during an actual renderToStaticMarkup
 * pass, then that captured function is invoked exactly like a click would,
 * and checked against a spied `signInWithGoogle`. That fails if a CTA loses
 * its handler, is wired to something else, or the handler stops calling
 * signInWithGoogle - not on reformatting, renames, or code motion.
 */

const realJsxRuntime = (await import("react/jsx-runtime")) as {
  Fragment: unknown;
  jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
  jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
};
const trueJsx = realJsxRuntime.jsx;
const trueJsxs = realJsxRuntime.jsxs;
const trueFragment = realJsxRuntime.Fragment;

// Bun's transpiler (or a dependency's own build) may go through either the
// production or the dev jsx-runtime, so both are instrumented.
let trueJsxDEV: ((...args: unknown[]) => unknown) | undefined;
try {
  const realDevRuntime = (await import("react/jsx-dev-runtime")) as {
    jsxDEV: (...args: unknown[]) => unknown;
  };
  trueJsxDEV = realDevRuntime.jsxDEV;
} catch {
  trueJsxDEV = undefined;
}

/** Every `type`/`onClick` pair either file hands directly to its own JSX. */
const clicksSeen: Array<{ type: unknown; onClick: unknown }> = [];

function recordClick(type: unknown, props: unknown) {
  if (props && typeof props === "object" && "onClick" in (props as object)) {
    clicksSeen.push({ type, onClick: (props as { onClick: unknown }).onClick });
  }
}

mock.module("react/jsx-runtime", () => ({
  Fragment: trueFragment,
  jsx: (type: unknown, props: unknown, key?: unknown) => {
    recordClick(type, props);
    return trueJsx(type, props, key);
  },
  jsxs: (type: unknown, props: unknown, key?: unknown) => {
    recordClick(type, props);
    return trueJsxs(type, props, key);
  },
}));

if (trueJsxDEV) {
  const jsxDEV = trueJsxDEV;
  mock.module("react/jsx-dev-runtime", () => ({
    Fragment: trueFragment,
    jsxDEV: (type: unknown, props: unknown, ...rest: unknown[]) => {
      recordClick(type, props);
      return jsxDEV(type, props, ...rest);
    },
  }));
}

// mock.module replaces the module for the rest of the bun:test process, not
// just this file, so every other real export is preserved here and only
// signInWithGoogle is swapped for a spy. A mock that dropped useSession,
// signIn, etc. would silently break any other test file that imports them
// after this one runs.
const realAuthClient = (await import("@/lib/auth-client")) as Record<string, unknown>;
let signInCallCount = 0;
mock.module("@/lib/auth-client", () => ({
  ...realAuthClient,
  signInWithGoogle: () => {
    signInCallCount += 1;
  },
}));

const { LandingNav } = await import("./landing-nav");
const { CtaSection } = await import("./cta-section");
const { MagneticButton } = await import("./fx");

/** Click handlers either file wires directly onto a button-like control. */
function ctaClickHandlers(): Array<() => void> {
  return clicksSeen
    .filter((c) => c.type === "button" || c.type === MagneticButton)
    .map((c) => c.onClick as () => void);
}

describe("landing authentication entry points", () => {
  test("terminal CTAs start sign-in instead of linking anonymous users to /app", () => {
    signInCallCount = 0;

    clicksSeen.length = 0;
    const navMarkup = renderToStaticMarkup(createElement(LandingNav));
    const navHandlers = ctaClickHandlers();

    clicksSeen.length = 0;
    const ctaMarkup = renderToStaticMarkup(createElement(CtaSection));
    const ctaHandlers = ctaClickHandlers();

    // Nav has exactly one wired control: the "Enter the Terminal" button.
    expect(navHandlers.length).toBe(1);
    // CtaSection has two: the hero's magnetic CTA and the footer's sign-in
    // button.
    expect(ctaHandlers.length).toBe(2);

    // Clicking every one of them starts Google sign-in.
    for (const onClick of [...navHandlers, ...ctaHandlers]) {
      expect(typeof onClick).toBe("function");
      onClick();
    }
    expect(signInCallCount).toBe(navHandlers.length + ctaHandlers.length);

    // No anonymous visitor is ever handed a direct link into the
    // authenticated app; both surfaces must gate entry through sign-in
    // instead.
    expect(navMarkup).not.toContain('href="/app"');
    expect(ctaMarkup).not.toContain('href="/app"');
  });
});
