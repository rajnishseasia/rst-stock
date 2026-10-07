import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";
import {
  MOBILE_NAV_ITEMS,
  MobileBottomNav,
  MobileNavMenu,
  isMobileNavItemActive,
  navigateMobileScreen,
  resolveMobileNavLabel,
  type MobileScreen,
} from "./mobile-nav";

function bottomNav(
  overrides: Partial<Parameters<typeof MobileBottomNav>[0]> = {},
) {
  return MobileBottomNav({
    active: "markets",
    onChange: () => {},
    ...overrides,
  });
}

describe("mobile bottom nav", () => {
  test("is announced as the app navigation", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).toContain('aria-label="Mobile app navigation"');
  });

  test("offers the four primary destinations in product order", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    // Feed and Copy merged into Traders (with Watchlist), which frees a slot.
    // The slot stays free: nothing is invented to fill it.
    expect(MOBILE_NAV_ITEMS.map(({ key, label, screen }) => ({ key, label, screen }))).toEqual([
      { key: "markets", label: "Markets", screen: "markets" },
      { key: "traders", label: "Traders", screen: "traders" },
      { key: "trade", label: "Trade", screen: "chart" },
      { key: "account", label: "Account", screen: "account" },
    ]);

    for (const label of ["Markets", "Traders", "Trade", "Account"]) {
      expect(markup).toContain(`>${label}</span>`);
    }
    for (const retired of ["Feed", "Copy", "Search", "Info"]) {
      expect(markup).not.toContain(`>${retired}</span>`);
    }
    expect(MOBILE_NAV_ITEMS[0]?.screen).toBe("markets");
  });

  test("hides itself on the desktop terminal", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).toContain("xl:hidden");
  });

  test("uses the preview's full-width premium chrome and gold active rule", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).toContain("w-full");
    expect(markup).toContain("bg-[#04141b]/97");
    expect(markup).toContain("border-[#1a323b]");
    expect(markup).toContain("focus-visible:ring-[#e7c65d]");
    expect(markup).toContain("bg-[#e7c65d]");
    expect(markup).toContain('aria-hidden="true"');
  });

  test("keeps each destination touchable with a clear active and primary state", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="traders" onChange={() => {}} />,
    );

    expect(markup).toContain('data-mobile-v2-nav-list="true"');
    expect(markup).toContain('data-mobile-v2-nav-item="traders"');
    expect(markup).toContain('data-mobile-v2-nav-state="active"');
    expect(markup).toContain('data-mobile-v2-nav-state="primary"');
    expect(markup).toContain("active:scale-[0.96]");
    expect(markup).toContain("motion-reduce:active:scale-100");
    expect(markup).toContain("focus-visible:ring-offset-1");
    expect(markup).toContain("focus-visible:ring-offset-[#04141b]");
  });

  test("marks the current destination with brighter text under the gold rule, not a filled pill", () => {
    // DESIGN.md: gold is a seasoning. The nav's only fill is Trade's warm
    // primary tint; the active destination is white text under the hairline.
    const buttons = flattenElements(bottomNav({ active: "traders" })).filter(
      (element) => element.props.type === "button",
    );
    const active = buttons.find(
      (element) => element.props["data-mobile-v2-nav-state"] === "active",
    );
    const activeClass = String(active?.props.className ?? "");

    expect(activeClass).toContain("text-white");
    expect(activeClass).not.toContain("bg-[#132e36]");
    expect(activeClass).not.toContain("text-[#f0d56c]");
    expect(activeClass).not.toContain("border-[#8d7834]");

    const markup = renderToStaticMarkup(
      <MobileBottomNav active="traders" onChange={() => {}} />,
    );
    expect(markup.match(/h-0\.5 w-7 rounded-full bg-\[#e7c65d\]/g)).toHaveLength(1);
  });

  test("keeps Trade's primary tint when Trade is the selected destination", () => {
    // Regression guard. The tint used to be an else-branch of isActive, which
    // was harmless only while Trade had no screen and could never be selected.
    // Trade is now the landing destination, so a cold open selects it and the
    // bar's one call to action rendered flat exactly when it was on screen.
    const selectedTrade = flattenElements(bottomNav({ active: "chart" })).find(
      (element) => element.props["data-mobile-v2-nav-item"] === "trade",
    );
    const selectedClass = String(selectedTrade?.props.className ?? "");

    expect(selectedClass).toContain("bg-[#201e12]");
    // Selected reads as white on the tint, not as the idle gold lettering.
    expect(selectedClass).toContain("text-white");
    expect(selectedClass).not.toContain("text-[#e7c65d]");

    const idleTrade = flattenElements(bottomNav({ active: "markets" })).find(
      (element) => element.props["data-mobile-v2-nav-item"] === "trade",
    );
    const idleClass = String(idleTrade?.props.className ?? "");

    expect(idleClass).toContain("bg-[#201e12]");
    expect(idleClass).toContain("text-[#e7c65d]");
  });

  test("leaves bottom safe-area ownership to the mobile frame", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).not.toContain("safe-area-inset-bottom");
  });

  test("stays edge-to-edge while leaving safe-area ownership to the mobile frame", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).toContain("w-full");
    expect(markup).not.toContain("mx-3");
    expect(markup).not.toContain("safe-area-inset-left");
    expect(markup).not.toContain("safe-area-inset-right");
    expect(markup).not.toContain("safe-area-inset-bottom");
  });

  test("marks only the current screen as the current page", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="traders" onChange={() => {}} />,
    );

    const current = markup.split("<button").filter((chunk) =>
      chunk.includes('aria-current="page"'),
    );

    expect(current).toHaveLength(1);
    expect(current[0]).toContain(">Traders</span>");
  });

  test("every destination is a 44px-tall touch target", () => {
    const buttons = flattenElements(bottomNav()).filter(
      (element) => element.props.type === "button",
    );

    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(String(button.props.className)).toContain("h-12");
    }
  });

  test("keeps the four-cell grid width-safe at the narrowest supported viewport", () => {
    const nav = bottomNav();
    const list = flattenElements(nav).find(
      (element) => element.props["data-mobile-v2-nav-list"] === "true",
    );
    const buttons = flattenElements(nav).filter(
      (element) => element.props["data-mobile-v2-nav-item"],
    );

    expect(String(list?.props.className)).toContain("w-full");
    expect(String(list?.props.className)).toContain("min-w-0");
    expect(String(list?.props.className)).toContain("grid-cols-4");
    expect(String(list?.props.className)).not.toContain("grid-cols-5");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(String(button.props.className)).toContain("min-w-0");
    }
  });

  test("keeps the Account cell stable when the supplied balance is long", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        active="markets"
        onChange={() => {}}
        balance={{ short: "$123,456,789.01", long: "portfolio $123,456,789.01" }}
      />,
    );
    const accountButton =
      markup.match(/<button[^>]*data-mobile-v2-nav-item="account"[\s\S]*?<\/button>/)?.[0] ?? "";

    expect(accountButton).toContain(">Account</span>");
    expect(accountButton).toContain('aria-label="Account, portfolio $123,456,789.01"');
    expect(accountButton).not.toContain("overflow-hidden");
  });

  test("paints the live balance in the Account cell under a stable label", () => {
    const withBalance = renderToStaticMarkup(
      <MobileBottomNav
        active="markets"
        onChange={() => {}}
        balance={{ short: "$12.4K", long: "portfolio $12,400.00" }}
      />,
    );
    const without = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );
    const accountButton =
      withBalance.match(/<button[^>]*data-mobile-v2-nav-item="account"[\s\S]*?<\/button>/)?.[0] ?? "";
    const value =
      accountButton.match(/<span[^>]*data-mobile-v2-nav-value="true"[^>]*>/)?.[0] ?? "";

    expect(accountButton).toContain(">Account</span>");
    expect(accountButton).toContain(">$12.4K</span>");
    // The exact amount is already in the accessible name; the painted compact
    // form is decorative to assistive technology.
    expect(value).toContain('aria-hidden="true"');
    expect(value).toContain("font-data");
    expect(value).toContain("tabular-nums");
    // Only the Account cell carries it, and only when there is a balance.
    expect((withBalance.match(/data-mobile-v2-nav-value="true"/g) ?? []).length).toBe(1);
    expect(without).not.toContain('data-mobile-v2-nav-value="true"');
  });

  test("keeps the nav to 8px of padding around 48px cells", () => {
    const nav = bottomNav();
    const list = flattenElements(nav).find(
      (element) => element.props["data-mobile-v2-nav-list"] === "true",
    );

    expect(String(list?.props.className)).toContain("min-h-14");
    expect(String(list?.props.className)).not.toContain("min-h-[4.5rem]");
    expect(String(nav.props.className)).toContain("pt-1");
    expect(String(nav.props.className)).toContain("pb-1");
  });

  test("Trade is a destination: it opens the chart screen, not the ticket", () => {
    // The ticket is opened from the chart screen's pinned Long/Short pair and
    // its Trade CTA, so a nav tap lands on the instrument first.
    const screens: MobileScreen[] = [];
    const nav = bottomNav({
      onChange: (screen) => screens.push(screen),
    });

    click(findByAriaLabel(nav, "Trade"));

    expect(screens).toEqual(["chart"]);
    expect(findByAriaLabel(nav, "Open trade ticket")).toBeUndefined();
  });

  test("a destination tap reports its own screen", () => {
    const screens: MobileScreen[] = [];
    const nav = bottomNav({
      onChange: (screen) => screens.push(screen),
    });

    click(findByAriaLabel(nav, "Traders"));
    click(findByAriaLabel(nav, "Markets"));

    expect(screens).toEqual(["traders", "markets"]);
  });

  test("Account is a destination with an accessible name", () => {
    const screens: MobileScreen[] = [];
    const nav = bottomNav({
      onChange: (screen) => screens.push(screen),
    });

    click(findByAriaLabel(nav, "Account"));

    expect(screens).toEqual(["account"]);
  });
});

describe("mobile navigation menu", () => {
  test("stays available below xl, including 1279px, and hides at xl", () => {
    const markup = renderToStaticMarkup(
      <MobileNavMenu
        active="markets"
        onChange={() => {}}
        accountMode="PAPER"
        onAccountModeChange={() => {}}
      />,
    );

    // Tailwind's xl breakpoint starts at 1280px: a plain class keeps this
    // trigger visible through 1279px, while xl:hidden removes it at xl.
    expect(markup).toContain("xl:hidden");
    expect(markup).not.toContain("lg:hidden");
  });

  test("disables menu animation when reduced motion is requested", () => {
    const menu = MobileNavMenu({
      active: "markets",
      onChange: () => {},
      accountMode: "PAPER",
      onAccountModeChange: () => {},
    });
    const content = flattenElements(menu).find((element) =>
      String(element.props.className).includes("max-h-[calc(100dvh-1rem)]"),
    );

    expect(String(content?.props.className)).toContain("motion-reduce:animate-none");
  });
});

describe("mobile nav destinations", () => {
  test("Trade is the chart screen, so it reads as current there and nowhere else", () => {
    const trade = MOBILE_NAV_ITEMS.find((item) => item.key === "trade");

    expect(trade?.screen).toBe("chart");
    expect(isMobileNavItemActive(trade!, "chart")).toBe(true);
    for (const screen of ["markets", "traders", "search", "account"] as const) {
      expect(isMobileNavItemActive(trade!, screen)).toBe(false);
    }
  });

  test("each screen item is active on its own screen only", () => {
    for (const item of MOBILE_NAV_ITEMS) {
      if (!item.screen) continue;
      expect(isMobileNavItemActive(item, item.screen)).toBe(true);
      const other: MobileScreen = item.screen === "markets" ? "account" : "markets";
      expect(isMobileNavItemActive(item, other)).toBe(false);
    }
  });

  test("contextual Search is not a bottom-nav item; the chart is reached only as Trade", () => {
    expect(MOBILE_NAV_ITEMS.some((item) => item.screen === "search")).toBe(false);
    expect(
      MOBILE_NAV_ITEMS.filter((item) => item.screen === "chart").map((item) => item.key),
    ).toEqual(["trade"]);
  });
});

describe("navigateMobileScreen", () => {
  function spies() {
    const opened: number[] = [];
    const screens: MobileScreen[] = [];
    return {
      opened,
      screens,
      handlers: {
        openSearch: () => opened.push(1),
        setScreen: (screen: MobileScreen) => screens.push(screen),
      },
    };
  }

  test("Search goes through the search opener, not a bare screen switch", () => {
    // The opener seeds the input with the active symbol and focuses it; a bare
    // screen switch would land the user on an empty, unfocused field.
    const { opened, screens, handlers } = spies();

    navigateMobileScreen("search", handlers);

    expect(opened).toHaveLength(1);
    expect(screens).toEqual([]);
  });

  test("every other destination switches the screen directly", () => {
    const { opened, screens, handlers } = spies();

    for (const screen of ["markets", "traders", "chart", "account"] as const) {
      navigateMobileScreen(screen, handlers);
    }

    expect(screens).toEqual(["markets", "traders", "chart", "account"]);
    expect(opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plan A9 - the balance as the nav label.
//
// Bullpen puts the live wallet balance in the tab bar so funding state is
// ambient. Ours has to survive two extra constraints: the destination is a
// multi-tab screen (Positions / Orders / Portfolio / AI), and the balance can
// legitimately be unknown.
// ---------------------------------------------------------------------------
const BALANCE = { short: "$16.00K", long: "portfolio $16,000.00" };

describe("resolveMobileNavLabel", () => {
  const account = MOBILE_NAV_ITEMS.find((item) => item.key === "account")!;
  const markets = MOBILE_NAV_ITEMS.find((item) => item.key === "markets")!;

  test("keeps the static label when no balance is known", () => {
    // A user with no connected venue must not see "-" where money goes.
    expect(resolveMobileNavLabel(account, null).label).toBe("Account");
    expect(resolveMobileNavLabel(account, undefined).label).toBe("Account");
  });

  test("keeps the Account label stable while exposing a known balance as context", () => {
    const resolved = resolveMobileNavLabel(account, BALANCE);

    expect(resolved.label).toBe("Account");
    expect(resolved.hint).toBe("$16.00K");
  });

  test("never lets the balance replace the accessible name", () => {
    // The screen behind it is Positions / Orders / Portfolio / AI. A screen
    // reader announcing only a dollar amount would lose the destination.
    const resolved = resolveMobileNavLabel(account, BALANCE);
    expect(resolved.ariaLabel).toContain("Account");
    expect(resolved.ariaLabel).toContain("portfolio $16,000.00");
  });

  test("leaves every other destination alone", () => {
    const resolved = resolveMobileNavLabel(markets, BALANCE);
    expect(resolved.label).toBe("Markets");
    expect(resolved.ariaLabel).toBe("Markets");
    expect(resolved.hint).toBeUndefined();
  });
});

describe("mobile bottom nav balance", () => {
  test("renders a stable Account label while retaining the balance in its accessible name", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        active="markets"
        onChange={() => {}}
        balance={BALANCE}
      />,
    );

    expect(markup).toContain(">Account</span>");
    expect(markup).toContain('aria-label="Account, portfolio $16,000.00"');
    // The other three destinations are untouched.
    for (const label of ["Markets", "Traders", "Trade"]) {
      expect(markup).toContain(`>${label}</span>`);
    }
  });

  test("the balance destination is still tappable by its accessible name", () => {
    const screens: MobileScreen[] = [];
    const nav = bottomNav({
      balance: BALANCE,
      onChange: (screen) => screens.push(screen),
    });

    click(findByAriaLabel(nav, "Account, portfolio $16,000.00"));

    expect(screens).toEqual(["account"]);
  });

  test("falls back to the static label with no balance", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav active="markets" onChange={() => {}} />,
    );

    expect(markup).toContain(">Account</span>");
  });
});
