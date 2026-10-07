"use client";

import { useEffect } from "react";
import type { Route } from "next";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import {
  formatPerpNotionalUsd,
  formatPerpPx,
  formatPerpRoePct,
} from "@/components/perps/perp-format";
import { closedPerpPositions } from "@/components/perps/perp-closed-positions";
// Position sizes read as dollars, not coin units: a quantity means nothing to a
// reader comparing a BTC position with a 1000PEPE one.

type ProfileTab = "positions" | "closed" | "fills";

function parseProfileTab(value: string | null): ProfileTab {
  if (value === "closed") return "closed";
  if (value === "fills") return "fills";
  return "positions";
}

function initials(name: string): string {
  return name.split(/\s+/u).map((part) => part[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

/** Minimal public profile for platform users who have enabled Hyperliquid. */
export default function UserHyperliquidProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = parseProfileTab(searchParams.get("t") ?? searchParams.get("tab"));
  const leaderboardHref = "/lb?t=users";
  const profilePath = `/lb/users/${encodeURIComponent(slug)}` as Route;

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("window");
    next.delete("sort");
    next.delete("t");
    next.delete("tab");
    if (activeTab !== "positions") next.set("t", activeTab);
    if (next.toString() !== searchParams.toString()) {
      const query = next.toString();
      router.replace((query ? `${profilePath}?${query}` : profilePath) as Route, { scroll: false });
    }
  }, [activeTab, profilePath, router, searchParams]);

  const setActiveTab = (value: string) => {
    const tab = parseProfileTab(value);
    router.replace(
      (tab === "positions" ? profilePath : `${profilePath}?t=${tab}`) as Route,
      { scroll: false },
    );
  };
  const { data: session, isPending: sessionPending } = useSession();
  const profile = trpc.leaderboard.userProfile.useQuery({ slug });
  // A profile read requires a session. Without this the signed-out case fell
  // into the not-found branch below and told people the link was invalid, which
  // sent them looking for a broken URL instead of the sign-in button.
  const needsSignIn =
    profile.error?.data?.code === "UNAUTHORIZED" ||
    (!sessionPending && !session?.user);
  const perps = trpc.leaderboard.userProfilePerps.useQuery(
    { slug },
    { enabled: profile.isSuccess && Boolean(profile.data.walletAddress), refetchInterval: 30_000 },
  );

  // An already-shared /lb/users/<traderKey hash> link still resolves server-side;
  // swap the address bar over to the readable slug so that is what gets copied.
  const canonicalSlug = profile.data?.slug;
  useEffect(() => {
    if (!canonicalSlug || canonicalSlug === slug) return;
    const query = searchParams.toString();
    const canonicalPath = `/lb/users/${encodeURIComponent(canonicalSlug)}`;
    router.replace((query ? `${canonicalPath}?${query}` : canonicalPath) as Route, { scroll: false });
  }, [canonicalSlug, slug, router, searchParams]);

  if (profile.isLoading) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-6xl space-y-6 bg-background px-4 py-8">
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </main>
    );
  }

  if (needsSignIn) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 py-12">
        <Button variant="ghost" className="w-fit" asChild>
          <Link href={leaderboardHref}><ArrowLeft className="size-4" /> Leaderboard</Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to view this profile</h1>
        <p className="text-sm text-muted-foreground">
          Trader profiles are visible to signed-in members.
        </p>
        <Button className="w-fit" asChild>
          <Link href={"/" as Route}>Sign in</Link>
        </Button>
      </main>
    );
  }

  if (profile.error || !profile.data) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 py-12">
        <Button variant="ghost" className="w-fit" asChild>
          <Link href={leaderboardHref}><ArrowLeft className="size-4" /> Leaderboard</Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Trader not found</h1>
        <p className="text-sm text-muted-foreground">This profile is unavailable or the link is no longer valid.</p>
      </main>
    );
  }

  const data = profile.data;
  const positions = perps.data?.positions ?? [];
  const fills = perps.data?.fills ?? [];
  const closedPositions = closedPerpPositions(fills);
  const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0);

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href={leaderboardHref}><ArrowLeft className="size-4" /> Leaderboard</Link>
          </Button>
          <Badge variant="outline">Hyperliquid</Badge>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8">
        <section className="border-b pb-8">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar size="lg" className="rounded-xl">
              <AvatarImage src={data.avatar} alt={data.displayName} />
              <AvatarFallback>{initials(data.displayName) || "?"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{data.displayName}</h1>
                {data.twitterLinked && <Badge variant="secondary">X</Badge>}
              </div>
              {data.twitterHandle && (
                <a
                  href={`https://x.com/${encodeURIComponent(data.twitterHandle)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  @{data.twitterHandle} <ExternalLink className="inline size-3" />
                </a>
              )}
            </div>
          </div>
        </section>

        {data.walletAddress && (
          <>
            <section className="grid grid-cols-2 gap-x-8 gap-y-6 border-b pb-8 sm:grid-cols-3">
              <Stat label="Account equity" value={formatUsd(perps.data?.crossMargin?.accountValueUsd)} />
              <Stat label="Margin used" value={formatUsd(perps.data?.crossMargin?.totalMarginUsedUsd)} />
              <Stat
                label="Unrealized P&L"
                value={formatUsd(unrealizedPnl)}
                valueClassName={cn(unrealizedPnl > 0 && "text-green-500", unrealizedPnl < 0 && "text-red-500")}
              />
            </section>

            {perps.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : perps.error ? (
              <div className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
                Hyperliquid data is unavailable. <button onClick={() => perps.refetch()} className="font-medium underline">Try again</button>
              </div>
            ) : (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="positions">
                    Open <span className="ml-1 text-muted-foreground">{positions.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="closed">
                    Closed <span className="ml-1 text-muted-foreground">{closedPositions.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="fills">Fills</TabsTrigger>
                </TabsList>
                <TabsContent value="positions" className="pt-3">
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr><th className="p-3">Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>uPnL</th><th>ROE</th><th>Leverage</th></tr>
                      </thead>
                      <tbody>
                        {positions.length === 0 ? (
                          <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No open positions.</td></tr>
                        ) : positions.map((position) => (
                          <tr key={position.coin} className="border-t">
                            <td className="p-3 font-medium">{position.coin}</td>
                            <td className={position.side === "long" ? "text-green-500" : "text-red-500"}>{position.side}</td>
                            <td className="font-data" title={`${position.size} ${position.coin}`}>
                              {formatPerpNotionalUsd(position.size, position.markPx ?? position.entryPx)}
                            </td>
                            <td className="font-data">{formatPerpPx(position.entryPx)}</td>
                            <td className="font-data">{formatPerpPx(position.markPx)}</td>
                            <td className={cn("font-data", Number(position.unrealizedPnl) > 0 && "text-green-500", Number(position.unrealizedPnl) < 0 && "text-red-500")}>{formatUsd(position.unrealizedPnl)}</td>
                            <td className="font-data">{formatPerpRoePct(position.returnOnEquity, null, null)}</td>
                            <td className="font-data">{position.leverage}x</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>
                <TabsContent value="closed" className="pt-3">
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[680px] text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="p-3">Closed</th>
                          <th>Market</th>
                          <th>Side</th>
                          <th>Size</th>
                          <th className="text-right p-3">Avg close</th>
                          <th className="text-right p-3">Realized P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {closedPositions.length === 0 ? (
                          <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                            No closed positions in the most recent 100 fills.
                          </td></tr>
                        ) : closedPositions.map((pos) => (
                          <tr key={pos.id} className="border-t">
                            <td className="p-3 whitespace-nowrap text-muted-foreground text-xs">
                              {pos.closedAt > 0 ? new Date(pos.closedAt).toLocaleString() : "-"}
                            </td>
                            <td className="font-medium">
                              {pos.coin}
                              {pos.partial && (
                                <span
                                  className="ml-1 text-xs font-normal text-muted-foreground"
                                  title="This position opened before the visible fill history, so its size and average close use only the visible fills."
                                >
                                  partial
                                </span>
                              )}
                            </td>
                            <td className={pos.side === "long" ? "text-green-500" : "text-red-500"}>{pos.side}</td>
                            <td className="font-data" title={`${pos.sizeCoin} ${pos.coin}`}>
                              {formatPerpNotionalUsd(pos.sizeCoin, pos.avgClosePx)}
                            </td>
                            <td className="font-data text-right p-3">{formatPerpPx(pos.avgClosePx)}</td>
                            <td className={cn("font-data text-right p-3", pos.realizedPnl > 0 && "text-green-500", pos.realizedPnl < 0 && "text-red-500")}>
                              {formatUsd(pos.realizedPnl)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>
                <TabsContent value="fills" className="pt-3">
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr><th className="p-3">Time</th><th>Market</th><th>Action</th><th>Price</th><th>Size</th><th>Closed P&L</th><th>Fee</th></tr>
                      </thead>
                      <tbody>
                        {fills.length === 0 ? (
                          <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No recent fills.</td></tr>
                        ) : fills.map((fill) => (
                          <tr key={`${fill.hash}:${fill.tid}`} className="border-t">
                            <td className="p-3 whitespace-nowrap text-muted-foreground">{new Date(fill.time).toLocaleString()}</td>
                            <td className="font-medium">{fill.coin}</td>
                            <td>{fill.dir}</td>
                            <td className="font-data">{formatPerpPx(fill.px)}</td>
                            <td className="font-data" title={`${fill.sz} ${fill.coin}`}>
                              {formatPerpNotionalUsd(fill.sz, fill.px)}
                            </td>
                            <td className={cn("font-data", Number(fill.closedPnl) > 0 && "text-green-500", Number(fill.closedPnl) < 0 && "text-red-500")}>{formatUsd(fill.closedPnl)}</td>
                            <td className="font-data">{formatUsd(fill.fee)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-data text-xl font-semibold tabular-nums", valueClassName)}>{value}</p>
    </div>
  );
}
