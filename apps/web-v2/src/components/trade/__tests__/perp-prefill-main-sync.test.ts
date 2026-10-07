import { describe, expect, test, mock } from "bun:test";

// Hook doubles are process-local so the canonical suite keeps its real React.
if (!process.env.RST_PREFILL_TEST_CHILD) {
  test("real parent, rail, and perp form prefill regressions", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, RST_PREFILL_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
      timeout: 30000,
    });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  }, 30000);
} else {
  const React = await import("react");
  type Slots = { values: any[]; cursor: number; effects: (() => void)[]; runEffects: boolean };
  const slots = (runEffects = true): Slots => ({ values: [], cursor: 0, effects: [], runEffects });
  let active = slots();
  mock.module("react", () => ({
    ...React,
    useState: (initial: any) => {
      const owner = active;
      const i = owner.cursor++;
      if (!(i in owner.values)) owner.values[i] = typeof initial === "function" ? initial() : initial;
      return [owner.values[i], (next: any) => {
        owner.values[i] = typeof next === "function" ? next(owner.values[i]) : next;
      }];
    },
    useRef: (initial: any) => {
      const i = active.cursor++;
      return active.values[i] ??= { current: initial };
    },
    useMemo: (fn: () => any) => fn(),
    useCallback: (fn: any) => fn,
    useId: () => "prefill-test-id",
    useLayoutEffect: () => {},
    useEffect: (fn: () => void, deps?: any[]) => {
      const i = active.cursor++;
      const old = active.values[i];
      active.values[i] = deps;
      if (active.runEffects && (!old || !deps || deps.some((v, j) => !Object.is(v, old[j])))) active.effects.push(fn);
    },
  }));
  let fields: Record<string, any> = {};
  let resets = 0;
  const reset = (value: any) => { resets++; fields = typeof value === "function" ? value(fields) : { ...value }; };
  const setValue = (key: string, value: any) => { fields[key] = value; };
  const rhf = await import("react-hook-form");
  mock.module("react-hook-form", () => ({ ...rhf, useForm: ({ defaultValues }: any) => {
    if (!Object.keys(fields).length) fields = { ...defaultValues };
    return { control: {}, watch: (key: string) => fields[key], setValue, reset,
      handleSubmit: (fn: any) => () => fn({ ...fields }), formState: { errors: {} } };
  } }));
  const submissions: any[] = [];
  const query = (data: any) => ({ data, isSuccess: true, isLoading: false, isError: false });
  const api: any = new Proxy({}, { get: (_, key) => key === "useUtils" ? () => ({ positions: { listPerps: { invalidate: async () => {} } } }) : new Proxy({}, {
    get: (_, method) => ({ useQuery: () => query(method === "assetSnapshot" ? { markPx: "60000", maxLeverage: 20, szDecimals: 4 }
      : method === "listPerps" ? { positions: [] } : method === "hasApiCredentials" ? { accounts: [] }
      : method === "status" ? { enabled: true, hlEquityUsd: 1000 } : undefined),
    useInfiniteQuery: () => ({ data: { pages: [{ hasCredentials: false, accounts: [], isComplete: true, nextCursor: null }] }, hasNextPage: false, isFetching: false, isLoading: false, isSuccess: true, isError: false, error: null, fetchNextPage: async () => {}, refetch: async () => ({}) }),
    useMutation: () => ({ isPending: false, reset: () => {}, mutateAsync: async (input: any) => { submissions.push(input); return { success: true }; } }) }),
  }) });
  mock.module("@/lib/trpc", () => ({ trpc: api }));
  const auth = await import("@/lib/auth-client");
  mock.module("@/lib/auth-client", () => ({ ...auth, useSession: () => ({ data: { user: { id: "fixture" } } }) }));
  const venue = await import("@/lib/venue-context");
  mock.module("@/lib/venue-context", () => ({ ...venue, useVenue: () => ({ venue: "perps", accountContext: { venue: "perps", agentReady: true, hlBalanceUsd: 1000 } }) }));
  mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));
  const media = await import("@/hooks/use-media-query");
  mock.module("@/hooks/use-media-query", () => ({ ...media, useMediaQuery: () => false }));
  const router = await import("@/lib/use-symbol-venue-router");
  mock.module("@/lib/use-symbol-venue-router", () => ({ ...router, useSymbolVenueRouter: () => ({ ready: true, resolveRoute: () => "stocks" }) }));
  const layout = await import("@/app/app/use-terminal-layout-sync");
  mock.module("@/app/app/use-terminal-layout-sync", () => ({ ...layout, useTerminalLayoutSync: () => ({}) }));
  mock.module("sonner", () => ({ toast: { error: () => {}, success: () => {}, warning: () => {} } }));
  const { flattenElements, elementText } = await import("@/testing/element-tree");
  const { PerpTradeForm } = await import("../perp-trade-form");
  const { VenueAwareTradeRail, VenueAwareChartPanel } = await import("@/app/app/venue-aware-panels");
  const { TradingAppContent } = await import("@/app/app/trading-app-content");
  const { TradingResponsiveShell } = await import("@/components/layout/trading-responsive-shell");
  const { TerminalDrawer } = await import("@/components/terminal/terminal-drawer");
  const { MobilePrimaryActionBar } = await import("@/app/app/mobile-v2/primary-action-bar");
  const { VenueAwareCopyTradePanel } = await import("@/app/app/venue-aware-panels");
  function render(owner: Slots, fn: () => any) {
    active = owner; owner.cursor = 0; owner.effects = [];
    const tree = fn();
    for (const effect of owner.effects) effect();
    return tree;
  }
  const base: any = { activeSymbol: "SPY", activeCoin: "BTC", selectedSignal: null, selectedAccountLabel: "Fixture", tradeIsPrefilled: false, onSymbolCommit: () => {} };
  function formProps(props: any) { return (VenueAwareTradeRail({ ...base, ...props }) as any).props; }
  function dirty() { Object.assign(fields, { isLong: true, sizeCoin: "0.25", leverage: 5, marginMode: "isolated", orderType: "StopLimit", limitPrice: "59000", triggerPx: "58000", postOnly: true, reduceOnly: false }); }
  const copied = (nonce: number, consumed = false) => ({ nonce, consumed, value: { coin: "BTC", side: "long", leverage: 3, copySourceItemId: "user:source" } });
  function toggleExits(tree: any, checked: boolean) {
    const label = flattenElements(tree).find(e => e.type === "label" && elementText(e.props.children as any).includes("Take Profit / Stop Loss"))!;
    const input = flattenElements(label).find(e => e.type === "input")!;
    (input.props.onChange as Function)({ target: { checked } });
  }
  function exitInput(tree: any, label: string) {
    return flattenElements(tree).find(e => e.props["aria-label"] === label)!;
  }
  async function submitTicket(renderForm: () => any) {
    (flattenElements(renderForm()).find(e => e.type === "form")!.props.onSubmit as Function)();
    const confirm = flattenElements(renderForm()).find(e => elementText(e.props.children as any) === "Confirm Submit" && typeof e.props.onClick === "function")!;
    (confirm.props.onClick as Function)();
    await Promise.resolve();
  }

  describe("real perp rail and form effects", () => {
    test("consumed copy allows a new book price without old source or callback", async () => {
      fields = {}; resets = 0; submissions.length = 0;
      const owner = slots(); let event = copied(7);
      const consumed = () => { event = { ...event, consumed: true }; };
      const props = () => formProps({ perpCopyPrefill: event, onPerpCopyPrefillConsumed: consumed });
      render(owner, () => PerpTradeForm(props())); dirty();
      const before = { ...fields }; const resetCount = resets;
      const direct = () => formProps({ perpCopyPrefill: event, onPerpCopyPrefillConsumed: consumed, perpPrefillNonce: 8, activePerpPrefillCoin: "BTC", activePerpLimitPrice: "61234.5" });
      render(owner, () => PerpTradeForm(direct()));
      expect(direct()).toMatchObject({ prefillNonce: 8, prefillConsumed: false });
      expect(direct().onPrefillConsumed).toBeUndefined();
      expect(direct().copySourceItemId).toBeUndefined();
      expect(fields).toEqual({ ...before, orderType: "Limit", limitPrice: "61234.5" });
      expect(resets).toBe(resetCount);
      let tree = render(owner, () => PerpTradeForm(direct()));
      (flattenElements(tree).find(e => e.type === "form")!.props.onSubmit as Function)();
      tree = render(owner, () => PerpTradeForm(direct()));
      const confirm = flattenElements(tree).find(e => elementText(e.props.children as any) === "Confirm Submit" && typeof e.props.onClick === "function")!;
      (confirm.props.onClick as Function)(); await Promise.resolve();
      expect(submissions[0]).toMatchObject({ limitPrice: "61234.5", sizeCoin: "0.25", leverage: 5 });
      expect(submissions[0].copySourceItemId).toBeUndefined();
    }, 15000);

    test("real mobile side handler preserves a ticket while actual Copy fully resets it and supersedes old direct input", async () => {
      fields = {}; resets = 0; submissions.length = 0;
      const parent = slots(false); const form = slots();
      const subscriptions: any = { isPerps: true, marketSymbol: "BTC", activeQuote: {}, perpQuote: {}, mobileSymbolSearch: { suggestions: [] }, availability: {}, pickMarket: () => {} };
      const parentTree = () => render(parent, TradingAppContent);
      const shell = () => flattenElements(parentTree()).find(e => e.type === TradingResponsiveShell)!;
      const mobile = () => (shell().props.renderMobile as Function)(subscriptions);
      let useDesktopRail = false;
      const getRail = () => {
        if (!useDesktopRail) return flattenElements(mobile()).find(e => e.type === VenueAwareTradeRail)!;
        const drawer = flattenElements(shell().props.desktop as any).find(e => e.type === TerminalDrawer && e.props.side === "right")!;
        return (drawer.props.renderPane as Function)("trade", "fixture");
      };
      const applyRail = () => {
        const props = formProps(getRail()?.props ?? {});
        return render(form, () => PerpTradeForm(props));
      };
      render(form, () => PerpTradeForm(formProps({}))); dirty();
      toggleExits(applyRail(), true);
      (exitInput(applyRail(), "Take profit price").props.onChange as Function)({ target: { value: "65000" } });
      (exitInput(applyRail(), "Stop loss price").props.onChange as Function)({ target: { value: "55000" } });
      const before = { ...fields };
      const action = flattenElements(mobile()).map(e => e.props.actionBar as any).find(e => e?.type === MobilePrimaryActionBar);
      action.props.onTrade("short");
      applyRail();
      expect(fields).toEqual({ ...before, isLong: false }); expect(resets).toBe(0);
      expect(exitInput(applyRail(), "Take profit price").props.value).toBe("65000");
      expect(exitInput(applyRail(), "Stop loss price").props.value).toBe("55000");
      expect(getRail().props.perpCopyPrefill).toBeNull();
      expect(formProps(getRail().props).onPrefillConsumed).toBeUndefined();
      expect(formProps(getRail().props).copySourceItemId).toBeUndefined();
      // Reach the actual desktop book and copy callbacks from the parent's JSX.
      const desktop = () => shell().props.desktop as any;
      useDesktopRail = true;
      (flattenElements(desktop()).find(e => e.type === VenueAwareChartPanel)!.props.onBookPriceSelect as Function)("61234.5");
      applyRail();
      const drawer = flattenElements(desktop()).find(e => e.type === TerminalDrawer && e.props.side === "left")!;
      const copyPanel = (drawer.props.renderPane as Function)("copy_trade", "fixture");
      expect(copyPanel.type).toBe(VenueAwareCopyTradePanel);
      copyPanel.props.onCopyPerp({ itemId: "user:new-source", coin: "BTC", side: "long", leverage: 3 });
      applyRail();
      expect(fields).toMatchObject({ isLong: true, leverage: 3, sizeCoin: "", orderType: "Market", limitPrice: "", triggerPx: "", postOnly: false, reduceOnly: false });
      expect(exitInput(applyRail(), "Take profit price")).toBeUndefined();
      toggleExits(applyRail(), true);
      expect(exitInput(applyRail(), "Take profit price").props.value).toBe("");
      expect(exitInput(applyRail(), "Stop loss price").props.value).toBe("");
      toggleExits(applyRail(), false);
      expect(getRail().props.perpCopyPrefill).toMatchObject({ consumed: true });
      expect(getRail().props.perpPrefillNonce).toBe(0);
      fields.sizeCoin = "0.1";
      const copiedFields = { ...fields };
      applyRail();
      expect(fields).toEqual(copiedFields);
      expect(formProps(getRail().props).copySourceItemId).toBe("user:new-source");
      await submitTicket(applyRail);
      expect(submissions.at(-1)).toMatchObject({ copySourceItemId: "user:new-source", isLong: true, sizeCoin: "0.1" });
      fields.isLong = false;
      await submitTicket(applyRail);
      expect(submissions.at(-1).copySourceItemId).toBeUndefined();
      // The consumed real Copy must also give way to the actual book handler.
      dirty();
      const beforeBook = { ...fields };
      const beforeBookResets = resets;
      (flattenElements(desktop()).find(e => e.type === VenueAwareChartPanel)!.props.onBookPriceSelect as Function)("62345.6");
      applyRail();
      expect(fields).toEqual({ ...beforeBook, orderType: "Limit", limitPrice: "62345.6" });
      expect(resets).toBe(beforeBookResets);
      expect(formProps(getRail().props)).toMatchObject({ prefillConsumed: false, initialLimitPrice: "62345.6" });
      expect(formProps(getRail().props).onPrefillConsumed).toBeUndefined();
      expect(formProps(getRail().props).copySourceItemId).toBeUndefined();
      await submitTicket(applyRail);
      expect(submissions.at(-1).copySourceItemId).toBeUndefined();
    }, 15000);
  });
}
