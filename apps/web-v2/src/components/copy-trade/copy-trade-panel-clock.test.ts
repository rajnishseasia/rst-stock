import { beforeAll, afterAll, describe, expect, test } from "bun:test";

const browserTest = process.env.RST_PLAYWRIGHT_MODULE ? test : test.skip;
const isolateBrowser = Boolean(process.env.RST_PLAYWRIGHT_MODULE && !process.env.RST_QUOTE_CLOCK_TEST_CHILD);
const START = Date.UTC(2026, 8, 6, 12);
let browser: any;
let script: string;

if (isolateBrowser) {
  test("actual Copy panel browser regressions in an isolated process", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, RST_QUOTE_CLOCK_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const evidence = result.stdout.toString() + result.stderr.toString();
    console.info(evidence);
    expect(result.exitCode, evidence).toBe(0);
  }, 65_000);
}

beforeAll(async () => {
  if (!process.env.RST_PLAYWRIGHT_MODULE || isolateBrowser) return;
  // The child process keeps real React and browser dependencies free of other suites' mocks.
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/copy-trade-panel-clock.fixture.tsx`],
    target: "browser", format: "iife",
    define: { "process.env": "{}", "process.env.NEXT_PUBLIC_PRIVY_APP_ID": '"fixture"', "process.env.NODE_ENV": '"development"' },
  });
  expect(bundle.success, String(bundle.logs)).toBe(true);
  script = await bundle.outputs[0]!.text();
  const { chromium } = await import(process.env.RST_PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}, 30_000);
afterAll(async () => { await browser?.close(); }, 30_000);

/** Mount the actual panel with a paused browser clock and real query clients. */
async function mount() {
  const page = await browser.newPage();
  page.on("pageerror", (error: Error) => console.error(error.message));
  await page.route("http://quote-fixture.test/**", (route: any) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://quote-fixture.test/");
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START);
  await page.evaluate(() => {
    const timers = new Map<number, number>();
    const originalSet = window.setTimeout.bind(window);
    const originalClear = window.clearTimeout.bind(window);
    window.setTimeout = ((callback: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const id = originalSet(() => { timers.delete(id); callback(...args); }, delay);
      timers.set(id, delay ?? 0);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { timers.delete(id!); originalClear(id); }) as typeof window.clearTimeout;
    const listeners = new Map<string, Set<unknown>>();
    for (const [label, target, events] of [
      ["window", window, ["focus", "pageshow"]],
      ["document", document, ["visibilitychange"]],
    ] as const) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = ((type: string, listener: any, options: any) => {
        if ((events as readonly string[]).includes(type)) {
          const key = `${label}.${type}`;
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)!.add(listener);
        }
        add(type, listener, options);
      }) as typeof target.addEventListener;
      target.removeEventListener = ((type: string, listener: any, options: any) => {
        listeners.get(`${label}.${type}`)?.delete(listener);
        remove(type, listener, options);
      }) as typeof target.removeEventListener;
    }
    (window as any).quoteLifecycle = () => ({
      expiryTimers: [...timers.values()].filter(delay => delay > 89_000 && delay <= 90_001).length,
      listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    });
  });
  await page.addScriptTag({ content: script });
  for (let i = 0; i < 10; i++) await page.clock.runFor(1);
  await page.getByRole("button", { name: "Copy 10 sh", exact: true }).waitFor();
  await page.getByRole("button", { name: "Copy 1 ct", exact: true }).waitFor();
  await page.getByRole("button", { name: "Prefill 2x Long", exact: true }).waitFor();
  const times = await page.evaluate(() => (window as any).quoteQA.snapshots().map((s: any) => s.updatedAt));
  expect(new Set(times).size).toBe(1);
  await page.clock.setSystemTime(times[0]);
  await page.evaluate(() => (window as any).quoteQA.hold());
  await page.clock.runFor(1);
  return { page, received: times[0], copy: page.getByRole("button", { name: /^(Copy(?: \d+ (?:sh|ct))?|Prefill 2x Long)$/ }) };
}

describe("actual Copy panel quote clock and dispatch", () => {
  if (isolateBrowser) return;
  browserTest("cleans up scheduled expiry and resume listeners on unmount", async () => {
    const { page } = await mount();
    try {
      const mounted = await page.evaluate(() => (window as any).quoteLifecycle());
      expect(mounted.expiryTimers).toBe(1);
      expect(mounted.listeners).toBe(3);
      await page.evaluate(() => (window as any).quoteQA.unmount());
      expect(await page.evaluate(() => (window as any).quoteLifecycle())).toEqual({ expiryTimers: 0, listeners: 0 });
      await page.clock.runFor(90_001);
      expect(await page.locator("#root").innerHTML()).toBe("");
    } finally { await page.close(); }
  });
  browserTest("expires stock, perp and option UI at 90001 without any query response", async () => {
    const { page, received, copy } = await mount();
    try {
      const before = await page.evaluate(() => (window as any).quoteQA.snapshots());
      expect(before.every((s: any) => s.fetchStatus === "fetching")).toBe(true);
      await page.clock.runFor(89_999);
      expect(await page.evaluate(() => Date.now())).toBe(received + 90_000);
      for (let i = 0; i < 3; i++) {
        expect(await copy.nth(i).isEnabled()).toBe(true);
        await copy.nth(i).click();
      }
      expect(await page.evaluate(() => (window as any).quoteQA.dispatches.length)).toBe(3);
      await page.clock.runFor(1);
      for (let i = 0; i < 3; i++) expect(await copy.nth(i).isDisabled()).toBe(true);
      expect(await page.evaluate(() => (window as any).quoteQA.snapshots())).toEqual(before);
      expect(await page.evaluate(() => (window as any).quoteQA.dispatches.length)).toBe(3);
    } finally { await page.close(); }
  });

  browserTest("rejects all three stale clicks before the delayed expiry callback renders, then refreshes on resume", async () => {
    const { page, received, copy } = await mount();
    try {
      await page.clock.setSystemTime(received + 90_001);
      for (let i = 0; i < 3; i++) expect(await copy.nth(i).isEnabled()).toBe(true);
      await page.evaluate(() => { for (let i = 0; i < 3; i++) (window as any).quoteQA.click(i); });
      expect(await page.evaluate(() => (window as any).quoteQA.dispatches)).toEqual([]);
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      await page.clock.runFor(1);
      for (let i = 0; i < 3; i++) expect(await copy.nth(i).isDisabled()).toBe(true);
    } finally { await page.close(); }
  });

  for (const [index, kind] of ["stock", "perp", "option"].entries()) {
    browserTest(`${kind}: current failed cache blocks a click before the observer render; recovery uses current sizing`, async () => {
      const { page, copy } = await mount();
      try {
        await page.evaluate(() => (window as any).quoteQA.pauseNotifications());
        const beforeClick = await page.evaluate(async (i: number) => {
          await (window as any).quoteQA.settle(i, true);
          const dom = (window as any).quoteQA.buttonState(i);
          (window as any).quoteQA.click(i);
          return dom;
        }, index);
        expect(beforeClick.disabled).toBe(false);
        expect(await page.evaluate(() => (window as any).quoteQA.dispatches)).toEqual([]);
        await page.evaluate(() => (window as any).quoteQA.flushNotifications());
        await page.clock.runFor(1);
        expect(await copy.nth(index).isDisabled()).toBe(true);
        await page.evaluate((i: number) => (window as any).quoteQA.refresh(i), index);
        await page.evaluate((i: number) => (window as any).quoteQA.settle(i), index);
        await page.clock.runFor(1);
        expect(await copy.nth(index).isEnabled()).toBe(true);
        await page.evaluate((i: number) => {
          (window as any).quoteQA.pauseNotifications();
          (window as any).quoteQA.setPrice(i);
          (window as any).quoteQA.refresh(i);
        }, index);
        const previousLabel = await copy.nth(index).innerText();
        const priceClick = await page.evaluate(async (i: number) => {
          await (window as any).quoteQA.settle(i);
          const dom = (window as any).quoteQA.buttonState(i);
          (window as any).quoteQA.click(i);
          return dom;
        }, index);
        expect(priceClick).toEqual({ disabled: false, label: previousLabel });
        const dispatches = await page.evaluate(() => (window as any).quoteQA.dispatches);
        expect(dispatches.length).toBe(1);
        if (index !== 1) expect(dispatches[0].qty).toBe(5);
        else expect(dispatches[0]).toMatchObject({ coin: "BTC", side: "long" });
        await page.evaluate(() => (window as any).quoteQA.flushNotifications());
        await page.clock.runFor(1);
        expect(await copy.nth(index).isEnabled()).toBe(true);
      } finally { await page.close(); }
    });

    browserTest(`${kind}: a backward clock after a real response blocks until a new response, including clock catch-up`, async () => {
      const { page, received, copy } = await mount();
      try {
        await page.clock.setSystemTime(received - 1);
        await page.evaluate((i: number) => (window as any).quoteQA.click(i), index);
        expect(await page.evaluate(() => (window as any).quoteQA.dispatches)).toEqual([]);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.clock.runFor(1);
        expect(await copy.nth(index).isDisabled()).toBe(true);
        await page.clock.setSystemTime(received + 2);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.clock.runFor(1);
        expect(await copy.nth(index).isDisabled()).toBe(true);
        await page.evaluate((i: number) => (window as any).quoteQA.settle(i), index);
        await page.clock.runFor(1);
        expect(await copy.nth(index).isEnabled()).toBe(true);
      } finally { await page.close(); }
    });

    browserTest(`${kind}: future cache timestamps fail closed and a successful response recovers`, async () => {
      const { page, copy } = await mount();
      try {
        for (const offset of [1, 86_400_000]) {
          await page.evaluate(({ i, offset }: any) => (window as any).quoteQA.future(i, offset), { i: index, offset });
          await page.clock.runFor(1);
          expect(await copy.nth(index).isDisabled()).toBe(true);
          await page.evaluate((i: number) => (window as any).quoteQA.settle(i), index);
          await page.clock.runFor(1);
          expect(await copy.nth(index).isEnabled()).toBe(true);
          await page.evaluate((i: number) => (window as any).quoteQA.refresh(i), index);
        }
      } finally { await page.close(); }
    });
  }
});
