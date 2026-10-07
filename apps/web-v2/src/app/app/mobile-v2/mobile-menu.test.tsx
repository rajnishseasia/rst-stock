import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";
import { MOBILE_MENU_SECTIONS, MobileV2MenuPanel, navigateMobileMenuSection } from "./mobile-menu";

const account = { id: "paper", accountId: "PA1", accountType: "PAPER", username: "trader" };
function menu(overrides: Partial<Parameters<typeof MobileV2MenuPanel>[0]> = {}) {
  return MobileV2MenuPanel({
    active: "markets", accountMode: "PAPER", onAccountModeChange: () => {},
    onChange: () => {}, onNavigateSection: () => {}, onClose: () => {},
    menuRef: { current: null }, ...overrides,
  });
}

describe("MobileV2Menu", () => {
  test("renders a compact drawer with a top-right close control", () => {
    const tree = menu();
    const elements = flattenElements(tree);
    const surface = elements.find((element) => element.props["data-mobile-menu-surface"] === "true");
    const header = elements.find((element) => element.props["data-mobile-menu-header"] === "true");
    expect(String(surface?.props.className)).toContain("w-[min(88vw,420px)]");
    expect(String(surface?.props.className)).toContain("overflow-y-auto");
    expect(String(header?.props.className)).toContain("justify-between");
    expect(renderToStaticMarkup(tree)).toContain("Ready Set Trade");
  });

  test("uses compact icon grids and useful emoji shortcuts", () => {
    const markup = renderToStaticMarkup(menu({ balance: { short: "$12.4K", long: "$12,400.00" } }));
    expect(markup).toContain('data-mobile-menu-destinations="true" class="mt-4 grid grid-cols-2');
    expect(markup).toContain('data-mobile-menu-sections="true" class="grid grid-cols-2');
    expect(markup).toContain("<svg");
    for (const emoji of ["📰", "🔁", "⭐", "📊", "💼", "🏆", "📖", "⚙️"]) expect(markup).toContain(emoji);
    expect(markup).toContain("$12.4K");
  });

  test("keeps only useful shortcuts and all secondary pages", () => {
    expect(MOBILE_MENU_SECTIONS.map(({ key }) => key)).toEqual([
      "traders:feed", "traders:following", "traders:watchlist",
      "account:positions", "account:portfolio",
    ]);
    const markup = renderToStaticMarkup(menu());
    for (const href of ["/lb", "/guide", "/settings", "/legal"]) expect(markup).toContain(`href="${href}"`);
    for (const removed of ["Top X", "Top Users", "Closed", "Orders"]) expect(markup).not.toContain(`>${removed}</button>`);
  });

  test("routes destinations, shortcuts, execution mode, and close", () => {
    const calls: string[] = [];
    const tree = menu({
      paperAccount: account, liveAccount: { ...account, id: "live", accountType: "LIVE" },
      onChange: (screen) => calls.push(`screen:${screen}`),
      onNavigateSection: ({ screen, tab }) => calls.push(`section:${screen}:${tab}`),
      onAccountModeChange: (mode) => calls.push(`mode:${mode}`), onClose: () => calls.push("close"),
    });
    click(findByAriaLabel(tree, "Trade"));
    click(flattenElements(tree).find((element) => element.props["data-mobile-menu-section"] === "account:positions"));
    click(flattenElements(tree).find((element) => element.props["aria-pressed"] === false));
    click(flattenElements(tree).find((element) => element.props["aria-label"] === "Close navigation menu" && String(element.props.className).includes("min-w-11")));
    expect(calls).toEqual(["screen:chart", "close", "section:account:positions", "close", "mode:LIVE", "close"]);
  });

  test("selects a section tab before changing its screen", () => {
    const calls: string[] = [];
    navigateMobileMenuSection({ screen: "traders", tab: "following" }, {
      setTradersTab: (tab) => calls.push(`traders:${tab}`),
      setAccountTab: (tab) => calls.push(`account:${tab}`),
      setScreen: (screen) => calls.push(`screen:${screen}`),
    });
    expect(calls).toEqual(["traders:following", "screen:traders"]);
  });

  test("retains modal, safe-area, and execution-mode contracts", () => {
    const markup = renderToStaticMarkup(menu({
      active: "traders", paperAccount: account,
      liveAccount: { ...account, id: "live", accountType: "LIVE" }, accountMode: "LIVE",
    }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Execution mode"');
    expect(markup).toContain("env(safe-area-inset-top)");
    expect(markup).toContain("env(safe-area-inset-bottom)");
  });
});
