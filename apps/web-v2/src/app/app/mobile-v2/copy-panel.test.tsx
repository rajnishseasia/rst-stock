import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MobileCopyPanel,
  MOBILE_COPY_TABS,
  type MobileCopyDeploymentState,
  type MobileCopyTab,
} from "./copy-panel";
import { click, elementText, flattenElements } from "@/testing/element-tree";

const COPY_FEED = <div data-testid="production-copy-feed">Following feed</div>;
const X_CALLERS = <div data-testid="production-x-callers">Top X body</div>;
const USERS = <div data-testid="production-users">Top users body</div>;
const RISK_ACTION = (
  <button type="button" data-testid="production-risk-settings">
    Manage copy risk settings
  </button>
);

function panelTree(
  activeTab: MobileCopyTab = "following",
  deploymentState: MobileCopyDeploymentState = "unknown",
) {
  return MobileCopyPanel({
    activeTab,
    copyFeed: COPY_FEED,
    xCallers: X_CALLERS,
    users: USERS,
    riskSettingsAction: RISK_ACTION,
    deploymentState,
  });
}

describe("MobileCopyPanel", () => {
  test("shares the canonical Following value and label with its tab registry", () => {
    expect(MOBILE_COPY_TABS.map((tab) => tab.value)).toEqual([
      "following",
      "x-callers",
      "users",
    ]);
    expect(MOBILE_COPY_TABS[0]?.label).toBe("Following");
  });

  test("owns no tab strip: the Traders screen selects the surface", () => {
    const markup = renderToStaticMarkup(panelTree("x-callers"));

    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tabpanel"');
    expect(markup).toContain('data-mobile-copy-active-tab="x-callers"');
  });

  // Traders lost the pinned venue bar. The venue still scopes ONE Copy
  // surface, Following, whose feed is queried with the venue-derived asset
  // class, so the control travels to that surface instead of being painted
  // above all three (and above the two leaderboards, which rank people).
  test("hosts the venue switch above Following, and above nothing else", () => {
    const venueSwitch = (
      <div data-testid="venue-switch">Stocks | Perps</div>
    );
    const rendered = (tab: MobileCopyTab) =>
      renderToStaticMarkup(
        MobileCopyPanel({
          activeTab: tab,
          copyFeed: COPY_FEED,
          xCallers: X_CALLERS,
          users: USERS,
          venueSwitch,
        }),
      );

    const following = rendered("following");
    expect(following).toContain('data-mobile-copy-venue="true"');
    expect(following).toContain('data-testid="venue-switch"');
    // Scope first, then the feed it scopes.
    expect(following.indexOf('data-mobile-copy-venue="true"')).toBeLessThan(
      following.indexOf('data-testid="production-copy-feed"'),
    );

    for (const tab of ["x-callers", "users"] as const) {
      expect(rendered(tab)).not.toContain("data-mobile-copy-venue");
    }
  });

  test("paints no venue row for a deployment that has no second venue", () => {
    expect(renderToStaticMarkup(panelTree("following"))).not.toContain(
      "data-mobile-copy-venue",
    );
  });

  test("leaves Copy content scrolling to the mobile frame", () => {
    const markup = renderToStaticMarkup(panelTree());

    expect(markup).not.toContain("overflow-y-auto");
    expect(markup).not.toContain("overscroll-contain");
  });

  test("puts the selected surface before deployment and risk details", () => {
    const elements = flattenElements(panelTree("x-callers"));
    const indexOf = (
      predicate: (element: (typeof elements)[number]) => boolean,
    ) => elements.findIndex(predicate);
    const contentIndex = indexOf(
      (element) => element.props["data-mobile-copy-content"] === "x-callers",
    );
    const disclosureIndex = indexOf(
      (element) => element.props["data-mobile-copy-disclosure"] === "true",
    );
    const deploymentIndex = indexOf(
      (element) => element.props["data-testid"] === "mobile-copy-deployment-state",
    );
    const riskIndex = indexOf(
      (element) => element.props["data-testid"] === "mobile-copy-risk-settings",
    );
    const disclosure = elements[disclosureIndex];

    expect(disclosure?.type).toBe("details");
    expect(disclosure?.props.open).toBe(true);
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeLessThan(disclosureIndex);
    expect(disclosureIndex).toBeLessThan(deploymentIndex);
    expect(disclosureIndex).toBeLessThan(riskIndex);
  });

  test("keeps the selected Copy surface in normal frame flow with one panel layer", () => {
    const elements = flattenElements(panelTree());
    const panel = elements.find(
      (element) => element.props["data-testid"] === "mobile-copy-panel",
    );
    const surfaces = elements.filter(
      (element) => element.props["data-mobile-copy-panel-surface"] === "true",
    );

    expect(panel?.props.className).not.toContain("h-full");
    expect(panel?.props.className).not.toContain("min-h-0");
    expect(panel?.props.className).not.toContain("flex-1");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.props["data-mobile-copy-content"]).toBe("following");
    expect(surfaces[0]?.props.className).not.toContain("min-h-0");
    expect(surfaces[0]?.props.className).not.toContain("flex-1");
    expect(surfaces[0]?.props.className).not.toContain("overflow-y-");
    expect(surfaces[0]?.props.className).not.toContain("overscroll-contain");
  });

  test("makes automation posture and risk controls scannable without claiming runtime readiness", () => {
    const markup = renderToStaticMarkup(panelTree());

    expect(markup).toContain('data-testid="mobile-copy-automation-context"');
    expect(markup).toContain("Manual copies stay one-off.");
    expect(markup).toContain(
      "Auto-mirroring only acts when the deployment is enabled and uses saved risk limits.",
    );
    expect(markup).toContain('data-testid="mobile-copy-risk-settings"');
    expect(markup).not.toContain("Auto-mirroring is running");
  });

  test("keeps the automation disclosure to one compact accessible row", () => {
    const tree = panelTree();
    const context = flattenElements(tree).find(
      (element) => element.props["data-mobile-copy-automation-context"] === "true",
    );

    expect(context?.props.role).toBe("note");
    expect(context?.props["aria-label"]).toBe(
      "Manual copies stay one-off. Auto-mirroring only acts when the deployment is enabled and uses saved risk limits.",
    );
    expect(context?.props.className).toContain("flex");
    expect(context?.props.className).toContain("min-h-9");
    expect(context?.props.className).toContain("items-center");
    expect(context?.props.className).toContain("whitespace-nowrap");
    expect(context?.props.className).toContain("py-1.5");
  });

  test("keeps supplied empty or error states inside the readable panel surface", () => {
    const tree = MobileCopyPanel({
      activeTab: "following",
      copyFeed: <div role="alert">Feed unavailable</div>,
      xCallers: <div role="status">No callers yet</div>,
      users: <div role="status">No users yet</div>,
      riskSettingsAction: RISK_ACTION,
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).toContain('data-mobile-copy-content="following"');
    expect(markup).toContain('data-mobile-copy-state="alert"');
    expect(markup).toContain("Feed unavailable");
    expect(markup).not.toContain("No calls in this window yet.");
  });

  test("scopes shell state styling to the top-level content wrapper", () => {
    const nestedFeedback = (
      <div role="alert" className="feed-error">
        Feed unavailable
        <span role="status" className="follow-feedback">
          Updating follow
        </span>
      </div>
    );
    const tree = MobileCopyPanel({
      activeTab: "following",
      copyFeed: nestedFeedback,
      xCallers: X_CALLERS,
      users: USERS,
    });
    const elements = flattenElements(tree);
    const content = elements.find(
      (element) => element.props["data-mobile-copy-content"] === "following",
    );
    const feedback = elements.find(
      (element) => element.props.className === "follow-feedback",
    );

    expect(content?.props["data-mobile-copy-state"]).toBe("alert");
    expect(content?.props.className).toContain("border-[#8d4f4d]");
    expect(content?.props.className).toContain("bg-[#301d20]");
    expect(content?.props.className).not.toContain("[&_[role=alert]]");
    expect(content?.props.className).not.toContain("[&_[role=status]]");
    expect(feedback?.props.className).toBe("follow-feedback");
  });

  test("is flat: no card around the body and no card around the automation rows", () => {
    // The body used to sit in a bordered, shadowed surface, and the automation
    // section was a card holding two more bordered boxes, so the Following
    // feed's own header, its sizing box and its input ended up three borders
    // deep. Now spacing and hairlines separate the parts (DESIGN.md: never a
    // card inside a card).
    const elements = flattenElements(panelTree("x-callers"));
    const surface = elements.find(
      (element) => element.props["data-mobile-copy-panel-surface"] === "true",
    );
    const disclosure = elements.find(
      (element) => element.props["data-mobile-copy-disclosure"] === "true",
    );
    const context = elements.find(
      (element) => element.props["data-mobile-copy-automation-context"] === "true",
    );
    const deployment = elements.find(
      (element) => element.props["data-testid"] === "mobile-copy-deployment-state",
    );
    const surfaceClass = String(surface?.props.className ?? "");
    const disclosureClass = String(disclosure?.props.className ?? "");
    const contextClass = String(context?.props.className ?? "");
    const deploymentClass = String(deployment?.props.className ?? "");

    for (const className of [surfaceClass, disclosureClass, contextClass, deploymentClass]) {
      expect(className).not.toContain("rounded");
      expect(className).not.toContain("shadow-");
      expect(className).not.toContain("ring-");
    }
    expect(surfaceClass).not.toContain("border");
    expect(surfaceClass).not.toContain("bg-[");
    expect(disclosureClass).toContain("border-t");
    expect(contextClass).not.toContain("border");
    expect(contextClass).not.toContain("bg-[");
    expect(deploymentClass).not.toContain("border");
    expect(deploymentClass).not.toContain("bg-[");
  });

  test("mounts only the body selected by the controlled tab", () => {
    const following = renderToStaticMarkup(panelTree("following"));
    const callers = renderToStaticMarkup(panelTree("x-callers"));
    const users = renderToStaticMarkup(panelTree("users"));

    expect(following).toContain('data-testid="production-copy-feed"');
    expect(following).not.toContain('data-testid="production-x-callers"');
    expect(following).not.toContain('data-testid="production-users"');

    expect(callers).not.toContain('data-testid="production-copy-feed"');
    expect(callers).toContain('data-testid="production-x-callers"');
    expect(callers).not.toContain('data-testid="production-users"');

    expect(users).not.toContain('data-testid="production-copy-feed"');
    expect(users).not.toContain('data-testid="production-x-callers"');
    expect(users).toContain('data-testid="production-users"');
  });

  test("keeps deployment state honest for unknown, off, and on states", () => {
    const unknown = renderToStaticMarkup(panelTree("following", "unknown"));
    const off = renderToStaticMarkup(panelTree("following", "off"));
    const on = renderToStaticMarkup(panelTree("following", "on"));

    expect(unknown).toContain("Auto-mirroring status is unknown");
    expect(off).toContain("Auto-mirroring is turned off");
    expect(on).toContain("Auto-mirroring is configured");
    expect(on).toContain("worker runtime status is not independently confirmed");
  });

  test("keeps loading neutral and reserves the operator warning for settled unknown", () => {
    const loading = renderToStaticMarkup(panelTree("following", "loading"));
    const unknown = renderToStaticMarkup(panelTree("following", "unknown"));

    expect(loading).toContain('data-mobile-copy-deployment-kind="loading"');
    expect(loading).toContain("Checking auto-mirroring status…");
    expect(loading).not.toContain("Ask an operator before relying on an armed follow.");
    expect(unknown).toContain("Auto-mirroring status is unknown");
    expect(unknown).toContain("Ask an operator before relying on an armed follow.");
    expect(unknown).not.toContain("Checking auto-mirroring status…");
  });

  test("exposes deployment state tone without upgrading configured status to running", () => {
    const unknown = renderToStaticMarkup(panelTree("following", "unknown"));
    const off = renderToStaticMarkup(panelTree("following", "off"));
    const on = renderToStaticMarkup(panelTree("following", "on"));

    expect(unknown).toContain('data-mobile-copy-deployment-kind="unknown"');
    expect(off).toContain('data-mobile-copy-deployment-kind="off"');
    expect(on).toContain('data-mobile-copy-deployment-kind="on"');
    expect(on).not.toContain("Auto-mirroring is running");
  });

  test("renders the controller's real risk-settings action, or a button for a plain handler", () => {
    const tree = panelTree();
    const markup = renderToStaticMarkup(tree);

    expect(markup).toContain('data-testid="production-risk-settings"');
    expect(markup).toContain("Manage copy risk settings");
    expect(markup).not.toContain("Demo data");
    expect(markup).not.toContain("leaderboard metrics");
    expect(elementText(tree)).toContain("Following feed");

    let opened = 0;
    const handlerTree = MobileCopyPanel({
      activeTab: "following",
      copyFeed: COPY_FEED,
      xCallers: X_CALLERS,
      users: USERS,
      riskSettingsAction: () => {
        opened += 1;
      },
    });
    const button = flattenElements(handlerTree).find(
      (element) => element.props["aria-label"] === "Manage copy risk settings",
    );
    expect(button?.type).toBe("button");
    // Guarded rather than called straight through the optional chain: a
    // missing element must fail as an assertion, not a TypeError.
    const onButton = button?.props.onClick as
      | (() => void)
      | undefined;
    expect(typeof onButton).toBe("function");
    onButton?.();
    expect(opened).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Naming the leaderboard where it lives. Both ranked boards have been mounted
// inside Traders since the destinations merged, but the word "Leaderboard" was
// painted only in the hamburger, on a row that leaves the shell for /lb, so a
// differentiator read as a menu item.
// ---------------------------------------------------------------------------
describe("MobileCopyPanel leaderboard row", () => {
  const leaderboardRow = (tree: ReturnType<typeof panelTree>) =>
    flattenElements(tree).find(
      (element) => element.props["data-testid"] === "mobile-copy-leaderboard-row",
    );

  const followingWithEntry = (onOpenLeaderboard: () => void) =>
    MobileCopyPanel({
      activeTab: "following",
      copyFeed: COPY_FEED,
      xCallers: X_CALLERS,
      users: USERS,
      onOpenLeaderboard,
    });

  test("names the leaderboard on each ranked board, alongside that board's own name", () => {
    for (const board of ["x-callers", "users"] as const) {
      const row = leaderboardRow(panelTree(board));
      const label = MOBILE_COPY_TABS.find((tab) => tab.value === board)?.label;

      expect(row?.props["data-mobile-copy-leaderboard"]).toBe("heading");
      expect(row?.props["data-mobile-copy-leaderboard-board"]).toBe(board);
      expect(elementText(row)).toContain("Leaderboard");
      expect(typeof label).toBe("string");
      expect(elementText(row)).toContain(label ?? "");
    }
  });

  test("offers Following an entry that switches tabs in the shell", () => {
    let opened = 0;
    const row = leaderboardRow(
      followingWithEntry(() => {
        opened += 1;
      }),
    );

    expect(row?.props["data-mobile-copy-leaderboard"]).toBe("entry");
    expect(row?.type).toBe("button");
    expect(row?.props["aria-label"]).toBe("Open the leaderboard");
    // A tab switch, never a link: routing out to /lb would discard the shell.
    expect(row?.props.href).toBeUndefined();
    click(row);
    expect(opened).toBe(1);
  });

  test("never paints a dead entry when the screen supplies no handler", () => {
    // panelTree passes no onOpenLeaderboard, so Following gets no row at all.
    expect(leaderboardRow(panelTree("following"))).toBeUndefined();
    // The ranked boards still name themselves; that row is a label, not a control.
    expect(leaderboardRow(panelTree("users"))?.type).toBe("div");
  });

  test("keeps a 44px target on the entry and adds no second tab row", () => {
    const tree = followingWithEntry(() => {});
    const markup = renderToStaticMarkup(tree);
    const className = String(leaderboardRow(tree)?.props.className ?? "");

    expect(className).toContain("min-h-11");
    // Gold seasons the eyebrow; it never fills the row (DESIGN.md line 207).
    expect(className).not.toContain("bg-[#e7c65d]");
    expect(className).not.toContain("bg-[#d1b95e]");
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('role="tab"');
    // The shell's `main` stays the only scroller.
    expect(markup).not.toContain("overflow-y-auto");
  });

  test("puts the leaderboard name above the board it names", () => {
    const elements = flattenElements(panelTree("x-callers"));
    const rowIndex = elements.findIndex(
      (element) => element.props["data-testid"] === "mobile-copy-leaderboard-row",
    );
    const contentIndex = elements.findIndex(
      (element) => element.props["data-mobile-copy-content"] === "x-callers",
    );

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBeLessThan(contentIndex);
  });
});
