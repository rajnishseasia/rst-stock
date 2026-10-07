"use client";

/**
 * SignaSignalsPanel
 *
 * Left-column dashboard tab that surfaces the Signa-scored signal board.
 * Each row puts the trade plan front and centre - ticker + ENTRY / STOP /
 * TARGET in big type - and tucks the supporting metadata (model count,
 * confidence, key drivers, etc.) underneath in a dimmer style. A "Copy
 * signal" button prefills the trade form with the symbol, side, stop, and
 * target (the trade form auto-switches to OCO when both stop and target
 * are present).
 *
 * Data shape comes from the API-server side proxy in
 * `apps/api/src/routers/signa.ts`, which holds the bearer key.
 */

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Sparkles, ChevronDown, ChevronRight, Filter, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SignaInfoDialog } from "./signa-info-dialog";
import { BestPickRow } from "./best-pick-row";
import { formatSignedNumber, formatUsd } from "@/lib/format";

export interface SignaSignalCopyPayload {
  symbol: string;
  side: "buy" | "sell";
  entry?: number;
  stop?: number;
  target?: number;
}

export interface SignaSignalsPanelProps {
  isSignedIn: boolean;
  onCopySignal: (payload: SignaSignalCopyPayload) => void;
  onViewSymbol: (symbol: string) => void;
  /** Highlight the row the user most recently copied. */
  selectedTicker?: string;
  subheaderAction?: SignaSubheaderAction;
  subheaderActionNonce?: number;
  /**
   * Opens AI chat and prefills a research prompt for this signal's symbol.
   * Optional - the panel renders without it.
   */
  onAskAi?: (symbol: string) => void;
  embedded?: boolean;
}

export type SignaSubheaderAction = "best_picks" | "risk_reward" | "copy_signal";

function directionTone(direction: string): {
  badgeClass: string;
  text: string;
} {
  const up = /BULL|LONG|BUY/i.test(direction);
  return {
    text: up ? "BULLISH" : "BEARISH",
    badgeClass: up
      ? "text-green-500 bg-green-500/10 border-green-500/20"
      : "text-red-500 bg-red-500/10 border-red-500/20",
  };
}

/**
 * A single signal row. Trade plan (entry/stop/target) is the headline; the
 * scoring and reason metadata sits below in a dim subline that can be
 * expanded for full context.
 */
function SignalRow({
  pick,
  isSelected,
  onCopy,
  onAskAi,
  onViewSymbol,
}: {
  pick: {
    id: string;
    ticker: string;
    direction: string;
    side: "buy" | "sell";
    score: number;
    tier: number;
    grade?: string;
    confidence?: number;
    modelCount: number;
    modelIds: string[];
    reason?: string;
    keyDrivers: string[];
    regime?: string;
    risks: string[];
    entry?: number;
    stop?: number;
    target?: number;
    riskReward?: number;
    price?: number;
    change24h?: number;
    signaAction?: string;
    signaGrade?: string;
    signaConviction?: number;
  };
  isSelected: boolean;
  onCopy: () => void;
  onAskAi?: () => void;
  onViewSymbol: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tone = directionTone(pick.direction);
  const hasPlan = pick.entry != null || pick.stop != null || pick.target != null;
  const canCopy = pick.stop != null && pick.target != null;
  const changeNum = pick.change24h;
  const isUp = changeNum != null && changeNum >= 0;

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors min-w-0",
        isSelected ? "ring-2 ring-primary bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      {/* ── Headline row: ticker · direction · price · confluence on the right ── */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onViewSymbol}
            aria-label={`View $${pick.ticker} live chart`}
            title={`View $${pick.ticker} live chart`}
            className="shrink-0 cursor-pointer rounded-sm text-base font-bold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {pick.ticker}
          </button>
          <Badge variant="outline" className={cn("h-5 px-1.5 text-3xs font-bold uppercase shrink-0", tone.badgeClass)}>
            {tone.text}
          </Badge>
          {pick.tier >= 2 && (
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-3xs font-bold uppercase shrink-0",
                pick.tier === 3
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                  : "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              T{pick.tier}
            </Badge>
          )}
          {pick.price != null && (
            <span className="font-data tabular-nums text-xs text-muted-foreground truncate">
              {formatUsd(pick.price)}
              {changeNum != null && (
                <span className={cn("ml-1", isUp ? "text-green-500" : "text-red-500")}>
                  {formatSignedNumber(changeNum, "%")}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex flex-col items-end leading-tight">
            <span className="font-data tabular-nums text-base font-semibold">{pick.score}</span>
            <span className="text-3xs uppercase tracking-wider text-muted-foreground">
              score
            </span>
          </div>
          {onAskAi && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onAskAi}
              title={`Open AI Chat and analyze ${pick.ticker}`}
              className="h-8 gap-1 px-2 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Ask AI
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={canCopy ? "default" : "outline"}
            disabled={!canCopy}
            title={
              canCopy ? "Prefill the trade form with this signal's stop + target" : "Stop / target unavailable for this signal"
            }
            onClick={onCopy}
            className="h-8 gap-1 px-2 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Copy signal
          </Button>
        </div>
      </div>

      {/* ── HERO: entry / stop / target / R:R ─────────────────────────────── */}
      {hasPlan && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          <PlanStat label="Entry" value={formatUsd(pick.entry)} />
          <PlanStat
            label="Stop"
            value={formatUsd(pick.stop)}
            tone="bad"
            missing={pick.stop == null}
          />
          <PlanStat
            label="Target"
            value={formatUsd(pick.target)}
            tone="good"
            missing={pick.target == null}
          />
          <PlanStat
            label="R/R"
            value={pick.riskReward != null ? `${pick.riskReward.toFixed(1)}R` : "-"}
          />
        </div>
      )}
      {!hasPlan && (
        <p className="mt-2 text-2xs text-muted-foreground italic">
          No trade plan in cache yet - copy needs entry/stop/target.
        </p>
      )}

      {/* ── Secondary metadata strip (dim, small) ─────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        {pick.signaGrade && (
          <span>
            Grade <span className="font-medium text-foreground/80">{pick.signaGrade}</span>
          </span>
        )}
        {pick.signaAction && pick.signaAction !== pick.direction && (
          <span>
            Action <span className="font-medium text-foreground/80">{pick.signaAction}</span>
          </span>
        )}
        {pick.signaConviction != null && (
          <span>
            Conviction <span className="tabular-nums">{pick.signaConviction}</span>
          </span>
        )}
        <span>
          {pick.modelCount} {pick.modelCount === 1 ? "model" : "models"}
        </span>
        {pick.confidence != null && (
          <span>
            Conf <span className="tabular-nums">{(pick.confidence * 100).toFixed(0)}%</span>
          </span>
        )}
        {pick.regime && <span className="opacity-70">{pick.regime}</span>}
      </div>

      {/* ── Headline reason + expandable detail ───────────────────────────── */}
      {pick.reason && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group mt-2 flex w-full items-start gap-1 text-left text-2xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
          ) : (
            <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 leading-snug",
              expanded ? "" : "line-clamp-2",
            )}
          >
            {pick.reason}
          </span>
        </button>
      )}

      {expanded && pick.keyDrivers.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-4 text-2xs leading-snug text-muted-foreground">
          {pick.keyDrivers.map((d, i) => (
            <li key={i} className="list-disc marker:text-muted-foreground/40">
              {d}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A single filter pill - used for direction + tier toggles in the header. */
function FilterPill({
  active,
  onClick,
  label,
  tone,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: "good" | "bad";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "h-6 rounded-md border px-2 text-2xs font-medium transition-colors",
        active
          ? tone === "good"
            ? "border-green-500/40 bg-green-500/10 text-green-500"
            : tone === "bad"
              ? "border-red-500/40 bg-red-500/10 text-red-500"
              : "border-primary/40 bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** One of the four headline trade-plan cells. */
function PlanStat({
  label,
  value,
  tone,
  missing,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  missing?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-2 py-1.5">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-data tabular-nums text-sm font-semibold",
          tone === "good" && !missing && "text-green-500",
          tone === "bad" && !missing && "text-red-500",
          missing && "text-muted-foreground/60",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** Short human description of how old a cached snapshot is. */
function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return "just now";
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes - hours * 60;
  return restMin > 0 ? `${hours}h ${restMin}m ago` : `${hours}h ago`;
}

/**
 * The set of direction filters available in the panel header. The Signa
 * dashboard offers the same three: All, Bullish-only, Bearish-only.
 */
type DirectionFilter = "all" | "bullish" | "bearish";

/** Whether a single pick matches the current filter set. Pure function - easy
 *  to test if we later add a unit test. */
function pickMatchesFilters(
  pick: { direction: string; tier: number; score: number },
  filters: {
    direction: DirectionFilter;
    tiers: Set<number>;
    minScore: number;
  },
): boolean {
  if (filters.direction === "bullish" && !/BULL|LONG|BUY/i.test(pick.direction)) return false;
  if (filters.direction === "bearish" && !/BEAR|SHORT|SELL/i.test(pick.direction)) return false;
  // Empty tier set means "no tier filter" - show all.
  if (filters.tiers.size > 0 && !filters.tiers.has(pick.tier)) return false;
  if (pick.score < filters.minScore) return false;
  return true;
}

export function SignaSignalsPanel({
  isSignedIn,
  onCopySignal,
  onViewSymbol,
  selectedTicker,
  subheaderAction = "best_picks",
  subheaderActionNonce = 0,
  onAskAi,
  embedded = false,
}: SignaSignalsPanelProps) {
  // ── view-mode toggle (Best Picks vs full Agent-Signals list) ───────────
  // Default to Best Picks so the most-curated view is the first thing a
  // user sees. Switching to "all" reveals the existing filter bar and the
  // full scored-signal feed.
  const [view, setView] = useState<"best" | "all">("best");
  const [drawerFocus, setDrawerFocus] = useState<"standard" | "risk_reward" | "copy_ready">("standard");
  const lastSubheaderNonceRef = useRef(0);

  // ── filter state ────────────────────────────────────────────────────────
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [tiers, setTiers] = useState<Set<number>>(new Set());
  const [minScoreInput, setMinScoreInput] = useState<string>("0");
  const minScore = useMemo(() => {
    const n = parseInt(minScoreInput, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }, [minScoreInput]);

  const toggleTier = (t: number) => {
    setTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const filtersActive =
    direction !== "all" || tiers.size > 0 || minScore > 0;
  const clearFilters = () => {
    setDirection("all");
    setTiers(new Set());
    setMinScoreInput("0");
  };

  useEffect(() => {
    if (
      subheaderActionNonce === 0 ||
      lastSubheaderNonceRef.current === subheaderActionNonce
    ) {
      return;
    }
    lastSubheaderNonceRef.current = subheaderActionNonce;

    clearFilters();
    if (subheaderAction === "best_picks") {
      setView("best");
      setDrawerFocus("standard");
      return;
    }

    setView("all");
    setDrawerFocus(subheaderAction === "risk_reward" ? "risk_reward" : "copy_ready");
  }, [subheaderAction, subheaderActionNonce]);

  // The server caches the snapshot in Redis with a 1-hour TTL and that TTL is
  // the only freshness control: the browser does not poll, and there is no
  // manual refresh button. A refresh button existed here once but it was
  // misleading, it called refetch() without passing { force: true } so the
  // server just handed back the same cached snapshot while the tooltip
  // claimed it was forcing a fresh fetch. Instead the header reports how old
  // the data actually is, so a stale board is visible rather than hidden.
  const query = trpc.signa.todaysSignals.useQuery(undefined, {
    enabled: isSignedIn,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    retry: false,
  });

  // Apply the filter set to the upstream list.
  const filteredPicks = useMemo(() => {
    const all = query.data?.picks ?? [];
    const filtered = all.filter((p) => pickMatchesFilters(p, { direction, tiers, minScore }));

    if (drawerFocus === "copy_ready") {
      return filtered.filter((p) => p.stop != null && p.target != null);
    }

    if (drawerFocus === "risk_reward") {
      return [...filtered]
        .filter((p) => p.riskReward != null)
        .sort(
          (a, b) =>
            (b.riskReward ?? 0) - (a.riskReward ?? 0) ||
            b.score - a.score,
        );
    }

    return filtered;
  }, [query.data?.picks, direction, drawerFocus, tiers, minScore]);

  // Best Picks: the server has already gated to bullish + plan-present +
  // model_count >= threshold and computed pillars/confluence. We just sort
  // by confluence here and take the top slice.
  const bestPicks = useMemo(() => {
    const all = query.data?.picks ?? [];
    return all
      .filter((p) => p.isBestPick && p.bestPickConfluence != null)
      .sort(
        (a, b) =>
          (b.bestPickConfluence ?? 0) - (a.bestPickConfluence ?? 0) ||
          b.tier - a.tier ||
          b.score - a.score,
      );
  }, [query.data?.picks]);

  // If the user changes the data set out from under filters that now match
  // nothing, leave them in place - the empty-state copy explains what to do.
  // Just want to make sure the linter is happy with the effect.
  useEffect(() => undefined, [filteredPicks.length]);

  return (
    <Card
      className={cn(
        "w-full",
        embedded
          ? "h-full min-h-0 gap-0 overflow-hidden rounded-none bg-transparent py-0 ring-0"
          : "",
      )}
    >
      <CardHeader
        className={cn(
          "pb-3",
          embedded && "shrink-0 border-b bg-background/70 px-3 py-2",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {!embedded && <Sparkles className="h-4 w-4 text-primary" />}
            {!embedded && <CardTitle>Signa Signals</CardTitle>}
            {/* "How it works" - decodes score/tier/grade/regime/etc. so new
                users aren't staring at jargon. See ./signa-info-dialog.tsx */}
            <SignaInfoDialog />
          </div>
          <div className="flex items-center gap-1.5">
            {query.data && (
              <span className="font-data text-3xs text-muted-foreground">
                {query.data.enrichedCount}/{query.data.totalCandidates} plans
              </span>
            )}
          </div>
        </div>
        <div className={cn("flex items-baseline justify-between gap-3", embedded && "justify-end")}>
          {!embedded && (
            <p className="text-2xs text-muted-foreground">
              Multi-agent scored signals - Copy signal prefills the trade form
              with the suggested stop &amp; target.
            </p>
          )}
          {query.data && (
            <span
              className="shrink-0 font-data text-3xs text-muted-foreground"
              title="How long ago we pulled from Signa, and how old the Signa scoring run itself is. There is no manual refresh: the snapshot rebuilds at most once an hour."
            >
              {`pulled ${formatAge(query.data.cacheAgeSeconds)}`}
              {query.data.upstreamAgeSeconds != null &&
                ` · signals ${formatAge(query.data.upstreamAgeSeconds)}`}
            </span>
          )}
        </div>

        {/* ── View-mode sub-tabs: Best Picks vs All Signals ──────────────── */}
        {isSignedIn && query.data && (
          <div className="mt-2 inline-flex w-fit items-center rounded-md border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              aria-pressed={view === "best"}
              onClick={() => setView("best")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-sm px-2 text-2xs font-medium transition-colors",
                view === "best"
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Trophy className="h-3 w-3" />
              Best Picks
              {bestPicks.length > 0 && (
                <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 font-data text-3xs tabular-nums text-primary">
                  {bestPicks.length}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-pressed={view === "all"}
              onClick={() => setView("all")}
              className={cn(
                "inline-flex h-7 items-center rounded-sm px-2 text-2xs font-medium transition-colors",
                view === "all"
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              All Signals
              {query.data.picks.length > 0 && (
                <span className="ml-1 font-data text-3xs tabular-nums opacity-60">
                  {query.data.picks.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* ── Filter bar ────────────────────────────────────────────────────
            Mirrors the Signa dashboard's filter layout (Direction · Tier · Min
            score). Compact pills so it works in the narrow left-column slot
            and still wraps cleanly. Only shown in the "All Signals" view -
            Best Picks is a curated, already-filtered list. */}
        {isSignedIn && query.data && view === "all" && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 text-3xs uppercase tracking-wide text-muted-foreground">
              <Filter className="h-3 w-3" />
              <span>Filter</span>
            </div>

            {/* Direction segmented control */}
            <FilterPill
              active={direction === "all"}
              onClick={() => setDirection("all")}
              label="All"
            />
            <FilterPill
              active={direction === "bullish"}
              onClick={() => setDirection("bullish")}
              label="Bullish"
              tone="good"
            />
            <FilterPill
              active={direction === "bearish"}
              onClick={() => setDirection("bearish")}
              label="Bearish"
              tone="bad"
            />

            <span className="mx-1 h-3 w-px bg-border" aria-hidden />

            {/* Tier multi-select */}
            {[3, 2, 1].map((t) => (
              <FilterPill
                key={t}
                active={tiers.has(t)}
                onClick={() => toggleTier(t)}
                label={`T${t}`}
                title={`Toggle tier ${t} only`}
              />
            ))}

            <span className="mx-1 h-3 w-px bg-border" aria-hidden />

            {/* Min-score input */}
            <label className="flex items-center gap-1 text-3xs text-muted-foreground">
              <span>Score ≥</span>
              <Input
                type="number"
                min={0}
                max={100}
                value={minScoreInput}
                onChange={(e) => setMinScoreInput(e.target.value)}
                aria-label="Minimum score"
                className="h-6 w-14 px-1.5 text-2xs tabular-nums"
              />
            </label>

            {/* Show "filtered/total shown" only when a filter is actually
                active - otherwise the count is just the total and feels
                redundant. */}
            {filtersActive && (
              <span className="font-data text-3xs text-muted-foreground">
                {filteredPicks.length}/{query.data.picks.length}
              </span>
            )}

            {filtersActive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="ml-auto h-6 px-1.5 text-3xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </Button>
            )}
          </div>
        )}

        {isSignedIn && query.data && view === "all" && drawerFocus !== "standard" && (
          <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-2xs text-muted-foreground">
            {drawerFocus === "risk_reward"
              ? "Showing signals with available risk/reward, sorted by R/R."
              : "Showing copy-ready signals with stop and target data."}
          </div>
        )}
      </CardHeader>

      <CardContent
        className={cn(
          "flex flex-col gap-2 pt-0",
          embedded && "no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2",
        )}
      >
        {!isSignedIn && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Sign in to view Signa signals.
          </p>
        )}

        {isSignedIn && query.isLoading && (
          <>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </>
        )}

        {isSignedIn && query.error && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-300">
            <p className="font-semibold">Signa unavailable</p>
            <p className="mt-1 leading-snug">{query.error.message}</p>
          </div>
        )}

        {isSignedIn && query.data && query.data.picks.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No signals returned today.
          </p>
        )}

        {/* ── Best Picks view: top-of-the-stack confluence cards ───────── */}
        {isSignedIn && query.data && view === "best" && (
          <>
            {bestPicks.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No tickers qualify as a Best Pick right now.
                </p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  Best Picks require a bullish setup, a complete trade plan,
                  and broad multi-model agreement.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 text-xs"
                  onClick={() => setView("all")}
                >
                  Browse all signals
                </Button>
              </div>
            ) : (
              bestPicks.map((pick, idx) => (
                <BestPickRow
                  key={pick.id}
                  rank={idx + 1}
                  pick={pick}
                  isSelected={selectedTicker === pick.ticker}
                  onAskAi={onAskAi ? () => onAskAi(pick.ticker) : undefined}
                  onViewSymbol={() => onViewSymbol(pick.ticker)}
                  onCopy={() =>
                    onCopySignal({
                      symbol: pick.ticker,
                      side: pick.side,
                      entry: pick.entry,
                      stop: pick.stop,
                      target: pick.target,
                    })
                  }
                />
              ))
            )}
          </>
        )}

        {/* ── All Signals view: full scored-signal feed + filter empty state ── */}
        {isSignedIn && query.data && view === "all" && (
          <>
            {/* Filtered to nothing - distinct from "no signals returned" so the
                user knows to relax the filter, not blame the upstream. */}
            {query.data.picks.length > 0 && filteredPicks.length === 0 && (
              <div className="py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No signals match these filters.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 text-xs"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              </div>
            )}

            {filteredPicks.map((pick) => (
              <SignalRow
                key={pick.id}
                pick={pick}
                isSelected={selectedTicker === pick.ticker}
                onAskAi={onAskAi ? () => onAskAi(pick.ticker) : undefined}
                onViewSymbol={() => onViewSymbol(pick.ticker)}
                onCopy={() =>
                  onCopySignal({
                    symbol: pick.ticker,
                    side: pick.side,
                    entry: pick.entry,
                    stop: pick.stop,
                    target: pick.target,
                  })
                }
              />
            ))}
          </>
        )}

        {query.data?.warnings && query.data.warnings.length > 0 && (
          <details className="mt-2 text-3xs text-muted-foreground">
            <summary className="cursor-pointer">{query.data.warnings.length} upstream warning(s)</summary>
            <ul className="mt-1 ml-3 list-disc">
              {query.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
