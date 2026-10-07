import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MobileBottomNav } from "@/components/layout/mobile-nav";
import { AlpacaCredentialReimportNotice } from "@/lib/alpaca-credential-reimport-notice";
import { MobileMarketsScreen } from "./markets-screen";
import { MobileV2Frame, MobileV2Header } from "./mobile-frame";

type AnyElement = ReactElement<Record<string, unknown>>;

/** Depth-first search of an element tree for the first element matching. */
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

function renderFrame(
  headerProps: Partial<Parameters<typeof MobileV2Header>[0]> = {},
  notice?: ReactNode,
) {
  return renderToStaticMarkup(
    <MobileV2Frame
      header={
        <MobileV2Header
          title="Markets"
          subtitle="Discover instruments"
          onOpenMenu={() => {}}
          onOpenSearch={() => {}}
          accountValueState="available"
          accountValue="$12,500.25"
          {...headerProps}
        />
      }
      content={<p>Scrollable market content</p>}
      navigation={<button type="button">Account</button>}
      notice={notice}
      overlay={null}
    />,
  );
}

describe("MobileV2Frame", () => {
  test("provides one semantic main landmark and keeps content in a bounded scroller", () => {
    const html = renderFrame();

    expect((html.match(/<main\b/g) ?? []).length).toBe(1);
    expect(html).toContain('data-mobile-v2-content="true"');
    expect(html).toContain("min-h-0");
    expect(html).toContain("overflow-y-auto");
    // A flex column, so a destination can grow to the full scroll height and
    // center an empty state in the slack instead of leaving it underneath.
    expect(html).toMatch(/<main\b[^>]*class="[^"]*\bflex-col\b/);
  });

  // The venue used to be a 49px bar between the header and `main` on four of
  // the five destinations, two of which read the venue nowhere at all. It is
  // routed to the screens that read it now, so the shell owns no venue slot
  // and `main` starts directly under the app bar on every destination.
  test("owns no venue slot: main starts directly under the header", () => {
    const html = renderFrame();

    expect(html).not.toContain("data-mobile-v2-venue-bar");
    expect(html.indexOf('data-mobile-v2-header="true"')).toBeLessThan(
      html.indexOf('data-mobile-v2-content="true"'),
    );
    const between = html.slice(
      html.indexOf("</header>") + "</header>".length,
      html.indexOf("<main"),
    );
    expect(between.trim()).toBe("");
  });

  test("keeps the persistent recovery notice in flow below the safe-area header", () => {
    const actions: string[] = [];
    const header = MobileV2Header({
      title: "Ready Set Trade",
      subtitle: "Markets",
      onOpenMenu: () => actions.push("menu"),
      onOpenSearch: () => actions.push("search"),
    });
    const frame = MobileV2Frame({
      header,
      notice: (
        <AlpacaCredentialReimportNotice
          accounts={[{ provider: "alpaca", accountType: "PAPER", needsReentry: true }]}
          dismissed
          now={new Date("2026-09-13T00:00:00.000Z")}
        />
      ),
      content: <p>Scrollable market content</p>,
      navigation: <button type="button">Account</button>,
    });
    const html = renderToStaticMarkup(frame);
    const headerBottom = html.indexOf("</header>");
    const notice = html.indexOf('role="alert"');
    const main = html.indexOf("<main");
    const frameTag =
      html.match(/<div data-mobile-v2-frame="true" class="([^"]+)"/)?.[1] ?? "";
    const noticeTag = html.match(/<div role="alert" class="([^"]+)"/)?.[1] ?? "";

    // In the mobile flex column, the actual recovery alert follows the header
    // that owns env(safe-area-inset-top). Normal flow keeps it below the full
    // header height at any viewport width or safe-area inset.
    expect(headerBottom).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(headerBottom);
    expect(notice).toBeLessThan(main);
    expect(html.slice(0, main)).toContain("env(safe-area-inset-top)");
    expect(frameTag).toContain("flex-col");
    expect(noticeTag).not.toContain("fixed");
    expect(noticeTag).not.toContain("absolute");

    const menu = findElement(
      frame,
      (props) => props["aria-label"] === "Open menu",
    );
    const search = findElement(frame, (props) => props["aria-label"] === "Search");
    (menu?.props.onClick as (() => void) | undefined)?.();
    (search?.props.onClick as (() => void) | undefined)?.();
    expect(actions).toEqual(["menu", "search"]);
  });

  test("provides a keyboard-visible skip link to the focusable mobile main", () => {
    const html = renderFrame();

    expect(html).toContain('href="#mobile-v2-main"');
    expect(html).toContain(">Skip to main content</a>");
    expect(html).toContain('id="mobile-v2-main"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("sr-only");
    expect(html).toContain("focus:not-sr-only");
  });

  test("keeps the skip link out of shell flow and contains horizontal page overflow", () => {
    const html = renderFrame();
    const skipLink = html.match(/<a href="#mobile-v2-main"[^>]*>/)?.[0] ?? "";
    const main = html.match(/<main\b[^>]*>/)?.[0] ?? "";

    expect(skipLink).toContain("focus:absolute");
    expect(skipLink).toContain("focus:top-[calc(0.5rem+env(safe-area-inset-top))]");
    expect(main).toContain("overflow-x-hidden");
    expect((html.match(/overflow-y-auto/g) ?? []).length).toBe(1);
  });

  test("owns horizontal landscape insets once instead of duplicating them in the header", () => {
    const html = renderFrame();
    const header = html.match(/<header\b[^>]*>/)?.[0] ?? "";

    expect(html).toContain("pl-[env(safe-area-inset-left)]");
    expect(html).toContain("pr-[env(safe-area-inset-right)]");
    expect(header).toContain("px-3");
    expect(header).not.toContain("safe-area-inset-left");
    expect(header).not.toContain("safe-area-inset-right");
  });

  test("uses one supplied header and one global Search action", () => {
    const html = renderFrame();

    expect((html.match(/<header\b/g) ?? []).length).toBe(1);
    expect((html.match(/aria-label="Search"/g) ?? []).length).toBe(1);
    expect(html).toContain(">Markets</p>");
    expect(html).toContain("Discover instruments");
  });

  test("renders the real bull emblem as the brand mark, not a placeholder letter", () => {
    const html = renderFrame({ title: "Ready Set Trade" });
    const mark =
      html.match(/<img\b[^>]*data-mobile-v2-brand-mark="true"[^>]*>/)?.[0] ?? "";

    // The mark is the brand asset the desktop header and landing nav use, on
    // the shell's dark surface, and it is decorative next to the wordmark.
    expect(mark).not.toBe("");
    expect(mark).toContain("emblem-dark.png");
    expect(mark).toContain('alt=""');
    expect(mark).toContain("size-8");
    expect(mark).toContain("shrink-0");
    expect(html).not.toContain(">R</span>");
    expect(html).toContain(">Ready Set Trade</p>");
  });

  test("ports the preview chrome with account context", () => {
    const html = renderFrame();

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("bg-[#020f16]/95");
    expect(html).toContain("border-[#142b34]");
    expect(html).toContain('data-mobile-v2-account-context="true"');
    expect(html).toContain("bg-[#071a23]");
  });

  test("keeps account value honest across available, loading, and unavailable states", () => {
    const available = renderFrame({
      accountValueState: "available",
      accountValue: "$12,500.25",
    });
    const loading = renderFrame({
      accountValueState: "loading",
      accountValue: null,
    });
    const unavailable = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
    });

    expect(available).toContain("$12,500.25");
    expect(available).toContain('data-account-value-state="available"');
    expect(loading).toContain("Checking account value");
    expect(loading).not.toContain("$0.00");
    expect(unavailable).toContain("Not available right now");
    expect(unavailable).not.toContain("Account value unavailable");
    expect(unavailable).not.toContain("$0.00");
  });

  test("does not render an empty value as available", () => {
    const html = renderFrame({
      accountValueState: "available",
      accountValue: null,
    });

    expect(html).toContain('data-account-value-state="unavailable"');
    expect(html).toContain("Not available right now");
  });

  test("offers Connect when no venue is connected and routes it to Account", () => {
    let opened = 0;
    const html = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
      accountValueReason: "not-connected",
      onOpenAccount: () => {
        opened += 1;
      },
    });
    const action =
      html.match(/<button[^>]*data-mobile-v2-account-action="true"[^>]*>/)?.[0] ??
      "";

    expect(html).toContain('data-account-value-reason="not-connected"');
    expect(html).toContain("No broker connected");
    expect(html).toContain("Connect");
    expect(action).toContain("min-h-11");
    expect(action).toContain('type="button"');

    const header = MobileV2Header({
      title: "Markets",
      onOpenMenu: () => {},
      onOpenSearch: () => {},
      accountValueState: "unavailable",
      accountValue: null,
      accountValueReason: "not-connected",
      onOpenAccount: () => {
        opened += 1;
      },
    });
    const button = findElement(
      header,
      (props) => props["data-mobile-v2-account-action"] === "true",
    );
    expect(button).not.toBeNull();
    (button?.props.onClick as (() => void) | undefined)?.();
    expect(opened).toBe(1);
  });

  test("names a failed venue check without prompting to connect", () => {
    const html = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
      accountValueReason: "venue-check-failed",
      onOpenAccount: () => {},
    });

    expect(html).toContain("A venue could not be checked");
    expect(html).not.toContain('data-mobile-v2-account-action="true"');
    expect(html).not.toContain("Connect");
  });

  test("does not offer Connect without a handler to route it", () => {
    const html = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
      accountValueReason: "not-connected",
    });

    expect(html).toContain("No broker connected");
    expect(html).not.toContain('data-mobile-v2-account-action="true"');
    expect(html).not.toContain("Connect");
  });

  test("sets a status sentence in the reading font, not the data font", () => {
    const available = renderFrame({
      accountValueState: "available",
      accountValue: "$12,500.25",
    });
    const unavailable = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
    });
    const valueClass = (html: string) =>
      html.match(/<span data-mobile-v2-account-value="true" class="([^"]+)"/)?.[1] ??
      "";

    expect(valueClass(available)).toContain("font-data");
    expect(valueClass(available)).toContain("tabular-nums");
    expect(valueClass(unavailable)).not.toContain("font-data");
    expect(valueClass(unavailable)).not.toContain("tabular-nums");
  });

  test("fails closed for unknown or stale account values instead of showing cached data", () => {
    const states = [
      ["unknown", "unavailable"],
      ["stale", "unavailable"],
      ["offline", "unavailable"],
      ["fetching", "loading"],
      ["unexpected-status", "unavailable"],
    ] as const;

    for (const [state, expectedState] of states) {
      const html = renderFrame({
        accountValueState: state,
        accountValue: "$12,500.25",
      });

      expect(html).toContain(`data-account-value-state="${expectedState}"`);
      expect(html).not.toContain("$12,500.25");
    }
  });

  test("requires an explicit available state before showing an account value", () => {
    const html = renderFrame({
      accountValueState: undefined,
      accountValue: "$12,500.25",
    });

    expect(html).toContain('data-account-value-state="unavailable"');
    expect(html).not.toContain("$12,500.25");
  });

  test("keeps long confirmed account values readable without truncation", () => {
    const html = renderFrame({
      accountValueState: "available",
      accountValue: "portfolio $123,456,789.01",
    });
    const value =
      html.match(/<span data-mobile-v2-account-value="true"[^>]*>/)?.[0] ?? "";

    expect(html).toContain("portfolio $123,456,789.01");
    expect(value).toContain("min-w-0");
    expect(value).toContain("break-words");
    expect(value).toContain("whitespace-normal");
    expect(value).not.toContain("truncate");
  });

  test("folds the account chip into the single app-bar row", () => {
    const html = renderFrame();
    const rowStart = html.indexOf('data-mobile-v2-header-row="true"');
    const chip = html.indexOf('data-mobile-v2-account-context="true"');
    const search = html.indexOf('aria-label="Search"');
    const headerClose = html.indexOf("</header>");

    expect((html.match(/data-mobile-v2-header-row="true"/g) ?? []).length).toBe(1);
    expect(rowStart).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(rowStart);
    expect(chip).toBeLessThan(search);
    expect(search).toBeLessThan(headerClose);
    // No second full-width strip under the row.
    expect(html).not.toContain(">Account value</span>");
  });

  test("paints the compact value in the chip and keeps the exact value in the accessible text", () => {
    let opened = 0;
    const html = renderFrame({
      accountValueState: "available",
      accountValue: "portfolio $12,500.25",
      accountValueCompact: "$12.5K",
      onOpenAccount: () => {
        opened += 1;
      },
    });
    const chip =
      html.match(/<button[^>]*data-mobile-v2-account-link="true"[\s\S]*?<\/button>/)?.[0] ?? "";

    expect(chip).toContain('aria-hidden="true">$12.5K</span>');
    expect(chip).toContain('class="sr-only">portfolio $12,500.25</span>');
    expect(chip).toContain("min-h-11");
    expect(chip).toContain("font-data");
    expect(chip).toContain("tabular-nums");
    // Without a handler the chip is a status, not a control.
    expect(
      renderFrame({
        accountValueState: "available",
        accountValue: "$12,500.25",
      }),
    ).not.toContain('data-mobile-v2-account-link="true"');

    const header = MobileV2Header({
      title: "Markets",
      onOpenMenu: () => {},
      onOpenSearch: () => {},
      accountValueState: "available",
      accountValue: "$12,500.25",
      accountValueCompact: "$12.5K",
      onOpenAccount: () => {
        opened += 1;
      },
    });
    const link = findElement(
      header,
      (props) => props["data-mobile-v2-account-link"] === "true",
    );
    (link?.props.onClick as (() => void) | undefined)?.();
    expect(opened).toBe(1);
  });

  test("keeps the chip's non-value states short on screen and full in the accessible text", () => {
    const loading = renderFrame({ accountValueState: "loading", accountValue: null });
    const failed = renderFrame({
      accountValueState: "unavailable",
      accountValue: null,
      accountValueReason: "venue-check-failed",
    });

    expect(loading).toContain('aria-hidden="true">Checking</span>');
    expect(loading).toContain('class="sr-only">Checking account value…</span>');
    expect(failed).toContain('aria-hidden="true">Check failed</span>');
    expect(failed).toContain('class="sr-only">A venue could not be checked</span>');
  });

  test("pins an optional action bar between the content and the navigation, in flow", () => {
    const withBar = renderToStaticMarkup(
      <MobileV2Frame
        header={<header>app bar</header>}
        content={<p>content</p>}
        actionBar={<div data-testid="pinned-actions">Long / Short</div>}
        navigation={<nav>nav</nav>}
      />,
    );
    const slotClass =
      withBar.match(/data-mobile-v2-action-slot="true"[^>]*class="([^"]+)"/)?.[1] ?? "";

    expect(withBar).toContain('data-testid="pinned-actions"');
    expect(withBar.indexOf('data-mobile-v2-action-slot="true"')).toBeGreaterThan(
      withBar.indexOf("</main>"),
    );
    expect(withBar.indexOf('data-mobile-v2-action-slot="true"')).toBeLessThan(
      withBar.indexOf('data-mobile-v2-navigation-slot="true"'),
    );
    expect(slotClass).toContain("shrink-0");
    expect(slotClass).not.toContain("fixed");
    expect(slotClass).not.toContain("overflow-y-auto");
    // `main` is still the only scroller.
    expect((withBar.match(/overflow-y-auto/g) ?? []).length).toBe(1);
    expect(renderFrame()).not.toContain('data-mobile-v2-action-slot="true"');
  });

  test("puts navigation in an in-flow safe-area slot", () => {
    const html = renderFrame();

    expect(html).toContain('data-mobile-v2-navigation-slot="true"');
    expect(html).toContain("shrink-0");
    expect(html).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(html).not.toContain("fixed inset-x-0 bottom-0");
  });

  test("contains the mobile shell below xl without adding duplicate app chrome", () => {
    const html = renderFrame();

    expect(html).toContain("xl:hidden");
    expect((html.match(/data-mobile-v2-header="true"/g) ?? []).length).toBe(1);
    expect((html.match(/data-mobile-v2-navigation-slot="true"/g) ?? []).length).toBe(1);
  });

  test("composes the real bottom nav with exactly one bottom safe-area inset", () => {
    const html = renderToStaticMarkup(
      <MobileV2Frame
        header={
          <MobileV2Header
            title="Markets"
            onOpenMenu={() => {}}
            onOpenSearch={() => {}}
            accountValueState="available"
            accountValue="$12,500.25"
          />
        }
        content={
          <MobileMarketsScreen
            accountSummary={<div>Account summary</div>}
            marketBrowse={<div>Browse panel</div>}
            onOpenSearch={() => {}}
          />
        }
        navigation={
          <MobileBottomNav
            active="markets"
            onChange={() => {}}
          />
        }
      />,
    );

    expect((html.match(/safe-area-inset-bottom/g) ?? []).length).toBe(1);
    expect((html.match(/safe-area-inset-left/g) ?? []).length).toBe(1);
    expect((html.match(/safe-area-inset-right/g) ?? []).length).toBe(1);
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="mobile-markets-screen"');
    expect(html).toContain(">Markets</h1>");
    expect(html).toContain('aria-label="Mobile app navigation"');
  });
});

describe("MobileV2Header", () => {
  test("exposes 44px menu and search targets with tabular account values", () => {
    const html = renderToStaticMarkup(
      <MobileV2Header
        title="Account"
        onOpenMenu={() => {}}
        onOpenSearch={() => {}}
        accountValueState="available"
        accountValue="$12,500.25"
      />,
    );

    expect(html).toContain('aria-label="Open menu"');
    expect(html).toContain('aria-label="Search"');
    expect((html.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("tabular-nums");
  });

  test("keeps the compact command hierarchy polished for touch and keyboard input", () => {
    const html = renderToStaticMarkup(
      <MobileV2Header
        title="Account"
        subtitle="Account workspace"
        onOpenMenu={() => {}}
        onOpenSearch={() => {}}
        accountValueState="available"
        accountValue="$12,500.25"
      />,
    );

    expect(html).toContain('data-mobile-v2-header-row="true"');
    expect(html).toContain('data-mobile-v2-account-value="true"');
    expect(html).toContain("active:scale-[0.96]");
    expect(html).toContain("motion-reduce:active:scale-100");
    expect(html).toContain("focus-visible:ring-offset-2");
    expect(html).toContain("focus-visible:ring-offset-[#020f16]");
  });
});
