import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PositionsPanelHeader } from "./positions-panel-header";

const SAMPLE_POSITION = {
  coin: "BTC",
  side: "long" as const,
  size: "0.25",
  entryPx: "60000",
  markPx: "61000",
  liquidationPx: "42000",
  unrealizedPnl: "250",
  returnOnEquity: "0.04",
  leverage: 5,
  marginMode: "cross" as const,
  marginUsed: "3000",
  funding: "-1.2",
  realizedPnl: 500,
};

const SAMPLE_TPSL = {
  coin: "BTC",
  side: "sell" as const,
  oid: 1,
  cloid: null,
  sz: "0.25",
  limitPx: "0",
  isTrigger: true,
  triggerPx: "58000",
  tpsl: "sl" as const,
  reduceOnly: true,
  isPositionTpsl: true,
  orderType: "Stop Market",
  timestamp: 1,
};

const queryResult = {
  data: { positions: [SAMPLE_POSITION] },
  isLoading: false,
  isSuccess: true,
  error: null as { message: string } | null,
};

const POPULATED_OPEN_ORDERS = [
  SAMPLE_TPSL,
  { ...SAMPLE_TPSL, oid: 2, triggerPx: "57000" },
  { ...SAMPLE_TPSL, oid: 3, triggerPx: "63000", tpsl: "tp" as const },
  { ...SAMPLE_TPSL, oid: 4, triggerPx: "64000", tpsl: "tp" as const },
];

type OpenOrdersQueryResult = {
  data?: { orders: typeof POPULATED_OPEN_ORDERS };
  isLoading: boolean;
  isFetching: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
  isSuccess: boolean;
  error: { message: string } | null;
};

const OPEN_ORDERS_STALE_TIME_MS = 15_000;

function successfulOpenOrders(
  orders: typeof POPULATED_OPEN_ORDERS = POPULATED_OPEN_ORDERS,
): OpenOrdersQueryResult {
  return {
    data: { orders },
    isLoading: false,
    isFetching: false,
    fetchStatus: "idle",
    dataUpdatedAt: Date.now(),
    isSuccess: true,
    error: null,
  };
}

let openOrdersResult: OpenOrdersQueryResult = successfulOpenOrders();
let openOrdersQueryEnabled: boolean | undefined;

/**
 * A scale-in and a partial close, so the replayed run ends on the 0.25 the
 * sample position still holds and the row can show a real RPNL.
 */
const fillsResult = {
  data: {
    fills: [
      {
        time: 1,
        coin: "BTC",
        side: "buy" as const,
        px: "60000",
        sz: "0.5",
        closedPnl: "0",
        fee: "1",
        dir: "Open Long",
        oid: 1,
        orderType: null,
      },
      {
        time: 2,
        coin: "BTC",
        side: "sell" as const,
        px: "62000",
        sz: "0.25",
        closedPnl: "500",
        fee: "1",
        dir: "Close Long",
        oid: 2,
        orderType: null,
      },
    ],
  },
  isLoading: false,
  error: null as { message: string } | null,
};

const noopMutation = {
  mutate: () => {},
  isPending: false,
  isSuccess: false,
  error: null as { message: string } | null,
  variables: undefined as unknown,
};

const MASTER_WALLET_ADDRESS = "0x0000000000000000000000000000000000000abc";

beforeEach(() => {
  openOrdersQueryEnabled = undefined;
  openOrdersResult = successfulOpenOrders();
});

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {}, warning: () => {} },
}));

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      positions: {
        listPerps: { invalidate: async () => {} },
        listPerpOpenOrders: { invalidate: async () => {} },
      },
    }),
    positions: {
      listPerps: { useQuery: () => queryResult },
      listPerpOpenOrders: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => {
          openOrdersQueryEnabled = options.enabled;
          return openOrdersResult;
        },
      },
      listPerpFills: { useQuery: () => fillsResult },
    },
    orders: {
      getByClientOrderId: { useQuery: () => ({ data: undefined, isLoading: false }) },
      cancelPerp: { useMutation: () => noopMutation },
      submitPerp: { useMutation: () => noopMutation },
      setPerpTpSl: { useMutation: () => noopMutation },
      modifyPerpTpSl: { useMutation: () => noopMutation },
    },
    pnlImage: {
      generateOpenPerp: { useMutation: () => noopMutation },
    },
  },
}));

// page-layout.test.ts imports this component as an identity sentinel before
// this file runs. A query-qualified import gives this behavioral test a fresh
// module instance, so its tRPC mock cannot be bypassed by that cached module.
const mobilePanelModule = (await import(
  "./perp-positions-panel?mobile-touch-target-test" as string,
)) as typeof import("./perp-positions-panel");
const { PerpPositionsPanel } = mobilePanelModule;

function renderPanel(walletAddress: string | null = MASTER_WALLET_ADDRESS) {
  return renderToStaticMarkup(
    <PerpPositionsPanel walletAddress={walletAddress} enabled onViewChart={() => {}} />,
  );
}

const mountedPanelChild = process.env.RST_PERP_PANEL_MOUNTED_CHILD === "1";
const isolateMountedPanel = Boolean(
  process.env.RST_PLAYWRIGHT_MODULE && !mountedPanelChild,
);
const mountedPanelTest = mountedPanelChild ? test : test.skip;
const MOUNTED_PANEL_ORIGIN = "http://rst-perp-panel.test";
const MOUNTED_PANEL_START_TIME = Date.UTC(2026, 8, 12, 12);

if (isolateMountedPanel) {
  test(
    "mounted Set, Edit, and Cancel handlers run in an isolated process",
    () => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "test",
          "--timeout",
          "60000",
          "--test-name-pattern",
          "mounted Set, Edit, and Cancel handlers block stale snapshots and dispatch when fresh",
          import.meta.path,
        ],
        env: { ...process.env, RST_PERP_PANEL_MOUNTED_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      const evidence = result.stdout.toString() + result.stderr.toString();
      console.info(evidence);
      expect(result.exitCode, evidence).toBe(0);
    },
    65_000,
  );
}

const mountedPanelMockAliases: Record<string, string> = {
  "@/components/ui/button": "button",
  "@/components/ui/card": "card",
  "@/components/ui/input": "input",
  "@/components/trade/close-position-alert-dialog": "null-components",
  "@/components/trade/share-pnl-modal": "null-components",
  "@/components/ui/toggle-group": "toggle-group",
  "@/components/trade/positions-panel-header": "positions-header",
  "@/components/perps/perp-closed-panel": "null-components",
  "@/components/ui/empty-state": "empty-state",
  "@/lib/trpc": "trpc",
  "@/lib/utils": "utils",
  "@/components/feed/ticker-chart-action": "ticker",
  "@/lib/format": "format",
  "@/lib/perps-wallet-selection": "wallet",
  "@/components/perps/perp-format": "perp-format",
};

const mountedPanelMockModules: Record<string, string> = {
  button:
    "import { createElement } from 'react'; export function Button({ children, variant, size, ...props }) { return createElement('button', props, children); }",
  card:
    "import { createElement } from 'react'; export function Card({ children, ...props }) { return createElement('div', props, children); } export function CardContent({ children, ...props }) { return createElement('div', props, children); }",
  input:
    "import { createElement } from 'react'; export function Input(props) { return createElement('input', props); }",
  "null-components":
    "export function ClosePositionAlertDialog() { return null; } export function SharePnlModal() { return null; } export function PerpClosedPanel() { return null; }",
  "toggle-group":
    "import { createContext, createElement, useContext } from 'react'; const ToggleContext = createContext(() => {}); export function ToggleGroup({ children, onValueChange, ...props }) { return createElement(ToggleContext.Provider, { value: onValueChange }, createElement('div', props, children)); } export function ToggleGroupItem({ children, value, ...props }) { const onValueChange = useContext(ToggleContext); return createElement('button', { ...props, type: 'button', onClick: () => onValueChange(value) }, children); }",
  "positions-header":
    "import { createElement } from 'react'; export function parsePositionsSort() { return 'date'; } export function PositionsPanelHeader() { return createElement('div'); }",
  "empty-state":
    "import { createElement } from 'react'; export function EmptyState({ children, ...props }) { return createElement('div', props, children); }",
  utils: "export function cn(...parts) { return parts.filter(Boolean).join(' '); }",
  ticker: "export function perpDisplayCoin(coin) { return coin; }",
  format:
    "export function formatUsd(value) { return '$' + Number(value ?? 0).toFixed(2); }",
  wallet:
    "export function isValidPerpsMasterAddress(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }",
  "perp-format":
    "export function formatPerpPx(value) { return String(value ?? 'N/A'); } export function formatPerpExitPx(value) { return String(value ?? 'N/A'); } export function formatPerpNotionalUsd(size, price) { return '$' + (Number(size) * Number(price)).toFixed(2); } export function formatPerpRoePct() { return '8%'; } export function formatPerpUsd(value) { return '$' + Number(value ?? 0).toFixed(2); }",
  trpc: [
    "const SAMPLE_POSITION = " + JSON.stringify(SAMPLE_POSITION) + ";",
    "const POPULATED_OPEN_ORDERS = " + JSON.stringify(POPULATED_OPEN_ORDERS) + ";",
    "window.__rstMutationCalls = [];",
    "const initialOrders = new URL(window.location.href).searchParams.get('orders') === 'empty' ? [] : POPULATED_OPEN_ORDERS;",
    "window.__rstOpenOrdersState = { data: { orders: initialOrders }, isLoading: false, isFetching: false, fetchStatus: 'idle', dataUpdatedAt: Date.now(), isSuccess: true, error: null };",
    "window.__rstSetOpenOrders = (state) => { window.__rstOpenOrdersState = state; };",
    "const openOrdersResult = new Proxy({}, { get: (_target, key) => window.__rstOpenOrdersState[key] });",
    "const mutation = (name) => ({ useMutation: () => ({ mutate: (variables) => window.__rstMutationCalls.push({ name, variables }), isPending: false, isSuccess: false, error: null, variables: undefined }) });",
    "const noOp = { invalidate: async () => {} };",
    "const positions = { useQuery: () => ({ data: { positions: [SAMPLE_POSITION] }, isLoading: false, isSuccess: true, error: null }) };",
    "const fills = { useQuery: () => ({ data: { fills: [] }, isLoading: false, error: null }) };",
    "export const trpc = { useUtils: () => ({ positions: { listPerps: noOp, listPerpOpenOrders: noOp } }), positions: { listPerps: positions, listPerpOpenOrders: { useQuery: () => openOrdersResult }, listPerpFills: fills }, orders: { getByClientOrderId: { useQuery: () => ({ data: undefined, isLoading: false }) }, cancelPerp: mutation('cancelPerp'), submitPerp: mutation('submitPerp'), setPerpTpSl: mutation('setPerpTpSl'), modifyPerpTpSl: mutation('modifyPerpTpSl') }, pnlImage: { generateOpenPerp: mutation('generateOpenPerp') } };",
  ].join("\n"),
  icons:
    "import { createElement } from 'react'; const icon = (props) => createElement('svg', { ...props, 'aria-hidden': true }); export const AlertTriangle = icon; export const LoaderCircle = icon; export const Pencil = icon; export const Share2 = icon; export const Shield = icon; export const X = icon;",
  sonner:
    "export const toast = { success() {}, error() {}, info() {}, warning() {} };",
  "close-reconciliation":
    "export const PERP_CLOSE_BACKGROUND_POLL_MS = 30000; export function perpClosePollInterval() { return 30000; } export function perpCloseSlowNoticeDelay() { return 5000; } export function resolvePerpClose() { return 'pending'; }",
  "perp-form-math":
    "export function generatePerpCloid() { return '123e4567-e89b-12d3-a456-426614174000'; }",
};

async function buildMountedPanelFixture() {
  const fixturePath = import.meta.dir + "/.rst-perp-panel-mounted-fixture.tsx";
  const panelPath = import.meta.dir + "/perp-positions-panel.tsx";
  const fixtureEntry = [
    "import { createElement, useEffect, useState } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { PerpPositionsPanel } from " + JSON.stringify(panelPath) + ";",
    "function Fixture() {",
    "  const [revision, setRevision] = useState(0);",
    "  useEffect(() => {",
    "    const refresh = () => setRevision((current) => current + 1);",
    "    window.addEventListener('rst-open-orders-updated', refresh);",
    "    window.__rstUpdateListenerReady = true;",
    "    return () => window.removeEventListener('rst-open-orders-updated', refresh);",
    "  }, []);",
    "  return createElement('div', { 'data-rst-revision': revision }, createElement(PerpPositionsPanel, { walletAddress: '" + MASTER_WALLET_ADDRESS + "', enabled: true, onViewChart: () => {} }));",
    "}",
    "createRoot(document.getElementById('root')).render(createElement(Fixture));",
  ].join("\n");
  return Bun.build({
    entrypoints: ["rst-perp-panel-mounted-fixture"],
    target: "browser",
    format: "iife",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "rst-perp-panel-mounted-fixture",
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({
            path: Bun.resolveSync("react", import.meta.dir),
          }));
          build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
            path: Bun.resolveSync("react-dom/client", import.meta.dir),
          }));
          build.onResolve(
            { filter: /^rst-perp-panel-mounted-fixture$/ },
            () => ({ path: fixturePath }),
          );
          build.onLoad(
            { filter: /\.rst-perp-panel-mounted-fixture\.tsx$/ },
            () => ({
              contents: fixtureEntry,
              loader: "tsx",
              resolveDir: import.meta.dir,
            }),
          );
          build.onResolve({ filter: /^@\// }, ({ path }) =>
            mountedPanelMockAliases[path]
              ? { path: mountedPanelMockAliases[path]!, namespace: "rst-panel-mock" }
              : undefined,
          );
          build.onResolve({ filter: /^lucide-react$/ }, () => ({
            path: "icons",
            namespace: "rst-panel-mock",
          }));
          build.onResolve({ filter: /^sonner$/ }, () => ({
            path: "sonner",
            namespace: "rst-panel-mock",
          }));
          build.onResolve(
            { filter: /^\.\/perp-close-reconciliation$/ },
            () => ({ path: "close-reconciliation", namespace: "rst-panel-mock" }),
          );
          build.onResolve(
            { filter: /^\.\/perp-form-math$/ },
            () => ({ path: "perp-form-math", namespace: "rst-panel-mock" }),
          );
          build.onLoad(
            { filter: /.*/, namespace: "rst-panel-mock" },
            ({ path }) => ({
              contents: mountedPanelMockModules[path]!,
              loader: "js",
              resolveDir: import.meta.dir,
            }),
          );
        },
      },
    ],
  });
}

if (!isolateMountedPanel) {
  mountedPanelTest(
    "mounted Set, Edit, and Cancel handlers block stale snapshots and dispatch when fresh",
    async () => {
    const bundle = await buildMountedPanelFixture();
    expect(bundle.success, String(bundle.logs)).toBe(true);
    const { chromium } = await import(process.env.RST_PLAYWRIGHT_MODULE!);
    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    const fixtureScript = await bundle.outputs[0]!.text();
    const externalRequests: string[] = [];

    const mount = async (orders: "empty" | "populated") => {
      const page = await browser.newPage();
      await page.route("**/*", async (route: any) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== MOUNTED_PANEL_ORIGIN) {
          externalRequests.push(request.url());
          await route.fulfill({ status: 204, body: "" });
        } else if (request.isNavigationRequest()) {
          await route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><div id="root"></div><script src="/panel.js"></script>',
          });
        } else if (url.pathname === "/panel.js") {
          await route.fulfill({
            contentType: "application/javascript",
            body: fixtureScript,
          });
        } else {
          await route.fulfill({ status: 204, body: "" });
        }
      });
      await page.clock.install({ time: MOUNTED_PANEL_START_TIME });
      await page.clock.pauseAt(MOUNTED_PANEL_START_TIME);
      await page.goto(MOUNTED_PANEL_ORIGIN + "/?orders=" + orders);
      await page.waitForFunction(
        () => (window as any).__rstUpdateListenerReady === true,
      );
      await page.locator("#root [aria-label]").first().waitFor();
      return page;
    };
    const mutationCalls = (page: any) =>
      page.evaluate(() => (window as any).__rstMutationCalls);
    const transitionToFetchingWithoutRender = (page: any) =>
      page.evaluate(() => {
        const state = (window as any).__rstOpenOrdersState;
        state.isFetching = true;
        state.fetchStatus = "fetching";
      });
    const transitionToFreshAndRender = async (
      page: any,
      orders: typeof POPULATED_OPEN_ORDERS,
    ) => {
      await page.evaluate((freshOrders: typeof POPULATED_OPEN_ORDERS) => {
        (window as any).__rstSetOpenOrders({
          data: { orders: freshOrders },
          isLoading: false,
          isFetching: false,
          fetchStatus: "idle",
          dataUpdatedAt: Date.now(),
          isSuccess: true,
          error: null,
        });
        window.dispatchEvent(new Event("rst-open-orders-updated"));
      }, orders);
      await page.waitForFunction(
        () =>
          document
            .querySelector("#root [data-rst-revision]")
            ?.getAttribute("data-rst-revision") === "1",
      );
    };
    const captureControls = (page: any) =>
      page.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")];
        const byText = (text: string) =>
          buttons.find((button) => button.textContent?.trim() === text) ?? null;
        (window as any).__rstCapturedControls = {
          set: document.querySelector('button[aria-label="Set stop loss for BTC"]'),
          edit: document.querySelector('button[aria-label="Edit stop loss 1 for BTC"]'),
          cancel: byText("Cancel SL"),
          submit: byText("Set TP/SL") ?? byText("Update"),
        };
      });
    const controlsAreUnchanged = (page: any) =>
      page.evaluate(() => {
        const before = (window as any).__rstCapturedControls;
        const buttons = [...document.querySelectorAll("button")];
        const byText = (text: string) =>
          buttons.find((button) => button.textContent?.trim() === text) ?? null;
        return (
          before.set === document.querySelector('button[aria-label="Set stop loss for BTC"]') &&
          before.edit === document.querySelector('button[aria-label="Edit stop loss 1 for BTC"]') &&
          before.cancel === byText("Cancel SL") &&
          before.submit === (byText("Set TP/SL") ?? byText("Update"))
        );
      });

    try {
      for (const staleMode of ["background-fetching", "age-boundary"] as const) {
        const emptyPage = await mount("empty");
        try {
          await emptyPage.locator('button[aria-label="Set stop loss for BTC"]').first().click();
          await emptyPage.getByRole("button", { name: "Price", exact: true }).click();
          await emptyPage.getByLabel("Stop-loss price for BTC").fill("59000");
          await captureControls(emptyPage);
          if (staleMode === "background-fetching") {
            await transitionToFetchingWithoutRender(emptyPage);
          } else {
            await emptyPage.clock.setSystemTime(MOUNTED_PANEL_START_TIME + 15_000);
          }
          expect(
            await emptyPage.locator("#root [data-rst-revision]").getAttribute("data-rst-revision"),
          ).toBe("0");
          expect(await controlsAreUnchanged(emptyPage)).toBe(true);
          await emptyPage.getByRole("button", { name: "Set TP/SL", exact: true }).click();
          await emptyPage.locator('button[aria-label="Set take profit for BTC"]').first().click();
          expect(await mutationCalls(emptyPage)).toEqual([]);
          expect(
            await emptyPage.getByLabel("Stop-loss price for BTC").inputValue(),
          ).toBe("59000");

          await transitionToFreshAndRender(emptyPage, []);
          await emptyPage.locator('button[aria-label="Set stop loss for BTC"]').first().click();
          await emptyPage.getByRole("button", { name: "Price", exact: true }).click();
          await emptyPage.getByLabel("Stop-loss price for BTC").fill("59000");
          await emptyPage.getByRole("button", { name: "Set TP/SL", exact: true }).click();
          const setCalls = await mutationCalls(emptyPage);
          expect(setCalls).toHaveLength(1);
          expect(setCalls[0]).toMatchObject({
            name: "setPerpTpSl",
            variables: {
              coin: "BTC",
              positionSide: "long",
              size: "0.25",
              isMarket: true,
              sizeMode: "full-position",
              stopLossPx: "59000",
              cloid: "123e4567-e89b-12d3-a456-426614174000",
            },
          });
        } finally {
          await emptyPage.close();
        }

        const populatedPage = await mount("populated");
        try {
          await populatedPage
            .locator('button[aria-label="Edit stop loss 1 for BTC"]')
            .first()
            .click();
          await populatedPage.getByLabel("Stop-loss price for BTC").fill("57500");
          await captureControls(populatedPage);
          if (staleMode === "background-fetching") {
            await transitionToFetchingWithoutRender(populatedPage);
          } else {
            await populatedPage.clock.setSystemTime(MOUNTED_PANEL_START_TIME + 15_000);
          }
          expect(
            await populatedPage.locator("#root [data-rst-revision]").getAttribute("data-rst-revision"),
          ).toBe("0");
          expect(await controlsAreUnchanged(populatedPage)).toBe(true);
          await populatedPage
            .locator('button[aria-label="Edit take profit 1 for BTC"]')
            .first()
            .click();
          expect(
            await populatedPage.getByText("Edit stop loss", { exact: true }).count(),
          ).toBe(1);
          await populatedPage.getByRole("button", { name: "Update", exact: true }).click();
          await populatedPage.getByRole("button", { name: "Cancel SL", exact: true }).click();
          expect(await mutationCalls(populatedPage)).toEqual([]);

          await transitionToFreshAndRender(populatedPage, POPULATED_OPEN_ORDERS);
          await populatedPage
            .locator('button[aria-label="Edit take profit 1 for BTC"]')
            .first()
            .click();
          await populatedPage.getByLabel("Take-profit price for BTC").fill("65000");
          await populatedPage.getByRole("button", { name: "Update", exact: true }).click();
          await populatedPage.getByRole("button", { name: "Cancel TP", exact: true }).click();
          expect(await mutationCalls(populatedPage)).toEqual([
            {
              name: "modifyPerpTpSl",
              variables: { coin: "BTC", orderId: 3, kind: "tp", triggerPx: "65000" },
            },
            {
              name: "cancelPerp",
              variables: { coin: "BTC", orderId: 3 },
            },
          ]);
        } finally {
          await populatedPage.close();
        }
      }
      expect(externalRequests).toEqual([]);
    } finally {
      await browser.close();
    }
    },
    60_000,
  );
}

function buttonWithLabel(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

describe("PerpPositionsPanel header parity with the equity panel", () => {
  // The perps table used to render with NO header at all: no title, no
  // Open | Closed toggle (closed round-trips were reachable only from a
  // separate drawer sub-tab), and no sort. Both venues now draw the same
  // `PositionsPanelHeader`, so these controls must be present here too.
  test("renders the shared Open | Closed and sort controls", () => {
    const markup = renderPanel();

    expect(markup).toContain("Open positions");
    expect(markup).toContain('aria-label="Sort positions"');
    expect(markup).toContain(">Open<");
    expect(markup).toContain(">Closed<");
    for (const label of [">Date<", ">P&amp;L<", ">Value<"]) {
      expect(markup).toContain(label);
    }
  });

  test("summarises the open positions the way the equity panel does", () => {
    const markup = renderPanel();

    // One sample position, $250 unrealized on $3,000 of margin.
    expect(markup).toContain("1 position");
    expect(markup).toContain("$250.00");
  });
});

describe("embedded PositionsPanelHeader responsive layout", () => {
  test("uses pane width for the compact row and keeps every status and control", () => {
    const markup = renderToStaticMarkup(
      <PositionsPanelHeader
        embedded
        showClosed={false}
        onShowClosedChange={() => {}}
        sortBy="date"
        onSortByChange={() => {}}
        description="1 position · +$250.00 unrealized · +$500.00 realized"
      />,
    );
    const text = markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&");

    expect(markup).toContain("@container/card-header");
    expect(markup).toContain("@[560px]/card-header:flex-row");
    expect(markup).toContain("@[560px]/card-header:h-7");
    expect(markup).not.toContain("xl:");
    for (const label of [
      "Open positions",
      "1 position",
      "+$250.00 unrealized",
      "+$500.00 realized",
      "Open",
      "Closed",
      "Date",
      "P&L",
      "Value",
    ]) {
      expect(text).toContain(label);
    }
  });
});

describe("PerpPositionsPanel mobile actions", () => {
  test("keeps the perp Close action at a mobile touch target and compact at xl", () => {
    const markup = renderPanel();
    const close = buttonWithLabel(markup, "Close BTC position");

    expect(close).not.toBe("");
    expect(close).toContain("h-11");
    expect(close).toContain("w-11");
    expect(close).toContain("xl:h-7");
    expect(close).toContain("xl:w-7");
  });

  test("reserves enough mobile table width for Share and Close", () => {
    const markup = renderPanel();

    expect(markup).toContain("w-[64%]");
    expect(markup).toContain("w-[36%]");
    expect(markup).toContain("@[520px]/perppos:w-[24%]");
  });

  test("has no TP/SL disclosure: the triggers live in the table", () => {
    // SL and TP are columns, and their pencils are the only way into the
    // editor. A row-level disclosure just repeated those same two values.
    const markup = renderPanel();

    expect(buttonWithLabel(markup, "Edit TP/SL for BTC")).toBe("");
    expect(markup).not.toMatch(/<tr[^>]*aria-label="Edit TP\/SL for BTC"[^>]*>/);
    expect(markup).not.toContain('tabindex="0"');
    expect(buttonWithLabel(markup, "Edit stop loss 1 for BTC")).not.toBe("");
    expect(buttonWithLabel(markup, "Edit take profit 1 for BTC")).not.toBe("");
  });

  test("exposes every attached stop-loss and take-profit leg", () => {
    const markup = renderPanel();

    for (const label of [
      "Edit stop loss 1 for BTC",
      "Edit stop loss 2 for BTC",
      "Edit take profit 1 for BTC",
      "Edit take profit 2 for BTC",
    ]) {
      expect(buttonWithLabel(markup, label)).not.toBe("");
    }
    for (const price of ["58,000", "57,000", "63,000", "64,000"]) {
      expect(markup).toContain(price);
    }
  });

  test("keeps every visible SL/TP edit action reachable on mobile", () => {
    const markup = renderPanel();

    for (const label of [
      "Edit stop loss 1 for BTC",
      "Edit stop loss 2 for BTC",
      "Edit take profit 1 for BTC",
      "Edit take profit 2 for BTC",
    ]) {
      const button = buttonWithLabel(markup, label);
      expect(button).toContain("h-11");
      expect(button).toContain("w-11");
      expect(button).toContain("xl:h-6");
      expect(button).toContain("xl:w-6");
    }
  });

  test("shares P&L from one icon button beside Close, at every width", () => {
    // One control, in the actions cell next to Close, sized for a phone: a
    // second labelled Share button in the mobile detail block dwarfed the row.
    const markup = renderPanel();
    const shareButtons =
      markup.match(/<button[^>]*aria-label="Share BTC P&amp;L"[^>]*>/g) ?? [];

    expect(shareButtons.length).toBe(1);
    expect(shareButtons[0]).not.toContain("hidden");
    expect(shareButtons[0]).toContain("h-11");
    expect(shareButtons[0]).toContain("w-11");
    expect(shareButtons[0]).toContain("xl:h-7");
    expect(shareButtons[0]).toContain("xl:w-7");
    expect(markup).not.toContain("Share P&amp;L</button>");
  });

  test("shows the realized P&L banked on the position", () => {
    // listPerps returns the realized P&L reconstructed from durable DB fills.
    expect(renderPanel()).toContain("$500.00");
  });

  test("shows loading instead of setup guidance while enablement is unresolved", () => {
    const markup = renderToStaticMarkup(
      <PerpPositionsPanel walletAddress={null} enabled={false} loading />,
    );

    expect(markup).toContain("Loading positions...");
    expect(markup).not.toContain("Set up perpetual futures");
  });
});

describe("PerpPositionsPanel TP/SL availability", () => {
  const unavailableStates: Array<{
    name: string;
    result: OpenOrdersQueryResult;
  }> = [
    {
      name: "pending with no data",
      result: {
        data: undefined,
        isLoading: true,
        isFetching: true,
        fetchStatus: "fetching",
        dataUpdatedAt: 0,
        isSuccess: false,
        error: null,
      },
    },
    {
      name: "missing data after the initial request",
      result: {
        data: undefined,
        isLoading: false,
        isFetching: false,
        fetchStatus: "idle",
        dataUpdatedAt: 0,
        isSuccess: false,
        error: null,
      },
    },
    {
      name: "a success status without an order payload",
      result: {
        data: undefined,
        isLoading: false,
        isFetching: false,
        fetchStatus: "idle",
        dataUpdatedAt: Date.now(),
        isSuccess: true,
        error: null,
      },
    },
    {
      name: "an error without cached data",
      result: {
        data: undefined,
        isLoading: false,
        isFetching: false,
        fetchStatus: "idle",
        dataUpdatedAt: 0,
        isSuccess: false,
        error: { message: "venue unavailable" },
      },
    },
    {
      name: "an error with cached protective orders",
      result: {
        data: { orders: POPULATED_OPEN_ORDERS },
        isLoading: false,
        isFetching: false,
        fetchStatus: "idle",
        dataUpdatedAt: Date.now(),
        isSuccess: false,
        error: { message: "venue unavailable" },
      },
    },
    {
      name: "a cached empty success during a background refetch",
      result: {
        ...successfulOpenOrders([]),
        isFetching: true,
        fetchStatus: "fetching",
      },
    },
    {
      name: "cached protective orders during a background refetch",
      result: {
        ...successfulOpenOrders(),
        isFetching: true,
        fetchStatus: "fetching",
      },
    },
    {
      name: "an over-age empty successful snapshot",
      result: {
        ...successfulOpenOrders([]),
        dataUpdatedAt: Date.now() - OPEN_ORDERS_STALE_TIME_MS - 1,
      },
    },
    {
      name: "an over-age populated successful snapshot",
      result: {
        ...successfulOpenOrders(),
        dataUpdatedAt: Date.now() - OPEN_ORDERS_STALE_TIME_MS - 1,
      },
    },
  ];

  for (const state of unavailableStates) {
    test(`does not expose TP/SL actions for ${state.name}`, () => {
      openOrdersResult = state.result;
      const markup = renderPanel();

      for (const label of [
        "Set stop loss for BTC",
        "Set take profit for BTC",
        "Edit stop loss 1 for BTC",
        "Edit take profit 1 for BTC",
      ]) {
        expect(buttonWithLabel(markup, label)).toBe("");
      }
      expect(markup).not.toContain("Cancel SL");
      expect(markup).not.toContain("Cancel TP");
    });
  }

  test("offers Set for a successful empty snapshot and a valid master address", () => {
    openOrdersResult = successfulOpenOrders([]);
    const markup = renderPanel();

    expect(buttonWithLabel(markup, "Set stop loss for BTC")).not.toBe("");
    expect(buttonWithLabel(markup, "Set take profit for BTC")).not.toBe("");
    expect(buttonWithLabel(markup, "Edit stop loss for BTC")).toBe("");
  });

  test("does not treat an empty successful response as actionable without a valid master address", () => {
    openOrdersResult = successfulOpenOrders([]);

    for (const walletAddress of [null, "0xabc"]) {
      const markup = renderPanel(walletAddress);

      expect(openOrdersQueryEnabled).toBe(false);
      expect(buttonWithLabel(markup, "Set stop loss for BTC")).toBe("");
      expect(buttonWithLabel(markup, "Set take profit for BTC")).toBe("");
      expect(buttonWithLabel(markup, "Edit stop loss for BTC")).toBe("");
    }

    openOrdersResult = successfulOpenOrders();
    for (const walletAddress of [null, "0xabc"]) {
      const markup = renderPanel(walletAddress);

      expect(openOrdersQueryEnabled).toBe(false);
      for (const label of [
        "Edit stop loss 1 for BTC",
        "Edit stop loss 2 for BTC",
        "Edit take profit 1 for BTC",
        "Edit take profit 2 for BTC",
      ]) {
        expect(buttonWithLabel(markup, label)).toBe("");
      }
    }
  });

  test("keeps populated trigger prices and edit actions with a valid master address", () => {
    const markup = renderPanel();

    expect(openOrdersQueryEnabled).toBe(true);
    for (const price of ["58,000", "57,000", "63,000", "64,000"]) {
      expect(markup).toContain(price);
    }
    expect(buttonWithLabel(markup, "Edit stop loss 1 for BTC")).not.toBe("");
    expect(buttonWithLabel(markup, "Edit take profit 1 for BTC")).not.toBe("");
  });

  test("restores Set only after an empty refetch settles successfully", () => {
    openOrdersResult = {
      ...successfulOpenOrders([]),
      isFetching: true,
      fetchStatus: "fetching",
    };
    expect(buttonWithLabel(renderPanel(), "Set stop loss for BTC")).toBe("");

    openOrdersResult = successfulOpenOrders([]);
    expect(buttonWithLabel(renderPanel(), "Set stop loss for BTC")).not.toBe("");
  });

  test("restores Edit only after a populated refetch settles successfully", () => {
    openOrdersResult = {
      ...successfulOpenOrders(),
      isFetching: true,
      fetchStatus: "fetching",
    };
    expect(buttonWithLabel(renderPanel(), "Edit stop loss 1 for BTC")).toBe("");

    openOrdersResult = successfulOpenOrders();
    expect(buttonWithLabel(renderPanel(), "Edit stop loss 1 for BTC")).not.toBe("");
  });
});
