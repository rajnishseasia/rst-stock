"use client";

/**
 * BestPickRow
 *
 * Single Best Picks card - visually echoes Signa's own dashboard layout:
 * rank · ticker · direction · tier · status on the left, big CONFLUENCE
 * number on the right, then a 4-pillar bar grid (Trend / Agents / News /
 * Plan) and the headline trade plan. Catalyst chip surfaces the insider
 * cluster or news signal we used.
 *
 * Data shape is the SignaPick from `apps/api/src/routers/signa.ts` with
 * the optional `pillars`, `bestPickConfluence`, and `catalyst` fields
 * populated (see annotateBestPick there).
 */

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Sparkles, TrendingUp } from "lucide-react";
import { formatSignedNumber, formatUsd } from "@/lib/format";
import { feedChartViewLabel } from "@/components/feed/ticker-chart-action";

export interface BestPickRowPick {
  ticker: string;
  direction: string;
  side: "buy" | "sell";
  tier: number;
  modelCount: number;
  bestPickConfluence?: number;
  pillars?: {
    trend: number;
    agents: number;
    news: number;
    plan: number;
  };
  catalyst?: {
    type: string;
    direction: string;
    headline: string;
    strength?: string;
  } | null;
  entry?: number;
  stop?: number;
  target?: number;
  riskReward?: number;
  price?: number;
  change24h?: number;
  reason?: string;
}

/** Color & label for the headline direction badge (canonical chip recipe:
 *  direction color on its own tint, no border). */
function tone(direction: string): { text: string; cls: string } {
  const up = /BULL|LONG|BUY/i.test(direction);
  return {
    text: up ? "BULLISH" : "BEARISH",
    cls: up
      ? "text-green-500 bg-gain-tint border-transparent"
      : "text-red-500 bg-loss-tint border-transparent",
  };
}

/** A single 0–100 pillar bar with a label + score. */
function Pillar({ name, score }: { name: string; score: number }) {
  // Color the bar green when the pillar is strong, amber mid, dim weak.
  const fill =
    score >= 80
      ? "bg-green-500"
      : score >= 60
        ? "bg-amber-500"
        : score >= 40
          ? "bg-muted-foreground/60"
          : "bg-muted-foreground/30";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <span className="font-data tabular-nums text-2xs font-semibold text-foreground">
          {Math.round(score)}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className={cn("h-1.5 rounded-full transition-[width]", fill)}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

/** A single trade-plan stat cell. */
function PlanStat({
  label,
  value,
  toneOverride,
  missing,
}: {
  label: string;
  value: string;
  toneOverride?: "good" | "bad";
  missing?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/40 px-2 py-1.5">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "min-w-0 truncate font-data tabular-nums text-xs font-semibold @[420px]/best-pick:text-sm",
          toneOverride === "good" && !missing && "text-green-500",
          toneOverride === "bad" && !missing && "text-red-500",
          missing && "text-muted-foreground/60",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function BestPickRow({
  rank,
  pick,
  isSelected,
  onCopy,
  onAskAi,
  onViewSymbol,
}: {
  rank: number;
  pick: BestPickRowPick;
  isSelected: boolean;
  onCopy: () => void;
  /**
   * Optional: when provided, renders an "Ask AI" button next to Copy signal
   * that opens the AI Chat overlay pre-filled with a research prompt for this
   * ticker.
   */
  onAskAi?: () => void;
  /** Open the live chart for this ticker (clicking the ticker symbol). */
  onViewSymbol: () => void;
}) {
  const t = tone(pick.direction);
  const conf = pick.bestPickConfluence ?? 0;
  const isUp = pick.change24h != null && pick.change24h >= 0;

  return (
    <div
      className={cn(
        "@container/best-pick min-w-0 rounded-lg border p-3 transition-colors",
        isSelected
          ? "ring-2 ring-primary bg-muted/50"
          : "border-primary/20 bg-primary/5 hover:bg-primary/10",
      )}
    >
      {/* ── Headline: rank · ticker · direction · tier · CONFLUENCE on the right */}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-bold text-xs text-muted-foreground shrink-0">
              #{rank}
            </span>
            <button
              type="button"
              onClick={onViewSymbol}
              aria-label={feedChartViewLabel(pick.ticker)}
              title={feedChartViewLabel(pick.ticker)}
              className="shrink-0 cursor-pointer rounded-sm text-base font-bold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {pick.ticker}
            </button>
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-3xs font-bold uppercase shrink-0",
                t.cls,
              )}
            >
              {t.text}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-3xs font-bold uppercase shrink-0",
                pick.tier === 3
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                  : pick.tier === 2
                    ? "border-muted-foreground/30 text-muted-foreground"
                    : "border-muted-foreground/20 text-muted-foreground/70",
              )}
            >
              T{pick.tier}
            </Badge>
          </div>
          {pick.price != null && (
            <span className="font-data tabular-nums text-2xs text-muted-foreground">
              {formatUsd(pick.price)}
              {pick.change24h != null && (
                <span className={cn("ml-1", isUp ? "text-green-500" : "text-red-500")}>
                  {formatSignedNumber(pick.change24h, "%")}
                </span>
              )}
              <span className="ml-2 opacity-60">{pick.modelCount} models</span>
            </span>
          )}
        </div>

        {/* Big CONFLUENCE number echoing Signa's layout. */}
        <div className="flex flex-col items-end leading-tight shrink-0">
          <span className="font-data tabular-nums text-2xl font-bold text-foreground">
            {Math.round(conf)}
          </span>
          <span className="text-3xs uppercase tracking-wider text-muted-foreground">
            confluence
          </span>
        </div>
      </div>

      {/* ── Catalyst chip - what makes this a Best Pick (typically insider) */}
      {pick.catalyst && pick.catalyst.headline && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
          <TrendingUp className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="text-2xs leading-snug text-amber-600 dark:text-amber-300">
            <span className="font-semibold">{labelCatalystType(pick.catalyst.type)}:</span>{" "}
            {pick.catalyst.headline}
          </span>
        </div>
      )}

      {/* ── Pillar bars - 4 columns mirroring Signa's confluence breakdown */}
      {pick.pillars && (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          <Pillar name="Trend" score={pick.pillars.trend} />
          <Pillar name="Agents" score={pick.pillars.agents} />
          <Pillar name="News" score={pick.pillars.news} />
          <Pillar name="Plan" score={pick.pillars.plan} />
        </div>
      )}

      {/* ── Trade plan grid (the actionable part) */}
      <div className="mt-3 grid grid-cols-2 gap-2 @[420px]/best-pick:grid-cols-4">
        <PlanStat label="Entry" value={formatUsd(pick.entry)} />
        <PlanStat
          label="Stop"
          value={formatUsd(pick.stop)}
          toneOverride="bad"
          missing={pick.stop == null}
        />
        <PlanStat
          label="Target"
          value={formatUsd(pick.target)}
          toneOverride="good"
          missing={pick.target == null}
        />
        <PlanStat
          label="R/R"
          value={pick.riskReward != null ? `${pick.riskReward.toFixed(1)}R` : "-"}
        />
      </div>

      {/* ── CTA row: Ask AI (optional) + Copy signal */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-end gap-2">
        {onAskAi && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAskAi}
            className="h-8 min-w-0 gap-1 px-2 text-xs @[360px]/best-pick:px-3"
            title={`Open AI Chat and analyze ${pick.ticker}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={onCopy}
          className="h-8 min-w-0 gap-1 px-2 text-xs @[360px]/best-pick:px-3"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Copy signal
        </Button>
      </div>
    </div>
  );
}

/** Human label for an upstream catalyst.type string. */
function labelCatalystType(type: string): ReactNode {
  switch (type) {
    case "INSIDER_CLUSTER":
      return "Insider buying";
    case "NEWS":
      return "News";
    default:
      return type.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  }
}
