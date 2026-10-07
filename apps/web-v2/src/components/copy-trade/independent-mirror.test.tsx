import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  elementText,
  findByAriaLabel,
  flattenElements,
  type TestElement,
} from "@/testing/element-tree";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ArmMirrorDialog } from "./mirror-consent-dialogs";
import { AutoMirrorSwitch } from "./auto-mirror-switch";
import {
  IndependentFollowRow,
  DestinationArmConsentDialog,
  DestinationStopConsentDialog,
  type ConsentAsk,
} from "./manage-follows";
import {
  accountForDestination,
  accountOptionLabel,
  toAccountOptions,
  buildDestinationPatch,
  autoMirrorSwitchState,
  type AlpacaAccountOption,
  type MirrorDestination,
} from "./account-targeting";
import {
  buildDestinationArmingSummary,
  buildDestinationStopSummary,
  followUpdateToast,
  type MirrorLimits,
} from "./mirror-consent";
import {
  resolveFollowDestination,
  type DestinationFollowDraft,
} from "./use-manage-follows-state";
import type { FollowItem } from "./use-manage-follows";

const PAPER: AlpacaAccountOption = {
  id: "alpaca-paper",
  provider: "alpaca",
  accountId: "PA-123",
  accountType: "PAPER",
};

const LIVE: AlpacaAccountOption = {
  id: "alpaca-live",
  provider: "alpaca",
  accountId: "LIVE-456",
  accountType: "LIVE",
};

const HYPERLIQUID: AlpacaAccountOption = {
  id: "hyperliquid-account",
  provider: "hyperliquid",
  accountId: null,
  accountType: "LIVE",
};

const LIMITS: MirrorLimits = {
  dailyCap: 20,
  maxOrderDollars: 1_000,
  dailyCapFromDefaults: false,
  maxOrderDollarsFromDefaults: false,
};

const FOLLOW: FollowItem = {
  id: "follow-1",
  targetType: "user",
  targetKey: "trader-key",
  targetLabel: "Example Trader",
  sizingMode: "pct",
  sizingValue: 5,
  maxTradeSize: null,
  maxCoinSize: null,
  autoMirror: false,
  credentialId: null,
  credentialAccountLabel: null,
  credentialAccountType: null,
  credentialProvider: null,
  perpTakeProfitPct: 25,
  perpStopLossPct: 10,
  perpMaxLeverage: null,
  destinations: {
    stock: {
      enabled: false,
      credentialId: "alpaca-paper",
      sizingMode: "usd",
      sizingValue: 25,
    },
    perp: {
      enabled: false,
      credentialId: "hyperliquid-account",
      sizingMode: "pct",
      sizingValue: 10,
    },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function findComponent(node: unknown, component: unknown): TestElement[] {
  return flattenElements(node as never).filter((element) => element.type === component);
}

function findSelectContaining(tree: unknown, text: string): TestElement {
  const select = findComponent(tree, Select).find((element) =>
    elementText(element).includes(text),
  );
  if (!select) throw new Error(`No Select contained ${text}`);
  return select;
}

function findInput(tree: unknown, label: string): TestElement {
  const input = findByAriaLabel(tree as never, label);
  if (!input) throw new Error(`No input named ${label}`);
  return input;
}

function attributeValues(markup: string, attribute: string): string[] {
  const pattern = new RegExp(`(?:^|\\s)${attribute}="([^"]+)"`, "g");
  return Array.from(markup.matchAll(pattern), (match) => match[1]);
}

function switchProps(tree: unknown, destination: MirrorDestination): TestElement["props"] {
  const autoMirror = findComponent(tree, AutoMirrorSwitch)[destination === "stock" ? 0 : 1];
  if (!autoMirror) throw new Error(`No ${destination} switch`);
  const rendered = AutoMirrorSwitch(
    autoMirror.props as Parameters<typeof AutoMirrorSwitch>[0],
  );
  const switchComponent = findComponent(rendered, Switch)[0];
  if (!switchComponent) throw new Error(`No ${destination} switch control`);
  return { ...switchComponent.props, title: autoMirror.props.reason };
}

function renderIndependent(
  overrides: Partial<FollowItem> = {},
  options: {
    accounts?: AlpacaAccountOption[];
    globalPerpMaxLeverage?: number | null;
    drafts?: Partial<Record<MirrorDestination, DestinationFollowDraft>>;
  } = {},
) {
  const updates: Array<{ destination: MirrorDestination; config: unknown }> = [];
  const asks: ConsentAsk[] = [];
  const follow = { ...FOLLOW, ...overrides };
  const drafts = options.drafts ?? {};
  const tree = IndependentFollowRow({
    follow,
    accounts: options.accounts ?? [PAPER, LIVE, HYPERLIQUID],
    accountsLoading: false,
    buyingPower: 10_000,
    equity: 10_000,
    balancesCredentialId: null,
    limits: LIMITS,
    globalPerpMaxLeverage:
      options.globalPerpMaxLeverage === undefined ? 2 : options.globalPerpMaxLeverage,
    deploymentBlockReason: null,
    destinationDrafts: drafts,
    onDestinationDraftChange: (destination, change) => {
      const draft = drafts[destination];
      if (!draft) return;
      if (change.mode !== undefined) draft.mode = change.mode;
      if (change.value !== undefined) draft.value = change.value;
      if (change.protection) Object.assign(draft.protection, change.protection);
    },
    onDestinationUpdate: (destination, config) => updates.push({ destination, config }),
    onPerpUpdate: () => {},
    onRequestConsent: (ask) => asks.push(ask),
    disabled: false,
  });
  return { tree, follow, updates, asks, drafts };
}

describe("independent stock and perp mirror configuration", () => {
  for (const destination of ["stock", "perp"] as const) {
    for (const credentialId of [null, destination === "stock" ? PAPER.id : HYPERLIQUID.id]) {
      test(`${destination} off sizing save with ${credentialId} reports settings updated`, () => {
        const config = { ...FOLLOW.destinations![destination]!, enabled: false, credentialId };
        const { tree, updates } = renderIndependent(
          { destinations: { ...FOLLOW.destinations, [destination]: config } },
          { drafts: { [destination]: { mode: "usd", value: "123.45", protection: { stopLoss: "", takeProfit: "" } } } },
        );
        const input = findInput(tree, `${destination === "stock" ? "Stocks" : "Perps"}: Dollars per order`);
        (input.props.onKeyDown as (e: { key: string }) => void)({ key: "Enter" });
        const update = updates[0]!;
        const patch = buildDestinationPatch(destination, update.config as typeof config);
        expect(followUpdateToast({ ...patch })).toBe("Follow settings updated");
      });
    }

    for (const kind of ["destination-disarm", "destination-clear"] as const) {
      test(`${destination} ${kind} confirmation sends a scoped mutation and truthful toast`, () => {
        const follow = { ...FOLLOW, destinations: { ...FOLLOW.destinations, [destination]: { ...FOLLOW.destinations![destination]!, enabled: true } } };
        let patch: Parameters<typeof followUpdateToast>[0] | undefined;
        const dialog = DestinationStopConsentDialog({
          consent: { follow, ask: { kind, destination } }, accounts: [PAPER, HYPERLIQUID],
          mutationPending: false, onClose: () => {}, onUpdate: (_follow, next) => { patch = { ...next }; },
        });
        expect(patch).toBeUndefined();
        (dialog!.props.onConfirm as () => void)();
        expect(Object.keys(patch!.destinations!)).toEqual([destination]);
        expect(followUpdateToast(patch!)).toContain(kind === "destination-clear" ? "account cleared" : "auto-mirror stopped");
      });
    }
  }

  for (const network of ["mainnet", "testnet"] as const) {
    test(`real ${network} account response reaches picker, arm, repoint and Stop`, async () => {
      const previousNetwork = process.env.HYPERLIQUID_NETWORK;
      const previousAllow = process.env.HYPERLIQUID_ALLOW_TESTNET;
      try {
        process.env.HYPERLIQUID_NETWORK = network;
        process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
        const { userSettingsRouter } = await import("../../../../api/src/routers/user-settings");
        const caller = userSettingsRouter.createCaller({
          userId: "settings-user", session: { userId: "settings-user" },
          db: { query: { userApiCredentials: { findMany: async () => [HYPERLIQUID, { ...HYPERLIQUID, id: "new-hl" }] } } },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        } as never);
        const response = await caller.hasApiCredentials({});
        const accounts = toAccountOptions(response.accounts);
        const label = `Hyperliquid ${network} perps`;
        expect(accounts.map(accountOptionLabel)).toEqual([label, label]);
        const follow = { ...FOLLOW, destinations: { ...FOLLOW.destinations, perp: { ...FOLLOW.destinations!.perp!, credentialAccountLabel: label } } };
        const { tree } = renderIndependent(follow, { accounts });
        expect(elementText(findSelectContaining(tree, label))).toContain(label);
        for (const kind of ["destination-arm", "destination-repoint"] as const) {
          const dialog = DestinationArmConsentDialog({
            consent: { follow, ask: { kind, destination: "perp", credentialId: "new-hl" } },
            accounts, limits: LIMITS, globalPerpMaxLeverage: 2, mutationPending: false,
            onClose() {}, onUpdate() {},
          });
          expect(dialog!.props.summary.facts.find((fact: { label: string }) =>
            fact.label === (kind === "destination-repoint" ? "New account" : "Account"),
          )?.value).toBe(label);
        }
        const stop = DestinationStopConsentDialog({
          consent: { follow, ask: { kind: "destination-disarm", destination: "perp" } },
          accounts: accounts.map((account) => ({ ...account, credentialAccountLabel: null })),
          mutationPending: false, onClose() {}, onUpdate() {},
        });
        expect(JSON.stringify(stop!.props.summary)).toContain(label);
      } finally {
        if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
        else process.env.HYPERLIQUID_NETWORK = previousNetwork;
        if (previousAllow === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
        else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllow;
      }
    });
  }
  test("does not infer a missing venue from legacy auto-mirror state", () => {
    const follow = {
      ...FOLLOW,
      autoMirror: true,
      credentialId: "alpaca-paper",
      credentialProvider: "alpaca" as const,
      destinations: {
        stock: {
          enabled: true,
          credentialId: "alpaca-paper",
          sizingMode: "usd" as const,
          sizingValue: 50,
        },
      },
    } satisfies FollowItem;

    expect(resolveFollowDestination(follow, "stock").enabled).toBe(true);
    expect(resolveFollowDestination(follow, "perp")).toMatchObject({
      enabled: false,
      credentialId: null,
    });
  });

  test("preserves a saved Hyperliquid network label in destination state", () => {
    const follow = {
      ...FOLLOW,
      destinations: {
        ...FOLLOW.destinations,
        perp: {
          ...FOLLOW.destinations!.perp!,
          credentialAccountLabel: "Hyperliquid testnet perps",
        },
      },
    } satisfies FollowItem;

    expect(resolveFollowDestination(follow, "perp").credentialAccountLabel).toBe(
      "Hyperliquid testnet perps",
    );
  });

  test("renders both destinations with their own venue labels", () => {
    const { tree } = renderIndependent();
    const text = elementText(tree);

    expect(text).toContain("Stocks");
    expect(text).toContain("Alpaca stocks and options");
    expect(text).toContain("Perps");
    expect(text).toContain("Hyperliquid perpetuals");
    expect(findByAriaLabel(tree, "Stocks mirror account")).toBeDefined();
    expect(findByAriaLabel(tree, "Perps mirror account")).toBeDefined();
  });

  test("filters each account selector to its provider", () => {
    const { tree } = renderIndependent();
    const stocks = findSelectContaining(tree, "Paper account PA-123");
    const perps = findSelectContaining(tree, "Hyperliquid perps");

    expect(elementText(stocks)).toContain("Paper account PA-123");
    expect(elementText(stocks)).toContain("Live account LIVE-456");
    expect(elementText(stocks)).not.toContain("Hyperliquid perps");
    expect(elementText(perps)).toContain("Hyperliquid perps");
    expect(elementText(perps)).not.toContain("Paper account PA-123");
  });

  test("account changes and sizing saves address only the destination that changed", () => {
    const drafts: Partial<Record<MirrorDestination, DestinationFollowDraft>> = {
      stock: {
        mode: null,
        value: "25",
        protection: { stopLoss: "", takeProfit: "" },
      },
      perp: {
        mode: "usd",
        value: "",
        protection: { stopLoss: "10", takeProfit: "25" },
      },
    };
    const { tree, updates } = renderIndependent(
      {
        destinations: {
          stock: { ...FOLLOW.destinations!.stock!, credentialId: null },
          perp: FOLLOW.destinations!.perp,
        },
      },
      { drafts },
    );

    const stockAccount = findSelectContaining(tree, "Paper account PA-123");
    (stockAccount.props.onValueChange as (value: string) => void)(PAPER.id);
    expect(updates[0]).toEqual({
      destination: "stock",
      config: {
        enabled: false,
        credentialId: PAPER.id,
        credentialAccountLabel: "Paper account PA-123",
        sizingMode: "usd",
        sizingValue: 25,
      },
    });

    const perpInput = findInput(tree, "Perps: Dollars per order");
    (perpInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "100" },
    });
    (perpInput.props.onKeyDown as (event: { key: string }) => void)({ key: "Enter" });

    expect(updates[1]).toEqual({
      destination: "perp",
      config: {
        enabled: false,
        credentialId: HYPERLIQUID.id,
        sizingMode: "usd",
        sizingValue: 100,
      },
    });
    expect(updates).toHaveLength(2);
  });

  test("does not arm a destination with no account", () => {
    const { tree, asks, updates } = renderIndependent({
      destinations: {
        stock: { ...FOLLOW.destinations!.stock!, credentialId: null },
        perp: { ...FOLLOW.destinations!.perp!, credentialId: null },
      },
    });

    expect(switchProps(tree, "stock").disabled).toBe(true);
    expect(switchProps(tree, "perp").disabled).toBe(true);
    expect(asks).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("preserves the source-quantity requirement for caller ratio sizing", () => {
    const { tree } = renderIndependent({
      targetType: "x_author",
      destinations: {
        stock: { ...FOLLOW.destinations!.stock!, sizingMode: "ratio" },
        perp: FOLLOW.destinations!.perp,
      },
    });

    expect(switchProps(tree, "stock").disabled).toBe(true);
    expect(elementText(tree)).toContain("source trader's quantity");
  });

  test("keeps an armed destination stoppable when its credential or readiness disappears", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: "deleted-credential",
      credentialAvailable: false,
      destinationProvider: "hyperliquid",
      globalPerpMaxLeverage: null,
    });

    expect(state.interactive).toBe(true);
    expect(state.reason).toContain("unavailable");
  });

  test("asks to stop only the missing destination and does not require readiness", () => {
    const { tree, asks } = renderIndependent(
      {
        destinations: {
          stock: FOLLOW.destinations!.stock,
          perp: {
            ...FOLLOW.destinations!.perp!,
            enabled: true,
            credentialId: "deleted-credential",
          },
        },
      },
      { accounts: [PAPER], globalPerpMaxLeverage: null },
    );

    const perpSwitch = findComponent(tree, AutoMirrorSwitch)[1];
    expect(switchProps(tree, "perp").disabled).toBe(false);
    const onRequestDisarm = perpSwitch?.props.onRequestDisarm;
    if (typeof onRequestDisarm !== "function") {
      throw new Error("No perp mirror switch disarm handler");
    }
    onRequestDisarm();

    expect(asks).toEqual([{ kind: "destination-disarm", destination: "perp" }]);
  });

  test("blocks only unarmed perp arming when leverage is missing or invalid", () => {
    const missing = renderIndependent({}, { globalPerpMaxLeverage: null });
    expect(switchProps(missing.tree, "stock").disabled).toBe(false);
    expect(switchProps(missing.tree, "perp").disabled).toBe(true);
    expect(switchProps(missing.tree, "perp").title).toContain("valid global");

    const invalid = renderIndependent(
      { perpMaxLeverage: 4 },
      { globalPerpMaxLeverage: 2 },
    );
    expect(switchProps(invalid.tree, "perp").disabled).toBe(true);
    expect(switchProps(invalid.tree, "perp").title).toContain("invalid");

    const armed = renderIndependent(
      {
        perpMaxLeverage: 4,
        destinations: {
          stock: FOLLOW.destinations!.stock,
          perp: { ...FOLLOW.destinations!.perp!, enabled: true },
        },
      },
      { globalPerpMaxLeverage: null },
    );
    expect(
      autoMirrorSwitchState({
        supported: true,
        pending: false,
        autoMirror: true,
        credentialId: HYPERLIQUID.id,
        destinationProvider: "hyperliquid",
        globalPerpMaxLeverage: null,
        leverageInvalid: true,
      }).interactive,
    ).toBe(true);
    expect(switchProps(armed.tree, "perp").disabled).toBe(false);
  });

  test("arming confirmation names the exact venue, account, size, protection, and risk", () => {
    const summary = buildDestinationArmingSummary({
      trader: "Example Trader",
      destination: "perp",
      account: accountOptionLabel(HYPERLIQUID),
      sizingMode: "usd",
      sizingValue: 250,
      perpProtection: { stopLossPct: 10, takeProfitPct: 25 },
      globalPerpMaxLeverage: 2,
      followPerpMaxLeverage: null,
      limits: LIMITS,
    });
    const text = elementText(
      ArmMirrorDialog({
        open: true,
        onOpenChange: () => {},
        summary,
        onConfirm: () => {},
      }),
    );

    expect(text).toContain("Hyperliquid perpetuals");
    expect(text).toContain("Hyperliquid perps");
    expect(text).toContain("$250.00 of notional");
    expect(text).toContain("Protection");
    expect(text).toContain("liquidated");
    expect(text).toContain("Turning this off later stops new orders");
  });

  test("stop confirmation names the destination and leaves the risk open", () => {
    const summary = buildDestinationStopSummary({
      kind: "disarm",
      destination: "stock",
      trader: "Example Trader",
      account: accountOptionLabel(PAPER),
      sizingMode: "usd",
      sizingValue: 25,
    });

    const text = summary.points.join(" ");
    expect(summary.title).toContain("automatic stock orders");
    expect(text).toContain("Alpaca stocks and options");
    expect(text).toContain("Paper account PA-123");
    expect(text).toContain("$25.00 of notional");
    expect(text).toContain("No automatic take-profit or stop-loss controls");
    expect(text).toContain("does not sell or close them");
  });

  test("does not borrow a terminal account when neither destination has one", () => {
    const accounts = [PAPER, LIVE, HYPERLIQUID];
    const destination = accountForDestination("stock", null, accounts);
    expect(destination).toBeNull();

    const { tree } = renderIndependent({
      destinations: {
        stock: { ...FOLLOW.destinations!.stock!, credentialId: null },
        perp: { ...FOLLOW.destinations!.perp!, credentialId: null },
      },
    });
    expect(elementText(tree)).toContain("No user-owned account selected");
    expect(elementText(tree)).not.toContain("Selected: Live account LIVE-456");
  });

  test("keeps the independent editor bounded for a 375px drawer", () => {
    const { tree } = renderIndependent();
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('data-independent-mirror="true"');
    expect(html).toContain("min-w-0");
    expect(html).toContain("max-w-full");
    expect(html).not.toContain("min-w-44");
    expect(html).not.toContain("min-w-52");
    expect(html).toContain("w-full");
  });

  test("names every follow destination namespace uniquely in rendered markup", () => {
    const first = renderIndependent().tree;
    const second = renderIndependent({ id: "follow-2" }).tree;
    const html = renderToStaticMarkup(
      <>
        {first}
        {second}
      </>,
    );
    const ids = attributeValues(html, "id");
    const labelledBy = attributeValues(html, "aria-labelledby");

    expect(new Set(ids).size).toBe(ids.length);
    for (const target of labelledBy) {
      expect(ids.filter((id) => id === target)).toHaveLength(1);
    }
    expect(ids).toContain("follow-1-stock-mirror-heading");
    expect(ids).toContain("follow-1-perp-mirror-heading");
    expect(ids).toContain("follow-2-stock-mirror-heading");
    expect(ids).toContain("follow-2-perp-mirror-heading");
  });
});
