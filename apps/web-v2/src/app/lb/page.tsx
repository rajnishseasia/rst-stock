"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Settings, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu } from "@/components/auth/user-menu";
import { useSession } from "@/lib/auth-client";
import { LeaderboardView } from "@/components/copy-trade/leaderboard-view";
import type {
  LeaderboardWindow,
  XSortBy,
  XHorizon,
  UsersSortBy,
} from "@/components/copy-trade/use-leaderboard-view";

/** Parse and validate a window param from the URL. */
function parseWindow(raw: string | null): LeaderboardWindow | undefined {
  if (raw === "7d" || raw === "30d" || raw === "all") return raw;
  return undefined;
}

/** Parse and validate a sort param for the Callers tab. */
function parseXSort(raw: string | null): XSortBy | undefined {
  if (raw === "forwardReturn" || raw === "hitRate" || raw === "calls") return raw;
  return undefined;
}

/** Parse and validate a sort param for the Users tab. */
function parseUsersSort(raw: string | null): UsersSortBy | undefined {
  if (raw === "pnl" || raw === "winRate" || raw === "trades") return raw;
  return undefined;
}

/** Parse and validate the horizon param (1, 3, or 7 days). */
function parseHorizon(raw: string | null): XHorizon | undefined {
  if (raw === "1") return 1;
  if (raw === "3") return 3;
  if (raw === "7") return 7;
  return undefined;
}

/**
 * `useSearchParams` requires a Suspense boundary in the App Router, so the
 * page body lives in an inner component and the default export wraps it.
 */
export default function LeaderboardPage() {
  return (
    <Suspense fallback={<LeaderboardShell />}>
      <LeaderboardPageInner />
    </Suspense>
  );
}

/** Static chrome rendered while the page shell suspends. */
function LeaderboardShell() {
  return (
    <main className="min-h-screen bg-background">
      <header className="flex justify-center sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 w-full max-w-[1400px]">
          <div className="flex items-center gap-3">
            <div className="h-8 w-24" />
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-bold">Top Traders</h1>
            </div>
          </div>
        </div>
      </header>
      <div className="flex justify-center px-4 py-8">
        <div className="w-full max-w-3xl space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    </main>
  );
}

/**
 * Top Traders leaderboard - its own page (/lb). Vet/discover traders
 * by reconstructed P&L (Users) or forward-return (Callers), then Follow /
 * auto-copy from the ranking. Reached from the "Top Traders" link in the Copy
 * Trade panel header.
 *
 * The URL identifies the actual page only: Callers is `/lb`, and Users is
 * `/lb?t=users`. Ranking controls are transient view state.
 */
function LeaderboardPageInner() {
  const { data: session } = useSession();
  const isSignedIn = !!session?.user;
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawTab = searchParams.get("t") ?? searchParams.get("tab");
  const tab: "x" | "users" = rawTab === "users" ? "users" : "x";

  // Read the old verbose URL once so existing shared links retain their initial
  // filters, then keep those controls local while the address is compacted.
  const [xWindow, setXWindow] = useState<LeaderboardWindow>(
    () => parseWindow(searchParams.get("xWindow")) ?? "30d",
  );
  const [xSort, setXSort] = useState<XSortBy>(
    () => parseXSort(searchParams.get("xSort")) ?? "forwardReturn",
  );
  const [xHorizon, setXHorizon] = useState<XHorizon>(
    () => parseHorizon(searchParams.get("horizon")) ?? 1,
  );
  const [usersWindow, setUsersWindow] = useState<LeaderboardWindow>(
    () => parseWindow(searchParams.get("usersWindow")) ?? "all",
  );
  const [usersSort, setUsersSort] = useState<UsersSortBy>(
    () => parseUsersSort(searchParams.get("usersSort")) ?? "pnl",
  );

  // Strip the old filter params. Only a non-default page tab belongs in the URL.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["t", "tab", "xWindow", "xSort", "horizon", "usersWindow", "usersSort"]) {
      params.delete(key);
    }
    if (tab === "users") params.set("t", "users");
    if (params.toString() !== searchParams.toString()) {
      const query = params.toString();
      router.replace(query ? `/lb?${query}` : "/lb", { scroll: false });
    }
  }, [router, searchParams, tab]);

  const setTab = (nextTab: "x" | "users") => {
    router.replace(
      nextTab === "users" ? "/lb?t=users" : "/lb",
      { scroll: false },
    );
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="flex justify-center sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 w-full max-w-[1400px]">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" className="gap-2" asChild>
              <Link href="/app">
                <ArrowLeft className="h-4 w-4" />
                Dashboard
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-bold">Top Traders</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link href="/settings" aria-label="Settings">
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
            <UserMenu />
          </div>
        </div>
      </header>

      <div className="flex justify-center px-4 py-8">
        <div className="w-full max-w-3xl">
          <p className="mb-4 text-sm text-muted-foreground">
            Vet and discover traders, then follow or auto-copy from the ranking.
          </p>
          <LeaderboardView
            isSignedIn={isSignedIn}
            tab={tab}
            onTabChange={setTab}
            xOptions={{
              window: xWindow,
              sortBy: xSort,
              horizonDays: xHorizon,
              onWindowChange: setXWindow,
              onSortByChange: setXSort,
              onHorizonChange: setXHorizon,
            }}
            usersOptions={{
              window: usersWindow,
              sortBy: usersSort,
              onWindowChange: setUsersWindow,
              onSortByChange: setUsersSort,
            }}
          />
        </div>
      </div>
    </main>
  );
}
