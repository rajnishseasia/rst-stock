import { mock, test, expect } from "bun:test";
import assert from "node:assert/strict";

if (!process.env.RST_TICKET_LIFECYCLE_CHILD) {
  test("real parent, rail, and ticket lifecycle regressions", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, RST_TICKET_LIFECYCLE_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    console.log(output);
    expect(result.exitCode, output).toBe(0);
  }, 30_000);
} else {
// Persist hook slots across explicit renders, execute dependency-driven effects,
// and invoke the actual returned handlers. No lifecycle logic is doubled here.
const React = await import("react");
class Hooks {
  slots: any[] = [];
  cursor = 0;
  effects: Array<() => void> = [];
  flushEffects() {
    const effects = this.effects.splice(0);
    for (const effect of effects) effect();
  }
}
let current = new Hooks();
function render(host: Hooks, fn: () => any) {
  current = host;
  host.cursor = 0;
  host.effects = [];
  return fn();
}
function state(initial: any) {
  const host = current;
  const index = host.cursor++;
  if (!(index in host.slots)) host.slots[index] = typeof initial === "function" ? initial() : initial;
  return [host.slots[index], (value: any) => {
    host.slots[index] = typeof value === "function" ? value(host.slots[index]) : value;
  }];
}
function effect(fn: () => void, deps?: any[]) {
  const host = current;
  const index = host.cursor++;
  const old = host.slots[index];
  if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old[i]))) {
    host.slots[index] = deps;
    host.effects.push(fn);
  }
}
mock.module("react", () => ({
  ...React, useState: state, useRef: (value: any) => state(() => ({ current: value }))[0],
  useEffect: effect, useLayoutEffect: () => {}, useMemo: (fn: any) => fn(),
  useCallback: (fn: any) => fn, useId: () => "ticket-test",
}));
let values: any;
const forms = new WeakMap<Hooks, any>();
const fieldArray = { fields: [], append() {}, remove() {}, replace() {} };
const realForm = await import("react-hook-form");
mock.module("react-hook-form", () => ({
  ...realForm,
  useForm: () => {
    if (!forms.has(current)) forms.set(current, {
      control: {}, watch: (key?: string) => key ? values[key] : values,
      getValues: (key?: string) => key ? values[key] : values,
      setValue: (key: string, value: any) => { values[key] = value; },
      reset: (next: any) => { values = typeof next === "function" ? next(values) : { ...next }; },
      formState: { errors: {}, isSubmitting: false },
      handleSubmit: (fn: any) => () => fn(structuredClone(values)),
      register: () => ({}),
      trigger: async () => true,
    });
    return forms.get(current);
  },
  useFieldArray: () => fieldArray,
  Controller: () => null,
}));
const auth = await import("@/lib/auth-client");
mock.module("@/lib/auth-client", () => ({ ...auth, useSession: () => ({ data: { user: { id: "ticket-user" } } }) }));
mock.module("sonner", () => ({ toast: { success() {}, error() {}, warning() {} } }));
mock.module("@/components/perps/perps-onboarding-card", () => ({ PerpsOnboardingCard: () => null }));
let venue = "stocks";
const venueModule = await import("@/lib/venue-context");
mock.module("@/lib/venue-context", () => ({ ...venueModule,
  VenueProvider: () => null,
  useVenue: () => ({ venue, accountContext: { venue, agentReady: true } }),
}));
mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));
mock.module("@/hooks/use-media-query", () => ({ DESKTOP_TERMINAL_MEDIA_QUERY: "desktop", useMediaQuery: () => true }));
mock.module("@/lib/use-symbol-venue-router", () => ({ useSymbolVenueRouter: () => ({ ready: true, resolveRoute: () => ({ target: "stocks" }) }) }));
mock.module("@/components/ui/use-modal-focus", () => ({ useModalFocus: () => ({ current: null }) }));
const layoutSync = await import("@/app/app/use-terminal-layout-sync");
mock.module("@/app/app/use-terminal-layout-sync", () => ({ ...layoutSync, useTerminalLayoutSync: () => ({}) }));
const defaultAccounts = [{ id: "paper-id", accountId: "broker-paper", accountType: "PAPER" }, { id: "live-id", accountId: "broker-live", accountType: "LIVE" }];
let accounts: Array<{ id: string; accountId: string | null; accountType: string | null }> = defaultAccounts;
let responses: any[] = [];
let requests: any[] = [];
const query = (data: any) => ({ data, isSuccess: true, isLoading: false, isFetching: false, refetch: async () => ({ data }) });
const invalidate = async () => {};
function mutation(name: string, callbacks: any = {}) {
  const send = async (payload: any) => {
    requests.push({ name, ...payload });
    try {
      const result = await (responses.shift() ?? { success: true, message: "ok" });
      if (result instanceof Error) throw result;
      callbacks.onSuccess?.(result, payload);
      return result;
    } catch (error) {
      callbacks.onError?.(error, payload, {});
      throw error;
    }
  };
  return { isPending: false, reset() {}, mutateAsync: send, mutate: (p: any) => { void send(p).catch(() => {}); } };
}
mock.module("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ orders: { list: { invalidate, cancel: invalidate, getData() {}, setData() {} }, listAlpacaOrders: { invalidate } }, positions: { list: { invalidate }, listPerps: { invalidate } } }),
  userSettings: { hasApiCredentials: {
    useQuery: () => query({ hasCredentials: true, accounts }),
    useInfiniteQuery: () => ({ data: { pages: [{ hasCredentials: accounts.length > 0, accounts, isComplete: true, nextCursor: null }] }, hasNextPage: false, isFetching: false, isLoading: false, isSuccess: true, isError: false, error: null, fetchNextPage: async () => {}, refetch: async () => ({}) }),
  } },
  hyperliquid: { status: { useQuery: () => query({ enabled: true }) }, assetSnapshot: { useQuery: () => query({ markPx: "50000", szDecimals: 4, maxLeverage: 20 }) } },
  quotes: { getStockQuote: { useQuery: () => query({ last: "150", bid: "149", ask: "151" }) }, getOptionQuote: { useQuery: () => query({ last: "5", bid: "4.9", ask: "5.1", volume: 10, openInterest: 20 }) }, listOptionContracts: { useQuery: () => query([{ expiration: "2027-01-15", type: "call", strike: 150 }]) } },
  positions: { account: { useQuery: () => query({ portfolioValue: 10000, nonMarginableBuyingPower: 5000 }) }, list: { useQuery: () => query([]) }, listPerps: { useQuery: () => query({ positions: [] }) } },
  orders: Object.fromEntries(["submit", "submitBracket", "submitWithExitPlan", "submitPerp"].map(name => [name, { useMutation: (c: any) => mutation(name, c) }])),
} }));
const { TradingAppContent } = await import("@/app/app/trading-app-content");
const { VenueAwareTradeRail } = await import("@/app/app/venue-aware-panels");
const { TradeForm } = await import("../trade-form");
const { PerpTradeForm } = await import("../perp-trade-form");
const { formatPerpUsd } = await import("@/components/perps/perp-format");
const { stockSignalSelection } = await import("@/components/feed/signal-selection");
// Browser persistence and viewport APIs only; no DOM or browser behavior claimed.
const browser = {
  innerWidth: 1440, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {}, removeEventListener() {},
  location: { search: "", pathname: "/app", hash: "" },
  history: { state: {}, pushState() {}, replaceState() {} },
};
Object.assign(globalThis, { window: browser, localStorage: browser.localStorage,
  document: { body: { style: {} }, documentElement: { style: {} }, addEventListener() {}, removeEventListener() {} },
});
function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
let parent: Hooks;
let child: Hooks;
let mobileTicket = false;
function app() {
  const tree = nodes(render(parent, () => TradingAppContent()));
  parent.flushEffects();
  return tree;
}
function drawer(side: string) {
  const shell = app().find(n => n.props?.renderMobile);
  return nodes(shell.props.desktop).find(n => n.props?.side === side && n.props?.renderPane).props;
}
function mobile() {
  const shell = app().find(n => n.props?.renderMobile);
  return nodes(shell.props.renderMobile({ isPerps: venue === "perps", marketSymbol: venue === "perps" ? "BTC" : "AAPL", activeQuote: {}, perpQuote: {}, mobileSymbolSearch: { suggestions: [] }, availability: {}, pickMarket() {} }));
}
function rail() {
  return mobileTicket
    ? mobile().find(n => n.type === VenueAwareTradeRail)?.props
    : drawer("right").renderPane("trade").props;
}
function copy(entry = "panel", source = "source-a") {
  const left = drawer("left");
  if (entry === "perp") {
    left.renderPane("copy_trade", "left").props.onCopyPerp({ itemId: `user:${source}`, coin: "BTC", side: "long", leverage: 2 });
  } else if (entry === "x") {
    left.renderPane("x_signals", "left").props.onSelectSignal(stockSignalSelection({ symbol: "AAPL", signalId: source, content: "buy AAPL" }));
  } else {
    left.renderPane("copy_trade", "left").props.onCopy({ symbol: "AAPL", side: "buy", qty: 1, copySourceItemId: `user:${source}` });
  }
}
function ticket() {
  const element = nodes(VenueAwareTradeRail(rail())).find(n => n.type === (venue === "perps" ? PerpTradeForm : TradeForm));
  assert.ok(element, "rail must render real form");
  const tree = nodes(render(child, () => element.type(element.props)));
  child.flushEffects();
  return tree;
}
const stockOrder = () => ({ symbol: "AAPL", assetType: "EQUITY", action: "Buy", direction: "long", orderType: "Market", entryOrderType: "Market", timeInForce: "gtc", quantity: "1", maxRisk: "100", stopMarketPrice: "", priceTrigger: "", limitPrice: "", takeProfits: [], trailingEnabled: false });
const perpOrder = () => ({ isLong: true, marginMode: "cross", orderType: "Market", sizeCoin: "0.01", limitPrice: "", triggerPx: "", reduceOnly: false, postOnly: false, leverage: 2 });
function setup(entry: string, phone = false) {
  parent = new Hooks(); child = new Hooks(); requests = []; responses = [];
  accounts = defaultAccounts;
  mobileTicket = phone;
  browser.innerWidth = phone ? 375 : 1440;
  venue = entry === "perp" ? "perps" : "stocks";
  values = venue === "perps" ? perpOrder() : stockOrder();
  copy(entry);
  ticket();
  values = venue === "perps" ? perpOrder() : stockOrder();
}
function review(payload?: any) {
  const form = ticket().find(n => n.type === "form");
  // Mutation-route cases supply the validated form payload at the submit edge.
  // This also covers the retained legacy option bracket handler, although the
  // current interactive option selector normalizes OCO back to Market.
  if (payload) values = structuredClone(payload);
  form.props.onSubmit();
}
function dialog() { return ticket().find(n => venue === "perps" ? n.props?.open === true && n.props?.onOpenChange : typeof n.props?.onConfirm === "function"); }
function confirm() {
  if (venue === "perps") ticket().find(n => n.props?.children === "Confirm Submit").props.onClick();
  else { const d = dialog(); d.props.onConfirm(d.props.order); }
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function check(name: string, fn: () => any) { test(name, fn); }
for (const failure of [new Error("transport"), { success: false, message: "refused" }]) {
  for (const phone of [false, true]) for (const end of ["retry", "cancel"]) await check(`perp ${phone ? "mobile" : "desktop"} ${failure instanceof Error ? "transport" : "refusal"} then ${end}`, async () => {
    setup("perp", phone); responses = [failure]; review(); confirm(); await flush();
    assert.ok(rail().perpCopyPrefill);
    if (end === "retry") { confirm(); await flush(); assert.equal(requests[1].copySourceItemId, "user:source-a"); }
    else dialog().props.onOpenChange(false);
    assert.equal(rail().perpCopyPrefill, null);
  });
}
for (const entry of ["panel", "x"]) await check(`${entry} stock success clears parent and next ordinary order`, async () => {
  setup(entry); review(); confirm(); await flush();
  assert.equal(requests[0].copySourceItemId, entry === "x" ? "x_signal:source-a" : "user:source-a");
  assert.equal(rail().manualCopyPrefill, null);
  assert.equal(rail().selectedSignal, null);
  values = stockOrder(); review(); confirm(); await flush();
  assert.equal(requests[1].copySourceItemId, undefined);
  assert.equal(requests[1].signalId, undefined);
});
function deferred() {
  let resolve!: (result: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}
for (const end of ["retry", "cancel"]) test(`perp local precision refusal retains ownership for ${end}`, async () => {
  setup("perp"); values = { ...perpOrder(), sizeCoin: "0.000001" };
  review(); confirm(); await flush();
  assert.equal(requests.length, 0);
  const nonce = rail().perpCopyPrefill?.nonce;
  assert.ok(nonce);
  if (end === "cancel") dialog().props.onOpenChange(false);
  else {
    values = perpOrder(); review(); confirm(); await flush();
    assert.equal(requests[0].copySourceItemId, "user:source-a");
  }
  assert.equal(rail().perpCopyPrefill, null);
});
function orderFor(route: string) {
  const order: any = stockOrder();
  if (route === "smart") Object.assign(order, { orderType: "OCO", stopMarketPrice: "140" });
  if (route === "bracket") Object.assign(order, { assetType: "OPTION", action: "BuyToOpen", orderType: "OCO", stopMarketPrice: "4", optionsDateYear: "27", optionsDateMonth: "01", optionsDateDay: "15", optionsStrike: "150", optionType: "call", takeProfits: [{ price: "6", quantity: "1" }] });
  return order;
}
for (const entry of ["panel", "x"]) {
  for (const route of ["ordinary", "smart", "bracket"]) {
    for (const outcome of ["success", "transport", "refusal"]) test(`${entry} ${route} ${outcome} mutation settles only on success`, async () => {
      setup(entry); values = orderFor(route);
      // Let quote-derived sizing settle before taking the reviewed snapshot.
      if (route === "smart") { ticket(); ticket(); }
      if (outcome !== "success") responses = [outcome === "transport" ? new Error("transport") : { success: false, message: "refused" }];
      review(route === "bracket" ? orderFor(route) : undefined); confirm(); await flush();
      assert.equal(requests[0].name, route === "ordinary" ? "submit" : route === "smart" ? "submitWithExitPlan" : "submitBracket");
      // Option orders intentionally do not carry manual-copy provenance.
      assert.equal(requests[0].copySourceItemId, route === "bracket" ? undefined : entry === "x" ? "x_signal:source-a" : "user:source-a");
      if (outcome !== "success") {
        assert.ok(rail().manualCopyPrefill, "failed mutation must retain the event");
        review(route === "bracket" ? orderFor(route) : undefined); confirm(); await flush();
        assert.equal(requests.length, 2);
        assert.equal(requests[1].idempotencyKey, requests[0].idempotencyKey);
      }
      assert.equal(rail().manualCopyPrefill, null);
      assert.equal(rail().selectedSignal, null);
    });
  }
  test(`${entry} review cancellation leaves an ordinary same-symbol ticket`, async () => {
    setup(entry); review(); dialog().props.onOpenChange(false);
    assert.equal(rail().manualCopyPrefill, null); assert.equal(rail().selectedSignal, null);
    values = stockOrder(); review(); confirm(); await flush();
    assert.equal(requests[0].copySourceItemId, undefined); assert.equal(requests[0].signalId, undefined);
  });
  test(`${entry} account change cancels ownership and resets mounted review`, () => {
    setup(entry); review();
    app().find(n => n.props?.onAccountModeChange).props.onAccountModeChange("LIVE");
    app();
    assert.equal(rail().manualCopyPrefill, null); assert.equal(rail().selectedSignal, null);
    ticket();
    assert.equal(dialog().props.order, null);
    assert.equal(rail().selectedCredentialId, "live-id");
  });
  test(`${entry} explicit market reset removes source and signal linkage`, () => {
    setup(entry); rail().onSymbolCommit("MSFT");
    assert.equal(rail().manualCopyPrefill, null); assert.equal(rail().selectedSignal, null);
  });
}
for (const entry of ["panel", "x", "perp"]) {
  test(`${entry} old success preserves a newer unreviewed ticket's edited fields`, async () => {
    setup(entry); const pending = deferred(); responses = [pending.promise];
    review(); confirm(); await flush();
    copy(entry, "source-b"); ticket();
    values = entry === "perp" ? { ...perpOrder(), sizeCoin: "0.02" } : { ...stockOrder(), quantity: "7", limitPrice: "149", orderType: "Limit" };
    ticket();
    const edited = structuredClone(values);
    pending.resolve({ success: true, message: "old accepted" }); await flush();
    assert.deepEqual(values, edited);
    assert.ok(rail().manualCopyPrefill ?? rail().perpCopyPrefill);
  });
  for (const source of ["source-a", "source-b"]) test(`${entry} pending response cannot settle newer ${source} copy or review`, async () => {
    setup(entry); const pending = deferred(); responses = [pending.promise];
    review(); confirm(); await flush();
    assert.equal(requests.length, 1);
    const oldNonce = (rail().manualCopyPrefill ?? rail().perpCopyPrefill)?.nonce;
    copy(entry, source); ticket(); values = entry === "perp" ? perpOrder() : stockOrder(); review();
    const newer = rail().manualCopyPrefill ?? rail().perpCopyPrefill;
    assert.ok(newer && newer.nonce !== oldNonce);
    pending.resolve({ success: true, message: "old accepted" }); await flush();
    assert.equal((rail().manualCopyPrefill ?? rail().perpCopyPrefill)?.nonce, newer.nonce);
    assert.ok(venue === "perps" ? dialog()?.props.open : dialog()?.props.order, "old response must not close the new review");
    confirm(); await flush();
    assert.equal(requests[1].copySourceItemId, entry === "x" ? `x_signal:${source}` : `user:${source}`);
    assert.equal(rail().manualCopyPrefill, null); assert.equal(rail().perpCopyPrefill, null);
  });
  test(`${entry} mobile dismissal and ordinary reopen clear provenance`, async () => {
    setup(entry, true); review();
    mobile().find(n => n.props?.marketHeader && n.props?.onClose).props.onClose();
    mobileTicket = false;
    assert.equal(rail().manualCopyPrefill, null); assert.equal(rail().perpCopyPrefill, null);
    assert.equal(rail().selectedSignal, null);
    // Reopen through the parent's current Trade action, not another Copy.
    mobile().find(n => n.props?.navigation).props.navigation.props.onChange("chart");
    const trade = mobile().find(n => n.props?.actionBar)?.props.actionBar;
    assert.ok(trade, "Trade destination exposes the side action"); trade.props.onTrade("long");
    mobileTicket = true; child = new Hooks(); values = entry === "perp" ? perpOrder() : stockOrder();
    ticket(); values = entry === "perp" ? perpOrder() : stockOrder(); review(); confirm(); await flush();
    assert.equal(requests[0].copySourceItemId, undefined);
  });
}
test("terminal selects the new identified LIVE row without retargeting the legacy row", async () => {
  setup("panel");
  const legacy = { id: "legacy-live", accountId: null, accountType: "LIVE" };
  accounts = [legacy, defaultAccounts[1], defaultAccounts[0]];
  app().find(n => n.props?.onAccountModeChange).props.onAccountModeChange("LIVE");
  app();
  assert.equal(rail().selectedCredentialId, "live-id");
  ticket();
  copy("panel"); ticket(); review(stockOrder());
  assert.equal(dialog().props.order?.orderType, "Market");
  confirm(); await flush();
  assert.equal(requests.at(-1).credentialId, "live-id");
  assert.deepEqual(legacy, { id: "legacy-live", accountId: null, accountType: "LIVE" });
});
test("terminal excludes unidentified and unknown-type accounts from fresh orders", () => {
  setup("panel");
  accounts = [
    { id: "legacy-live", accountId: null, accountType: "LIVE" },
    { id: "legacy-paper", accountId: " ", accountType: "PAPER" },
    { id: "unknown", accountId: "known-id", accountType: null },
  ];
  app();
  assert.equal(rail().selectedCredentialId, undefined);
  values = stockOrder(); review();
  assert.equal(dialog().props.order, null);
  assert.equal(requests.length, 0);
});
test("X Copy acquires lifecycle ownership without inventing a sized order", () => {
  setup("panel");
  values = { ...stockOrder(), quantity: "9", orderType: "Limit", limitPrice: "149" };
  copy("x"); ticket();
  assert.equal(values.quantity, "9");
  assert.equal(values.orderType, "Limit");
  assert.equal(values.limitPrice, "149");
  assert.equal(rail().manualCopyPrefill?.value.copySourceItemId, "x_signal:source-a");
});

// Inline TP/SL is kept in ticket state rather than on the reviewed order, which
// is how it went missing from the perp confirmation while the stocks review
// showed it. The dialog must name both legs it is about to submit.
test("perp review shows the inline take-profit and stop-loss it will submit", () => {
  setup("perp");
  // Selected by its own label: the Execution flags above it are checkboxes too.
  const tpSlLabel = ticket().find(
    n => n.type === "label" &&
      [n.props?.children].flat().includes("Take Profit / Stop Loss"),
  );
  assert.ok(tpSlLabel, "ticket must expose the TP/SL toggle");
  const toggle = nodes(tpSlLabel).find(
    n => n.type === "input" && n.props?.type === "checkbox",
  );
  assert.ok(toggle, "TP/SL toggle must be a checkbox");
  toggle.props.onChange({ target: { checked: true } });
  const priced = ticket();
  const field = (label: string) =>
    priced.find(n => n.props?.["aria-label"] === label);
  assert.ok(field("Take profit price") && field("Stop loss price"));
  field("Take profit price").props.onChange({ target: { value: "55000" } });
  field("Stop loss price").props.onChange({ target: { value: "45000" } });
  review();
  const rows = ticket();
  const rowValue = (label: string) =>
    rows.find(n => n.props?.label === label)?.props?.value;
  assert.equal(rowValue("Take profit"), formatPerpUsd(55000));
  assert.equal(rowValue("Stop loss"), formatPerpUsd(45000));
});
}
