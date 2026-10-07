import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TerminalDrawer } from "./terminal-drawer";
import {
  DEFAULT_TERMINAL_LAYOUT,
  splitPane,
  updatePaneTab,
} from "./terminal-layout-state";
import type { LeftTerminalTab, TerminalDrawerState } from "./terminal-layout-state";

type TestTab = LeftTerminalTab;

const tabs: Array<{ value: TestTab; label: string }> = [
  { value: "x_signals", label: "X Signals" },
  { value: "signa", label: "Signa" },
  { value: "watchlist", label: "Watchlist" },
];

const tabsWithIcon: Array<{ value: TestTab; label: string; iconSrc?: string }> = [
  ...tabs.slice(0, 2),
  { value: "watchlist", label: "Watchlist", iconSrc: "/brand/rst-bull-ai.png" },
];

const singlePaneState: TerminalDrawerState<TestTab> = {
  collapsed: false,
  split: null,
  panes: [{ id: "left-a", tab: "x_signals" }],
};

const splitPaneState: TerminalDrawerState<TestTab> = {
  collapsed: false,
  split: "right",
  panes: [
    { id: "left-a", tab: "x_signals" },
    { id: "left-b", tab: "watchlist" },
  ],
};

function renderDrawer(state: TerminalDrawerState<TestTab> = singlePaneState) {
  return renderToStaticMarkup(
    <TerminalDrawer
      side="left"
      title="Discovery"
      tabs={tabs}
      state={state}
      collapsedLabel="Discover"
      renderPane={(tab, paneId) => (
        <div data-pane-content={`${paneId}:${tab}`}>{tab}</div>
      )}
      renderSubHeader={(tab, paneId) => (
        <button
          type="button"
          aria-pressed="false"
          data-pane-subheader={`${paneId}:${tab}`}
          data-pane-subheader-action="latest"
        >
          Filters for {tab}
        </button>
      )}
      resizeHandle={
        <button type="button" aria-label="Resize discovery drawer">
          Resize
        </button>
      }
      onCollapse={() => {}}
      onSplit={() => {}}
      onClosePane={() => {}}
      onTabChange={() => {}}
    />,
  );
}

function renderDrawerWithLeadingAction() {
  return renderToStaticMarkup(
    <TerminalDrawer
      side="right"
      title="Modules"
      tabs={tabs}
      state={singlePaneState}
      collapsedLabel="Modules"
      leadingTabAction={
        <button type="button" aria-label="Back to trade">
          Trade
        </button>
      }
      renderPane={(tab) => <div>{tab}</div>}
      onCollapse={() => {}}
      onSplit={() => {}}
      onClosePane={() => {}}
      onTabChange={() => {}}
    />,
  );
}

function renderDrawerWithIconTab() {
  return renderToStaticMarkup(
    <TerminalDrawer
      side="right"
      title="Modules"
      tabs={tabsWithIcon}
      state={singlePaneState}
      collapsedLabel="Modules"
      renderPane={(tab) => <div>{tab}</div>}
      onCollapse={() => {}}
      onSplit={() => {}}
      onClosePane={() => {}}
      onTabChange={() => {}}
    />,
  );
}

describe("TerminalDrawer", () => {
  test("renders an accessible drawer with directional framing and collapse control", () => {
    const markup = renderDrawer();

    expect(markup).toContain('aria-label="Discovery"');
    expect(markup).toContain('title="Discovery"');
    expect(markup).toContain('data-terminal-drawer-state="expanded"');
    expect(markup).toContain('data-terminal-drawer-transition="panel"');
    expect(markup).toContain('data-terminal-drawer-header="Discovery"');
    expect(markup).toContain("xl:border-l");
    expect(markup).toContain('aria-label="Collapse Discovery drawer"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-terminal-control="collapse"');
    expect(markup).toContain("lucide-chevrons-left");
  });

  test("renders split bottom and split right actions", () => {
    const markup = renderDrawer();

    expect(markup).toContain('aria-label="Split Discovery bottom"');
    expect(markup).toContain('aria-label="Split Discovery right"');
    expect(markup).toContain('data-terminal-control="split-bottom"');
    expect(markup).toContain('data-terminal-control="split-right"');
    expect(markup).toContain("lucide-panel-bottom");
    expect(markup).toContain("lucide-panel-right");
    expect(markup).toContain("hidden rounded-sm");
    expect(markup).toContain("xl:inline-flex");
  });

  test("renders pane tabs with a restrained active indicator", () => {
    const markup = renderDrawer();

    expect(markup).toContain('data-terminal-pane-tabs="left-a"');
    expect(markup).toContain('data-terminal-tab="x_signals"');
    expect(markup).toContain('data-terminal-tab-state="active"');
    expect(markup).toContain('data-terminal-tab-indicator="visible"');
    expect(markup).toContain("scale-x-100");
    expect(markup).toContain("focus-visible:ring-inset");
    expect(markup).not.toContain(
      "bg-primary text-primary-foreground",
    );
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>/);
    expect(markup).toContain("X Signals");
    expect(markup).toContain('data-pane-content="left-a:x_signals"');
  });

  test("vertically centers icon tabs on the same line as text-only tabs", () => {
    const markup = renderDrawerWithIconTab();

    expect(markup).toContain("inline-flex h-full");
    expect(markup).toContain("items-center justify-center");
    expect(markup).toContain("flex items-center gap-1.5 leading-none");
    expect(markup).toContain("%2Fbrand%2Frst-bull-ai.png");
  });

  test("can render a leading action before pane tabs", () => {
    const markup = renderDrawerWithLeadingAction();

    const tradeIndex = markup.indexOf("Back to trade");
    const firstTabIndex = markup.indexOf("X Signals");

    expect(tradeIndex).toBeGreaterThan(-1);
    expect(firstTabIndex).toBeGreaterThan(-1);
    expect(tradeIndex).toBeLessThan(firstTabIndex);
  });

  test("renders contextual pane subheaders and an optional resize handle", () => {
    const markup = renderDrawer();

    expect(markup).toContain('data-terminal-pane-subheader="left-a"');
    expect(markup).toContain('data-pane-subheader="left-a:x_signals"');
    expect(markup).toContain('data-pane-subheader-action="latest"');
    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("Filters for x_signals");
    expect(markup).toContain('aria-label="Resize discovery drawer"');
  });

  test("disables split actions and shows close controls once two panes exist", () => {
    const markup = renderDrawer(splitPaneState);

    expect(markup).toMatch(
      /<button[^>]*aria-label="Split Discovery bottom"[^>]*disabled/,
    );
    expect(markup).toMatch(
      /<button[^>]*aria-label="Split Discovery right"[^>]*disabled/,
    );
    expect(markup.match(/aria-label="Close Discovery pane/g)).toHaveLength(2);
    expect(markup.match(/data-terminal-control="close-pane"/g)).toHaveLength(2);
    expect(markup.match(/data-terminal-pane-tabs=/g)).toHaveLength(2);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2);
  });

  test("renders the second pane's selected tab and content independently", () => {
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "right");
    const secondPaneId = split.left.panes[1]!.id;
    const updated = updatePaneTab(split, "left", secondPaneId, "signa");
    const markup = renderDrawer(updated.left);
    const primaryStart = markup.indexOf('data-terminal-pane="left-a"');
    const secondaryStart = markup.indexOf('data-terminal-pane="left-b"');

    expect(primaryStart).toBeGreaterThanOrEqual(0);
    expect(secondaryStart).toBeGreaterThan(primaryStart);

    const primaryMarkup = markup.slice(primaryStart, secondaryStart);
    const secondaryMarkup = markup.slice(secondaryStart);
    const primaryActiveButtons =
      primaryMarkup.match(/<button\b[^>]*aria-pressed="true"[^>]*>/g) ?? [];
    const secondaryActiveButtons =
      secondaryMarkup.match(/<button\b[^>]*aria-pressed="true"[^>]*>/g) ?? [];

    expect(primaryActiveButtons).toHaveLength(1);
    expect(primaryActiveButtons[0]).toContain('data-terminal-tab="x_signals"');
    expect(primaryMarkup).toContain('data-terminal-pane-tab="x_signals"');
    expect(primaryMarkup).toContain(
      'data-pane-content="left-a:x_signals">x_signals</div>',
    );

    expect(secondaryActiveButtons).toHaveLength(1);
    expect(secondaryActiveButtons[0]).toContain('data-terminal-tab="signa"');
    expect(secondaryMarkup).toContain('data-terminal-pane-tab="signa"');
    expect(secondaryMarkup).toContain(
      'data-pane-content="left-b:signa">signa</div>',
    );
  });

  test("keeps split-right responsive with a stacked fallback", () => {
    const markup = renderDrawer(splitPaneState);

    expect(markup).toContain('data-terminal-split="right"');
    expect(markup).toContain('data-terminal-pane-count="2"');
    expect(markup).toContain('data-terminal-pane-transition="layout"');
    expect(markup).toContain("grid-cols-1");
    expect(markup).toContain("xl:grid-cols-2");
  });

  test("exposes stable pane hooks without animating persistent terminal panes", () => {
    const markup = renderDrawer(splitPaneState);

    expect(markup).toContain('aria-label="Discovery pane 1"');
    expect(markup).toContain('data-terminal-pane-index="0"');
    expect(markup).toContain('data-terminal-pane-position="primary"');
    expect(markup).toContain('data-terminal-pane-position="secondary"');
    expect(markup.match(/data-terminal-pane-transition="fade"/g)).toHaveLength(
      2,
    );
    expect(markup).toContain('data-terminal-pane-content="left-a"');
    expect(markup).toContain('data-terminal-pane-tab="x_signals"');
    expect(markup).not.toContain("motion-safe:animate-in");
    expect(markup).toContain("motion-reduce:transition-none");
  });

  test("does not render pane close controls before split", () => {
    const markup = renderDrawer();

    expect(markup).not.toContain('aria-label="Close Discovery pane');
  });

  test("renders the collapsed rail state", () => {
    const markup = renderDrawer({
      ...singlePaneState,
      collapsed: true,
    });

    expect(markup).toContain('data-terminal-collapsed="true"');
    expect(markup).toContain('data-terminal-drawer-state="collapsed"');
    expect(markup).toContain('data-terminal-drawer-transition="rail"');
    expect(markup).toContain('data-terminal-rail-label="Discover"');
    expect(markup).toContain('data-terminal-rail-accent="true"');
    expect(markup).toContain("Discover");
    expect(markup).toContain('aria-label="Expand Discovery drawer"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-terminal-control="expand"');
    expect(markup).toContain("lucide-chevrons-right");
    expect(markup).toContain("h-12");
    expect(markup).toContain("w-full");
    expect(markup).toContain("xl:h-full");
    expect(markup).toContain("xl:w-12");
    expect(markup).toContain("xl:[writing-mode:vertical-rl]");
    expect(markup).not.toContain("data-terminal-pane-tabs");
    expect(markup).not.toContain("data-pane-content");
  });
});
