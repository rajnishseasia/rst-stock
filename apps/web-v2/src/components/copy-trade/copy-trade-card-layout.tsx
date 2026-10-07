import type { ReactNode } from "react";
import { Zap, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SourceFilter } from "./copy-trade-persistence";

/** Matches the X-signals feed's perp chip wording so one venue reads one way. */
const PERP_BADGE_LABEL = "Perp";
const PERP_BADGE_HINT = "Hyperliquid perp";

/**
 * Venue badge for a copy-trade feed row, rendered only for a Hyperliquid perp.
 *
 * Without it a perp fill is visually identical to an equity buy: same bare
 * ticker, same green BUY chip, same live stock quote beside it. Copy now opens
 * the PERP ticket for a copyable row instead of the stock form (copy-perp-
 * route.ts decides which), but a row it refuses still shows a disabled Copy,
 * and either way a badge is not a substitute for a tooltip: the tickers
 * collide with real listings (SOL is ReneSola on Nasdaq, APT collides too), so
 * a follower has to be able to read the venue off the card itself.
 *
 * The asset type is taken as `unknown` because it arrives inside the feed item's
 * loosely typed `meta` bag; the check lives here so the decision is testable
 * rather than buried in the panel's row map.
 */
export function PerpRowBadge({ assetType }: { assetType: unknown }) {
  const isPerp =
    typeof assetType === "string" && assetType.trim().toUpperCase() === "PERP";
  if (!isPerp) return null;

  return (
    <Badge
      variant="outline"
      title={PERP_BADGE_HINT}
      className="shrink-0 gap-0.5 px-1.5 text-2xs font-bold uppercase text-gold bg-gold/10 border-gold/20"
    >
      <Zap aria-hidden="true" className="size-2.5" />
      {PERP_BADGE_LABEL}
    </Badge>
  );
}

/**
 * Venue badge for a plain equity (stock) copy-trade feed row.
 *
 * Option rows already carry an "Option" badge; perp rows carry the gold "Perp"
 * badge. Equity rows had no badge at all, making them look identical in format
 * to perp rows and giving no visual cue that the Copy button opens the stock
 * ticket. This badge closes that gap so all three venue types are labeled
 * consistently.
 *
 * Renders only when assetType is "EQUITY" (or the row has no assetType string
 * at all, which historically meant an Alpaca stock fill).
 */
export function EquityRowBadge({ assetType }: { assetType: unknown }) {
  const isPerp =
    typeof assetType === "string" && assetType.trim().toUpperCase() === "PERP";
  const isOption =
    typeof assetType === "string" && assetType.trim().toUpperCase() === "OPTION";
  if (isPerp || isOption) return null;

  return (
    <Badge
      variant="outline"
      title="Alpaca stock"
      className="shrink-0 gap-0.5 px-1.5 text-2xs font-bold uppercase text-sky-400 bg-sky-400/10 border-sky-400/20"
    >
      <TrendingUp aria-hidden="true" className="size-2.5" />
      Stock
    </Badge>
  );
}

interface CopyTradeCardHeaderLayoutProps {
  identity: ReactNode;
  author: ReactNode;
  actions: ReactNode;
}

export function CopyTradeCardHeaderLayout({
  identity,
  author,
  actions,
}: CopyTradeCardHeaderLayoutProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="copy-trade-card-header">
      <div
        className="flex min-w-0 items-center gap-1.5 overflow-hidden"
        data-testid="copy-trade-card-identity"
      >
        {identity}
      </div>
      <div
        className="min-w-0 truncate text-xs font-medium text-muted-foreground"
        data-testid="copy-trade-card-author"
      >
        {author}
      </div>
      <div
        className="flex min-w-0 flex-wrap items-center justify-end gap-1.5"
        data-testid="copy-trade-card-actions"
      >
        {actions}
      </div>
    </div>
  );
}

interface MirrorExplainerLayoutProps {
  copy: ReactNode;
  actions: ReactNode;
}

export function MirrorExplainerLayout({ copy, actions }: MirrorExplainerLayoutProps) {
  return (
    <div
      className="flex flex-wrap items-start gap-2 rounded-md border bg-muted/20 px-2 py-1.5"
      data-testid="mirror-explainer"
    >
      <div className="min-w-48 flex-1">{copy}</div>
      <div
        className="ml-auto flex shrink-0 items-center gap-1.5"
        data-testid="mirror-explainer-actions"
      >
        {actions}
      </div>
    </div>
  );
}

/** A single source-filter tab styled like a compact segmented control. */
function SourceTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-11 items-center rounded-md border px-2.5 text-xs font-medium transition-colors xl:h-7",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The copy-trade feed's source-filter row: All / Following / X / Users, plus
 * a disabled Politicians tab (Phase 2). Extracted so it is renderable and
 * assertable on its own - the panel's four tabs used to be pinned only by
 * checking that `setSource("x_signal")`-style call strings existed somewhere
 * in the component's source, which cannot tell whether a given button is
 * actually wired to the source it names. `onSelect` here is the same
 * `setSource` the panel's `useSourceFilter()` hook returns; passing it as a
 * prop (rather than closing over internal state) is what lets a test capture
 * each button's real onClick and invoke it directly.
 */
export function CopyTradeSourceTabs({
  source,
  onSelect,
}: {
  source: SourceFilter;
  onSelect: (source: SourceFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <SourceTab active={source === "all"} onClick={() => onSelect("all")}>
        All
      </SourceTab>
      <SourceTab active={source === "following"} onClick={() => onSelect("following")}>
        Following
      </SourceTab>
      <SourceTab active={source === "x_signal"} onClick={() => onSelect("x_signal")}>
        Callers
      </SourceTab>
      <SourceTab active={source === "user"} onClick={() => onSelect("user")}>
        Users
      </SourceTab>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Politician trades - coming soon"
        className="inline-flex h-11 cursor-not-allowed items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground opacity-60 xl:h-7"
      >
        Politicians
        <Badge variant="secondary" className="h-4 px-1 text-3xs uppercase">
          Soon
        </Badge>
      </button>
    </div>
  );
}
