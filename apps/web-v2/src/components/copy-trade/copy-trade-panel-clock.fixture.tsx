import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { observable } from "@trpc/server/observable";
import { TRPCClientError } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";
import { CopyTradePanel, SIZING_KEY } from "./copy-trade-panel";

// Browser-only fixture: real client/cache/hooks and panel; the transport never
// leaves this page. A pending response stays unresolved until the test settles it.
const feed = [
  { id: "user:stock", symbol: "AAPL", meta: { assetType: "EQUITY" } },
  { id: "user:perp", symbol: "BTC", meta: { assetType: "PERP", perpVenue: "hyperliquid", perpCoin: "BTC", perpDirection: "long", perpReduceOnly: false, perpLeverage: 2 } },
  { id: "user:option", symbol: "TSLA", meta: { assetType: "OPTION", optionExpiration: "260919", optionStrike: 250, optionType: "CALL", tradeAction: "BuyToOpen" } },
].map(item => ({ ...item, source: "user", side: "buy", displayName: item.id, avatar: null, timestamp: "2026-09-06T12:00:00Z", content: null, url: null, followTarget: null }));
const replies: Record<string, unknown> = {
  "copyTrade.feed": { items: feed, nextCursor: null, failedSources: [] },
  "copyTradeFollows.list": [],
  "copyTrade.mirrorStatus": null,
  "userSettings.hasApiCredentials": { accounts: [], hasCredentials: false, isComplete: true, nextCursor: null },
  "userSettings.getCopyPerpLeverageSettings": { globalPerpMaxLeverage: 2 },
  "positions.account": { buyingPower: "100000", equity: "100000" },
  "quotes.getChartQuotes": [{ symbol: "AAPL", last: "50", change: "1", changePercent: "2" }, { symbol: "TSLA", last: "250", change: "1", changePercent: "1" }],
  "quotes.getOptionQuotes": [{ symbol: "TSLA", expiration: "260919", strike: 250, optionType: "call", bid: "4", ask: "5" }],
  "hyperliquid.marketStats": [{ coin: "BTC", markPx: "60000", prevDayPx: "59000" }],
};
const paths = ["quotes.getChartQuotes", "hyperliquid.marketStats", "quotes.getOptionQuotes"];
const keys = [
  getQueryKey(trpc.quotes.getChartQuotes, { symbols: ["AAPL", "TSLA"] }, "query"),
  getQueryKey(trpc.hyperliquid.marketStats, undefined, "query"),
  getQueryKey(trpc.quotes.getOptionQuotes, { contracts: [{ symbol: "TSLA", expiration: "260919", strike: 250, optionType: "call" }], credentialId: "fixture-account" }, "query"),
];
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
let hold = false;
const pending = new Map<string, { next: (value: any) => void; error: (error: TRPCClientError<any>) => void; complete: () => void }>();
const rpc = trpc.createClient({ links: [() => ({ op }) => observable(observer => {
  if (op.type !== "query") throw new Error("This fixture permits reads only");
  if (!(op.path in replies)) throw new Error(`Unmapped fixture query: ${op.path}`);
  if (hold) {
    pending.set(op.path, observer);
    return () => { if (pending.get(op.path) === observer) pending.delete(op.path); };
  }
  observer.next({ result: { data: replies[op.path] } });
  observer.complete();
})] });
const dispatches: unknown[] = [];
localStorage.setItem(SIZING_KEY, JSON.stringify({ mode: "usd", value: 500 }));
const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={client}>
    <trpc.Provider client={rpc} queryClient={client}>
      <CopyTradePanel isSignedIn embedded activeCredentialId="fixture-account" onCopy={payload => dispatches.push(payload)} onCopyPerp={payload => dispatches.push(payload)} onViewSymbol={() => {}} />
    </trpc.Provider>
  </QueryClientProvider>,
);

/** Locate the mounted panel's native Copy control, including its stale DOM state. */
function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(button => /^(Copy(?: \d+ (?:sh|ct))?|Prefill 2x Long)$/.test(button.textContent ?? ""));
}

/** Settle the real tRPC observable and wait for TanStack's current cache state. */
async function settle(index: number, failure = false) {
  const path = paths[index]!;
  const observer = pending.get(path);
  if (!observer) throw new Error(`No pending response for ${path}`);
  if (failure) observer.error(TRPCClientError.from(new Error("fixture refresh failed")));
  else {
    observer.next({ result: { data: replies[path] } });
    observer.complete();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (client.getQueryState(keys[index]!)?.fetchStatus === "idle") return;
    await Promise.resolve();
  }
  throw new Error("Query response did not settle");
}

const deferredNotifications: Array<() => void> = [];
(window as any).quoteQA = {
  dispatches,
  snapshots: () => keys.map(key => {
    const state = client.getQueryState(key);
    return { updatedAt: state?.dataUpdatedAt, updates: state?.dataUpdateCount, fetchStatus: state?.fetchStatus, status: state?.status };
  }),
  hold: () => {
    hold = true;
    void client.refetchQueries({ type: "active" });
  },
  refresh: (index: number) => { void client.refetchQueries({ queryKey: keys[index]!, exact: true }); },
  settle,
  click: (index: number) => buttons()[index]!.click(),
  buttonState: (index: number) => ({ disabled: buttons()[index]!.disabled, label: buttons()[index]!.textContent }),
  pauseNotifications: () => notifyManager.setScheduler(callback => deferredNotifications.push(callback)),
  flushNotifications: () => {
    notifyManager.setScheduler(callback => setTimeout(callback, 0));
    deferredNotifications.splice(0).forEach(callback => callback());
  },
  setPrice: (index: number) => {
    if (index === 0) replies[paths[index]!] = [{ symbol: "AAPL", last: "100", change: "1", changePercent: "1" }];
    if (index === 2) replies[paths[index]!] = [{ symbol: "TSLA", expiration: "260919", strike: 250, optionType: "call", bid: "1", ask: "1" }];
  },
  future: (index: number, offset: number) => client.setQueryData(keys[index]!, replies[paths[index]!], { updatedAt: Date.now() + offset }),
  unmount: () => { root.unmount(); client.clear(); },
};
