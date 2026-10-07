import { describe, expect, test } from "bun:test";
import {
  MAX_RECENT_MARKETS,
  RECENT_MARKETS_STORAGE_KEY,
  addRecentMarket,
  browserRecentMarketsStore,
  readRecentMarkets,
  recentMarketKey,
  rememberRecentMarket,
  writeRecentMarkets,
  type RecentMarketsStore,
} from "./recent-markets";
import type { MarketSelection } from "./market-selection";

function fakeStore(initial?: string): RecentMarketsStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string) {
      return key === RECENT_MARKETS_STORAGE_KEY ? this.value : null;
    },
    setItem(key: string, next: string) {
      if (key === RECENT_MARKETS_STORAGE_KEY) this.value = next;
    },
  };
}

function throwingStore(): RecentMarketsStore {
  return {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
  };
}

const AAPL_STOCK: MarketSelection = { symbol: "AAPL", venue: "stocks" };
const AAPL_PERP: MarketSelection = { symbol: "AAPL", venue: "perps" };
const BTC_PERP: MarketSelection = { symbol: "BTC", venue: "perps" };

describe("recent markets identity", () => {
  test("the same symbol on two venues is two different recents", () => {
    expect(recentMarketKey(AAPL_STOCK)).not.toBe(recentMarketKey(AAPL_PERP));
  });
});

describe("addRecentMarket", () => {
  test("promotes the newest pick to the front without duplicating it", () => {
    const once = addRecentMarket([], AAPL_STOCK);
    const twice = addRecentMarket(once, BTC_PERP);
    const again = addRecentMarket(twice, AAPL_STOCK);

    expect(again).toEqual([AAPL_STOCK, BTC_PERP]);
  });

  test("does not let a perp pick evict the same ticker's stock row", () => {
    const next = addRecentMarket([AAPL_STOCK], AAPL_PERP);
    expect(next).toEqual([AAPL_PERP, AAPL_STOCK]);
  });

  test("truncates to the limit, dropping the oldest", () => {
    const filled = ["A", "B", "C", "D", "E", "F"].reduce<MarketSelection[]>(
      (list, symbol) => addRecentMarket(list, { symbol, venue: "stocks" }),
      [],
    );

    expect(filled).toHaveLength(MAX_RECENT_MARKETS);
    expect(filled[0]).toEqual({ symbol: "F", venue: "stocks" });
    expect(filled.some((item) => item.symbol === "A")).toBe(false);
  });
});

describe("readRecentMarkets", () => {
  test("returns an empty list for a missing, empty or corrupt payload", () => {
    expect(readRecentMarkets(fakeStore(), true)).toEqual([]);
    expect(readRecentMarkets(fakeStore(""), true)).toEqual([]);
    expect(readRecentMarkets(fakeStore("{not json"), true)).toEqual([]);
    expect(readRecentMarkets(fakeStore('{"symbol":"AAPL"}'), true)).toEqual([]);
    expect(readRecentMarkets(null, true)).toEqual([]);
  });

  test("drops perp rows when the deployment has no perps", () => {
    const store = fakeStore(JSON.stringify([AAPL_STOCK, BTC_PERP]));

    expect(readRecentMarkets(store, true)).toEqual([AAPL_STOCK, BTC_PERP]);
    expect(readRecentMarkets(store, false)).toEqual([AAPL_STOCK]);
  });

  test("survives a store that throws instead of crashing the screen", () => {
    expect(readRecentMarkets(throwingStore(), true)).toEqual([]);
  });
});

describe("rememberRecentMarket", () => {
  test("persists the promoted list and hands it back", () => {
    const store = fakeStore(JSON.stringify([BTC_PERP]));

    const next = rememberRecentMarket(store, AAPL_STOCK, true);

    expect(next).toEqual([AAPL_STOCK, BTC_PERP]);
    expect(JSON.parse(store.value ?? "null")).toEqual([AAPL_STOCK, BTC_PERP]);
  });

  test("keeps HL canonical casing rather than normalizing it", () => {
    const store = fakeStore();
    const next = rememberRecentMarket(
      store,
      { symbol: "kPEPE", venue: "perps" },
      true,
    );

    expect(next[0]?.symbol).toBe("kPEPE");
  });

  test("refuses to store a perp pick when perps are disabled", () => {
    const store = fakeStore(JSON.stringify([AAPL_STOCK]));

    const next = rememberRecentMarket(store, BTC_PERP, false);

    expect(next).toEqual([AAPL_STOCK]);
    expect(JSON.parse(store.value ?? "null")).toEqual([AAPL_STOCK]);
  });

  test("a failing store never breaks the pick", () => {
    expect(() => rememberRecentMarket(throwingStore(), AAPL_STOCK, true)).not.toThrow();
    expect(() => writeRecentMarkets(throwingStore(), [AAPL_STOCK])).not.toThrow();
  });
});

describe("browserRecentMarketsStore", () => {
  test("is null with no window, instead of throwing through a server render", () => {
    // The terminal and the mobile search screen both call this during render.
    // Touching `window.localStorage` where there is no window is a ReferenceError
    // that takes the whole page down, and recents are a convenience.
    expect(typeof window).toBe("undefined");
    expect(browserRecentMarketsStore()).toBeNull();
  });

  test("and every consumer keeps working without one", () => {
    const store = browserRecentMarketsStore();

    expect(readRecentMarkets(store, true)).toEqual([]);
    expect(() => writeRecentMarkets(store, [AAPL_STOCK])).not.toThrow();
    // The pick is still returned for the caller's React state, it just has
    // nowhere to persist: this session shows it, a reload does not.
    expect(rememberRecentMarket(store, AAPL_STOCK, true)).toEqual([AAPL_STOCK]);
  });
});
