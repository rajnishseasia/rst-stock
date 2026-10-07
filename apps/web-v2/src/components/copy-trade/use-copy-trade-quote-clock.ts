import { useCallback, useEffect, useReducer, useRef } from "react";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { COPY_TRADE_QUOTE_STALE_AFTER_MS } from "./copy-trade-quote-state";

/** Expire cached quotes independently of polling and latch clock anomalies until new data arrives. */
export function useCopyTradeQuoteClock(queryClient: QueryClient, getKeys: () => readonly QueryKey[]) {
  const [, render] = useReducer((version: number) => version + 1, 0);
  const rejected = useRef(new Map<number, { query: object; updates: number }>());

  // Both the scheduler and the action read the cache directly, including changes
  // for which TanStack has not yet delivered a React observer notification.
  const read = useCallback(<TData,>(index: number) => {
    const key = getKeys()[index]!;
    const query = queryClient.getQueryCache().find<TData>({ queryKey: key, exact: true });
    const state = query?.state;
    const previous = rejected.current.get(index);
    if (previous && (previous.query !== query || previous.updates !== state?.dataUpdateCount)) {
      rejected.current.delete(index);
    }
    if (query && Number.isFinite(state!.dataUpdatedAt) && state!.dataUpdatedAt > Date.now()) {
      rejected.current.set(index, { query, updates: state!.dataUpdateCount });
    }
    return { state, clockRejected: rejected.current.has(index) };
  }, [queryClient, getKeys]);

  useEffect(() => {
    let timer: number | undefined;
    const keys = new Set(getKeys().map(key => hashKey(key)));
    /** Recheck after query events, expiry, and browser resume; only one expiry timer is live. */
    const refresh = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      let next = Infinity;
      getKeys().forEach((_key, index) => {
        const { state, clockRejected } = read(index);
        const updatedAt = state?.dataUpdatedAt;
        if (!clockRejected && Number.isFinite(updatedAt) && updatedAt! > 0) {
          const expiresAt = updatedAt! + COPY_TRADE_QUOTE_STALE_AFTER_MS + 1;
          if (expiresAt > now) next = Math.min(next, expiresAt);
        }
      });
      if (Number.isFinite(next)) timer = window.setTimeout(refresh, next - now);
      render();
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if ((event.type === "updated" || event.type === "removed") && keys.has(event.query.queryHash)) refresh();
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [queryClient, getKeys, read]);

  return { read, isClockRejected: (index: number) => rejected.current.has(index) };
}
