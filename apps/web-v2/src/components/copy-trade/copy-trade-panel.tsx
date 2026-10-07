"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getQueryKey } from "@trpc/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useCompleteApiCredentials } from "@/lib/use-complete-api-credentials";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DegradedNotice } from "@/components/ui/degraded-notice";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import { copyTradeNotionalUsd } from "./copy-trade-notional";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Trophy, Wallet } from "lucide-react";
import { toast } from "sonner";
import { FollowButton } from "./follow-button";
import { buildFollowArmingSummary, ManageFollows } from "./manage-follows";
import { CopyTradeInfoDialog } from "./copy-trade-info-dialog";
import {
  CopyTradeCardHeaderLayout,
  CopyTradeSourceTabs,
  MirrorExplainerLayout,
  PerpRowBadge,
  EquityRowBadge,
} from "./copy-trade-card-layout";
import {
  accountForDestination,
  accountOptionLabel,
  autoMirrorSwitchState,
  buildDestinationPatch,
  DESTINATION_PRESENTATION,
  destinationSupportsTarget,
  toAccountOptions,
  type MirrorDestination,
  type MirrorDestinationConfig,
} from "./account-targeting";
import { resolveFollowDestination } from "./use-manage-follows-state";
import { InlineMirrorSwitch } from "./auto-mirror-switch";
import { ArmMirrorDialog, StopMirrorDialog } from "./mirror-consent-dialogs";
import {
  buildDestinationArmingSummary,
  buildDestinationStopSummary,
  describeMirrorDeployment,
  followTargetTypeLabel,
  followUpdateToast,
  resolveMirrorLimits,
  type ArmingSummary,
} from "./mirror-consent";
import {
  SIZING_MODE_PRESENTATION,
  type SizingMode,
  type PerpProtectionRuleView,
} from "./mirror-sizing";
import { SizingModeTabs } from "./sizing-mode-tabs";
import { copyDisabledReason } from "./copy-eligibility";
import { perpCopyFromTradeRow, type PerpTradeRowRoute } from "./copy-perp-route";
import { classifyCopyTradeInstrument } from "./copy-trade-instrument";
import { getCopyTradeQuoteReadiness } from "./copy-trade-quote-state";
import { useCopyTradeQuoteClock } from "./use-copy-trade-quote-clock";
import {
  copyTradeQuoteIdentity,
  findCopyTradePerpQuote,
  selectCopyTradeQuoteInputs,
} from "./copy-trade-quotes";
import { feedChartViewLabel } from "@/components/feed/ticker-chart-action";
import { PERPS_ENABLED } from "@/lib/perps-config";
import type { MarketSearchFilter, MarketVenue } from "@/lib/market-selection";
import { formatPerpChangePct, formatPerpUsd } from "@/components/perps/perp-format";
import {
  parseStoredSizing,
  parseStoredSourceFilter,
  type SourceFilter,
  type Sizing,
} from "./copy-trade-persistence";
import {
  computeCopyRowState,
  computeTargetDollars,
  optionContractKey,
  readNumber,
  readOptionType,
  readString,
  resolveCopyDispatch,
} from "./copy-trade-row-state";
import { followMembershipKeys } from "./follow-membership";
import { WalletFollowPanel } from "./wallet-follow-panel";
// Shared canonical author name: keeps the leaderboard consistent with the feed
// and chart markers (strips the relay label, collapses the Shardi variants)
// instead of re-implementing a trailing-only clean here.
import { normalizeAuthorName } from "@/lib/signal-display";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";

/** How many items to fetch per infinite-scroll page (matches signal-feed). */
const PAGE_SIZE = 30;

const MAX_OPTION_QUOTES = 20;

/** Keep tappable copy controls large until the desktop drawer reaches xl. */
const TOUCH_HEIGHT_COMPACT_XL = "h-11 xl:h-7";

function validPerpLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COPY_PERP_MAX_LEVERAGE_MIN &&
    value <= COPY_PERP_MAX_LEVERAGE_MAX
  );
}

/** localStorage key for the selected source filter ("all" | "x_signal" | "user" | "following"). */
export const SOURCES_KEY = "copy-trade:sources";

/** localStorage key for the sizing control ({ mode, value }). */
export const SIZING_KEY = "copy-trade:sizing";

/** The backend's CopyTradeSource discriminator (politician is Phase-2/disabled). */
type CopyTradeSource = "x_signal" | "user" | "politician";

// "all" expands to ["x_signal","user"]; "following" keeps all sources but
// drives the feed's `followedOnly` flag so the panel only shows targets the
// user follows. The type itself, and the parsing of its persisted value, now
// live in ./copy-trade-persistence so both are directly unit-testable.
export type CopyTradeSubheaderAction = "feed" | "following" | "mirror";

// SizingMode and the per-mode labels, captions and bounds now live in
// ./mirror-sizing, shared with manage-follows.tsx. They used to be two separate
// tables that had drifted: the same mode read "of buying power" here and "of
// margin buying power" there. The Sizing shape (and its persisted parsing) now
// live in ./copy-trade-persistence.

export type CopyOptionType = "CALL" | "PUT";
export type CopyTradeAction = "BuyToOpen" | "SellToClose";

export interface CopyTradePayload {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  copySourceItemId?: string;
  signalId?: string;
  assetType?: "EQUITY" | "OPTION";
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: CopyOptionType;
  tradeAction?: CopyTradeAction;
}

/**
 * The perp-route Copy payload: which feed item, which coin + side, and
 * leverage if the source fill carried one. Deliberately has no `symbol`/`qty`
 * field - a perp copy prefills the PERP ticket's coin/side/leverage, never an
 * equity size, and the two payload shapes stay disjoint at the type level so a
 * perp row cannot be typed into the equity handler.
 */
export interface CopyPerpTradePayload {
  itemId: string;
  coin: string;
  side: "long" | "short";
  leverage?: number;
}

/**
 * The venue-aware destination for a ticker click in the copy-trade feed.
 *
 * Equity rows intentionally keep the old symbol-only callback contract. A
 * Hyperliquid row instead carries the canonical, case-sensitive coin and the
 * venue so a display ticker such as `GOOGL` cannot be routed to the stock
 * market when its actual perp coin is `xyz:GOOGL`.
 */
export interface CopyTradeViewSelection {
  symbol: string;
  venue?: MarketVenue;
}

export function copyTradeViewSelection(
  displaySymbol: string,
  perpRoute: PerpTradeRowRoute,
  meta?: Record<string, unknown> | null,
): CopyTradeViewSelection | null {
  if (perpRoute?.kind === "perp") {
    return { symbol: perpRoute.coin, venue: "perps" };
  }
  if (perpRoute?.kind === "refused") {
    return { symbol: perpRoute.coin ?? displaySymbol, venue: "perps" };
  }

  if (meta !== undefined) {
    const instrument = classifyCopyTradeInstrument(meta);
    if (instrument === "perp") return { symbol: displaySymbol, venue: "perps" };
    if (instrument === "unknown") return null;
  }
  return { symbol: displaySymbol };
}

/**
 * Resolve the mirror destination from an explicitly typed feed row.
 *
 * Mirror setup is a venue-specific control. A missing or unfamiliar asset
 * marker is therefore unknown, rather than an equity row by default. Perp
 * markers stay perp even when routing is refused, so a bad coin cannot fall
 * through into a same-ticker stock order.
 */
export function copyTradeMirrorDestination(
  item: { meta?: Record<string, unknown> | null },
  _perpRoute?: PerpTradeRowRoute,
): "stock" | "perp" | null {
  const instrument = classifyCopyTradeInstrument(item.meta);
  if (instrument === "perp") return "perp";
  if (instrument === "equity" || instrument === "option") {
    // Mirror setup needs an explicit venue contract. Legacy empty signal meta
    // can remain a plain equity for manual Copy, but is not safe to arm.
    return readString(item.meta?.assetType) ? "stock" : null;
  }
  return null;
}

const DEFAULT_SIZING: Sizing = { mode: "pct", value: 5 };
const ZERO_SIZING: Sizing = { mode: "pct", value: 0 };
const DEFAULT_SOURCE: SourceFilter = "all";

/** Resolve persisted sizing, applying the active default only for a missing key. */
export function resolveStoredSizing(raw: string | null): Sizing {
  if (raw === null) return DEFAULT_SIZING;
  return parseStoredSizing(raw) ?? ZERO_SIZING;
}

/**
 * TweetShift relays tweets with usernames like "Serenity • TweetShift" - the
 * backend already strips this server-side, but mirror it for any local display.
 */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Formats a quote's last price as currency, or null when it's unavailable. */
function formatQuotePrice(value: string | undefined): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

/** A row needs a usable price before any sizing or prefill action. */
function hasPositiveQuote(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Formats a verified Hyperliquid mark, or null when no usable mark exists. */
function formatPerpQuotePrice(value: string | null | undefined): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return formatPerpUsd(value);
}

/** Formats a signed percent change like "+1.25%" / "-0.40%". */
function formatChangePercent(value: string | undefined): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

// readString / readNumber / readOptionType / readTradeAction / optionContractKey
// now live in ./copy-trade-row-state, alongside the qty/disabled/title decision
// that consumes them, so both are unit-testable together.

/**
 * Persists the source filter. SSR-safe: starts from a default on both server
 * and first client render (avoids a hydration mismatch), then reconciles from
 * localStorage after mount - same pattern as signal-feed's useHiddenAuthors.
 */
function useSourceFilter() {
  const [source, setSource] = useState<SourceFilter>(DEFAULT_SOURCE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SOURCES_KEY);
      const parsed = parseStoredSourceFilter(raw);
      if (parsed) setSource(parsed);
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(SOURCES_KEY, source);
    } catch {
      // ignore
    }
  }, [source, hydrated]);

  return { source, setSource };
}

/** Persists the sizing control ({ mode, value }). SSR-safe, like useSourceFilter. */
function useSizing() {
  const [sizing, setSizing] = useState<Sizing>(DEFAULT_SIZING);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIZING_KEY);
      setSizing(resolveStoredSizing(raw));
    } catch {
      // Storage access failed, so the key's absence cannot be confirmed.
      // Keep the manual copy path at zero exposure rather than guessing.
      setSizing(ZERO_SIZING);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(SIZING_KEY, JSON.stringify(sizing));
    } catch {
      // ignore
    }
  }, [sizing, hydrated]);

  const setMode = useCallback((mode: SizingMode) => setSizing((s) => ({ ...s, mode })), []);
  const setValue = useCallback((value: number) => setSizing((s) => ({ ...s, value })), []);

  return { sizing, setMode, setValue, hydrated };
}

export interface CopyTradePanelProps {
  isSignedIn: boolean;
  onCopy: (p: CopyTradePayload) => void;
  /**
   * Prefill the PERP ticket instead of the equity one. Only ever invoked for a
   * row `perpCopyFromTradeRow` resolved to `{ kind: "perp" }` - a row it
   * refuses, or one that isn't a perp at all, never reaches this callback.
   * Optional so a caller that hasn't wired perp copy yet still renders; such a
   * row falls back to a disabled Copy with a reason, never a silent no-op
   * (see `copyDisabled` below).
   */
  onCopyPerp?: (p: CopyPerpTradePayload) => void;
  onViewSymbol: (symbol: string, venue?: MarketVenue) => void;
  selectedItemId?: string;
  /** The credential whose buying power sizes % copies - must match the header /
   * the account the trade form submits against. */
  activeCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
  activeAccountLabel?: string;
  marketFilter?: MarketSearchFilter;
  subheaderAction?: CopyTradeSubheaderAction;
  subheaderActionNonce?: number;
  embedded?: boolean;
  /**
   * Hide the legacy source filter row when a containing surface owns the
   * canonical Copy destination navigation (for example, the mobile shell).
   */
  hideSourceTabs?: boolean;
  /** Lock the panel's source/query to a containing destination's source. */
  lockSource?: SourceFilter;
  /**
   * Plan A10. The mobile Copy screen mounts the leaderboards itself, in its own
   * tab row, so the header's link out to /lb is both redundant and
   * harmful there: that route is a separate page with no bottom nav, so tapping
   * it exits the mobile shell and discards the screen, feed tab and selected
   * signal. Left on for the desktop terminal, where /lb is a full-page
   * destination and nothing is lost by navigating to it.
   */
  showLeaderboardLink?: boolean;
}

/**
 * Add the user's global ceiling and this follow's optional override to the
 * inline Mirror confirmation. Keeping this wrapper next to the panel makes
 * the inline path use the same effective-ceiling wording as Manage follows,
 * so neither arming entry point can silently omit the safety fact.
 */
export function buildInlineMirrorArmingSummary(
  summary: ArmingSummary,
  globalPerpMaxLeverage: number | null,
  followPerpMaxLeverage: number | null,
): ArmingSummary {
  return buildFollowArmingSummary(
    summary,
    globalPerpMaxLeverage,
    followPerpMaxLeverage,
  );
}

export function CopyTradePanel({
  isSignedIn,
  onCopy,
  onCopyPerp,
  onViewSymbol,
  selectedItemId,
  activeCredentialId,
  marketFilter = "all",
  subheaderAction = "feed",
  subheaderActionNonce = 0,
  embedded = false,
  hideSourceTabs = false,
  lockSource,
  showLeaderboardLink = true,
}: CopyTradePanelProps) {
  const { collapsed, toggle } = useCollapsible("copy-trade");
  const isCollapsed = embedded ? false : collapsed;
  const { source, setSource } = useSourceFilter();
  const effectiveSource = lockSource ?? source;
  const { sizing, setMode, setValue, hydrated: sizingHydrated } = useSizing();
  const mirrorSetupActive = subheaderAction === "mirror";
  const lastSubheaderNonceRef = useRef(0);
  const [showWalletPanel, setShowWalletPanel] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // "Following" keeps every source but drives the feed's followedOnly flag.
  const followedOnly = effectiveSource === "following";

  // Translate the single-select source filter into the backend's `sources` arg.
  // "all"/"following" => ["x_signal","user"]; never request "politician" while disabled.
  const sources = useMemo<CopyTradeSource[]>(() => {
    if (effectiveSource === "x_signal") return ["x_signal"];
    if (effectiveSource === "user") return ["user"];
    return ["x_signal", "user"];
  }, [effectiveSource]);

  useEffect(() => {
    if (
      subheaderActionNonce === 0 ||
      lastSubheaderNonceRef.current === subheaderActionNonce
    ) {
      return;
    }
    lastSubheaderNonceRef.current = subheaderActionNonce;

    if (subheaderAction === "feed") {
      setSource("all");
      return;
    }
    if (subheaderAction === "following") {
      setSource("following");
      return;
    }

    setSource("following");
    setMode("pct");
  }, [subheaderAction, subheaderActionNonce, setMode, setSource]);

  // The user's follows, keyed as "type|key" (matches the server's followSetKey),
  // so each row can reflect followed-state without an extra per-row request.
  const trpcUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const followsQuery = trpc.copyTradeFollows.list.useQuery(undefined, {
    enabled: isSignedIn,
  });
  const followedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const f of followsQuery.data ?? []) {
      for (const key of followMembershipKeys(f)) {
        set.add(`${f.targetType}|${key}`);
      }
    }
    return set;
  }, [followsQuery.data]);

  // Map key → follow object so Mirror-tab rows can read/toggle autoMirror inline.
  const followsByKey = useMemo(() => {
    const map = new Map<string, {
      targetType: string;
      targetKey: string;
      autoMirror: boolean;
      credentialId: string | null;
      credentialAccountLabel: string | null;
      credentialAccountType: "PAPER" | "LIVE" | null;
      credentialProvider: "alpaca" | "hyperliquid" | null;
      sizingMode: SizingMode;
      sizingValue: number;
      destinations?: Partial<
        Record<MirrorDestination, MirrorDestinationConfig>
      >;
      perpStopLossPct: number | null;
      perpTakeProfitPct: number | null;
      /** Null means the inline Mirror follow inherits the global ceiling. */
      perpMaxLeverage: number | null;
      perpProtection: PerpProtectionRuleView | null;
    }>();
    for (const f of followsQuery.data ?? []) {
      const follow = {
        targetType: f.targetType,
        targetKey: f.targetKey,
        autoMirror: f.autoMirror ?? false,
        credentialId: f.credentialId ?? null,
        credentialAccountLabel: f.credentialAccountLabel ?? null,
        credentialAccountType: f.credentialAccountType ?? null,
        credentialProvider: f.credentialProvider ?? null,
        // The confirmation must state the size this follow will actually use,
        // which is the follow's own rule, never the panel's manual-copy sizing.
        sizingMode: f.sizingMode,
        sizingValue: f.sizingValue,
        destinations: f.destinations,
        perpStopLossPct: f.perpStopLossPct,
        perpTakeProfitPct: f.perpTakeProfitPct,
        // Keep the nullable override with the follow so inline arming can
        // show the exact effective ceiling instead of only the global default.
        perpMaxLeverage: f.perpMaxLeverage ?? null,
        // Same rule as the sizing above, and the same reason: the confirmation
        // must state the exit THIS follow will actually attach. Omitting it here
        // would have the inline switch print "no automatic exit" over a follow
        // that carries one, which is the arming copy describing something the
        // worker does not do.
        perpProtection:
          f.perpTakeProfitPct === null && f.perpStopLossPct === null
            ? null
            : { takeProfitPct: f.perpTakeProfitPct, stopLossPct: f.perpStopLossPct },
      };
      for (const key of followMembershipKeys(f)) {
        map.set(`${f.targetType}|${key}`, { ...follow, targetKey: key });
      }
    }
    return map;
  }, [followsQuery.data]);

  // The inline Mirror tab has no Manage follows child to supply this setting,
  // so it reads the same user-owned global ceiling directly. The optional
  // access keeps older embedded/test trpc mocks renderable without inventing a
  // value; the real router always exposes this procedure.
  const leverageSettingsQuery =
    trpc.userSettings.getCopyPerpLeverageSettings?.useQuery(undefined, {
      enabled: isSignedIn,
    }) ?? {
      data: undefined as { globalPerpMaxLeverage?: unknown } | undefined,
      isLoading: false,
      error: null as { message: string } | null,
    };
  const rawGlobalPerpMaxLeverage = leverageSettingsQuery.error
    ? undefined
    : leverageSettingsQuery.data?.globalPerpMaxLeverage;
  const globalPerpMaxLeverage = validPerpLeverage(rawGlobalPerpMaxLeverage)
    ? rawGlobalPerpMaxLeverage
    : null;

  const autoMirrorMutation = trpc.copyTradeFollows.update.useMutation({
    onSuccess: (_data, variables) => {
      trpcUtils.copyTradeFollows.list.invalidate();
      trpcUtils.copyTrade.feed.invalidate();
      toast.success(followUpdateToast(variables));
    },
    onError: (error) => {
      toast.error(error.message || "Could not update follow");
    },
  });

  // What this deployment can honestly say about auto-mirroring, so the inline
  // switch here blocks and explains for the same reasons Manage follows does.
  const mirrorStatusQuery = trpc.copyTrade.mirrorStatus.useQuery(undefined, {
    enabled: isSignedIn,
    staleTime: 60_000,
  });
  const mirrorDeployment = describeMirrorDeployment(mirrorStatusQuery.data ?? null);
  const mirrorLimits = resolveMirrorLimits(mirrorStatusQuery.data ?? null);

  // Saved destinations, so the arming confirmation can tell a Hyperliquid
  // account from an Alpaca one and show the perp disclosure accordingly.
  // Deduped by React Query with the identical read inside useManageFollows.
  const mirrorAccountsQuery = useCompleteApiCredentials(undefined, { enabled: isSignedIn });
  const mirrorAccounts = useMemo(
    () => toAccountOptions(mirrorAccountsQuery.accounts),
    [mirrorAccountsQuery.accounts],
  );

  /**
   * The arming request raised by an inline Mirror switch, held until the user
   * confirms it. The switch itself never mutates: see auto-mirror-switch.tsx.
   */
  const [mirrorConsent, setMirrorConsent] = useState<null | {
    kind: "arm" | "disarm";
    destination: MirrorDestination;
    displayName: string;
    targetType: "user" | "x_author" | "politician";
    targetKey: string;
    credentialId: string | null;
    accountLabel: string | null;
    destinationProvider: "alpaca" | "hyperliquid" | null;
    sizingMode: SizingMode;
    sizingValue: number;
    config: MirrorDestinationConfig;
    perpMaxLeverage: number | null;
    perpProtection: PerpProtectionRuleView | null;
  }>(null);

  // Infinite feed over the unified copy-trade endpoint, newest first. The
  // opaque base64 cursor is round-tripped straight from nextCursor.
  const {
    data,
    isLoading,
    isError: feedRequestFailed,
    error: feedError,
    refetch: refetchFeed,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.copyTrade.feed.useInfiniteQuery(
    { sources, limit: PAGE_SIZE, followedOnly, assetClass: marketFilter },
    {
      enabled: isSignedIn,
      getNextPageParam: (p) => p.nextCursor ?? undefined,
      refetchInterval: 10000,
    },
  );

  // Audit M13: sources that errored server-side. Rendered as a degraded
  // notice so a broken source is distinguishable from an empty feed.
  const failedSources = useMemo(() => {
    const failed = new Set<string>();
    for (const page of data?.pages ?? []) {
      for (const source of page.failedSources ?? []) failed.add(source);
    }
    return [...failed];
  }, [data]);

  // Flatten all loaded pages, de-duping by the source-prefixed item id across
  // page boundaries.
  const items = useMemo(() => {
    const pages = data?.pages ?? [];
    const seen = new Set<string>();
    return pages.flatMap((page) =>
      page.items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    );
  }, [data]);

  // Buying power for % sizing, bound to the SAME credential the header shows and
  // the trade form submits against - otherwise % copies could be sized off a
  // different (e.g. Paper vs Live) account than the order hits. Degrades
  // gracefully: no credential selected -> disabled; creds error -> 0 / disable %.
  const accountQuery = trpc.positions.account.useQuery(
    { credentialId: activeCredentialId },
    { enabled: isSignedIn && !!activeCredentialId, retry: false },
  );
  const buyingPower = Number(accountQuery.data?.buyingPower ?? 0);
  const hasBuyingPower = Number.isFinite(buyingPower) && buyingPower > 0;
  const equity = Number(accountQuery.data?.equity ?? 0);
  const hasEquity = Number.isFinite(equity) && equity > 0;

  // Stock symbols and canonical Hyperliquid coins have separate quote sources.
  // A PERP row with an unconfirmed venue/coin remains out of both inputs.
  const quoteInputs = useMemo(() => selectCopyTradeQuoteInputs(items), [items]);

  const quotesQuery = trpc.quotes.getChartQuotes.useQuery(
    { symbols: quoteInputs.stockSymbols },
    {
      enabled: isSignedIn && quoteInputs.stockSymbols.length > 0,
      refetchInterval: 30000,
      staleTime: 15000,
    },
  );

  const quotesBySymbol = useMemo(
    () => new Map((quotesQuery.data ?? []).map((q) => [q.symbol, q])),
    [quotesQuery.data],
  );

  // One existing keyless Hyperliquid market-stats query covers every verified
  // visible perp, including HIP-3 markets. Matching stays exact because HL coin
  // identity is case-sensitive and a `dex:` prefix selects a different market.
  const perpStatsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    enabled: isSignedIn && PERPS_ENABLED && quoteInputs.perpCoins.length > 0,
    refetchInterval: 30000,
    staleTime: 15000,
    retry: false,
  });

  const optionQuoteContracts = useMemo(() => {
    const seen = new Set<string>();
    const contracts: Array<{
      symbol: string;
      expiration: string;
      strike: number;
      optionType: "call" | "put";
    }> = [];

    for (const item of items) {
      if (classifyCopyTradeInstrument(item.meta) !== "option") continue;
      const expiration = readString(item.meta.optionExpiration);
      const strike = readNumber(item.meta.optionStrike);
      const optionType = readOptionType(item.meta.optionType);
      if (!expiration || !strike || !optionType) continue;
      const key = optionContractKey(item.symbol, expiration, strike, optionType);
      if (seen.has(key)) continue;
      seen.add(key);
      contracts.push({
        symbol: item.symbol,
        expiration,
        strike,
        optionType: optionType === "CALL" ? "call" : "put",
      });
      if (contracts.length >= MAX_OPTION_QUOTES) break;
    }
    return contracts;
  }, [items]);

  const optionQuotesQuery = trpc.quotes.getOptionQuotes.useQuery(
    { contracts: optionQuoteContracts, credentialId: activeCredentialId },
    {
      enabled: isSignedIn && !!activeCredentialId && optionQuoteContracts.length > 0,
      refetchInterval: 30000,
      staleTime: 15000,
      retry: false,
    },
  );
  const optionQuotesByKey = useMemo(
    () =>
      new Map(
        (optionQuotesQuery.data ?? []).map((quote) => [
          optionContractKey(
            quote.symbol,
            quote.expiration,
            quote.strike,
            quote.optionType === "call" ? "CALL" : "PUT",
          ),
          quote,
        ]),
      ),
    [optionQuotesQuery.data],
  );

  const getQuoteKeys = useCallback(() => [
    getQueryKey(trpc.quotes.getChartQuotes, { symbols: quoteInputs.stockSymbols }, "query"),
    getQueryKey(trpc.hyperliquid.marketStats, undefined, "query"),
    getQueryKey(trpc.quotes.getOptionQuotes, { contracts: optionQuoteContracts, credentialId: activeCredentialId }, "query"),
  ], [quoteInputs.stockSymbols, optionQuoteContracts, activeCredentialId]);
  const quoteClock = useCopyTradeQuoteClock(queryClient, getQuoteKeys);

  // Per-item dollar target - pct needs buying power, pct_equity needs equity,
  // usd is independent. Ratio mode is qty-derived (no $ target) and feeds
  // the per-item qty formula directly via sizing.value × source qty.
  const targetDollars = computeTargetDollars({
    sizingMode: sizing.mode,
    sizingValue: sizing.value,
    buyingPower,
    equity,
  });

  // Each pct mode is unusable without its respective broker number. Ratio
  // mode is per-item: we disable Copy only when the specific item lacks a
  // source qty (handled in the per-row computation below).
  const pctNeedsBrokerage = sizing.mode === "pct" && !hasBuyingPower;
  const pctEquityNeedsBrokerage = sizing.mode === "pct_equity" && !hasEquity;

  // Infinite scroll: fetch the next page when the sentinel enters the viewport.
  //
  // Under followedOnly the server hands back a nextCursor even for 0-item pages
  // so the "Following" view can page into older history. But an empty list
  // leaves the sentinel permanently in view, so auto-paging would chain
  // fetchNextPage as fast as the network allows and hammer the endpoint. Guard
  // it: never auto-page an empty feed, and stop once a page comes back dry
  // (no new items) instead of racing through the entire cursor history.
  const lastPageWasEmpty = (data?.pages?.at(-1)?.items.length ?? 0) === 0;
  useEffect(() => {
    if (isCollapsed || !hasNextPage || isFetchingNextPage) return;
    if (items.length === 0 || lastPageWasEmpty) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchNextPage();
      },
      { root, rootMargin: "200px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [
    isCollapsed,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    items.length,
    lastPageWasEmpty,
  ]);

  const closeMirrorConsent = () => setMirrorConsent(null);

  return (
    <>
    {/* Embedded, the panel is flat at every width: no card border, fill or
        ring of its own. On a phone it sits directly in the Traders screen's
        gutters, where a bordered card of its own put the sizing control's
        box, and then its input, three borders deep. */}
    <Card
      className={cn(
        "w-full flex flex-col",
        embedded
          ? "h-full min-h-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent py-0 text-[#dfe8eb] ring-0 xl:text-card-foreground"
          : isCollapsed
            ? ""
            : "h-[600px]",
      )}
    >
      <CardHeader
        className={cn(
          embedded &&
            "shrink-0 border-b border-[#1a3b46] bg-transparent px-0 py-3 xl:border-border xl:bg-background/70 xl:px-3 xl:py-2",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {!embedded && <CardTitle>Copy Trade</CardTitle>}
            {/* "How it works" explainer dialog - clarifies the difference
                between manual Copy, Follow, and Auto-mirror, and surfaces
                the safety rails / sizing semantics / leaderboard caveat. */}
            <CopyTradeInfoDialog />
          </div>
          {!embedded && (
            <CollapseButton collapsed={collapsed} onToggle={toggle} label="Copy Trade" />
          )}
        </div>

        {!isCollapsed && (
          <div className={cn("mt-3 flex flex-col gap-2", embedded && "mt-2")}>
            {/* Mirror is already scoped to followed targets, so its setup view
                does not repeat the broader discovery filters and links. */}
            {!mirrorSetupActive && (
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              {!hideSourceTabs && lockSource === undefined && (
                <CopyTradeSourceTabs source={effectiveSource} onSelect={setSource} />
              )}
              <div className="flex w-full items-center gap-1.5 sm:w-auto sm:shrink-0">
                {showLeaderboardLink && (
                  <Link
                    href="/lb"
                    className="flex-1 sm:flex-none"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-11 w-full gap-1.5 text-xs xl:h-7 sm:w-auto"
                    >
                      <Trophy className="h-3.5 w-3.5" />
                      Top Traders
                    </Button>
                  </Link>
                )}
                <ManageFollows
                  isSignedIn={isSignedIn}
                  buyingPower={buyingPower}
                  equity={equity}
                  balancesCredentialId={activeCredentialId ?? null}
                />
                {isSignedIn && (
                  <Button
                    type="button"
                    variant={showWalletPanel ? "secondary" : "outline"}
                    size="sm"
                    className="h-11 shrink-0 gap-1.5 text-xs sm:h-7"
                    onClick={() => setShowWalletPanel((v) => !v)}
                    aria-pressed={showWalletPanel}
                  >
                    <Wallet className="h-3.5 w-3.5" />
                    Copy Wallet
                  </Button>
                )}
              </div>
            </div>
            )}

            {/* Wallet follow panel: shown inline when the "Copy Wallet" button is
                active. Mounting/unmounting resets all its local state cleanly. */}
            {!mirrorSetupActive && showWalletPanel && isSignedIn && (
              <WalletFollowPanel onClose={() => setShowWalletPanel(false)} />
            )}

            {/* Panel sizing applies only to manual stock Copy. Auto-mirror
                stores account and sizing independently on each follow. */}
            {!mirrorSetupActive && (() => {
              const currentMode = SIZING_MODE_PRESENTATION[sizing.mode];
              const perpOnly = marketFilter === "perps";
              return (
                <div
                  // No box of its own when embedded: the sizing tabs and the
                  // input sit on the header row, separated by spacing, at
                  // every width (the desktop drawer never had the box).
                  className="flex flex-wrap items-center gap-2 rounded-md transition-colors"
                >
                  {perpOnly ? (
                    <p className="text-xs leading-4 text-muted-foreground">
                      Perp copies only prefill the ticket. Enter the order size
                      there before reviewing and submitting.
                    </p>
                  ) : (
                    <>
                      <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Stock copy sizing
                      </span>
                      <SizingModeTabs
                        value={sizing.mode}
                        onChange={setMode}
                        disabled={!sizingHydrated}
                      />
                      <SizingValueInput
                        committedValue={Number.isFinite(sizing.value) ? sizing.value : 0}
                        min={currentMode.min}
                        max={currentMode.max}
                        step={currentMode.step}
                        ariaLabel={currentMode.aria}
                        onCommit={setValue}
                        disabled={!sizingHydrated}
                      />
                      <span className="text-xs text-muted-foreground">
                        {currentMode.caption}
                      </span>
                      <span className="basis-full text-2xs leading-4 text-muted-foreground sm:basis-auto">
                        Perp copies only prefill a ticket and require size there.
                      </span>
                    </>
                  )}
                </div>
              );
            })()}

            {mirrorSetupActive && (
              <MirrorExplainerLayout
                copy={
                  <>
                  <p className="text-xs font-medium">Mirror followed traders</p>
                  <p className="text-2xs leading-4 text-muted-foreground">
                    Enable a trader on the row&apos;s venue. Stocks and perps use
                    separate saved accounts and sizing; configure perp exits in
                    Manage follows.
                  </p>
                  </>
                }
                actions={
                  <>
                  <Badge
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-3xs uppercase text-muted-foreground"
                    title="Stocks and perps use their own saved destination account."
                  >
                    Per-follow accounts
                  </Badge>
                  <ManageFollows
                    isSignedIn={isSignedIn}
                    buyingPower={buyingPower}
                    equity={equity}
                    balancesCredentialId={activeCredentialId ?? null}
                  />
                  </>
                }
              />
            )}

            {!mirrorSetupActive && pctNeedsBrokerage && (
              <p className="text-2xs text-muted-foreground">
                Link a brokerage to size copies by % of buying power, or switch to $.
              </p>
            )}

            {!mirrorSetupActive && pctEquityNeedsBrokerage && (
              <p className="text-2xs text-muted-foreground">
                Link a brokerage to size copies by % of net equity, or switch to $.
              </p>
            )}

            {!mirrorSetupActive && sizing.mode === "ratio" && (
              <p className="text-2xs text-muted-foreground">
                Ratio mode needs the source trader&apos;s qty. Caller signal rows
                (text-only) will show <em>Copy</em> disabled - pick %, % eq, or $
                to copy those.
              </p>
            )}
          </div>
        )}
      </CardHeader>

      {!isCollapsed && (
        <CardContent className="flex-1 p-0 min-h-0">
          <div
            ref={scrollRef}
            className={cn(
              "no-scrollbar h-full overflow-y-auto",
              embedded ? "px-0 pb-3 pt-2 xl:px-3" : "px-4 pb-4",
            )}
          >
            <div className="flex flex-col gap-2">
              {isLoading && (
                <>
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </>
              )}

              {items.map((item) => {
                const displayName = normalizeAuthorName(item.displayName);
                const instrument = classifyCopyTradeInstrument(item.meta);
                const quoteIdentity = copyTradeQuoteIdentity(item);
                const isPerpRow = quoteIdentity.venue === "perps";
                const quote =
                  quoteIdentity.venue === "stocks"
                    ? quotesBySymbol.get(quoteIdentity.symbol)
                    : undefined;
                const perpQuote = findCopyTradePerpQuote(
                  quoteIdentity,
                  perpStatsQuery.data,
                );
                const perpChange = isPerpRow
                  ? formatPerpChangePct(perpQuote?.markPx, perpQuote?.prevDayPx)
                  : null;
                const price = isPerpRow
                  ? formatPerpQuotePrice(perpQuote?.markPx)
                  : formatQuotePrice(quote?.last);
                const isUp = isPerpRow
                  ? perpChange?.tone === "positive"
                  : Number(quote?.change ?? 0) > 0;
                const isDown = isPerpRow
                  ? perpChange?.tone === "negative"
                  : Number(quote?.change ?? 0) < 0;
                const displaySymbol =
                  quoteIdentity.venue === "perps" && quoteIdentity.coin
                    ? quoteIdentity.coin
                    : item.symbol;

                // Perp / derivative / short signals (meta.mirrorableEquity === false)
                // and all manual sells must never prefill an EQUITY ticket; the
                // reason doubles as the disabled action's tooltip.
                const copyEligibilityReason = copyDisabledReason(item.meta, item.side);
                // Partial perp markers stay on the perp path, where complete
                // venue and opening-trade metadata are required for a prefill.
                const perpRoute = perpCopyFromTradeRow(item.meta, {
                  perpsEnabled: PERPS_ENABLED,
                });

                // The option-quotes cache is keyed by contract, which this
                // component owns (it drove the batched query above), so the
                // lookup itself stays here; everything downstream of it - qty,
                // disabled, title, button label - is decided by
                // computeCopyRowState (copy-trade-row-state.ts) so it is
                // directly unit-testable.
                const quoteOptionExpiration = readString(item.meta?.optionExpiration);
                const quoteOptionStrike = readNumber(item.meta?.optionStrike);
                const quoteOptionType = readOptionType(item.meta?.optionType);
                const optionQuoteKey =
                  instrument === "option" &&
                  quoteOptionExpiration &&
                  quoteOptionStrike &&
                  quoteOptionType
                    ? optionContractKey(
                        item.symbol,
                        quoteOptionExpiration,
                        quoteOptionStrike,
                        quoteOptionType,
                      )
                    : null;
                const optionQuote = optionQuoteKey
                  ? optionQuotesByKey.get(optionQuoteKey)
                  : undefined;

                const quoteValueForReadiness = isPerpRow
                  ? perpQuote?.markPx
                  : instrument === "option"
                    ? item.side === "sell"
                      ? optionQuote?.bid
                      : optionQuote?.ask
                    : quote?.last;
                const quoteIndex = isPerpRow ? 1 : instrument === "option" ? 2 : 0;
                const quoteReadiness = getCopyTradeQuoteReadiness({
                  clockRejected: quoteClock.isClockRejected(quoteIndex),
                  hasQuote: hasPositiveQuote(quoteValueForReadiness),
                  updatedAt: isPerpRow
                    ? perpStatsQuery.dataUpdatedAt
                    : instrument === "option"
                      ? optionQuotesQuery.dataUpdatedAt
                      : quotesQuery.dataUpdatedAt,
                  isFetching: isPerpRow
                    ? perpStatsQuery.isFetching
                    : instrument === "option"
                      ? optionQuotesQuery.isFetching
                      : quotesQuery.isFetching,
                  hasError: isPerpRow
                    ? perpStatsQuery.isError
                    : instrument === "option"
                      ? optionQuotesQuery.isError
                      : quotesQuery.isError,
                });

                const rowInputs = {
                  meta: item.meta,
                  side: item.side,
                  // Source qty comes from item.qty (social trades carry it;
                  // x_signal rows don't, so ratio mode silently produces
                  // qty=0 for those).
                  rawQty: (item as { qty?: unknown }).qty,
                  copyEligibilityReason,
                  perpRoute,
                  hasPerpHandler: Boolean(onCopyPerp),
                  quoteReadiness,
                  quoteLast: isPerpRow ? perpQuote?.markPx : quote?.last,
                  optionBid: optionQuote?.bid,
                  optionAsk: optionQuote?.ask,
                  sizingMode: sizing.mode,
                  sizingValue: sizing.value,
                  targetDollars,
                  pctNeedsBrokerage,
                  pctEquityNeedsBrokerage,
                };
                const row = computeCopyRowState(rowInputs);
                const {
                  isOption,
                  copyDisabled,
                  copyTitle,
                  buttonLabel,
                } = row;

                // Dollar size of the source trade, from the feed item's meta
                // (qty x fill/limit price, with the option multiplier applied).
                const tradeNotional = copyTradeNotionalUsd(item.meta);

                const isBuy = item.side === "buy";
                const isSelected = selectedItemId === item.id;

                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex min-w-0 gap-2.5 border transition-colors",
                      embedded
                        ? "rounded-2xl border-[#193742] bg-[#071b24] p-3.5 shadow-[0_12px_35px_rgba(0,0,0,0.18)] hover:border-[#2c5661] xl:rounded-md xl:border-border xl:bg-transparent xl:p-2.5 xl:shadow-none xl:hover:border-border xl:hover:bg-muted/50"
                        : "rounded-md p-2.5 hover:bg-muted/50",
                      isSelected &&
                        (embedded
                          ? "ring-2 ring-[#e7c65d] bg-[#0b2933] xl:ring-primary xl:bg-muted/50"
                          : "ring-2 ring-primary bg-muted/50"),
                    )}
                  >
                    <Avatar className="mt-0.5 h-8 w-8">
                      {item.avatar && <AvatarImage src={item.avatar} alt={displayName} />}
                      <AvatarFallback
                        className={
                          embedded
                            ? "bg-[#282517] text-[#ecd46f] xl:bg-muted xl:text-muted-foreground"
                            : undefined
                        }
                      >
                        {initialsOf(displayName) || "?"}
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex flex-col gap-2 min-w-0 flex-1">
                      <CopyTradeCardHeaderLayout
                        identity={
                          <>
                          <Badge
                            asChild
                            variant="outline"
                            className="min-w-0 max-w-full shrink font-bold hover:bg-muted"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const selection = copyTradeViewSelection(item.symbol, perpRoute, item.meta);
                                if (selection) onViewSymbol(selection.symbol, selection.venue);
                              }}
                              aria-label={feedChartViewLabel(displaySymbol)}
                              title={feedChartViewLabel(displaySymbol)}
                            className={cn(
                              "flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden",
                              embedded &&
                                "border-[#31505a] bg-[#0b242d] text-[#e5eef0] hover:bg-[#12313b] xl:border-border xl:bg-input/20 dark:xl:bg-input/30 xl:text-foreground xl:hover:bg-muted xl:hover:text-muted-foreground",
                            )}
                            >
                              <span className="shrink-0">${displaySymbol}</span>
                              {price && (
                                <span
                                  className={cn(
                                    "min-w-0 truncate font-data tabular-nums font-semibold",
                                    isUp && "text-green-500",
                                    isDown && "text-red-500",
                                    !isUp && !isDown && "text-muted-foreground",
                                  )}
                                >
                                  {price}
                                  <span className="ml-1 opacity-90">
                                    {isPerpRow
                                      ? perpChange?.text
                                      : formatChangePercent(quote?.changePercent)}
                                  </span>
                                </span>
                              )}
                            </button>
                          </Badge>
                          {item.source === "user" && (
                            <Badge
                              variant="outline"
                              className={cn(
                                "shrink-0 px-1.5 text-2xs font-bold uppercase",
                                isBuy
                                  ? "text-green-500 bg-green-500/10 border-green-500/20"
                                  : "text-red-500 bg-red-500/10 border-red-500/20",
                              )}
                            >
                              {item.side}
                            </Badge>
                          )}
                          {/* How big the trade was, in dollars. Without it a $50
                              dabble and a $50,000 conviction trade render
                              identically, and a unit count would not fix that:
                              shares, option contracts and perp coins are not
                              comparable. Omitted entirely when the size cannot
                              be computed, rather than shown as "$0.00". */}
                          {item.source === "user" && tradeNotional != null && (
                            <Badge
                              variant="outline"
                              title="Position size of this trade"
                              className="shrink-0 px-1.5 font-data text-2xs font-bold tabular-nums text-muted-foreground"
                            >
                              {formatUsd(tradeNotional)}
                            </Badge>
                          )}
                          {isOption && (
                            <Badge
                              variant="outline"
                              className="shrink-0 px-1.5 text-2xs font-bold uppercase text-amber-500 bg-amber-500/10 border-amber-500/20"
                            >
                              Option
                            </Badge>
                          )}
                          {/* Stock badge: shown on plain equity rows so all three
                              venue types (Stock / Option / Perp) are labeled
                              consistently and new users can immediately see that
                              copy trading covers Alpaca stocks too. */}
                          {!isOption && (
                            <EquityRowBadge assetType={item.meta?.assetType} />
                          )}
                          {/* A Hyperliquid perp otherwise renders exactly like an
                              equity buy on this card, and its ticker can be a real
                              Alpaca listing, so the venue is labeled on the row and
                              not left to the disabled Copy button's tooltip. */}
                          <PerpRowBadge assetType={item.meta?.assetType} />
                          </>
                        }
                        author={<span title={displayName}>{displayName}</span>}
                        actions={
                          <>
                          {/* Skip rows with no followable author (followTarget === null). */}
                          {!mirrorSetupActive && item.followTarget && (
                            <FollowButton
                              target={item.followTarget}
                              isFollowing={followedKeys.has(
                                `${item.followTarget.type}|${item.followTarget.key}`,
                              )}
                            />
                          )}
                          {/* Mirror setup is one destination at a time. The feed
                              row's explicit venue selects the persisted config;
                              it never borrows the terminal's account. */}
                          {mirrorSetupActive && item.followTarget && (() => {
                            const followKey = `${item.followTarget.type}|${item.followTarget.key}`;
                            const follow = followsByKey.get(followKey);
                            if (!follow) return null;
                            const autoMirrorSupported =
                              follow.targetType === "user" || follow.targetType === "x_author";
                            const destination = copyTradeMirrorDestination(item, perpRoute);
                            if (!destination) return null;
                            const config = resolveFollowDestination(follow, destination);
                            const presentation = DESTINATION_PRESENTATION[destination];
                            const selectedAccount = accountForDestination(
                              destination,
                              config.credentialId,
                              mirrorAccounts,
                            );
                            const accountLabel = selectedAccount
                              ? accountOptionLabel(selectedAccount)
                              : null;
                            // Paper/Live only describes an Alpaca account. A
                            // perp row already carries its Hyperliquid venue
                            // badge, so it must not be presented as the
                            // terminal's Paper/Live mode.
                            const accountMode =
                              destination === "stock"
                                ? selectedAccount?.accountType ?? null
                                : null;
                            const sizingBounds = SIZING_MODE_PRESENTATION[config.sizingMode];
                            const sizingInvalid =
                              !Number.isFinite(config.sizingValue) ||
                              config.sizingValue < sizingBounds.min ||
                              config.sizingValue > sizingBounds.max;
                            const ratioUnsupported =
                              config.sizingMode === "ratio" && follow.targetType === "x_author";
                            const leverageInvalid =
                              destination === "perp" &&
                              follow.perpMaxLeverage !== null &&
                              (!validPerpLeverage(follow.perpMaxLeverage) ||
                                (validPerpLeverage(globalPerpMaxLeverage) &&
                                  follow.perpMaxLeverage > globalPerpMaxLeverage));
                            const switchState = autoMirrorSwitchState({
                              supported: destinationSupportsTarget(
                                destination,
                                follow.targetType as
                                  | "user"
                                  | "x_author"
                                  | "politician"
                                  | "hl_wallet",
                              ),
                              pending: autoMirrorMutation.isPending,
                              autoMirror: config.enabled,
                              credentialId: config.credentialId,
                              destinationProvider: presentation.provider,
                              globalPerpMaxLeverage:
                                destination === "perp" ? globalPerpMaxLeverage : undefined,
                              targetLabel: followTargetTypeLabel(
                                follow.targetType as "user" | "x_author" | "politician",
                              ),
                              deploymentBlockReason: mirrorDeployment?.blockReason ?? null,
                              sizingInvalid,
                              sizingBlockReason: ratioUnsupported
                                ? "Multiple sizing needs the source trader's quantity, which caller signals do not provide."
                                : undefined,
                              credentialAvailable: mirrorAccountsQuery.isLoading
                                ? false
                                : selectedAccount !== null,
                              leverageInvalid,
                            });
                            return (
                              <InlineMirrorSwitch
                                displayName={displayName}
                                armed={autoMirrorSupported && config.enabled}
                                interactive={switchState.interactive}
                                reason={switchState.reason}
                                accountMode={accountMode}
                                onRequestArm={() =>
                                  setMirrorConsent({
                                    kind: "arm",
                                    destination,
                                    displayName,
                                    targetType: follow.targetType as
                                      | "user"
                                      | "x_author"
                                      | "politician",
                                    targetKey: follow.targetKey,
                                    credentialId: config.credentialId,
                                    accountLabel,
                                    destinationProvider: presentation.provider,
                                    sizingMode: config.sizingMode,
                                    sizingValue: config.sizingValue,
                                    config,
                                    perpMaxLeverage: follow.perpMaxLeverage,
                                    perpProtection: follow.perpProtection,
                                  })
                                }
                                onRequestDisarm={() =>
                                  setMirrorConsent({
                                    kind: "disarm",
                                    destination,
                                    displayName,
                                    targetType: follow.targetType as
                                      | "user"
                                      | "x_author"
                                      | "politician",
                                    targetKey: follow.targetKey,
                                    credentialId: config.credentialId,
                                    accountLabel,
                                    destinationProvider: presentation.provider,
                                    sizingMode: config.sizingMode,
                                    sizingValue: config.sizingValue,
                                    config,
                                    perpMaxLeverage: follow.perpMaxLeverage,
                                    perpProtection: follow.perpProtection,
                                  })
                                }
                              />
                            );
                          })()}
                          <Button
                            type="button"
                            size="sm"
                            variant={copyDisabled ? "outline" : "default"}
                            disabled={
                              copyDisabled ||
                              (perpRoute === null && !sizingHydrated)
                            }
                            title={copyTitle}
                            className={cn(
                              TOUCH_HEIGHT_COMPACT_XL,
                              embedded &&
                                (copyDisabled
                                  ? "border-[#35515a] bg-[#0b242d] text-[#8da5ad] xl:border-border xl:bg-transparent dark:xl:bg-input/30 xl:text-foreground xl:hover:bg-input/50"
                                  : "bg-[#e7c65d] text-[#1c1a0f] hover:bg-[#f0d56c] xl:bg-primary xl:text-primary-foreground xl:hover:bg-primary/80"),
                            )}
                            onClick={() => {
                              if (perpRoute === null && !sizingHydrated) return;

                              // A pending render or throttled timer must not leave
                              // a captured price/quantity eligible for dispatch.
                              const { state, clockRejected } = quoteClock.read(quoteIndex);
                              const currentStock = quoteIdentity.venue === "stocks"
                                ? (state?.data as typeof quotesQuery.data)?.find(q => q.symbol === quoteIdentity.symbol)
                                : undefined;
                              const currentPerp = isPerpRow
                                ? findCopyTradePerpQuote(quoteIdentity, state?.data as typeof perpStatsQuery.data)
                                : undefined;
                              const currentOption = instrument === "option"
                                ? (state?.data as typeof optionQuotesQuery.data)?.find(q => optionContractKey(q.symbol, q.expiration, q.strike, q.optionType === "call" ? "CALL" : "PUT") === optionQuoteKey)
                                : undefined;
                              const currentLast = isPerpRow ? currentPerp?.markPx : currentStock?.last;
                              const currentPrice = instrument === "option"
                                ? item.side === "sell" ? currentOption?.bid : currentOption?.ask
                                : currentLast;
                              const currentRow = computeCopyRowState({
                                ...rowInputs,
                                quoteLast: currentLast,
                                optionBid: currentOption?.bid,
                                optionAsk: currentOption?.ask,
                                quoteReadiness: getCopyTradeQuoteReadiness({
                                  hasQuote: hasPositiveQuote(currentPrice),
                                  updatedAt: state?.dataUpdatedAt,
                                  hasError: state?.status === "error",
                                  isFetching: state?.fetchStatus === "fetching",
                                  clockRejected,
                                }),
                              });
                              if (currentRow.copyDisabled) return;
                              const dispatch = resolveCopyDispatch({
                                perpRoute,
                                item,
                                ...currentRow,
                              });
                              if (dispatch.kind === "perp") {
                                onCopyPerp?.(dispatch.payload);
                              } else if (dispatch.kind === "equity") {
                                onCopy(dispatch.payload);
                              }
                            }}
                          >
                            {buttonLabel}
                          </Button>
                          </>
                        }
                      />

                      {item.content && (
                        <div className="min-w-0">
                          <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap line-clamp-3">
                            {item.content}
                          </p>
                          {item.url && (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              🔗 View Original
                            </a>
                          )}
                        </div>
                      )}

                      {typeof item.meta?.copiedFrom === "string" && item.meta.copiedFrom && (
                        <span className="text-2xs text-muted-foreground">
                          Copied · {item.meta.copiedFrom}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Infinite-scroll sentinel */}
              {hasNextPage && (
                <div
                  ref={sentinelRef}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  {isFetchingNextPage ? "Loading more…" : ""}
                </div>
              )}

              {!isSignedIn && (
                <div className="text-center text-muted-foreground py-8">
                  Sign in to copy trades.
                </div>
              )}

              {/* Source names (x_signal, user) are ours, not the reader's;
                  the notice says what is missing in plain words instead. */}
              {failedSources.length > 0 && (
                <DegradedNotice
                  message="Some of the copy feed could not be loaded. Showing what came through; it keeps retrying on its own."
                  onRetry={() => void refetchFeed()}
                />
              )}

              {isSignedIn && feedRequestFailed && (
                <div
                  role="alert"
                  className="flex flex-col items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-4 text-center text-xs text-amber-400"
                >
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  <p>Copy-trade feed is having trouble loading right now.</p>
                  {feedError?.message && (
                    <p className="max-w-md text-2xs text-amber-300/80">
                      {feedError.message}
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchFeed()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Retry
                  </Button>
                </div>
              )}

              {isSignedIn &&
                !isLoading &&
                !feedRequestFailed &&
                items.length === 0 &&
                failedSources.length === 0 && (
                  <div className="text-center text-muted-foreground py-8">
                    {followedOnly
                      ? "No activity from anyone you follow yet. Use Follow on a feed row."
                      : "No copy-trade activity yet."}
                  </div>
                )}
            </div>
          </div>
        </CardContent>
      )}
    </Card>

    {/*
      The inline Mirror switch raises a request; these are the only callers of
      the update mutation from this panel. Same wording as Manage follows,
      because it is the same decision.
    */}
    {mirrorConsent?.kind === "arm" && (
      <ArmMirrorDialog
        open
        onOpenChange={(open) => {
          if (!open) closeMirrorConsent();
        }}
        summary={buildDestinationArmingSummary({
          trader: mirrorConsent.displayName,
          destination: mirrorConsent.destination,
          account: mirrorConsent.accountLabel,
          sizingMode: mirrorConsent.sizingMode,
          sizingValue: mirrorConsent.sizingValue,
          perpProtection: mirrorConsent.perpProtection,
          globalPerpMaxLeverage,
          followPerpMaxLeverage: mirrorConsent.perpMaxLeverage,
          limits: mirrorLimits,
        })}
        pending={autoMirrorMutation.isPending}
        onConfirm={() => {
          const request = mirrorConsent;
          const account = accountForDestination(
            request.destination,
            request.credentialId,
            mirrorAccounts,
          );
          const sizingBounds = SIZING_MODE_PRESENTATION[request.config.sizingMode];
          const sizingValid =
            Number.isFinite(request.config.sizingValue) &&
            request.config.sizingValue >= sizingBounds.min &&
            request.config.sizingValue <= sizingBounds.max;
          const leverageReady =
            request.destination !== "perp" ||
            (validPerpLeverage(globalPerpMaxLeverage) &&
              (request.perpMaxLeverage === null ||
                (validPerpLeverage(request.perpMaxLeverage) &&
                  request.perpMaxLeverage <= globalPerpMaxLeverage)));
          const canArm =
            Boolean(account) &&
            destinationSupportsTarget(request.destination, request.targetType) &&
            sizingValid &&
            !(request.config.sizingMode === "ratio" && request.targetType === "x_author") &&
            leverageReady;
          closeMirrorConsent();
          if (!canArm || !account) return;
          autoMirrorMutation.mutate({
            targetType: request.targetType,
            targetKey: request.targetKey,
            ...buildDestinationPatch(request.destination, {
              ...request.config,
              enabled: true,
              credentialId: account.id,
            }),
          });
        }}
      />
    )}

    {mirrorConsent && mirrorConsent.kind === "disarm" && (
      <StopMirrorDialog
        open
        onOpenChange={(open) => {
          if (!open) closeMirrorConsent();
        }}
        summary={buildDestinationStopSummary({
          kind: "disarm",
          destination: mirrorConsent.destination,
          trader: mirrorConsent.displayName,
          account: mirrorConsent.accountLabel,
          sizingMode: mirrorConsent.sizingMode,
          sizingValue: mirrorConsent.sizingValue,
          perpProtection: mirrorConsent.perpProtection,
        })}
        pending={autoMirrorMutation.isPending}
        onConfirm={() => {
          const request = mirrorConsent;
          closeMirrorConsent();
          autoMirrorMutation.mutate({
            targetType: request.targetType,
            targetKey: request.targetKey,
            ...buildDestinationPatch(request.destination, {
              ...request.config,
              enabled: false,
            }),
          });
        }}
      />
    )}
    </>
  );
}

/**
 * Sizing value input that commits only on blur or Enter, which avoids firing a
 * localStorage write (and future API call) per keystroke, and gives the user
 * a clear "I pressed Enter / left the field" save moment instead of silent
 * auto-save on every character.
 */
function SizingValueInput({
  committedValue,
  min,
  max,
  step,
  ariaLabel,
  onCommit,
  disabled = false,
}: {
  committedValue: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onCommit: (value: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(committedValue));
  const isFocused = useRef(false);

  // Sync draft when the committed value changes from outside (e.g. mode switch
  // resets the value, or localStorage hydration lands after mount), but only
  // when the input isn't actively being edited.
  useEffect(() => {
    if (!isFocused.current) {
      setDraft(String(committedValue));
    }
  }, [committedValue]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) {
      onCommit(Math.max(min, Math.min(max, n)));
    } else {
      // Revert to last committed value if input is invalid.
      setDraft(String(committedValue));
    }
  };

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { isFocused.current = true; }}
      onBlur={() => { isFocused.current = false; commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
      aria-label={ariaLabel}
      disabled={disabled}
      className="h-11 xl:h-7 w-24 tabular-nums"
    />
  );
}

// SourceTab now lives in ./copy-trade-card-layout, alongside the
// CopyTradeSourceTabs row that is its only caller.
