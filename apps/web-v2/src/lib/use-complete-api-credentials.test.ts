import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ApiCredentialStatusAccount,
  ApiCredentialStatusPage,
} from "./use-complete-api-credentials";

type QueryResult = {
  data: { pages: ApiCredentialStatusPage[] } | undefined;
  hasNextPage: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: { message: string } | null;
  fetchNextPage: (options?: unknown) => Promise<unknown>;
  refetch: () => Promise<unknown>;
};

let queryResult: QueryResult;
let capturedInput: unknown;
let capturedOptions: {
  enabled?: boolean;
  getNextPageParam: (page: ApiCredentialStatusPage) => unknown;
} | undefined;

mock.module("@/lib/trpc", () => ({
  trpc: {
    userSettings: {
      hasApiCredentials: {
        useInfiniteQuery: (
          input: unknown,
          options: typeof capturedOptions,
        ) => {
          capturedInput = input;
          capturedOptions = options;
          return queryResult;
        },
      },
    },
  },
}));

const { shouldFetchNextCredentialPage, useCompleteApiCredentials } = await import(
  "./use-complete-api-credentials"
);
const { toAccountOptions } = await import("../components/copy-trade/account-targeting");

function credential(
  id: string,
  provider: "alpaca" | "hyperliquid",
  needsReentry?: boolean,
): ApiCredentialStatusAccount {
  return {
    id,
    provider,
    accountId: id,
    accountType: provider === "alpaca" ? "PAPER" : "LIVE",
    credentialAccountLabel: provider === "hyperliquid" ? "Hyperliquid mainnet perps" : null,
    ...(provider === "alpaca" ? { needsReentry: needsReentry ?? false } : {}),
    username: null,
    baseUrl: null,
    updatedAt: new Date(0),
  };
}

function page(
  accounts: ApiCredentialStatusAccount[],
  isComplete: boolean,
  nextCursor: string | null,
): ApiCredentialStatusPage {
  return { hasCredentials: accounts.length > 0, accounts, isComplete, nextCursor };
}

function setQueryResult(overrides: Partial<QueryResult> = {}): void {
  queryResult = {
    data: undefined,
    hasNextPage: false,
    isFetching: false,
    isLoading: false,
    isSuccess: false,
    isError: false,
    error: null,
    fetchNextPage: async () => undefined,
    refetch: async () => undefined,
    ...overrides,
  };
  capturedInput = undefined;
  capturedOptions = undefined;
}

function mount(provider?: "alpaca" | "hyperliquid", options?: { enabled?: boolean }) {
  let state: ReturnType<typeof useCompleteApiCredentials> | undefined;
  function Harness() {
    state = useCompleteApiCredentials(provider, options);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return state!;
}

describe("complete API credential pagination", () => {
  test("keeps server page order and exposes selectable accounts only after completion", () => {
    const flagged = credential("alpaca-flagged", "alpaca", true);
    const healthy = credential("alpaca-healthy", "alpaca");
    const hyperliquid = credential("hyperliquid", "hyperliquid");
    const firstPage = page([flagged, healthy], false, "cursor-2");
    const lastPage = page([healthy, hyperliquid], true, null);
    setQueryResult({
      data: { pages: [firstPage, lastPage] },
      isSuccess: true,
    });

    const state = mount("alpaca", { enabled: true });

    expect(capturedInput).toEqual({ provider: "alpaca" });
    expect(capturedOptions?.enabled).toBe(true);
    expect(capturedOptions?.getNextPageParam(firstPage)).toBe("cursor-2");
    expect(capturedOptions?.getNextPageParam(lastPage)).toBeUndefined();
    expect(state.isComplete).toBe(true);
    expect(state.accounts.map((account) => account.id)).toEqual([
      "alpaca-flagged",
      "alpaca-healthy",
      "hyperliquid",
    ]);
    expect(toAccountOptions(state.accounts).map((account) => account.id)).toEqual([
      "alpaca-healthy",
      "hyperliquid",
    ]);
  });

  test("fails closed while pages are partial or a later page errors", () => {
    const partialPage = page([credential("partial", "alpaca")], false, "cursor-2");
    setQueryResult({
      data: { pages: [partialPage] },
      hasNextPage: true,
      isFetching: true,
      isSuccess: true,
    });

    const partial = mount();
    expect(partial.accounts).toEqual([]);
    expect(partial.hasCredentials).toBe(false);
    expect(partial.isComplete).toBe(false);
    expect(partial.isLoading).toBe(true);

    setQueryResult({
      data: { pages: [partialPage] },
      hasNextPage: true,
      isError: true,
      error: { message: "page failed" },
      isSuccess: true,
    });
    const failed = mount();
    expect(failed.accounts).toEqual([]);
    expect(failed.isComplete).toBe(false);
    expect(failed.isError).toBe(true);
  });

  test("hides cached accounts while the query is disabled", () => {
    const completePage = page([credential("cached", "alpaca")], true, null);
    setQueryResult({
      data: { pages: [completePage] },
      isSuccess: true,
    });

    const state = mount("alpaca", { enabled: false });

    expect(capturedOptions?.enabled).toBe(false);
    expect(state.accounts).toEqual([]);
    expect(state.isComplete).toBe(false);
  });

  test("requests another page only when pagination is enabled and idle", () => {
    expect(shouldFetchNextCredentialPage({
      enabled: true,
      hasNextPage: true,
      isFetching: false,
      isError: false,
    })).toBe(true);
    expect(shouldFetchNextCredentialPage({
      enabled: true,
      hasNextPage: true,
      isFetching: true,
      isError: false,
    })).toBe(false);
    expect(shouldFetchNextCredentialPage({
      enabled: true,
      hasNextPage: true,
      isFetching: false,
      isError: true,
    })).toBe(false);
  });

  test("runs the mounted hook effect to fetch sequential pages and stays closed on a later error", async () => {
    const firstPage = page([credential("first", "alpaca")], false, "cursor-2");
    const secondPage = page([credential("second", "alpaca")], false, "cursor-3");
    const finalPage = page([credential("third", "alpaca")], true, null);
    const successfulPages = [firstPage, secondPage, finalPage];
    const fetchNextPage = mock(async () => {
      const fetchedPageCount = fetchNextPage.mock.calls.length;
      queryResult = {
        ...queryResult,
        data: { pages: successfulPages.slice(0, fetchedPageCount + 1) },
        hasNextPage: fetchedPageCount + 1 < successfulPages.length,
        isFetching: true,
      };
    });
    setQueryResult({
      data: { pages: [firstPage] },
      hasNextPage: true,
      isSuccess: true,
      fetchNextPage,
    });

    const globals = globalThis as unknown as Record<string, unknown>;
    const originalWindow = globals.window;
    const originalDocument = globals.document;
    const originalActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
    const ignoreEvent = () => {};
    class TestIFrame {}
    const documentStub: Record<string, unknown> = {
      nodeType: 9,
      activeElement: null,
      body: null,
      addEventListener: ignoreEvent,
      removeEventListener: ignoreEvent,
      documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" },
    };
    const windowStub = {
      document: documentStub,
      HTMLIFrameElement: TestIFrame,
      addEventListener: ignoreEvent,
      removeEventListener: ignoreEvent,
    };
    documentStub.defaultView = windowStub;
    globals.window = windowStub;
    globals.document = documentStub;
    globals.IS_REACT_ACT_ENVIRONMENT = true;

    const container = {
      nodeType: 1,
      tagName: "DIV",
      nodeName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: documentStub,
      addEventListener: ignoreEvent,
      removeEventListener: ignoreEvent,
    };
    let mountedState: ReturnType<typeof useCompleteApiCredentials> | undefined;
    function Harness() {
      mountedState = useCompleteApiCredentials("alpaca");
      return null;
    }
    const root = createRoot(container as never);
    const renderMountedHook = async () => {
      await act(async () => {
        root.render(createElement(Harness));
      });
      return mountedState!;
    };

    try {
      const afterFirstFetch = await renderMountedHook();
      const whileFirstFetchSettles = await renderMountedHook();
      queryResult = { ...queryResult, isFetching: false };
      const afterSecondFetch = await renderMountedHook();
      const complete = await renderMountedHook();

      expect(fetchNextPage).toHaveBeenCalledTimes(2);
      expect(afterFirstFetch.accounts).toEqual([]);
      expect(whileFirstFetchSettles.accounts).toEqual([]);
      expect(afterSecondFetch.accounts).toEqual([]);
      expect(complete.accounts.map((account) => account.id)).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(complete.isComplete).toBe(true);

      const fetchFailingPage = mock(async () => {
        queryResult = {
          ...queryResult,
          hasNextPage: false,
          isError: true,
          error: { message: "later page failed" },
        };
      });
      setQueryResult({
        data: { pages: [firstPage] },
        hasNextPage: true,
        isSuccess: true,
        fetchNextPage: fetchFailingPage,
      });

      const beforeFailureRerender = await renderMountedHook();
      const failed = await renderMountedHook();

      expect(fetchFailingPage).toHaveBeenCalledTimes(1);
      expect(beforeFailureRerender.accounts).toEqual([]);
      expect(failed.accounts).toEqual([]);
      expect(failed.isComplete).toBe(false);
      expect(failed.isError).toBe(true);
    } finally {
      await act(async () => root.unmount());
      globals.window = originalWindow;
      globals.document = originalDocument;
      globals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
  });
});
