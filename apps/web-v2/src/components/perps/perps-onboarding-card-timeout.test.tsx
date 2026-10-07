import { afterAll, beforeAll, expect, test } from "bun:test";

const browserTest = process.env.RST_PLAYWRIGHT_MODULE ? test : test.skip;
const START_TIME = Date.UTC(2026, 8, 12, 12);
const FIXTURE_ORIGIN = "http://rst-wallet-fixture.test";
const MASTER_ADDRESS = "0x1111111111111111111111111111111111111111";
const ACCOUNT_BALANCE = "$321.45";

const fixtureEntry = `
  import { createElement } from "react";
  import { createRoot } from "react-dom/client";
  import { PerpsOnboardingCard } from "./perps-onboarding-card";

  createRoot(document.getElementById("root")).render(
    createElement(PerpsOnboardingCard, { enabledSession: true }),
  );
`;

const mockModules: Record<string, string> = {
  trpc: `
    const status = {
      enabled: true,
      agentReady: false,
      walletAddress: "${MASTER_ADDRESS}",
      hlBalanceUsd: 321.45,
      network: "mainnet",
    };
    const record = (name) => window.__rstRecord(name);
    const mutation = (name) => () => ({
      mutate: () => { void record("trpc." + name); },
      mutateAsync: async () => { await record("trpc." + name); },
      isPending: false,
      isError: false,
      error: null,
      reset: () => {},
    });
    export const trpc = {
      useUtils: () => ({
        hyperliquid: {
          status: { invalidate: async () => {}, fetch: async () => status },
        },
      }),
      hyperliquid: {
        status: {
          useQuery: () => ({
            data: status,
            isPending: false,
            isLoading: false,
            isSuccess: true,
            isError: false,
            error: null,
            refetch: async () => ({ data: status }),
          }),
        },
        enable: { useMutation: mutation("enable") },
        rotatePendingAgent: { useMutation: mutation("rotatePendingAgent") },
        markAgentRegistered: { useMutation: mutation("markAgentRegistered") },
      },
    };
  `,
  wallet: `
    const record = (name) => window.__rstRecord(name);
    export function usePerpsWallet() {
      const notReady = new URL(window.location.href).searchParams.get("case") === "wallet-not-ready";
      const address = notReady ? undefined : "${MASTER_ADDRESS}";
      const state = {
        ready: !notReady,
        authenticated: !notReady,
        customAuthActive: true,
        subjectVerified: false,
        subjectMismatch: false,
        walletsReady: !notReady,
        address,
        embeddedWallet: address ? { address } : undefined,
        hasWallet: Boolean(address),
        login: async () => { await record("wallet.login"); },
        logout: async () => {
          await record("wallet.logout");
          if (localStorage.getItem("rst-wallet-logout") === "reject") {
            throw new Error("Fixture logout failed");
          }
        },
        createWallet: async () => { await record("wallet.create"); },
        importWallet: async () => { await record("wallet.import"); },
        getWalletClient: async () => {
          await record("wallet.getClient");
          return {};
        },
        fundWallet: async () => { await record("wallet.fund"); },
        exportWallet: async () => { await record("wallet.export"); },
        usdcBalance: 2000,
        ethBalance: 0.1,
        depositToHyperliquid: async () => { await record("wallet.deposit"); },
      };
      window.__rstWalletState = state;
      return state;
    }
  `,
  activate: `
    const record = (name) => window.__rstRecord(name);
    export async function activateAgentOnChain() {
      await record("wallet.sign");
      return {};
    }
    export async function activateAgentWithReuseRecovery() {
      await record("wallet.sign");
      return {};
    }
  `,
  deposit: `
    const record = (name) => window.__rstRecord(name);
    export const HL_MIN_DEPOSIT_USDC = 5;
    export async function readPerpsWalletBalancesByAddress() {
      await record("wallet.read-balances");
      const lowBalance = new URL(window.location.href).searchParams.get("case") === "subject-low-balance";
      return { usdc: lowBalance ? 1 : 2000, eth: 0.1 };
    }
    export async function depositUsdcToHyperliquid() {
      await record("wallet.deposit");
    }
  `,
};

const mockImportPaths: Record<string, string> = {
  "@/lib/trpc": "trpc",
  "@/lib/use-perps-wallet": "wallet",
  "@/lib/hyperliquid-activate": "activate",
  "@/lib/hyperliquid-deposit": "deposit",
};

let browser: any;
let fixtureScript = "";
const fixtureVirtualPath = `${import.meta.dir}/.rst-perps-onboarding-card-timeout-fixture.tsx`;

beforeAll(async () => {
  if (!process.env.RST_PLAYWRIGHT_MODULE) return;

  const bundle = await Bun.build({
    entrypoints: ["rst-perps-timeout-fixture"],
    target: "browser",
    format: "iife",
    define: {
      "process.env": "{}",
      "process.env.NEXT_PUBLIC_PRIVY_APP_ID": '"fixture"',
      "process.env.NODE_ENV": '"development"',
    },
    plugins: [
      {
        name: "rst-perps-timeout-fixture",
        setup(build) {
          build.onResolve(
            { filter: /^rst-perps-timeout-fixture$/ },
            () => ({ path: fixtureVirtualPath }),
          );
          build.onLoad(
            { filter: /\.rst-perps-onboarding-card-timeout-fixture\.tsx$/ },
            () => ({ contents: fixtureEntry, loader: "tsx" }),
          );
          build.onResolve({ filter: /^@\/lib\// }, ({ path }) => {
            const mock = mockImportPaths[path];
            return mock ? { path: mock, namespace: "rst-mock" } : undefined;
          });
          build.onLoad({ filter: /.*/, namespace: "rst-mock" }, ({ path }) => ({
            contents: mockModules[path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  expect(bundle.success, String(bundle.logs)).toBe(true);
  fixtureScript = await bundle.outputs[0]!.text();

  const { chromium } = await import(process.env.RST_PLAYWRIGHT_MODULE!);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}, 30_000);

afterAll(async () => {
  await browser?.close();
}, 30_000);

async function mount(caseName: "wallet-not-ready" | "subject-pending" | "subject-low-balance") {
  const page = await browser.newPage();
  const events: string[] = [];
  const externalRequests: string[] = [];
  let navigationCount = 0;

  await page.exposeFunction("__rstRecord", (name: string) => {
    events.push(name);
  });
  await page.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== FIXTURE_ORIGIN) {
      externalRequests.push(request.url());
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (request.isNavigationRequest()) {
      navigationCount += 1;
      if (navigationCount > 1) events.push("page.reload");
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><div id="root"></div><script>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>window.__rstRecord("clipboard.writeText")}})</script><script src="/rst-fixture.js"></script>',
      });
      return;
    }
    if (url.pathname === "/rst-fixture.js") {
      await route.fulfill({ contentType: "application/javascript", body: fixtureScript });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });

  await page.clock.install({ time: START_TIME });
  await page.clock.pauseAt(START_TIME);
  await page.goto(`${FIXTURE_ORIGIN}/?case=${caseName}`);
  await page.locator("#root").waitFor();

  return {
    page,
    events,
    externalRequests,
    navigationCount: () => navigationCount,
  };
}

async function expectNoTimeoutControls(page: any) {
  expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Reset wallet session", exact: true }).count()).toBe(0);
}

async function expectTimeoutControls(page: any) {
  expect(await page.getByText("Wallet-management session unavailable").count()).toBe(1);
  expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Reset wallet session", exact: true }).count()).toBe(1);
}

async function pendingAccountSnapshot(page: any) {
  const text = await page.locator("#root").innerText();
  return {
    storedMaster: text.includes(MASTER_ADDRESS),
    agentStatus: text.includes("Funded"),
    balance: text.includes(ACCOUNT_BALANCE),
  };
}

async function expectPendingAccountSnapshot(page: any) {
  expect(await pendingAccountSnapshot(page)).toEqual({
    storedMaster: true,
    agentStatus: true,
    balance: true,
  });
}

async function expectFundingControlsUnavailable(page: any) {
  expect(await page.getByRole("button", { name: "Copy", exact: true }).count()).toBe(0);
  expect(await page.getByText("How to fund your wallet", { exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Copy address", exact: true }).count()).toBe(0);
  const text = await page.locator("#root").innerText();
  expect(text.includes("Send native USDC on Arbitrum")).toBe(false);
}

function walletActionEvents(events: string[]) {
  return events.filter((event) =>
    [
      "wallet.login",
      "wallet.create",
      "wallet.import",
      "wallet.getClient",
      "wallet.fund",
      "wallet.export",
      "wallet.deposit",
      "wallet.sign",
    ].includes(event),
  );
}

function accountMutationEvents(events: string[]) {
  return events.filter((event) =>
    [
      "trpc.enable",
      "trpc.rotatePendingAgent",
      "trpc.markAgentRegistered",
    ].includes(event),
  );
}

async function expireTimeout(page: any) {
  await page.clock.runFor(20_000);
  await expectTimeoutControls(page);
}

browserTest(
  "wallet.ready=false keeps loading until the exact 20-second recovery timeout",
  async () => {
    const { page, externalRequests } = await mount("wallet-not-ready");
    try {
      expect(await page.evaluate(() => (window as any).__rstWalletState.ready)).toBe(false);
      await page.getByText("Loading wallet...", { exact: true }).waitFor();
      await page.clock.runFor(19_999);
      expect(await page.evaluate((start: number) => Date.now() - start, START_TIME)).toBe(19_999);
      expect(await page.getByText("Loading wallet...", { exact: true }).count()).toBe(1);
      await expectNoTimeoutControls(page);

      await page.clock.runFor(1);
      expect(await page.evaluate((start: number) => Date.now() - start, START_TIME)).toBe(20_000);
      await expectTimeoutControls(page);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

browserTest(
  "an existing embedded address stays pending until the exact 20-second timeout",
  async () => {
    const { page, events, externalRequests } = await mount("subject-pending");
    try {
      const wallet = await page.evaluate(() => (window as any).__rstWalletState);
      expect(wallet).toMatchObject({
        ready: true,
        authenticated: true,
        walletsReady: true,
        address: MASTER_ADDRESS,
        subjectVerified: false,
        subjectMismatch: false,
      });
      await page.getByText("Wallet session verification is still pending").waitFor();
      await expectFundingControlsUnavailable(page);
      expect(events.filter((event) => event === "clipboard.writeText")).toEqual([]);
      expect(walletActionEvents(events)).toEqual([]);
      await page.clock.runFor(19_999);
      expect(await page.evaluate((start: number) => Date.now() - start, START_TIME)).toBe(19_999);
      expect(await page.getByText("Wallet session verification is still pending").count()).toBe(1);
      await expectNoTimeoutControls(page);

      await page.clock.runFor(1);
      expect(await page.evaluate((start: number) => Date.now() - start, START_TIME)).toBe(20_000);
      await page.getByText("Wallet session verification is still pending").waitFor();
      await expectTimeoutControls(page);
      await expectFundingControlsUnavailable(page);
      expect(await page.getByRole("button", { name: "Export Private Key", exact: true }).count()).toBe(0);
      await page.locator('input[type="number"]').fill("20");
      expect(await page.getByRole("button", { name: "Deposit USDC", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Activate Trading", exact: true }).count()).toBe(0);
      expect(events.filter((event) => event === "clipboard.writeText")).toEqual([]);
      expect(walletActionEvents(events)).toEqual([]);
      expect(accountMutationEvents(events)).toEqual([]);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

browserTest(
  "an unverified low-balance subject does not show the wallet-funding hint",
  async () => {
    const { page, events, externalRequests } = await mount("subject-low-balance");
    try {
      await page.getByText("Wallet session verification is still pending").waitFor();
      await page.getByText("1.00 USDC", { exact: true }).first().waitFor();
      await expectPendingAccountSnapshot(page);
      expect(await page.getByText(/Fund your wallet with at least/).count()).toBe(0);
      await expectFundingControlsUnavailable(page);
      expect(events.filter((event) => event === "clipboard.writeText")).toEqual([]);
      expect(walletActionEvents(events)).toEqual([]);
      expect(accountMutationEvents(events)).toEqual([]);
      expect(await page.getByRole("button", { name: "Deposit USDC", exact: true }).isDisabled()).toBe(true);

      await page.clock.runFor(20_000);
      await expectTimeoutControls(page);
      expect(await page.getByText("Wallet session verification is still pending").count()).toBe(1);
      await page.getByText("1.00 USDC", { exact: true }).first().waitFor();
      await expectPendingAccountSnapshot(page);
      expect(await page.getByText(/Fund your wallet with at least/).count()).toBe(0);
      await expectFundingControlsUnavailable(page);
      expect(events.filter((event) => event === "clipboard.writeText")).toEqual([]);
      expect(walletActionEvents(events)).toEqual([]);
      expect(accountMutationEvents(events)).toEqual([]);
      expect(await page.getByRole("button", { name: "Deposit USDC", exact: true }).isDisabled()).toBe(true);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

browserTest(
  "Retry reloads locally without wallet or account mutations and remains available after reload",
  async () => {
    const { page, events, externalRequests, navigationCount } = await mount("subject-pending");
    try {
      await page.getByText("Wallet session verification is still pending").waitFor();
      const snapshotBefore = await pendingAccountSnapshot(page);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expireTimeout(page);
        const eventStart = events.length;
        const navigationStart = navigationCount();
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.getByText("Wallet session verification is still pending").waitFor();
        expect(navigationCount()).toBe(navigationStart + 1);
        expect(events.slice(eventStart).filter((event) => event === "page.reload")).toHaveLength(1);
        expect(events.slice(eventStart).filter((event) => event === "wallet.logout")).toEqual([]);
        expect(await pendingAccountSnapshot(page)).toEqual(snapshotBefore);
        expect(walletActionEvents(events)).toEqual([]);
        expect(accountMutationEvents(events)).toEqual([]);
      }
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

browserTest(
  "Reset logs out before a local reload and repeated resets preserve the account snapshot",
  async () => {
    const { page, events, externalRequests, navigationCount } = await mount("subject-pending");
    try {
      await page.getByText("Wallet session verification is still pending").waitFor();
      const snapshotBefore = await pendingAccountSnapshot(page);
      expect(snapshotBefore).toEqual({
        storedMaster: true,
        agentStatus: true,
        balance: true,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expireTimeout(page);
        const eventStart = events.length;
        const navigationStart = navigationCount();
        await page.getByRole("button", { name: "Reset wallet session", exact: true }).click();
        await page.getByText("Wallet session verification is still pending").waitFor();
        expect(navigationCount()).toBe(navigationStart + 1);
        expect(
          events.slice(eventStart).filter((event) => ["wallet.logout", "page.reload"].includes(event)),
        ).toEqual(["wallet.logout", "page.reload"]);
        expect(walletActionEvents(events)).toEqual([]);
        expect(accountMutationEvents(events)).toEqual([]);
        expect(await pendingAccountSnapshot(page)).toEqual(snapshotBefore);
      }
      expect(events.filter((event) => event === "wallet.logout")).toHaveLength(2);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

browserTest(
  "a rejected Reset keeps controls usable and the next successful Reset reloads",
  async () => {
    const { page, events, externalRequests, navigationCount } = await mount("subject-pending");
    try {
      await page.getByText("Wallet session verification is still pending").waitFor();
      await expireTimeout(page);
      await page.evaluate(() => localStorage.setItem("rst-wallet-logout", "reject"));
      const eventStart = events.length;
      const navigationStart = navigationCount();

      await page.getByRole("button", { name: "Reset wallet session", exact: true }).click();
      await page.getByText("Fixture logout failed", { exact: true }).waitFor();
      expect(navigationCount()).toBe(navigationStart);
      expect(events.slice(eventStart).filter((event) => event === "wallet.logout")).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Reset wallet session", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).isEnabled()).toBe(true);

      await page.evaluate(() => localStorage.setItem("rst-wallet-logout", "resolve"));
      const successEventStart = events.length;
      await page.getByRole("button", { name: "Reset wallet session", exact: true }).click();
      await page.getByText("Wallet session verification is still pending").waitFor();
      expect(navigationCount()).toBe(navigationStart + 1);
      expect(
        events.slice(successEventStart).filter((event) => ["wallet.logout", "page.reload"].includes(event)),
      ).toEqual(["wallet.logout", "page.reload"]);
      expect(walletActionEvents(events)).toEqual([]);
      expect(accountMutationEvents(events)).toEqual([]);
      await expectPendingAccountSnapshot(page);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
    }
  },
  30_000,
);
