"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import {
  DashboardAuthUnavailable,
  shouldRenderDashboard,
  syncDashboardRedirect,
} from "./dashboard-guard";
import { TradingAppContent } from "./trading-app-content";

/**
 * The /app route: the anonymous-visitor redirect guard, and nothing else.
 *
 * The terminal itself is `TradingAppContent` (./trading-app-content), kept a
 * separate component so this guard can be rendered for real in a test without
 * also mounting that entire authenticated terminal, which needs a live
 * VenueProvider/tRPC context the test has no reason to fake.
 *
 * This file exports `default` and nothing else, and has to stay that way: a
 * Next.js page file may export only `default` plus the framework's own config
 * keys (`metadata`, `dynamic`, `viewport`, ...). Any other export fails the
 * page-type check `next build` generates into .next/types, which is a
 * production build failure `bun run check-types` alone does NOT catch, because
 * those generated types do not exist until the build writes them.
 */
export default function TradingApp() {
  const {
    data: session,
    isPending,
    error: sessionError,
    refetch: refetchSession,
  } = useSession();
  const router = useRouter();
  const [hasMounted, setHasMounted] = useState(false);
  const hasSessionError = Boolean(sessionError);

  useEffect(() => {
    setHasMounted(true);
    syncDashboardRedirect(router, isPending, !!session?.user, hasSessionError);
  }, [hasSessionError, isPending, session, router]);

  const retrySession = () => {
    // Keep old or test-only hook fixtures safe while the real Better Auth
    // client always supplies refetch. A missing refetch cannot authorize the
    // terminal or turn a failed read into an anonymous redirect.
    if (typeof refetchSession === "function") return refetchSession();
  };

  if (hasMounted && hasSessionError) {
    return <DashboardAuthUnavailable onRetry={retrySession} />;
  }

  if (
    !shouldRenderDashboard(
      isPending,
      !!session?.user,
      hasMounted,
      hasSessionError,
    )
  ) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <TradingAppContent />
    </Suspense>
  );
}
