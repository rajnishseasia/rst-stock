"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import { Users, Flame, Clock, RefreshCw, Radio, type LucideIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { feedChartViewLabel } from "@/components/feed/ticker-chart-action";

interface SocialFeedPanelProps {
  onViewSymbol: (symbol: string) => void;
  subheaderAction?: SocialSubheaderAction;
  subheaderActionNonce?: number;
  embedded?: boolean;
}

export type SocialSubheaderAction = "hot_symbols" | "live_feed";

export type SocialViewMeta = {
  label: string;
  description: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyBody: string;
};

/**
 * Per-view copy and iconography. Each of the three subheader buttons maps to a
 * genuinely distinct view here, so switching between them visibly changes the
 * heading and the empty state even before any community data loads (which is
 * what previously made all three look identical and "do nothing").
 */
export const SOCIAL_VIEW_META: Record<SocialSubheaderAction, SocialViewMeta> = {
  hot_symbols: {
    label: "Hot symbols",
    description: "Tickers the community is trading most in the last 30 minutes.",
    icon: Flame,
    emptyTitle: "No hot symbols yet",
    emptyBody: "When community activity picks up, the busiest tickers show here.",
  },
  live_feed: {
    label: "Live feed",
    description: "The community's most recent trades, updating in real time.",
    icon: Radio,
    emptyTitle: "No recent trades shared",
    emptyBody: "Eligible live trades appear here automatically.",
  },
};

export function getSocialViewMeta(focus: SocialSubheaderAction): SocialViewMeta {
  return SOCIAL_VIEW_META[focus] ?? SOCIAL_VIEW_META.hot_symbols;
}

function SocialEmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
      <Icon className="h-8 w-8 opacity-20" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-xs">{body}</p>
    </div>
  );
}

export function SocialFeedPanel({
  onViewSymbol,
  subheaderAction = "hot_symbols",
  subheaderActionNonce = 0,
  embedded = false,
}: SocialFeedPanelProps) {
  const { collapsed, toggle } = useCollapsible("community-trades");
  const isCollapsed = embedded ? false : collapsed;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [panelFocus, setPanelFocus] = useState<SocialSubheaderAction>("hot_symbols");
  const lastSubheaderNonceRef = useRef(0);
  const { data: session } = useSession();
  const isAuthed = !!session?.user;

  // Recent social trades (only when signed in). Now that the two views are
  // mutually exclusive, only the visible one polls: the data stays cached and
  // refetches as soon as its view is selected again.
  const feedQuery = trpc.social.feed.useQuery(
    { limit: 50 },
    {
      refetchInterval: panelFocus === "live_feed" ? 10000 : false,
      staleTime: 5000,
      enabled: isAuthed,
    }
  );

  // Hot symbols momentum (only when signed in)
  const hotSymbolsQuery = trpc.social.hotSymbols.useQuery(
    { minutes: 30 },
    {
      refetchInterval: panelFocus === "hot_symbols" ? 30000 : false,
      enabled: isAuthed,
    }
  );
  const refetchFeed = feedQuery.refetch;
  const refetchHotSymbols = hotSymbolsQuery.refetch;

  const handleRefresh = useCallback(async () => {
    if (!isAuthed) return;
    setIsRefreshing(true);
    await Promise.all([refetchFeed(), refetchHotSymbols()]);
    setIsRefreshing(false);
  }, [isAuthed, refetchFeed, refetchHotSymbols]);

  useEffect(() => {
    if (
      subheaderActionNonce === 0 ||
      lastSubheaderNonceRef.current === subheaderActionNonce
    ) {
      return;
    }
    lastSubheaderNonceRef.current = subheaderActionNonce;

    setPanelFocus(subheaderAction);
    if (subheaderAction === "live_feed") {
      handleRefresh();
    }
  }, [handleRefresh, subheaderAction, subheaderActionNonce]);

  // Canonical direction-chip recipe: direction color on its own tint, no border.
  const getSideColor = (side: string) => {
    return side.toLowerCase() === "buy"
      ? "text-green-500 bg-gain-tint border-transparent"
      : "text-red-500 bg-loss-tint border-transparent";
  };

  const viewMeta = getSocialViewMeta(panelFocus);

  const signInEmpty = (
    <SocialEmptyState
      icon={Users}
      title="Sign in to see community trades"
      body="Community activity is available once you sign in."
    />
  );

  const renderHotSymbolsView = () => {
    if (!isAuthed) return signInEmpty;
    if (hotSymbolsQuery.isLoading && !hotSymbolsQuery.data) {
      return (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Scanning community momentum...
        </div>
      );
    }
    if (!hotSymbolsQuery.data || hotSymbolsQuery.data.length === 0) {
      return (
        <SocialEmptyState
          icon={viewMeta.icon}
          title={viewMeta.emptyTitle}
          body={viewMeta.emptyBody}
        />
      );
    }
    return (
      <div className="flex flex-wrap content-start items-center gap-2 p-3">
        {hotSymbolsQuery.data.map((hot) => (
          <Badge
            asChild
            key={hot.symbol}
            variant="outline"
            className={`text-xs gap-1 py-1 hover:bg-muted ${hot.latestSide === 'buy' ? 'border-green-500/50 text-green-600 dark:text-green-400' : 'border-red-500/50 text-red-600 dark:text-red-400'}`}
          >
            <button
              type="button"
              onClick={() => onViewSymbol(hot.symbol)}
              aria-label={feedChartViewLabel(hot.symbol)}
              title={feedChartViewLabel(hot.symbol)}
              className="cursor-pointer"
            >
              <span className="font-bold">{hot.symbol}</span>
              <span className="opacity-70 text-xs sm:text-3xs ml-1">×{hot.traderCount} traders</span>
            </button>
          </Badge>
        ))}
      </div>
    );
  };

  const renderLiveFeedView = () => {
    if (!isAuthed) return signInEmpty;
    if (feedQuery.isLoading && !feedQuery.data) {
      return (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Listening for trades...
        </div>
      );
    }
    // `!data` covers the error case too (not just the empty one), so a failed
    // fetch renders the empty state instead of a blank padded div.
    if (!feedQuery.data || feedQuery.data.length === 0) {
      return (
        <SocialEmptyState
          icon={viewMeta.icon}
          title={viewMeta.emptyTitle}
          body={viewMeta.emptyBody}
        />
      );
    }
    return (
      // Flat full-bleed rows: separation comes from the hairline border-b,
      // not card chrome, so the feed reads as one etched surface.
      <div>
        {feedQuery.data?.map((trade) => (
          <div
            key={trade.id}
            className="flex items-start gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-surface-hover"
          >
            <Avatar className="h-10 w-10">
              <AvatarImage src={trade.traderImage} alt={trade.traderName} className="object-cover" />
              <AvatarFallback className="bg-primary/10 text-primary uppercase font-bold text-xs">
                {trade.traderName.substring(0, 2)}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-semibold text-sm truncate">
                  {trade.traderName}
                </span>
                <span className="text-xs sm:text-3xs text-muted-foreground flex items-center gap-1 whitespace-nowrap">
                  <Clock className="h-3 w-3" />
                  {formatDistanceToNow(new Date(trade.createdAt), { addSuffix: true })}
                </span>
              </div>

              <div className="flex items-center flex-wrap gap-2 mt-2">
                <Badge variant="outline" className={`font-bold ${getSideColor(trade.side)} uppercase text-2xs`}>
                  {trade.side}
                </Badge>
                <button
                  type="button"
                  onClick={() => onViewSymbol(trade.symbol)}
                  aria-label={feedChartViewLabel(trade.symbol)}
                  title={feedChartViewLabel(trade.symbol)}
                  className="cursor-pointer rounded-sm text-sm font-bold tracking-tight hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {trade.symbol}
                </button>
                <span className="text-sm text-muted-foreground">× {trade.qty}</span>

                <Separator orientation="vertical" className="h-4" />

                {trade.fillPrice != null ? (
                  <span className="text-xs font-semibold text-foreground">
                    @ {formatUsd(trade.fillPrice)}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    {trade.limitPrice != null ? formatUsd(trade.limitPrice) : "Pending fill"}
                  </span>
                )}
                {trade.orderType !== 'market' && (
                  <Badge variant="secondary" className="text-3xs sm:text-3xs uppercase px-1 h-4">
                    {trade.orderType}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderActiveView = () => {
    if (panelFocus === "live_feed") return renderLiveFeedView();
    return renderHotSymbolsView();
  };

  const ViewIcon = viewMeta.icon;

  return (
    <Card
      className={cn(
        "flex flex-col border-primary/20",
        embedded
          ? "h-full min-h-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent py-0 ring-0"
          : isCollapsed
            ? ""
            : "h-[420px]",
      )}
    >
      <CardHeader
        className={cn(
          "bg-muted/20",
          isCollapsed ? "pb-3" : "pb-3 border-b",
          embedded && "shrink-0 bg-background/70 px-3 py-2",
        )}
      >
        <div className={cn(
          "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
          embedded && "sm:justify-end",
        )}>
          {!embedded && (
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Users className="h-5 w-5 text-primary" />
                  Community Trades
                </CardTitle>
                <CardDescription>
                  Watch the community's trades in real-time
                </CardDescription>
              </div>
              <CollapseButton
                collapsed={collapsed}
                onToggle={toggle}
                label="Community Trades"
                className="sm:hidden"
              />
            </div>
          )}

          <div className="flex items-start gap-2 sm:items-center">
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <button
                onClick={handleRefresh}
                className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 min-h-11 py-1 sm:min-h-0 sm:py-0"
                disabled={isRefreshing || !isAuthed}
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {!embedded && (
              <CollapseButton
                collapsed={collapsed}
                onToggle={toggle}
                label="Community Trades"
                className="hidden sm:inline-flex"
              />
            )}
          </div>
        </div>
      </CardHeader>

      {!isCollapsed && (
      <CardContent className="flex-1 p-0 flex flex-col min-h-0">
        {/* View header - names the active view so switching between Hot symbols,
            Live feed, and Sharing is obviously doing something even when the
            underlying data is empty. */}
        <div
          data-social-view={panelFocus}
          className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-2"
        >
          <ViewIcon className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">{viewMeta.label}</div>
            <div className="truncate text-2xs text-muted-foreground">
              {viewMeta.description}
            </div>
          </div>
        </div>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
          {renderActiveView()}
        </div>
      </CardContent>
      )}
    </Card>
  );
}
