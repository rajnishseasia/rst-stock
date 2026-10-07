"use client";

import { useEffect, useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@trade-bot/api";
import { trpc } from "@/lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ApiCredentialStatusPage = RouterOutputs["userSettings"]["hasApiCredentials"];
export type ApiCredentialStatusAccount = ApiCredentialStatusPage["accounts"][number];
export type ApiCredentialProvider = "alpaca" | "hyperliquid";

type UseCompleteApiCredentialsOptions = {
  enabled?: boolean;
};

type CredentialPageSelection = {
  accounts: ApiCredentialStatusAccount[];
  hasCredentials: boolean;
  isComplete: boolean;
};

export function selectCompleteApiCredentials(
  pages: readonly ApiCredentialStatusPage[] | undefined,
  isSuccess: boolean,
  isError: boolean,
): CredentialPageSelection {
  const lastPage = pages?.at(-1);
  if (
    !pages?.length ||
    !isSuccess ||
    isError ||
    lastPage?.isComplete !== true ||
    lastPage.nextCursor !== null
  ) {
    return { accounts: [], hasCredentials: false, isComplete: false };
  }

  const seen = new Set<string>();
  const accounts: ApiCredentialStatusAccount[] = [];
  for (const page of pages) {
    for (const account of page.accounts) {
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
    }
  }
  return { accounts, hasCredentials: accounts.length > 0, isComplete: true };
}

export function shouldFetchNextCredentialPage(state: {
  enabled: boolean;
  hasNextPage: boolean;
  isFetching: boolean;
  isError: boolean;
}): boolean {
  return state.enabled && state.hasNextPage && !state.isFetching && !state.isError;
}

export function useCompleteApiCredentials(
  provider?: ApiCredentialProvider,
  { enabled = true }: UseCompleteApiCredentialsOptions = {},
) {
  const query = trpc.userSettings.hasApiCredentials.useInfiniteQuery(
    provider ? { provider } : {},
    {
      enabled,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );

  useEffect(() => {
    if (
      shouldFetchNextCredentialPage({
        enabled,
        hasNextPage: query.hasNextPage,
        isFetching: query.isFetching,
        isError: query.isError,
      })
    ) {
      void query.fetchNextPage({ cancelRefetch: false });
    }
  }, [enabled, query.fetchNextPage, query.hasNextPage, query.isError, query.isFetching]);

  const selected = useMemo(
    () => enabled
      ? selectCompleteApiCredentials(query.data?.pages, query.isSuccess, query.isError)
      : { accounts: [], hasCredentials: false, isComplete: false },
    [enabled, query.data, query.isError, query.isSuccess],
  );
  return {
    ...selected,
    isLoading:
      query.isLoading ||
      (!query.isError && !selected.isComplete && (query.isFetching || query.isSuccess)),
    isError: query.isError,
    isSuccess: selected.isComplete,
    error: query.error,
    refetch: query.refetch,
  };
}
