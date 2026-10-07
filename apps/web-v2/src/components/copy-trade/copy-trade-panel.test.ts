import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CopyTradeCardHeaderLayout,
  CopyTradeSourceTabs,
  MirrorExplainerLayout,
} from "./copy-trade-card-layout";
import { CopyTradeInfoContent, CopyTradeInfoDialog } from "./copy-trade-info-dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  computeCopyRowState,
  computeTargetDollars,
  resolveCopyDispatch,
} from "./copy-trade-row-state";
import { parseStoredSizing, parseStoredSourceFilter } from "./copy-trade-persistence";
import { copyDisabledReason } from "./copy-eligibility";
import { perpCopyFromTradeRow } from "./copy-perp-route";
import {
  buildInlineMirrorArmingSummary,
  copyTradeMirrorDestination,
  copyTradeViewSelection,
  resolveStoredSizing,
} from "./copy-trade-panel";
import {
  accountForDestination,
  accountOptionLabel,
  buildDestinationPatch,
  type AlpacaAccountOption,
} from "./account-targeting";
import { copyTradeQuoteIdentity } from "./copy-trade-quotes";
import { resolveFollowDestination } from "./use-manage-follows-state";
import { buildArmingSummary } from "./mirror-consent";

/**
 * A CRLF checkout (git core.autocrlf on Windows) breaks a raw multi-line
 * source-text match, because the literals below are written with LF.
 * Normalizing the read keeps the two remaining checks meaning the same thing
 * on every machine rather than only on the Linux CI box.
 */
const CRLF = /\r\n/g;

/** Supply the same cache context as the mounted panel for static render tests. */
function renderToStaticMarkup(node: Parameters<typeof renderMarkup>[0]) {
  return renderMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));
}

// dashboardSource / tradeFormSource: NOT this component. The /app terminal and
// trade/trade-form.tsx each own their own test file (page-layout.test.ts,
// trade-form.test.ts) and their own conversion effort; this file only reads
// them to pin the copy-trade prefill CONTRACT at the boundary between the two
// components (see "copy-trade panel cross-component contracts" below for
// exactly which four checks still need this, and why).
//
// The dashboard side is two files, not one: a Next.js page file may export only
// `default` plus the framework's own config keys, so app/app/page.tsx is now
// just the redirect guard and the terminal it mounts lives in the two sibling
// modules below (the copy prefill state in ./trading-app-content, the trade
// rail it feeds in ./venue-aware-panels). They are joined into one blob so the
// checks below stay exactly the strings they were, and so this file keeps its
// single source read rather than growing the source-string debt it is
// allowlisted for.
const dashboardSource = [
  new URL("../../app/app/trading-app-content.tsx", import.meta.url),
  new URL("../../app/app/venue-aware-panels.tsx", import.meta.url),
]
  .map((moduleUrl) => readFileSync(moduleUrl, "utf8").replace(CRLF, "\n"))
  .join("\n");
const tradeFormSource = readFileSync(
  new URL("../trade/trade-form.tsx", import.meta.url),
  "utf8",
).replace(CRLF, "\n");

describe("copy-trade source tabs", () => {
  test("keeps source tabs and the How it works trigger at 44px until xl", () => {
    const tabs = renderToStaticMarkup(
      createElement(CopyTradeSourceTabs, { source: "all", onSelect: () => {} }),
    );
    const info = renderToStaticMarkup(createElement(CopyTradeInfoDialog));

    for (const label of ["All", "Following", "Callers", "Users"]) {
      const button = tabs.match(
        new RegExp(`<button[^>]*>${label}<\\/button>`),
      )?.[0];
      expect(button).toContain("h-11");
      expect(button).toContain("xl:h-7");
      expect(button).not.toContain("sm:h-7");
    }
    expect(info).toContain("h-11");
    expect(info).toContain("xl:h-7");
    expect(info).not.toContain("sm:h-7");
  });

  test("renders All / Following / Callers / Users, plus a disabled Politicians (Phase 2)", () => {
    const html = renderToStaticMarkup(
      createElement(CopyTradeSourceTabs, { source: "all", onSelect: () => {} }),
    );
    expect(html).toContain("All");
    expect(html).toContain("Following");
    expect(html).toContain(">Callers<");
    expect(html).not.toContain(">X<");
    expect(html).toContain("Users");
    expect(html).toContain("Politicians");
    expect(html).toContain("Soon");
    expect(html).toContain("disabled");
  });

  test("marks exactly the selected source's tab active (aria-pressed)", () => {
    for (const source of ["all", "following", "x_signal", "user"] as const) {
      const element = CopyTradeSourceTabs({ source, onSelect: () => {} });
      const tabs = (element.props.children as unknown[]).filter(
        (child): child is { props: { active: boolean; children: unknown } } =>
          !!child && typeof child === "object" && "props" in (child as object),
      );
      // The Politicians button (always inactive, always disabled) is the 5th
      // child and has no `active` prop; only the four SourceTab elements do.
      const active = tabs.filter((t) => t.props.active === true);
      expect(active.length).toBe(1);
    }
  });

  /**
   * The property the old test pinned by matching `setSource("all")` /
   * `setSource("x_signal")` / `setSource("user")` as literal substrings of the
   * component's source: that each tab's onClick calls the setter with the
   * RIGHT source name, not just that those three strings exist somewhere in
   * the file. `CopyTradeSourceTabs` takes `onSelect` as a prop rather than
   * closing over internal state (that is the whole reason it was extracted),
   * so the real onClick closures are reachable by calling the component
   * directly and reading the returned element tree - no rendering, no DOM,
   * no event system required.
   */
  test("wires each tab's click to onSelect with its own source name", () => {
    const calls: string[] = [];
    const element = CopyTradeSourceTabs({ source: "all", onSelect: (s) => calls.push(s) });
    const children = element.props.children as Array<{ props: { children: unknown; onClick?: () => void } }>;

    const byLabel = (label: string) =>
      children.find((c) => c?.props?.children === label);

    byLabel("All")?.props.onClick?.();
    byLabel("Following")?.props.onClick?.();
    byLabel("Callers")?.props.onClick?.();
    byLabel("Users")?.props.onClick?.();

    expect(calls).toEqual(["all", "following", "x_signal", "user"]);
  });
});

describe("copy-trade panel persistence", () => {
  test("SOURCES_KEY / SIZING_KEY name the exact localStorage keys this panel persists to", async () => {
    const { SOURCES_KEY, SIZING_KEY } = await import("./copy-trade-panel");
    expect(SOURCES_KEY).toBe("copy-trade:sources");
    expect(SIZING_KEY).toBe("copy-trade:sizing");
  });

  test("parseStoredSourceFilter accepts only the four values this panel writes", () => {
    expect(parseStoredSourceFilter("all")).toBe("all");
    expect(parseStoredSourceFilter("following")).toBe("following");
    expect(parseStoredSourceFilter("x_signal")).toBe("x_signal");
    expect(parseStoredSourceFilter("user")).toBe("user");
    // Missing, stale, or foreign values resolve to null ("apply nothing"),
    // not a silent fallback to some default - the caller decides what "no
    // stored value" means.
    expect(parseStoredSourceFilter(null)).toBeNull();
    expect(parseStoredSourceFilter("politician")).toBeNull();
    expect(parseStoredSourceFilter("garbage")).toBeNull();
  });

  test("parseStoredSizing preserves valid modes and fails closed on bad values", () => {
    expect(parseStoredSizing('{"mode":"usd","value":25}', 5)).toEqual({
      mode: "usd",
      value: 25,
    });
    expect(parseStoredSizing('{"mode":"pct_equity","value":10}', 5)).toEqual({
      mode: "pct_equity",
      value: 10,
    });
    // Invalid persisted values never activate exposure.
    expect(parseStoredSizing('{"mode":"usd","value":-5}', 5)).toEqual({
      mode: "usd",
      value: 0,
    });
    expect(parseStoredSizing('{"mode":"usd"}', 5)).toEqual({ mode: "usd", value: 0 });
  });

  test("parseStoredSizing returns null only for a missing key", () => {
    expect(parseStoredSizing(null, 5)).toBeNull();
    expect(parseStoredSizing("", 5)).toEqual({ mode: "pct", value: 0 });
    expect(parseStoredSizing("{not json", 5)).toEqual({ mode: "pct", value: 0 });
  });

  test("applies the default only for a confirmed missing key", () => {
    expect(resolveStoredSizing(null)).toEqual({ mode: "pct", value: 5 });
    expect(resolveStoredSizing("")).toEqual({ mode: "pct", value: 0 });
    expect(resolveStoredSizing("{not json")).toEqual({ mode: "pct", value: 0 });
  });
});

describe("copy-trade panel sizing math", () => {
  test("computeTargetDollars floors nothing itself, but scopes pct/pct_equity to 100% and usd is passed through", () => {
    expect(
      computeTargetDollars({ sizingMode: "pct", sizingValue: 5, buyingPower: 1000, equity: 0 }),
    ).toBe(50);
    // A stored value over 100 cannot demand more than all of buying power.
    expect(
      computeTargetDollars({ sizingMode: "pct", sizingValue: 250, buyingPower: 1000, equity: 0 }),
    ).toBe(1000);
    expect(
      computeTargetDollars({ sizingMode: "pct_equity", sizingValue: 10, buyingPower: 0, equity: 2000 }),
    ).toBe(200);
    expect(
      computeTargetDollars({ sizingMode: "usd", sizingValue: 500, buyingPower: 0, equity: 0 }),
    ).toBe(500);
    // Ratio mode has no dollar target - qty is sized per-item from the
    // source trader's own qty instead (see computeCopyRowState below).
    expect(
      computeTargetDollars({ sizingMode: "ratio", sizingValue: 2, buyingPower: 1000, equity: 1000 }),
    ).toBe(0);
  });

  test("computes qty by flooring the dollar target over the live price", () => {
    // pct 5% of $1000 buying power -> $50 target, priced at $50/sh -> 1 share.
    const targetDollars = computeTargetDollars({
      sizingMode: "pct",
      sizingValue: 5,
      buyingPower: 1000,
      equity: 0,
    });
    const row = computeCopyRowState({
      meta: {},
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "pct",
      sizingValue: 5,
      targetDollars,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.qty).toBe(1);
    expect(row.copyDisabled).toBe(false);
    expect(row.buttonLabel).toBe("Copy 1 sh");

    // A price that does not divide evenly floors down, never rounds up.
    const row2 = computeCopyRowState({
      meta: {},
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "33",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 100,
      targetDollars: 100,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row2.qty).toBe(3); // floor(100 / 33) = 3, not 3.03
    expect(row2.buttonLabel).toBe("Copy 3 sh");
  });

  test("ratio mode sizes qty from the source trader's own qty, and disables when it has none", () => {
    const withSourceQty = computeCopyRowState({
      meta: {},
      side: "buy",
      rawQty: 5,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "ratio",
      sizingValue: 2,
      targetDollars: 0,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(withSourceQty.qty).toBe(10); // floor(min(2, 10) * 5)
    expect(withSourceQty.copyDisabled).toBe(false);

    const withoutSourceQty = computeCopyRowState({
      meta: {},
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "ratio",
      sizingValue: 2,
      targetDollars: 0,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(withoutSourceQty.qty).toBe(0);
    expect(withoutSourceQty.ratioNeedsSourceQty).toBe(true);
    expect(withoutSourceQty.copyDisabled).toBe(true);
  });

  test("a pct/pct_equity brokerage gate disables Copy independent of qty", () => {
    const row = computeCopyRowState({
      meta: {},
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "10",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "pct",
      sizingValue: 5,
      targetDollars: 500, // would otherwise floor to a positive qty
      pctNeedsBrokerage: true,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.qty).toBeGreaterThan(0);
    expect(row.copyDisabled).toBe(true);
  });
});

describe("copy-trade panel option rows (M-5)", () => {
  const OPTION_META = {
    assetType: "OPTION",
    optionExpiration: "260719",
    optionStrike: 250,
    optionType: "CALL",
    tradeAction: "BuyToOpen",
  };

  test("flags OPTION user-trades from meta.assetType and renders contracts, not shares", () => {
    const row = computeCopyRowState({
      meta: OPTION_META,
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: "4.50",
      optionAsk: "5.00",
      sizingMode: "usd",
      sizingValue: 5000,
      targetDollars: 5000,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.isOption).toBe(true);
    // 100x multiplier: floor(5000 / (5.00 * 100)) = 10 contracts, buy side
    // prices off the ASK.
    expect(row.qty).toBe(10);
    expect(row.copyDisabled).toBe(false);
    expect(row.buttonLabel).toBe("Copy 10 ct");
  });

  test("sell-side options price off the bid, not the ask", () => {
    const row = computeCopyRowState({
      meta: OPTION_META,
      side: "sell",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: "4.00",
      optionAsk: "5.00",
      sizingMode: "usd",
      sizingValue: 4000,
      targetDollars: 4000,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    // If this used the ask (5.00) it would floor to 8, not 10.
    expect(row.optionReferencePrice).toBe(4);
    expect(row.qty).toBe(10);
  });

  test("blocks copying a complete option contract with an unsupported action", () => {
    const { tradeAction: _drop, ...meta } = OPTION_META;
    const row = computeCopyRowState({
      meta,
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: "4.50",
      optionAsk: "5.00",
      sizingMode: "usd",
      sizingValue: 5000,
      targetDollars: 5000,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.hasCompleteOptionContract).toBe(true);
    expect(row.hasSupportedOptionAction).toBe(false);
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe("Option action is unsupported");
  });

  test("blocks an incomplete option contract (missing strike/expiration/type)", () => {
    const row = computeCopyRowState({
      meta: { assetType: "OPTION", tradeAction: "BuyToOpen" },
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 5000,
      targetDollars: 5000,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.hasCompleteOptionContract).toBe(false);
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe("Option contract details are missing");
  });

  test("blocks a complete option contract with no live premium", () => {
    const row = computeCopyRowState({
      meta: OPTION_META,
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 5000,
      targetDollars: 5000,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe("Option premium unavailable");
  });

  test("blocks unsupported option-like X signals instead of copying them as equities", () => {
    const row = computeCopyRowState({
      meta: { instrumentParseStatus: "unsupported" },
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 500,
      targetDollars: 500,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.unsupportedOptionSignal).toBe(true);
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe("Option signal is incomplete or unsupported");
  });

  test("wires copyDisabledReason (perp/derivative/short signals) into Copy's disabled state and title, using the REAL module", () => {
    const meta = {
      mirrorableEquity: false,
      platform: "hyperliquid",
      instrument: "perp",
      direction: "short",
    };
    const reason = copyDisabledReason(meta, "buy");
    expect(reason).not.toBeNull();

    const row = computeCopyRowState({
      meta,
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: reason,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 500,
      targetDollars: 500,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe(reason ?? undefined);
  });

  test("shows sell activity without offering a manual sell copy, using the REAL copyDisabledReason", () => {
    const reason = copyDisabledReason({}, "sell");
    const row = computeCopyRowState({
      meta: {},
      side: "sell",
      rawQty: undefined,
      copyEligibilityReason: reason,
      perpRoute: null,
      hasPerpHandler: false,
      quoteLast: "50",
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd",
      sizingValue: 500,
      targetDollars: 500,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe(reason ?? undefined);
    expect(row.buttonLabel).toBe("Sell shown");
  });
});

describe("copy-trade panel perp routing (the safety property that matters most)", () => {
  const VALID_PERP_META = {
    assetType: "PERP",
    perpVenue: "hyperliquid",
    perpCoin: "kPEPE",
    perpDirection: "long" as const,
    perpLeverage: 10,
    perpReduceOnly: false,
  };

  test("a routable perp row is enabled, priced off HL leverage (not qty/brokerage), and labeled by side+leverage", () => {
    const perpRoute = perpCopyFromTradeRow(VALID_PERP_META, { perpsEnabled: true });
    expect(perpRoute?.kind).toBe("perp");

    const row = computeCopyRowState({
      meta: VALID_PERP_META,
      side: "buy",
      rawQty: undefined,
      // Deliberately hostile equity-side inputs: no eligibility reason
      // computed (irrelevant for a perp row), and every equity gate below
      // would otherwise disable Copy - none of them apply to a perp row.
      copyEligibilityReason: null,
      perpRoute,
      hasPerpHandler: true,
      quoteLast: undefined,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "pct",
      sizingValue: 5,
      targetDollars: 0,
      pctNeedsBrokerage: true,
      pctEquityNeedsBrokerage: true,
    });
    expect(row.copyDisabled).toBe(false);
    expect(row.buttonLabel).toBe("Prefill 10x Long");
  });

  test("a perp row with no onCopyPerp handler wired stays disabled, but keeps its perp label (not a silent equity fallback)", () => {
    const perpRoute = perpCopyFromTradeRow(VALID_PERP_META, { perpsEnabled: true });
    const row = computeCopyRowState({
      meta: VALID_PERP_META,
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute,
      hasPerpHandler: false,
      quoteLast: undefined,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "pct",
      sizingValue: 5,
      targetDollars: 0,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.copyDisabled).toBe(true);
    expect(row.buttonLabel).toBe("Prefill 10x Long");
  });

  test("a refused perp row (reduce-only close) disables Copy and titles the button with the refusal reason", () => {
    const perpRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpReduceOnly: true },
      { perpsEnabled: true },
    );
    expect(perpRoute?.kind).toBe("refused");

    const row = computeCopyRowState({
      meta: { ...VALID_PERP_META, perpReduceOnly: true },
      side: "buy",
      rawQty: undefined,
      copyEligibilityReason: null,
      perpRoute,
      hasPerpHandler: true,
      quoteLast: undefined,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "pct",
      sizingValue: 5,
      targetDollars: 0,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
    });
    expect(row.copyDisabled).toBe(true);
    expect(row.copyTitle).toBe(
      "This trade closes a position rather than opening one; copying it as a new order isn't supported.",
    );
    expect(row.buttonLabel).toBe("Close shown");
  });

  test("labels both confirmed perp closes clearly, while short entries stay copyable and missing metadata stays unavailable", () => {
    const closeLongRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpReduceOnly: true },
      { perpsEnabled: true },
    );
    const closeShortRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpDirection: "short", perpReduceOnly: true },
      { perpsEnabled: true },
    );
    const shortEntryRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpDirection: "short", perpReduceOnly: false },
      { perpsEnabled: true },
    );
    const { perpReduceOnly: _missingReduceOnly, ...missingMetadata } = VALID_PERP_META;
    const missingMetadataRoute = perpCopyFromTradeRow(
      { ...missingMetadata, perpDirection: "short" },
      { perpsEnabled: true },
    );

    const rowFor = (
      meta: Record<string, unknown>,
      side: "buy" | "sell",
      perpRoute: ReturnType<typeof perpCopyFromTradeRow>,
    ) =>
      computeCopyRowState({
        meta,
        side,
        rawQty: undefined,
        copyEligibilityReason: null,
        perpRoute,
        hasPerpHandler: true,
        quoteLast: undefined,
        optionBid: undefined,
        optionAsk: undefined,
        sizingMode: "usd",
        sizingValue: 500,
        targetDollars: 500,
        pctNeedsBrokerage: false,
        pctEquityNeedsBrokerage: false,
      });

    expect(rowFor({ ...VALID_PERP_META, perpReduceOnly: true }, "sell", closeLongRoute)).toMatchObject({
      copyDisabled: true,
      buttonLabel: "Close shown",
    });
    expect(
      rowFor(
        { ...VALID_PERP_META, perpDirection: "short", perpReduceOnly: true },
        "buy",
        closeShortRoute,
      ),
    ).toMatchObject({ copyDisabled: true, buttonLabel: "Close shown" });
    expect(
      rowFor(
        { ...VALID_PERP_META, perpDirection: "short", perpReduceOnly: false },
        "sell",
        shortEntryRoute,
      ),
    ).toMatchObject({ copyDisabled: false, buttonLabel: "Prefill 10x Short" });
    expect(
      rowFor({ ...missingMetadata, perpDirection: "short" }, "sell", missingMetadataRoute),
    ).toMatchObject({ copyDisabled: true, buttonLabel: "Unavailable" });
  });

  /**
   * THE test the reviewer flagged: before this extraction, "invokes the
   * onCopy callback" was pinned by `expect(source).toContain("onCopy(")`,
   * and "computes qty by flooring..." was pinned by `expect(source).toContain
   * ("Math.floor")`. Both strings still exist, verbatim, in the equity
   * branch below - but a PERP row never reaches that branch, so neither
   * assertion ever actually exercised perp protection. This test calls the
   * real dispatch function with a PERP row and proves the result can never be
   * `{ kind: "equity" }`, regardless of what qty/isOption/option fields say -
   * i.e. regardless of what would make an equity payload LOOK plausible.
   */
  test("a PERP row's dispatch is never { kind: \"equity\" } - refused or routable, qty and isOption notwithstanding", () => {
    const item = {
      id: "user:perp-1",
      symbol: "kPEPE",
      side: "buy" as const,
      source: "user",
      meta: VALID_PERP_META as Record<string, unknown>,
    };

    const refusedRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpReduceOnly: true },
      { perpsEnabled: true },
    );
    const refusedDispatch = resolveCopyDispatch({
      perpRoute: refusedRoute,
      item,
      // Hostile: these would build a perfectly normal-looking equity payload
      // if the perpRoute check were ever bypassed or reordered.
      isOption: false,
      qty: 500,
    });
    expect(refusedDispatch.kind).toBe("noop");
    expect(refusedDispatch).not.toHaveProperty("payload");

    const routableRoute = perpCopyFromTradeRow(VALID_PERP_META, { perpsEnabled: true });
    const routableDispatch = resolveCopyDispatch({
      perpRoute: routableRoute,
      item,
      isOption: false,
      qty: 500,
    });
    expect(routableDispatch.kind).toBe("perp");
    if (routableDispatch.kind === "perp") {
      expect(routableDispatch.payload).toEqual({
        itemId: "user:perp-1",
        coin: "kPEPE",
        side: "long",
        leverage: 10,
      });
    }

    // Perps not enabled on this deployment: still a perp row, still refused,
    // still never an equity payload.
    const disabledDeploymentRoute = perpCopyFromTradeRow(VALID_PERP_META, {
      perpsEnabled: false,
    });
    const disabledDeploymentDispatch = resolveCopyDispatch({
      perpRoute: disabledDeploymentRoute,
      item,
      isOption: false,
      qty: 500,
    });
    expect(disabledDeploymentDispatch.kind).toBe("noop");
  });

  test("omits the leverage key entirely rather than defaulting to 1, in the actual dispatch payload", () => {
    const { perpLeverage: _drop, ...metaWithoutLeverage } = VALID_PERP_META;
    const perpRoute = perpCopyFromTradeRow(metaWithoutLeverage, { perpsEnabled: true });
    const dispatch = resolveCopyDispatch({
      perpRoute,
      item: {
        id: "user:perp-2",
        symbol: "kPEPE",
        side: "buy",
        source: "user",
        meta: metaWithoutLeverage as Record<string, unknown>,
      },
      isOption: false,
      qty: 0,
    });
    expect(dispatch.kind).toBe("perp");
    if (dispatch.kind === "perp") {
      expect(dispatch.payload).toEqual({ itemId: "user:perp-2", coin: "kPEPE", side: "long" });
      expect("leverage" in dispatch.payload).toBe(false);
    }
  });

  test("uses the canonical HIP-3 coin and perps venue when viewing a valid perp row", () => {
    const perpRoute = perpCopyFromTradeRow(
      {
        ...VALID_PERP_META,
        perpCoin: "xyz:GOOGL",
      },
      { perpsEnabled: true },
    );

    expect(copyTradeViewSelection("GOOGL", perpRoute)).toEqual({
      symbol: "xyz:GOOGL",
      venue: "perps",
    });
  });

  test("never falls through to the stock venue when a valid perp row is disabled only by deployment config", () => {
    const perpRoute = perpCopyFromTradeRow(
      {
        ...VALID_PERP_META,
        perpCoin: "xyz:GOOGL",
      },
      { perpsEnabled: false },
    );

    expect(copyTradeViewSelection("GOOGL", perpRoute)).toEqual({
      symbol: "xyz:GOOGL",
      venue: "perps",
    });
  });

  test("keeps a refused but valid perp close on its canonical perp market", () => {
    const perpRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpCoin: "xyz:GOOGL", perpReduceOnly: true },
      { perpsEnabled: true },
    );

    expect(perpRoute).toEqual({
      kind: "refused",
      coin: "xyz:GOOGL",
      reason:
        "This trade closes a position rather than opening one; copying it as a new order isn't supported.",
    });
    expect(copyTradeViewSelection("GOOGL", perpRoute)).toEqual({
      symbol: "xyz:GOOGL",
      venue: "perps",
    });
  });

  test("keeps an unconfirmed perp row on the perp venue instead of falling through to stocks", () => {
    const refusedRoute = perpCopyFromTradeRow(
      { ...VALID_PERP_META, perpVenue: "alpaca", perpCoin: undefined },
      { perpsEnabled: true },
    );

    expect(refusedRoute?.kind).toBe("refused");
    expect(copyTradeViewSelection("SOL", refusedRoute)).toEqual({
      symbol: "SOL",
      venue: "perps",
    });
  });

  test("preserves the existing symbol-only view callback for equity rows", () => {
    expect(copyTradeViewSelection("AAPL", null)).toEqual({ symbol: "AAPL" });
  });

  test("classifies every partial perp marker as a perp across quote, route, view, mirror, and dispatch", () => {
    const partials: Array<[string, Record<string, unknown>]> = [
      ["venue", { perpVenue: "hyperliquid" }],
      ["coin", { perpCoin: "SOL" }],
      ["direction", { perpDirection: "long" }],
      ["reduce-only", { perpReduceOnly: false }],
      ["leverage", { perpLeverage: 10 }],
      ["HIP-3 coin", { perpCoin: "xyz:GOOGL" }],
    ];

    for (const [label, meta] of partials) {
      const route = perpCopyFromTradeRow(meta, { perpsEnabled: true });
      const reason = copyDisabledReason(meta, "buy");
      const item = {
        id: `user:partial-${label}`,
        symbol: "SOL",
        side: "buy" as const,
        source: "user",
        meta,
      };

      expect(copyTradeQuoteIdentity(item), label).toMatchObject({ venue: "perps" });
      expect(route?.kind, label).toBe("refused");
      expect(reason, label).not.toBeNull();
      expect(copyTradeViewSelection("SOL", route), label).toMatchObject({ venue: "perps" });
      expect(copyTradeMirrorDestination({ meta }, route), label).toBe("perp");
      expect(
        resolveCopyDispatch({
          perpRoute: route,
          item,
          isOption: false,
          qty: 10,
        }),
        label,
      ).toMatchObject({ kind: "noop" });

      const row = computeCopyRowState({
        meta,
        side: "buy",
        rawQty: undefined,
        copyEligibilityReason: reason,
        perpRoute: route,
        hasPerpHandler: true,
        quoteLast: "100",
        optionBid: undefined,
        optionAsk: undefined,
        sizingMode: "usd",
        sizingValue: 1_000,
        targetDollars: 1_000,
        pctNeedsBrokerage: false,
        pctEquityNeedsBrokerage: false,
      });
      expect(row.copyDisabled, label).toBe(true);
    }
  });

  test("carries one failed quote decision into stock, perp, and option row state", () => {
    const quoteReadiness = {
      copyBlocked: true,
      copyBlockedReason: "Current quote refresh failed. Refresh before copying.",
    };
    const base = {
      side: "buy" as const,
      rawQty: undefined,
      hasPerpHandler: true,
      optionBid: undefined,
      optionAsk: undefined,
      sizingMode: "usd" as const,
      sizingValue: 500,
      targetDollars: 500,
      pctNeedsBrokerage: false,
      pctEquityNeedsBrokerage: false,
      quoteReadiness,
    };

    const stock = computeCopyRowState({
      ...base,
      meta: { assetType: "EQUITY" },
      copyEligibilityReason: null,
      perpRoute: null,
      quoteLast: "50",
    });
    const perpMeta = {
      assetType: "PERP",
      perpVenue: "hyperliquid",
      perpCoin: "SOL",
      perpDirection: "long",
      perpReduceOnly: false,
    };
    const perp = computeCopyRowState({
      ...base,
      meta: perpMeta,
      copyEligibilityReason: copyDisabledReason(perpMeta, "buy"),
      perpRoute: perpCopyFromTradeRow(perpMeta, { perpsEnabled: true }),
      quoteLast: undefined,
    });
    const optionMeta = {
      assetType: "OPTION",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
    };
    const option = computeCopyRowState({
      ...base,
      meta: optionMeta,
      copyEligibilityReason: null,
      perpRoute: null,
      quoteLast: undefined,
      optionAsk: "5",
    });

    for (const row of [stock, perp, option]) {
      expect(row.copyDisabled).toBe(true);
      expect(row.copyTitle).toBe(quoteReadiness.copyBlockedReason);
    }
  });
});

describe("copy-trade panel dispatch (equity path)", () => {
  test("dispatches a full equity payload, including option fields only when isOption", () => {
    const equityDispatch = resolveCopyDispatch({
      perpRoute: null,
      item: {
        id: "user:eq-1",
        symbol: "AAPL",
        side: "buy",
        source: "user",
        meta: {},
      },
      isOption: false,
      optionExpiration: "260719", // should be dropped: isOption is false
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
      qty: 12,
    });
    expect(equityDispatch).toEqual({
      kind: "equity",
      payload: {
        symbol: "AAPL",
        side: "buy",
        qty: 12,
        copySourceItemId: "user:eq-1",
        assetType: "EQUITY",
        optionExpiration: undefined,
        optionStrike: undefined,
        optionType: undefined,
        tradeAction: undefined,
        signalId: undefined,
      },
    });

    const optionDispatch = resolveCopyDispatch({
      perpRoute: null,
      item: {
        id: "user:opt-1",
        symbol: "TSLA",
        side: "buy",
        source: "user",
        meta: { assetType: "OPTION" },
      },
      isOption: true,
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
      qty: 10,
    });
    expect(optionDispatch.kind).toBe("equity");
    if (optionDispatch.kind === "equity") {
      expect(optionDispatch.payload.assetType).toBe("OPTION");
      expect(optionDispatch.payload.optionExpiration).toBe("260719");
      expect(optionDispatch.payload.optionStrike).toBe(250);
      expect(optionDispatch.payload.optionType).toBe("CALL");
      expect(optionDispatch.payload.tradeAction).toBe("BuyToOpen");
    }
  });

  test("dispatches canonical source ids for user and x_signal equity rows", () => {
    const userDispatch = resolveCopyDispatch({
      perpRoute: null,
      item: { id: "user:1", symbol: "AAPL", side: "buy", source: "user", meta: { signalId: "abc" } },
      isOption: false,
      qty: 1,
    });
    expect(userDispatch.kind).toBe("equity");
    if (userDispatch.kind === "equity") {
      expect(userDispatch.payload.copySourceItemId).toBe("user:1");
      expect(userDispatch.payload.signalId).toBeUndefined();
    }

    const xSignalDispatch = resolveCopyDispatch({
      perpRoute: null,
      item: {
        id: "x_signal:1",
        symbol: "AAPL",
        side: "buy",
        source: "x_signal",
        meta: { signalId: "abc-123" },
      },
      isOption: false,
      qty: 1,
    });
    expect(xSignalDispatch.kind).toBe("equity");
    if (xSignalDispatch.kind === "equity") {
      expect(xSignalDispatch.payload.copySourceItemId).toBe("x_signal:1");
      expect(xSignalDispatch.payload.signalId).toBe("abc-123");
    }
  });
});

describe("copy-trade info dialog content", () => {
  /**
   * `AlertDialogTitle`/`AlertDialogHeader` read Radix's Dialog context, which
   * only `AlertDialog` (the Root) provides - so `CopyTradeInfoContent` needs
   * a Root ancestor to render at all. The Root itself renders no Portal (only
   * `AlertDialogContent` does), so wrapping it here does not reintroduce the
   * "Portals are not supported by the server renderer" problem `Content`
   * would.
   */
  function markup(): string {
    return renderToStaticMarkup(
      createElement(AlertDialog, null, createElement(CopyTradeInfoContent)),
    );
  }

  test("scopes stock limits and describes perp directions and exits", () => {
    const html = markup();
    expect(html).toContain("single-leg options");
    expect(html).toContain("Buy to Open");
    expect(html).toContain("Sell to Close");
    expect(html).toContain("User and caller follows");
    expect(html).toContain("Stocks are long-only");
    expect(html).toContain("Manual Copy only pre-fills stock");
    expect(html).toContain("never opens a stock short");
    expect(html).toContain("perp opens can be long or short");
    expect(html).toContain("Manual Copy can");
    expect(html).toContain("prefill either direction");
    expect(html).toContain("Per-follow exits are optional");
    expect(html).toContain("not guaranteed to attach or execute");
    expect(html).toContain("Source signals do not inherently provide exits");
    expect(html).toContain("can remain open and can be liquidated");
    expect(html).toContain("For stock mirrors, sell quantities are capped");
    expect(html).not.toContain("Manual Copy is buy-only");
    expect(html).not.toContain("it never opens a short");
    expect(html).not.toContain("Mirror can never create a short");
    expect(html).not.toContain("No stop-loss, and no take-profit");
    expect(html).toContain("manual Copy only");
    expect(html).toContain("does not retarget");
    expect(html).toContain(
      "A perp trade is never converted into an Alpaca equity order.",
    );
    expect(html).toContain("enabled for this deployment");
  });

  test("never leaks internal deployment env-var names or stale copy into user-facing text", () => {
    const html = markup();
    expect(html).not.toContain("COPY_TRADE_AUTOMIRROR_ENABLED");
    expect(html).not.toContain("COPY_TRADE_AUTOMIRROR_ALLOW_LIVE");
    expect(html).not.toContain("Options are skipped");
  });
});

describe("copy-trade feed and mirror card layout", () => {
  test("keeps the embedded mobile feed flat, with bordered rows one level deep", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:mobile-style",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];

    const html = renderToStaticMarkup(
      createElement(CopyTradePanel, {
        isSignedIn: true,
        onCopy: () => {},
        onCopyPerp: () => {},
        onViewSymbol: () => {},
        activeCredentialId: "cred-1",
        activeAccountType: "PAPER",
        activeAccountLabel: "Test Paper",
        embedded: true,
      }),
    );

    // The panel itself is flat: no card border, fill or ring of its own around
    // the header, the sizing control and the rows, and the sizing control has
    // no bordered box of its own either. Only the rows keep their bordered
    // treatment, one level deep (DESIGN.md: never a card inside a card).
    expect(html).not.toContain("bg-[#020f16]");
    expect(html).not.toContain("border-[#203b44] bg-[#0b242d] p-2");
    expect(html).toContain("border-b border-[#1a3b46]");
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("border-[#193742]");
    expect(html).toContain("bg-[#071b24]");
  });

  test("restores the pre-embedded card density and theme at xl", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:desktop-style",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];

    const html = renderToStaticMarkup(
      createElement(CopyTradePanel, {
        isSignedIn: true,
        onCopy: () => {},
        onCopyPerp: () => {},
        onViewSymbol: () => {},
        activeCredentialId: "cred-1",
        activeAccountType: "PAPER",
        activeAccountLabel: "Test Paper",
        embedded: true,
      }),
    );

    // The card is flat at every width now, so it has no border or radius to
    // restore at xl; the header, the sizing control and the rows still do.
    expect(html).toContain("xl:bg-transparent");
    expect(html).toContain("xl:text-card-foreground");
    expect(html).toContain("xl:bg-background/70 xl:px-3 xl:py-2");
    expect(html).toContain("xl:rounded-md xl:border-border xl:bg-transparent xl:p-0");
    expect(html).toContain("xl:shadow-none");
    expect(html).toContain("dark:xl:bg-input/30");
  });

  test("renders identity, author, and follow actions as separate bounded rows", () => {
    const html = renderToStaticMarkup(
      createElement(CopyTradeCardHeaderLayout, {
        identity: createElement("button", { "aria-label": "View NVDA chart" }, "$NVDA $123.45"),
        author: createElement("span", { title: "Example trader" }, "Example trader"),
        actions: createElement("button", { type: "button" }, "Follow"),
      }),
    );

    expect(html).toContain('data-testid="copy-trade-card-identity"');
    expect(html).toContain('data-testid="copy-trade-card-author"');
    expect(html).toContain('data-testid="copy-trade-card-actions"');
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("truncate");
    expect(html).toContain("flex-wrap");
    expect(html.indexOf("View NVDA chart")).toBeLessThan(html.indexOf("Example trader"));
    expect(html.indexOf("Example trader")).toBeLessThan(html.indexOf("Follow"));
  });

  test("renders Mirror actions in a wrapping explainer and card action row", () => {
    const explainerHtml = renderToStaticMarkup(
      createElement(MirrorExplainerLayout, {
        copy: createElement(
          "p",
          null,
          "Enable a trader below. Account and sizing are managed per follow.",
        ),
        actions: createElement("button", { type: "button" }, "Manage follows"),
      }),
    );
    const cardHtml = renderToStaticMarkup(
      createElement(CopyTradeCardHeaderLayout, {
        identity: createElement("button", { "aria-label": "View TSLA chart" }, "$TSLA"),
        author: createElement("span", null, "Mirror trader"),
        actions: createElement(
          "label",
          null,
          "Auto-mirror Mirror trader",
          createElement("input", { type: "checkbox" }),
        ),
      }),
    );

    expect(explainerHtml).toContain('data-testid="mirror-explainer"');
    expect(explainerHtml).toContain("flex-wrap");
    expect(explainerHtml).toContain('data-testid="mirror-explainer-actions"');
    expect(explainerHtml).toContain("Manage follows");
    expect(cardHtml).toContain('data-testid="copy-trade-card-actions"');
    expect(cardHtml).toContain("Auto-mirror Mirror trader");
    expect(cardHtml).toContain('type="checkbox"');
  });
});

// ============================================================================
// Full-panel render: proves the trpc query wiring for real (spies on the
// actual hook calls the panel makes) and that a curated set of feed rows
// (plain equity, sell, option, routable perp, refused perp) renders the
// right badges/labels end to end - not just that computeCopyRowState (tested
// in isolation above) COULD produce them.
//
// PERPS_ENABLED and @/lib/trpc are mocked before the dynamic import below,
// per this repo's established pattern (see perps-onboarding-card.test.tsx).
// mock.module replaces a module for the whole test process, so this mock
// supplies every trpc leaf CopyTradePanel and its always-mounted children
// (ManageFollows -> useManageFollows) touch, not just the ones under test.
// ============================================================================

mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  reset: () => {},
};

/** Reassigned per test so the mocked feed query returns exactly the rows that test wants. */
let FEED_ITEMS: unknown[] = [];
let FEED_QUERY_STATE: {
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
} = {
  isLoading: false,
  isError: false,
  error: null,
};
let FEED_FAILED_SOURCES: string[] = [];
/** Reassigned for the inline Mirror tests; the real query returns the user's follows. */
let INLINE_FOLLOWS: unknown[] = [];
/** Reassigned for the inline Mirror tests; the real query returns saved destinations. */
let MIRROR_ACCOUNTS: unknown[] = [];
/** Reassigned for the inline Mirror tests; null represents an unavailable cap. */
let GLOBAL_PERP_MAX_LEVERAGE: number | null = 2;
/** Reassigned for the venue-correct quote render regression. */
let PERP_STATS: unknown[] = [];
type MOCK_QUOTE_QUERY_STATE = {
  dataUpdatedAt?: number;
  isError: boolean;
  isFetching: boolean;
  error: { message: string } | null;
};
const freshQuoteQueryState = (): MOCK_QUOTE_QUERY_STATE => ({
  dataUpdatedAt: Date.now(),
  isError: false,
  isFetching: false,
  error: null,
});
let QUOTE_QUERY_STATE = {
  chart: freshQuoteQueryState(),
  option: freshQuoteQueryState(),
  perp: freshQuoteQueryState(),
};
const DEFAULT_CHART_QUOTES = [
  { symbol: "AAPL", last: "50.00", change: "1", changePercent: "2.0" },
  { symbol: "MSFT", last: "300.00", change: "-1", changePercent: "-1.0" },
  { symbol: "BTC", last: "999.00", change: "1", changePercent: "2.0" },
  { symbol: "PUMP", last: "777.00", change: "1", changePercent: "2.0" },
];

const wiringCalls: {
  feed?: unknown;
  account?: unknown;
  chartQuotes?: unknown;
  optionQuotes?: unknown;
  perpStats?: unknown;
} = {};

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      copyTradeFollows: { list: { invalidate: async () => {}, getData: () => [] } },
      copyTrade: { feed: { invalidate: async () => {} } },
      leaderboard: {
        xCallers: { invalidate: async () => {} },
        users: { invalidate: async () => {} },
      },
    }),
    copyTradeFollows: {
      list: { useQuery: () => ({ data: INLINE_FOLLOWS, isLoading: false, error: null }) },
      update: { useMutation: () => noopMutation },
      unfollow: { useMutation: () => noopMutation },
      follow: { useMutation: () => noopMutation },
    },
    copyTrade: {
      mirrorStatus: { useQuery: () => ({ data: null, isLoading: false, error: null }) },
      feed: {
        useInfiniteQuery: (input: unknown) => {
          wiringCalls.feed = input;
          return {
            data: FEED_QUERY_STATE.isError
              ? undefined
              : {
                  pages: [
                    {
                      items: FEED_ITEMS,
                      failedSources: FEED_FAILED_SOURCES,
                      nextCursor: null,
                    },
                  ],
                },
            isLoading: FEED_QUERY_STATE.isLoading,
            isError: FEED_QUERY_STATE.isError,
            error: FEED_QUERY_STATE.error,
            refetch: async () => {},
            fetchNextPage: () => {},
            hasNextPage: false,
            isFetchingNextPage: false,
          };
        },
      },
    },
    userSettings: {
      hasApiCredentials: {
        useInfiniteQuery: () => ({
          data: { pages: [{ accounts: MIRROR_ACCOUNTS, hasCredentials: MIRROR_ACCOUNTS.length > 0, isComplete: true, nextCursor: null }] },
          hasNextPage: false,
          isFetching: false,
          isLoading: false,
          isSuccess: true,
          isError: false,
          error: null,
          fetchNextPage: async () => undefined,
          refetch: async () => undefined,
        }),
      },
      getCopyPerpLeverageSettings: {
        useQuery: () => ({
          data: { globalPerpMaxLeverage: GLOBAL_PERP_MAX_LEVERAGE },
          isLoading: false,
          error: null,
        }),
      },
    },
    positions: {
      account: {
        useQuery: (input: unknown) => {
          wiringCalls.account = input;
          return { data: { buyingPower: "100000", equity: "100000" }, isLoading: false };
        },
      },
    },
      quotes: {
        getChartQuotes: {
          useQuery: (input: unknown) => {
            wiringCalls.chartQuotes = input;
            return {
            data: DEFAULT_CHART_QUOTES,
            isLoading: false,
            ...QUOTE_QUERY_STATE.chart,
          };
        },
      },
      getOptionQuotes: {
        useQuery: (input: unknown) => {
          wiringCalls.optionQuotes = input;
          return {
            data: [
              {
                symbol: "TSLA",
                expiration: "260719",
                strike: 250,
                optionType: "call",
                bid: "4.50",
                ask: "5.00",
              },
            ],
            isLoading: false,
            ...QUOTE_QUERY_STATE.option,
          };
        },
      },
    },
    hyperliquid: {
      marketStats: {
        useQuery: (input: unknown, options: unknown) => {
          wiringCalls.perpStats = { input, options };
          return { data: PERP_STATS, isLoading: false, ...QUOTE_QUERY_STATE.perp };
        },
      },
    },
  },
}));

const { CopyTradePanel } = await import("./copy-trade-panel");

function renderPanel(
  marketFilter?: "all" | "stocks" | "perps",
  overrides?: {
    activeCredentialId?: string;
    activeAccountType?: "PAPER" | "LIVE";
    activeAccountLabel?: string;
    subheaderAction?: "feed" | "following" | "mirror";
    hideSourceTabs?: boolean;
    lockSource?: "all" | "following" | "x_signal" | "user";
  },
  embedded = false,
) {
  return renderToStaticMarkup(
    createElement(CopyTradePanel, {
      isSignedIn: true,
      onCopy: () => {},
      onCopyPerp: () => {},
      onViewSymbol: () => {},
      activeCredentialId: overrides?.activeCredentialId ?? "cred-1",
      activeAccountType: overrides?.activeAccountType ?? "PAPER",
      activeAccountLabel: overrides?.activeAccountLabel ?? "Test Paper",
      marketFilter,
      subheaderAction: overrides?.subheaderAction,
      hideSourceTabs: overrides?.hideSourceTabs,
      lockSource: overrides?.lockSource,
      embedded,
    }),
  );
}

describe("inline Mirror arming gate", () => {
  test("blocks an unarmed Hyperliquid follow until the global cap is available", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:mirror-cap",
        symbol: "kPEPE",
        side: "buy",
        displayName: "Trader With Perps",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: { type: "user", key: "perp-trader", label: "Trader With Perps" },
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "kPEPE",
          perpDirection: "long",
          perpLeverage: 2,
          perpReduceOnly: false,
        },
      },
    ];
    INLINE_FOLLOWS = [
      {
        targetType: "user",
        targetKey: "perp-trader",
        autoMirror: false,
        credentialId: "hl-cred",
        credentialAccountLabel: "Hyperliquid perps",
        credentialAccountType: "LIVE",
        credentialProvider: "hyperliquid",
        sizingMode: "pct",
        sizingValue: 5,
        perpMaxLeverage: null,
        perpTakeProfitPct: null,
        perpStopLossPct: null,
      },
    ];
    MIRROR_ACCOUNTS = [
      { id: "hl-cred", provider: "hyperliquid", accountId: null, accountType: "LIVE" },
    ];
    GLOBAL_PERP_MAX_LEVERAGE = null;

    const html = renderPanel("perps", {
      activeCredentialId: "hl-cred",
      activeAccountType: "LIVE",
      activeAccountLabel: "Hyperliquid perps",
      subheaderAction: "mirror",
    });

    expect(html).toContain('aria-label="Auto-mirror Trader With Perps"');
    expect(html).toContain("global copy-trading leverage cap");
    expect(html).toContain("disabled");

    FEED_ITEMS = [];
    INLINE_FOLLOWS = [];
    MIRROR_ACCOUNTS = [];
    GLOBAL_PERP_MAX_LEVERAGE = 2;
  });
});

describe("copy-trade panel independent mirror routing", () => {
  const PAPER: AlpacaAccountOption = {
    id: "alpaca-paper",
    provider: "alpaca",
    accountId: "PA-123",
    accountType: "PAPER",
  };
  const HYPERLIQUID: AlpacaAccountOption = {
    id: "hyperliquid-account",
    provider: "hyperliquid",
    accountId: null,
    accountType: "LIVE",
  };
  const PERP_META = {
    assetType: "PERP",
    perpVenue: "hyperliquid",
    perpCoin: "kPEPE",
    perpDirection: "long" as const,
    perpLeverage: 2,
    perpReduceOnly: false,
  };

  test("builds a destination-only row payload from the row's persisted perp config", () => {
    const route = perpCopyFromTradeRow(PERP_META, { perpsEnabled: true });
    const destination = copyTradeMirrorDestination({ meta: PERP_META }, route);
    expect(destination).toBe("perp");
    if (!destination) throw new Error("Expected an explicit perp destination");

    const stored = resolveFollowDestination(
      {
        destinations: {
          stock: {
            enabled: true,
            credentialId: PAPER.id,
            sizingMode: "usd",
            sizingValue: 50,
          },
          perp: {
            enabled: true,
            credentialId: HYPERLIQUID.id,
            sizingMode: "pct",
            sizingValue: 10,
          },
        },
        sizingMode: "pct",
        sizingValue: 5,
        perpStopLossPct: null,
        perpTakeProfitPct: null,
      },
      destination,
    );
    const payload = {
      targetType: "user",
      targetKey: "trader-key",
      ...buildDestinationPatch(destination, { ...stored, enabled: false }),
    };

    expect(payload).toEqual({
      targetType: "user",
      targetKey: "trader-key",
      destinations: {
        perp: {
          enabled: false,
          credentialId: HYPERLIQUID.id,
          sizingMode: "pct",
          sizingValue: 10,
        },
      },
    });
    expect(payload).not.toHaveProperty("autoMirror");
  });

  test("fails closed for unknown rows and credentials from the wrong provider", () => {
    expect(copyTradeMirrorDestination({ meta: {} }, null)).toBeNull();
    expect(copyTradeMirrorDestination({ meta: { assetType: "UNKNOWN" } }, null)).toBeNull();
    expect(accountForDestination("stock", HYPERLIQUID.id, [PAPER, HYPERLIQUID])).toBeNull();
    expect(accountForDestination("perp", PAPER.id, [PAPER, HYPERLIQUID])).toBeNull();
  });

  test("uses destination-specific labels instead of the terminal account label", () => {
    expect(accountOptionLabel(PAPER)).toBe("Paper account PA-123");
    expect(accountOptionLabel(HYPERLIQUID)).toBe("Hyperliquid perps");
    expect(
      copyTradeMirrorDestination(
        { meta: { assetType: "OPTION" } },
        null,
      ),
    ).toBe("stock");
  });

  test("does not paint the terminal Paper/Live badge in Mirror setup", () => {
    FEED_ITEMS = [];
    const html = renderPanel("all", {
      activeAccountType: "PAPER",
      activeAccountLabel: "Terminal Paper",
      subheaderAction: "mirror",
    });

    expect(html).toContain("Per-follow accounts");
    expect(html).not.toContain("Terminal Paper");
  });
});

describe("copy-trade panel data wiring (full render)", () => {
  test("locks the mobile Following panel to followedOnly=true and hides conflicting source tabs", () => {
    FEED_ITEMS = [];

    const html = renderPanel(
      undefined,
      { hideSourceTabs: true, lockSource: "following" },
      true,
    );

    expect(wiringCalls.feed).toMatchObject({
      sources: ["x_signal", "user"],
      followedOnly: true,
    });
    for (const label of ["All", "Following", "Callers", "Users"]) {
      expect(html).not.toContain(`>${label}</button>`);
    }
  });

  test("hides the legacy source tabs when the mobile controller owns Copy navigation", () => {
    FEED_ITEMS = [];

    const html = renderPanel(undefined, { hideSourceTabs: true }, true);

    for (const label of ["All", "Following", "Callers", "Users"]) {
      expect(html).not.toContain(`>${label}</button>`);
    }
    expect(html).toContain("Manage follows");
  });

  test("surfaces an initial feed transport error with a retry action instead of an empty-feed message", () => {
    FEED_ITEMS = [];
    FEED_QUERY_STATE = {
      isLoading: false,
      isError: true,
      error: { message: "copy-trade feed unavailable" },
    };

    const html = renderPanel();

    expect(html).toContain("Copy-trade feed is having trouble loading right now.");
    expect(html).toContain("copy-trade feed unavailable");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("No copy-trade activity yet.");

    FEED_QUERY_STATE = { isLoading: false, isError: false, error: null };
  });

  test("keeps a partial source failure as a degraded notice instead of an empty-feed message", () => {
    FEED_ITEMS = [];
    FEED_FAILED_SOURCES = ["x_signal"];

    const html = renderPanel();

    expect(html).toContain("Some of the copy feed could not be loaded.");
    // Internal source ids are not user-facing copy.
    expect(html).not.toContain("x_signal");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain("No copy-trade activity yet.");

    FEED_FAILED_SOURCES = [];
  });

  test("wires the unified feed, account, and live-quote queries with the real args this panel computes", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:1",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
      {
        source: "user",
        id: "user:2",
        symbol: "MSFT",
        side: "sell",
        displayName: "Trader Two",
        avatar: null,
        timestamp: "2026-01-01T00:00:01Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];

    renderPanel();

    // Default source filter is "all" -> ["x_signal", "user"]; followedOnly
    // only flips true for the "following" filter.
    expect(wiringCalls.feed).toEqual({
      sources: ["x_signal", "user"],
      limit: 30,
      followedOnly: false,
      assetClass: "all",
    });
    expect(wiringCalls.account).toEqual({ credentialId: "cred-1" });
    expect(wiringCalls.chartQuotes).toEqual({ symbols: ["AAPL", "MSFT"] });
  });

  test("forwards the global Perps market filter to the copy-trade feed", () => {
    FEED_ITEMS = [];

    renderPanel("perps");

    expect(wiringCalls.feed).toEqual({
      sources: ["x_signal", "user"],
      limit: 30,
      followedOnly: false,
      assetClass: "perps",
    });
  });

  test("wires the batched option-quotes query from the actual rendered option rows", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:opt-1",
        symbol: "TSLA",
        side: "buy",
        displayName: "Trader Three",
        avatar: null,
        timestamp: "2026-01-01T00:00:02Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: 250,
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
      },
    ];

    renderPanel();

    expect(wiringCalls.optionQuotes).toEqual({
      contracts: [{ symbol: "TSLA", expiration: "260719", strike: 250, optionType: "call" }],
      credentialId: "cred-1",
    });
  });

  test("uses Hyperliquid marks for confirmed perps and never falls back to colliding stock quotes", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:stock-btc",
        symbol: "BTC",
        side: "buy",
        displayName: "Stock Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: { assetType: "EQUITY" },
      },
      {
        source: "user",
        id: "user:perp-btc",
        symbol: "BTC",
        side: "buy",
        displayName: "Perp Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:01Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "BTC",
          perpDirection: "long",
          perpLeverage: 2,
          perpReduceOnly: false,
        },
      },
      {
        source: "user",
        id: "user:perp-hip3",
        symbol: "XYZ:SNDK",
        side: "buy",
        displayName: "HIP3 Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:02Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "xyz:SNDK",
          perpDirection: "long",
          perpLeverage: 3,
          perpReduceOnly: false,
        },
      },
      {
        source: "user",
        id: "user:perp-no-quote",
        symbol: "PUMP",
        side: "buy",
        displayName: "Missing Quote Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:03Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "PUMP",
          perpDirection: "long",
          perpLeverage: 4,
          perpReduceOnly: false,
        },
      },
    ];
    PERP_STATS = [
      { coin: "BTC", markPx: "60000", prevDayPx: "59000" },
      { coin: "xyz:SNDK", markPx: "13.25", prevDayPx: "12.5" },
    ];

    const html = renderPanel();

    expect(wiringCalls.chartQuotes).toEqual({ symbols: ["BTC"] });
    expect(wiringCalls.perpStats).toMatchObject({
      input: undefined,
      options: { enabled: true },
    });
    expect(html).toContain("$999.00");
    expect(html).toContain("$60,000.00");
    expect(html).toContain("$13.25");
    expect(html).not.toContain("$777.00");

    PERP_STATS = [];
  });
});

describe("copy-trade panel rendered rows (full render)", () => {
  test("keeps embedded Copy and sizing controls at the mobile target until xl", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:mobile-targets",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];

    const html = renderPanel(undefined, undefined, true);
    expect(html).toMatch(
      /<button(?=[^>]*>Copy 100 sh<\/button>)(?=[^>]*h-11 xl:h-7)[^>]*>/,
    );
    expect(html).toContain("h-11 xl:h-7 px-2 text-xs");
    expect(html).toContain("h-11 xl:h-7 w-24 tabular-nums");
  });

  test("makes a perp-only feed a ticket prefill surface, not a stock sizing surface", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:perp-prefill-copy",
        symbol: "kPEPE",
        side: "buy",
        displayName: "Perp Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "kPEPE",
          perpDirection: "long",
          perpLeverage: 10,
          perpReduceOnly: false,
        },
      },
    ];

    const html = renderPanel("perps");
    expect(html).toContain("Perp copies only prefill the ticket");
    expect(html).toContain("Prefill 10x Long");
    expect(html).not.toContain('aria-label="Order sizing basis"');
  });

  test("keeps sizing and Copy controls non-interactive before storage hydration", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:hydration-guard",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];

    const html = renderPanel();
    expect(html).toMatch(
      /<input(?=[^>]*aria-label="Percent of buying power per order")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(html).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*>Copy 100 sh<\/button>)[^>]*>/,
    );
  });
  test("renders an OPTION badge for option rows and none for a plain equity row", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:eq-1",
        symbol: "AAPL",
        side: "buy",
        displayName: "Trader One",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
      {
        source: "user",
        id: "user:opt-1",
        symbol: "TSLA",
        side: "buy",
        displayName: "Trader Three",
        avatar: null,
        timestamp: "2026-01-01T00:00:02Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: 250,
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
      },
    ];
    const html = renderPanel();
    expect(html).toContain(">Option<");
    // pct 5% of $100,000 buying power -> $5,000 target; AAPL at $50/sh -> 100 sh.
    expect(html).toContain("Copy 100 sh");
    // TSLA option, 100x multiplier, priced off the $5.00 ask -> 10 contracts.
    expect(html).toContain("Copy 10 ct");
  });

  test("disables retained stock, perp, and option prices after a refresh error, then recovers", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:fresh-stock",
        symbol: "AAPL",
        side: "buy",
        displayName: "Stock Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:00Z",
        content: null,
        url: null,
        followTarget: null,
        meta: { assetType: "EQUITY" },
      },
      {
        source: "user",
        id: "user:fresh-perp",
        symbol: "BTC",
        side: "buy",
        displayName: "Perp Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:01Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "PERP",
          perpVenue: "hyperliquid",
          perpCoin: "BTC",
          perpDirection: "long",
          perpLeverage: 2,
          perpReduceOnly: false,
        },
      },
      {
        source: "user",
        id: "user:fresh-option",
        symbol: "TSLA",
        side: "buy",
        displayName: "Options Trader",
        avatar: null,
        timestamp: "2026-01-01T00:00:02Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {
          assetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: 250,
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
      },
    ];
    PERP_STATS = [{ coin: "BTC", markPx: "60000", prevDayPx: "59000" }];
    const failedState = (updatedAt: number): MOCK_QUOTE_QUERY_STATE => ({
      dataUpdatedAt: updatedAt,
      isError: true,
      isFetching: false,
      error: { message: "refresh failed" },
    });
    const freshState = (updatedAt: number): MOCK_QUOTE_QUERY_STATE => ({
      dataUpdatedAt: updatedAt,
      isError: false,
      isFetching: false,
      error: null,
    });

    QUOTE_QUERY_STATE = {
      chart: failedState(Date.now() - 1_000),
      option: failedState(Date.now() - 1_000),
      perp: failedState(Date.now() - 1_000),
    };
    const failedHtml = renderPanel();
    const failureReason = "Current quote refresh failed. Refresh before copying.";
    expect(failedHtml.match(new RegExp(failureReason, "g"))?.length).toBe(3);
    expect(failedHtml).toContain(">Copy</button>");
    expect(failedHtml).toContain("Prefill 2x Long");

    const recoveredAt = Date.now();
    QUOTE_QUERY_STATE = {
      chart: freshState(recoveredAt),
      option: freshState(recoveredAt),
      perp: freshState(recoveredAt),
    };
    const recoveredHtml = renderPanel();
    expect(recoveredHtml).not.toContain(failureReason);
    expect(recoveredHtml).toContain("Copy 100 sh");
    expect(recoveredHtml).toContain("Prefill 2x Long");
    expect(recoveredHtml).toContain("Copy 10 ct");

    FEED_ITEMS = [];
    PERP_STATS = [];
    QUOTE_QUERY_STATE = {
      chart: freshQuoteQueryState(),
      option: freshQuoteQueryState(),
      perp: freshQuoteQueryState(),
    };
  });

  test("shows sell activity as \"Sell shown\", never a manual sell Copy", () => {
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:sell-1",
        symbol: "MSFT",
        side: "sell",
        displayName: "Trader Two",
        avatar: null,
        timestamp: "2026-01-01T00:00:01Z",
        content: null,
        url: null,
        followTarget: null,
        meta: {},
      },
    ];
    const html = renderPanel();
    expect(html).toContain("Sell shown");
  });

  test("routes a valid PERP row to the perp label and refuses a reduce-only PERP row, WITHOUT ever showing an equity Copy for either", () => {
    const basePerpMeta = {
      assetType: "PERP",
      perpVenue: "hyperliquid",
      perpCoin: "kPEPE",
      perpDirection: "long",
      perpLeverage: 10,
    };
    FEED_ITEMS = [
      {
        source: "user",
        id: "user:perp-open",
        symbol: "kPEPE",
        side: "buy",
        displayName: "Trader Four",
        avatar: null,
        timestamp: "2026-01-01T00:00:03Z",
        content: null,
        url: null,
        followTarget: null,
        meta: { ...basePerpMeta, perpReduceOnly: false },
      },
      {
        source: "user",
        id: "user:perp-close",
        symbol: "kPEPE",
        side: "buy",
        displayName: "Trader Five",
        avatar: null,
        timestamp: "2026-01-01T00:00:04Z",
        content: null,
        url: null,
        followTarget: null,
        meta: { ...basePerpMeta, perpReduceOnly: true },
      },
    ];
    const html = renderPanel();

    expect(html).toContain("Prefill 10x Long");
    expect(html).toContain(
      "This trade closes a position rather than opening one; copying it as a new order isn&#x27;t supported.",
    );
    // Neither PERP row - open or refused-close - ever renders the equity
    // share-count label; a kPEPE row never becomes "Copy N sh".
    expect(html).not.toContain("sh</button>");
  });
});

describe("inline Mirror arming leverage ceiling", () => {
  const baseSummary = buildArmingSummary({
    trader: "Example Trader",
    account: "Hyperliquid Main",
    destinationProvider: "hyperliquid",
    sizingMode: "pct",
    sizingValue: 5,
    limits: {
      dailyCap: 20,
      maxOrderDollars: 1_000,
      dailyCapFromDefaults: false,
      maxOrderDollarsFromDefaults: false,
    },
  });

  test("inherits the global cap when the inline follow has no override", () => {
    const summary = buildInlineMirrorArmingSummary(baseSummary, 3, null);
    expect(summary.facts).toContainEqual({
      label: "Perp leverage ceiling",
      value: "3x maximum for automatic perp copies. Leaders and markets may use less.",
    });
  });

  test("uses the stricter inline follow override when it is below global", () => {
    const summary = buildInlineMirrorArmingSummary(baseSummary, 3, 1);
    expect(summary.facts).toContainEqual({
      label: "Perp leverage ceiling",
      value: "1x maximum for automatic perp copies. Leaders and markets may use less.",
    });
  });
});

// ============================================================================
// Cross-component contracts (kept as source checks).
//
// These four checks pin behavior in the /app terminal (app/app, see
// `dashboardSource` above) and in
// components/trade/trade-form.tsx, NOT in copy-trade-panel.tsx - what happens
// to the trade ticket after a copy prefills it. Both files are owned by their
// own conversion efforts (page-layout.test.ts, trade-form.test.ts) and are
// under active, separate, in-flight edits in this same repo; this file only
// reads them read-only to pin the boundary CONTRACT copy-trade relies on.
//
// The logic itself is entirely inside `useEffect` bodies (trade-form.tsx) or
// spread across many onClick/onSuccess handlers (page.tsx's clearCopyPrefill,
// called from >=4 sites). This repo's test setup has no DOM/jsdom and no
// act()/fireEvent - only renderToStaticMarkup (a single static pass with no
// effects) and no persistent reconciler - so neither is reachable by
// rendering, the same conclusion trade-form.test.ts's own "kept as source
// checks" section already reaches for this file, with the same justification.
// Extracting the reset payloads into "pure" helpers would not add real
// coverage either: the risk is the effect forgetting to CALL the helper, not
// the helper computing the wrong thing, and a standalone unit test cannot see
// a call site it never runs.
// ============================================================================

describe("copy-trade -> trade-form prefill contract (kept as source checks)", () => {
  test("clears option prefill when a later equity copy is selected", () => {
    expect(dashboardSource).toContain(
      'initialAssetType={activeOptionCopy?.assetType ?? "EQUITY"}',
    );
    expect(tradeFormSource).toContain('if (initialAssetType === "EQUITY")');
    expect(tradeFormSource).toContain('assetType: "EQUITY"');
  });

  test("clears stale copy quantity and side when leaving copy-trade context", () => {
    expect(dashboardSource).toContain("const clearCopyPrefill = () => {");
    expect(dashboardSource).toContain("setActiveSide(undefined)");
    expect(dashboardSource).toContain("setActiveQty(undefined)");
    expect(dashboardSource).toContain("setActiveStockCopy(null)");
    expect(dashboardSource).toContain("setActivePerpCopy(null)");
    expect((dashboardSource.match(/clearCopyPrefill\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  test("does not invent a trade action for an option copy", () => {
    expect(tradeFormSource).toContain("if (!optionTradeAction) return;");
    expect(tradeFormSource).not.toContain("initialTradeAction ??");
  });

  test("applies instrument and action prefill atomically", () => {
    expect(tradeFormSource).toContain("const currentValues = getValues();");
    expect(tradeFormSource).toContain("reset({");
    expect(tradeFormSource).toContain("...currentValues");
    expect(tradeFormSource).toContain('assetType: "OPTION"');
    expect(tradeFormSource).toContain("action: optionTradeAction");
    expect(tradeFormSource).toContain('value={field.value || "EQUITY"}');
    expect(tradeFormSource).toContain('field.value || ""');
    expect(tradeFormSource).not.toContain("field.value || undefined");
  });
});
