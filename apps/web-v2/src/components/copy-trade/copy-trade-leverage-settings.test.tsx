import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, mock, test } from "bun:test";

type QueryState = {
  data?: { globalPerpMaxLeverage: number };
  isLoading: boolean;
  isError?: boolean;
  error?: { message: string } | null;
};

type MutationOptions = {
  onSuccess?: (data: { globalPerpMaxLeverage: number }) => void;
  onError?: (error: { message: string }) => void;
};

const queryState: QueryState = {
  data: { globalPerpMaxLeverage: 1 },
  isLoading: false,
  isError: false,
  error: null,
};
const mutationState = {
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null as { message: string } | null,
};
let capturedMutationOptions: MutationOptions | undefined;
const invalidations: string[] = [];

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      userSettings: {
        getCopyPerpLeverageSettings: {
          invalidate: () => invalidations.push("userSettings.getCopyPerpLeverageSettings"),
        },
      },
      copyTradeFollows: {
        list: {
          invalidate: () => invalidations.push("copyTradeFollows.list"),
        },
      },
    }),
    userSettings: {
      getCopyPerpLeverageSettings: {
        useQuery: () => queryState,
      },
      setCopyPerpMaxLeverage: {
        useMutation: (options: MutationOptions) => {
          capturedMutationOptions = options;
          return {
            ...mutationState,
            mutate: () => {},
          };
        },
      },
    },
  },
}));

const {
  CopyTradeLeverageSettings,
  parseCopyPerpLeverage,
  shouldShowCopyTradeLeverageSuccess,
} = await import(
  "./copy-trade-leverage-settings",
);

function markup(): string {
  return renderToStaticMarkup(createElement(CopyTradeLeverageSettings));
}

describe("CopyTradeLeverageSettings", () => {
  test("hides a stale saved message after the draft changes", () => {
    expect(
      shouldShowCopyTradeLeverageSuccess({
        mutationSucceeded: true,
        draftLeverage: "2",
        savedValue: 2,
      }),
    ).toBe(true);
    expect(
      shouldShowCopyTradeLeverageSuccess({
        mutationSucceeded: true,
        draftLeverage: "3",
        savedValue: 2,
      }),
    ).toBe(false);
  });

  test("accepts only bounded whole-number leverage values", () => {
    expect(parseCopyPerpLeverage("1")).toBe(1);
    expect(parseCopyPerpLeverage("100")).toBe(100);
    expect(parseCopyPerpLeverage("0")).toBeNull();
    expect(parseCopyPerpLeverage("101")).toBeNull();
    expect(parseCopyPerpLeverage("2.5")).toBeNull();
    expect(parseCopyPerpLeverage("1e2")).toBeNull();
  });

  test("renders the current global value and exact explanatory copy", () => {
    queryState.data = { globalPerpMaxLeverage: 7 };
    queryState.isLoading = false;
    mutationState.isPending = false;
    mutationState.isError = false;
    mutationState.isSuccess = false;

    const html = markup();

    expect(html).toContain("Copy-trading maximum leverage");
    expect(html).toContain('value="7"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="100"');
    expect(html).toContain('step="1"');
    expect(html).toContain(
      "Applies to every automatic perp copy. Leaders and markets can use less; no follow can use more.",
    );
  });

  test("shows a loading state before the saved value is available", () => {
    queryState.data = undefined;
    queryState.isLoading = true;
    mutationState.isPending = false;
    mutationState.isError = false;
    mutationState.isSuccess = false;

    const html = markup();

    expect(html).toContain("Loading copy-trading leverage settings");
    expect(html).toContain('data-testid="copy-trade-leverage-input"');
    expect(html).toContain("disabled");
  });

  test("keeps Save disabled when unchanged and while a save is pending", () => {
    queryState.data = { globalPerpMaxLeverage: 1 };
    queryState.isLoading = false;
    mutationState.isPending = false;
    mutationState.isError = false;
    mutationState.isSuccess = false;

    const unchanged = markup();
    expect(unchanged).toContain('data-testid="copy-trade-leverage-save"');
    expect(unchanged).toMatch(/data-testid="copy-trade-leverage-save"[^>]*disabled/);

    mutationState.isPending = true;
    const pending = markup();
    expect(pending).toContain("Saving…");
    expect(pending).toMatch(/data-testid="copy-trade-leverage-save"[^>]*disabled/);
  });

  test("renders mutation success and server error state", () => {
    queryState.data = { globalPerpMaxLeverage: 2 };
    queryState.isLoading = false;
    mutationState.isPending = false;
    mutationState.isSuccess = true;
    mutationState.isError = false;
    mutationState.error = null;
    expect(markup()).toContain("Copy-trading maximum leverage saved.");

    mutationState.isSuccess = false;
    mutationState.isError = true;
    mutationState.error = { message: "Enter a value from 1 to 100." };
    expect(markup()).toContain("Enter a value from 1 to 100.");
  });

  test("invalidates the global setting and follow list after a successful save", () => {
    queryState.data = { globalPerpMaxLeverage: 2 };
    queryState.isLoading = false;
    mutationState.isPending = false;
    mutationState.isSuccess = false;
    mutationState.isError = false;
    mutationState.error = null;
    invalidations.length = 0;

    markup();
    expect(capturedMutationOptions?.onSuccess).toBeFunction();

    capturedMutationOptions?.onSuccess?.({ globalPerpMaxLeverage: 2 });

    expect(invalidations).toEqual([
      "userSettings.getCopyPerpLeverageSettings",
      "copyTradeFollows.list",
    ]);
  });
});
