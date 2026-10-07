"use client";

import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import {
  PrivyProvider,
  useSubscribeToJwtAuthWithFlag,
} from "@privy-io/react-auth";
import { arbitrum } from "viem/chains";
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Toaster } from "@/components/ui/sonner";
import superjson from "superjson";
import { useSession } from "@/lib/auth-client";
import {
  PRIVY_CUSTOM_AUTH,
  fetchBetterAuthJwt,
  getCachedJwtSub,
  clearBetterAuthJwtCache,
  bindBetterAuthUserId,
} from "@/lib/privy-custom-auth";
import { PrivyJwtAuthStateProvider } from "@/lib/privy-jwt-auth-state";
import { createSessionRecoveringFetch } from "@/lib/session-recovering-fetch";

// Privy powers ONLY the perps wallet layer (embedded master wallet), not the
// platform login, which stays Better Auth. In production custom-auth mode the
// Better Auth session restores the wallet-management session, while the perps
// card explicitly asks whether to create or import the EVM wallet. The legacy
// Privy modal remains available via an explicit rollback flag. When the Privy
// app id is absent (for example in some CI/build contexts), the rest of the
// app renders without the provider.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const PRIVY_CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;

function WithPrivy({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) {
    return <>{children}</>;
  }
  // ZERO-EXTRA-LOGIN mode: production defaults to deriving the Privy session
  // from Better Auth. Requires custom auth in the Privy dashboard (JWKS URL =
  // <web origin>/api/auth/jwks). Set NEXT_PUBLIC_PRIVY_CUSTOM_AUTH=false only
  // to roll back to the login-modal flow below.
  if (PRIVY_CUSTOM_AUTH) {
    return <WithPrivyCustomAuth>{children}</WithPrivyCustomAuth>;
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        // Google first so perps connect is ~one click (no emailed OTP to type),
        // with email kept as a fallback so login still works if Google OAuth is
        // not yet enabled for this app. DEPLOY NOTE: "google" only works once
        // Google OAuth is turned on in the Privy dashboard for this app id; until
        // then users simply use the email option. That is a Privy dashboard config
        // step, not a code change.
        loginMethods: ["google", "email"],
        // Perps funding + the client-signed approveAgent both target Arbitrum One
        // (HL's L1-action EIP-712 domain + the native-USDC bridge live there), so
        // pin the embedded wallet's default and supported chains to Arbitrum. This
        // keeps the wallet on the right chain for deposits and signatures without a
        // per-call chain switch.
        defaultChain: arbitrum,
        supportedChains: [arbitrum],
        embeddedWallets: {
          // Do NOT auto-create on login. After the Privy login the perps
          // settings card lets the user explicitly CREATE a new wallet or IMPORT
          // an existing private key. Auto-creating would race the import path
          // (Privy errors if a wallet already exists) and prevent bring-your-own.
          ethereum: {
            createOnLogin: "off",
          },
          showWalletUIs: false,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

/**
 * PrivyProvider in CUSTOM AUTH mode: Privy trusts a Better Auth JWT
 * (GET /api/auth/token, verified against our JWKS) instead of running its own
 * login. `isLoading` mirrors the Better Auth session hook so Privy waits for
 * the platform session to resolve before deciding "no custom session". No
 * `loginMethods`: the Privy modal is never shown in this mode. Chain pinning
 * and silent wallet UIs are identical to the login-modal config above.
 */
function WithPrivyCustomAuth({ children }: { children: React.ReactNode }) {
  const { data: sessionData, isPending } = useSession();

  const currentUserId = sessionData?.user?.id;

  // Synchronous render-time binding: tells the JWT cache which user the
  // current session belongs to BEFORE any effects or Privy hook callbacks
  // run. This closes the race where Privy's useSubscribeToJwtAuthWithFlag
  // calls getExternalJwt during the same render cycle that triggered the
  // user change, before the useEffect below has had a chance to fire.
  // bindBetterAuthUserId evicts the cache immediately when the bound user
  // differs from the cached token's sub.
  bindBetterAuthUserId(currentUserId);

  // Belt-and-suspenders effect: also evict on the next tick for cross-tab
  // switches where the session resolves asynchronously after mount.
  const prevUserIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = currentUserId;
    if (!currentUserId) return;
    // A cached sub that doesn't match the current session means the cache is
    // from a previous user's session and must be evicted.
    const cachedSub = getCachedJwtSub();
    if (cachedSub && cachedSub !== currentUserId) {
      clearBetterAuthJwtCache();
    }
    // Also evict when the same tab switches users (prev userId ≠ current).
    if (prev && prev !== currentUserId) {
      clearBetterAuthJwtCache();
    }
  }, [currentUserId]);

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID!}
      clientId={PRIVY_CLIENT_ID}
      config={{
        defaultChain: arbitrum,
        supportedChains: [arbitrum],
        embeddedWallets: {
          // Keep eager creation off so a user with an existing wallet can
          // choose import before any new wallet is provisioned.
          ethereum: {
            createOnLogin: "off",
          },
          showWalletUIs: false,
        },
      }}
    >
      <PrivyJwtAuthSync
        isAuthenticated={Boolean(sessionData?.user)}
        isLoading={isPending}
      >
        {children}
      </PrivyJwtAuthSync>
    </PrivyProvider>
  );
}

/**
 * Keep Privy's custom-auth session synchronized with Better Auth for the
 * lifetime of the app. This is the supported JWT-based auth integration and
 * is especially important after a user resets a stale Privy session: the
 * page reload mounts this hook again and re-authenticates from the existing
 * Better Auth cookie without another Google/email prompt.
 */
function PrivyJwtAuthSync({
  isAuthenticated,
  isLoading,
  children,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
  children: React.ReactNode;
}) {
  const { state } = useSubscribeToJwtAuthWithFlag({
    enabled: true,
    isAuthenticated,
    isLoading,
    // Module-level fn (stable identity). Resolves undefined when signed out;
    // never throws.
    getExternalJwt: fetchBetterAuthJwt,
  });
  return (
    <PrivyJwtAuthStateProvider state={state}>
      {children}
    </PrivyJwtAuthStateProvider>
  );
}

// Get API URL - use relative path in browser so Next.js rewrites can proxy
function getApiUrl() {
  if (typeof window !== "undefined") {
    // In browser, use relative path so Next.js rewrites can proxy /trpc/* to API server
    return process.env.NEXT_PUBLIC_API_URL || "/trpc";
  }
  // Server-side: use environment variable or default to localhost:3001
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
}

export function shouldRetryTrpcQuery(failureCount: number, error: unknown): boolean {
  const queryError = error as {
    data?: { code?: string };
    message?: string;
  } | null;
  const code = queryError?.data?.code;
  // The transport already refreshes the Better Auth session and replays a
  // 401 once. More React Query retries would repeat a real signed-out request.
  if (code === "UNAUTHORIZED") return false;
  if (code === "TOO_MANY_REQUESTS") return false;
  if (
    code === "PRECONDITION_FAILED" &&
    queryError?.message === "Alpaca credentials need to be re-entered in Settings."
  ) {
    return false;
  }
  return failureCount < 2;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Don't retry rate-limited requests: React Query's default 3x retry
            // turns a momentary TOO_MANY_REQUESTS trip into a cascade of more
            // requests, which keeps panels stuck on the rate-limit error instead
            // of recovering on the next scheduled refetch.
            retry: shouldRetryTrpcQuery,
          },
        },
      })
  );
  const [sessionRecoveringFetch] = useState(() =>
    createSessionRecoveringFetch({
      fetch: globalThis.fetch.bind(globalThis),
      refreshSession: () =>
        globalThis.fetch("/api/auth/get-session", {
          credentials: "include",
          cache: "no-store",
        }),
    }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: typeof window !== "undefined" ? "/trpc" : `${getApiUrl()}/trpc`,
          transformer: superjson,
          // Do not let one slow venue request hold every initial panel behind
          // the same response. Production saw a candle request keep a 12-query
          // startup batch open for 58 seconds. HTTP/2 still multiplexes these
          // single-operation requests efficiently without head-of-line blocking.
          maxItems: 1,
          // Include cookies for auth
          fetch(url, options) {
            return sessionRecoveringFetch(url, {
              ...options,
              credentials: "include",
            });
          },
        }),
      ],
    })
  );

  return (
    <WithPrivy>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </WithPrivy>
  );
}
