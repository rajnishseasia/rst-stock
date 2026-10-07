/**
 * copyTrade.mirrorStatus: does the API tell the truth about auto-mirroring?
 *
 * Three things are under test, all against the real modules:
 *
 *  1. HONESTY. The auto-mirror flags are set on the WORKER deployment. The API
 *     is a different process with a different env, so an absent flag means "this
 *     process was not told", not "auto-mirror is off". The status must say
 *     unknown in that case instead of reporting a confident false. That holds
 *     per variable, not per process: mirroring one variable onto the API must
 *     not turn its absent neighbours into confident falses.
 *
 *  2. PARITY. The API must gate on the same reader functions the worker gates
 *     on. Both implementations exist while the worker still declares its own
 *     copies, so every reader is run side by side over the full value matrix.
 *     If somebody loosens one side ("true" vs truthy, say), this fails.
 *
 *  3. MONEY NUMBERS. The caps come from the shared DEFAULT_MIRROR_* constants,
 *     never from literals re-typed into the router.
 */

import { describe, expect, it, mock } from "bun:test";

// `protectedProcedure` runs a per-user rate limiter (60 calls / 10s) against a
// Redis client that is process-wide. In a whole-suite run the other API test
// files call procedures as the same "user-1" and burn that budget, so the three
// procedure cases below failed with TOO_MANY_REQUESTS while passing on their
// own. Stubbing the client is what the neighbouring router tests already do
// (see copy-trade-follows.test.ts); nothing here is testing the limiter.
mock.module("@trade-bot/redis", () => ({
  getRedisClient: async () => ({ incrWithTtl: async () => 1 }),
}));

import {
  resolveMirrorStatus,
  hasAutoMirrorEnvVar,
  isAutoMirrorEnabled,
  isAutoMirrorLiveAllowed,
  isPerpsMainnetAllowed,
  isHyperliquidNetworkExplicit,
  resolveExplicitHyperliquidNetwork,
  readPerpsAutoMirrorFlag,
  isPerpReconcilerEnabled,
  isPerpsAutoMirrorEnabled,
  resolveGuardrails,
  AUTOMIRROR_ENV_VARS,
  DEFAULT_MIRROR_DAILY_CAP,
  DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
  type AutoMirrorEnvVar,
  type MirrorEnv,
  type MirrorStatus,
} from "../lib/copy-mirror.js";
import { copyTradeRouter } from "../routers/copy-trade.js";

// The worker's own copies of the same readers. Imported so the two can be run
// against identical inputs; the worker path is the one the poller actually gates
// on, so if these ever disagree the API is lying about real money.
import {
  isAutoMirrorEnabled as workerIsAutoMirrorEnabled,
  isAutoMirrorLiveAllowed as workerIsAutoMirrorLiveAllowed,
  isPerpsMainnetAllowed as workerIsPerpsMainnetAllowed,
  isHyperliquidNetworkExplicit as workerIsHyperliquidNetworkExplicit,
  resolveGuardrails as workerResolveGuardrails,
} from "../../../worker/src/services/copy-mirror";
import {
  readPerpsAutoMirrorFlag as workerReadPerpsAutoMirrorFlag,
  isPerpReconcilerEnabled as workerIsPerpReconcilerEnabled,
  isPerpsAutoMirrorEnabled as workerIsPerpsAutoMirrorEnabled,
} from "../../../worker/src/services/copy-mirror-perp-sync-gate";

/** Every shape a boolean-ish env var realistically arrives in. */
const BOOLEAN_VALUES: (string | undefined)[] = [
  undefined,
  "",
  "true",
  "false",
  "TRUE",
  "True",
  "1",
  "0",
  "yes",
  " true",
  "true ",
];

/** Values a numeric override arrives in, including the hostile ones. */
const NUMERIC_VALUES: (string | undefined)[] = [
  undefined,
  "",
  " ",
  "0",
  "1",
  "3",
  "3.5",
  "-2",
  "20",
  "1e3",
  "abc",
  "NaN",
  "Infinity",
];

/** The flag-derived fields of a status, i.e. everything except `defaults`. */
type FlagField = Exclude<keyof MirrorStatus, "defaults" | "visibility">;

/**
 * Each auto-mirror variable, the ONE status field it decides, a value it
 * realistically arrives with, and what that value must resolve to.
 *
 * The point of the table is the negative case: with a single entry's variable
 * set, every OTHER field here has to be null. `network` is listed with no
 * variable of its own because it is decided by HYPERLIQUID_NETWORK, which is
 * absent in these envs, so it must stay null throughout.
 */
const OWN_VARIABLE: {
  name: AutoMirrorEnvVar;
  field: FlagField;
  on: string;
  expected: boolean | number;
  /** A value for the same variable that resolves to the OFF/floor answer. */
  off: string;
  expectedOff: boolean | number;
}[] = [
  {
    name: "COPY_TRADE_AUTOMIRROR_ENABLED",
    field: "enabled",
    on: "true",
    expected: true,
    off: "false",
    expectedOff: false,
  },
  {
    name: "COPY_TRADE_AUTOMIRROR_ALLOW_LIVE",
    field: "allowLive",
    on: "true",
    expected: true,
    off: "false",
    expectedOff: false,
  },
  {
    name: "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
    field: "perpsEnabled",
    on: "true",
    expected: true,
    off: "false",
    expectedOff: false,
  },
  {
    name: "COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET",
    field: "perpsMainnetAllowed",
    on: "true",
    expected: true,
    off: "false",
    expectedOff: false,
  },
  {
    name: "COPY_TRADE_AUTOMIRROR_DAILY_CAP",
    field: "dailyCap",
    on: "7",
    expected: 7,
    off: "-1",
    expectedOff: DEFAULT_MIRROR_DAILY_CAP,
  },
  {
    name: "COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS",
    field: "maxOrderDollars",
    on: "250",
    expected: 250,
    off: "abc",
    expectedOff: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
  },
];

/** Every flag-derived field, including the one no auto-mirror variable owns. */
const ALL_FLAG_FIELDS: FlagField[] = [...OWN_VARIABLE.map((entry) => entry.field), "network"];

function createLogger() {
  return {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  };
}

function createCaller() {
  return copyTradeRouter.createCaller({
    db: {} as never,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: createLogger(),
  } as never);
}

/**
 * Run `fn` with `process.env` replaced by exactly `env` for the auto-mirror and
 * Hyperliquid vars, then restore. The ambient test env may legitimately carry
 * some of these, and the whole point of the procedure is what it does with an
 * absence, so the absence has to be real.
 */
async function withEnv(env: MirrorEnv, fn: () => Promise<void> | void): Promise<void> {
  const managed = [
    ...AUTOMIRROR_ENV_VARS,
    "HYPERLIQUID_NETWORK",
    "HYPERLIQUID_ALLOW_TESTNET",
    "HYPERLIQUID_SYNC_ENABLED",
  ];
  const saved = new Map<string, string | undefined>();
  for (const name of managed) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("resolveMirrorStatus: absent configuration is unknown, not disabled", () => {
  it("reports every flag as null when this process carries no auto-mirror env", () => {
    const status = resolveMirrorStatus({});

    expect(status.visibility).toBe("unknown");
    expect(status.enabled).toBeNull();
    expect(status.allowLive).toBeNull();
    expect(status.perpsEnabled).toBeNull();
    expect(status.perpsMainnetAllowed).toBeNull();
    expect(status.network).toBeNull();
    expect(status.dailyCap).toBeNull();
    expect(status.maxOrderDollars).toBeNull();
  });

  it("never reports `enabled: false` from an absence", () => {
    // The failure this guards against: reading process.env on the API, finding
    // nothing, and telling the user auto-mirror is off while the worker runs it.
    expect(resolveMirrorStatus({}).enabled).not.toBe(false);
  });

  it("still exposes the compiled-in defaults when visibility is unknown", () => {
    const status = resolveMirrorStatus({});

    expect(status.defaults).toEqual({
      dailyCap: DEFAULT_MIRROR_DAILY_CAP,
      maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    });
  });

  it("treats a declared-but-empty var as absent", () => {
    const name = "COPY_TRADE_AUTOMIRROR_ENABLED";
    expect(hasAutoMirrorEnvVar(name, {})).toBe(false);
    expect(hasAutoMirrorEnvVar(name, { [name]: "" })).toBe(false);
    expect(hasAutoMirrorEnvVar(name, { [name]: "false" })).toBe(true);
    expect(resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_ENABLED: "" }).visibility).toBe("unknown");
    expect(resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_ENABLED: "" }).enabled).toBeNull();
  });

  it("decides presence per variable, so an empty cap does not hide a set master switch", () => {
    const status = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_DAILY_CAP: "",
    });
    expect(status.enabled).toBe(true);
    expect(status.dailyCap).toBeNull();
  });
});

describe("resolveMirrorStatus: a partly mirrored configuration reports only what it has", () => {
  // The bug this pins: visibility used to be computed across the WHOLE set, so
  // one present variable made every absent one read as a hard false. Mirroring
  // COPY_TRADE_AUTOMIRROR_DAILY_CAP alone onto the API made it announce
  // `enabled: false`, and the UI then told users auto-mirroring was off and
  // refused to arm follows, while the worker was running them.

  it("keeps every other flag unknown when exactly one variable is present", () => {
    for (const entry of OWN_VARIABLE) {
      const status = resolveMirrorStatus({ [entry.name]: entry.on });

      expect(status[entry.field]).toBe(entry.expected);
      for (const field of ALL_FLAG_FIELDS) {
        if (field === entry.field) continue;
        expect(status[field]).toBeNull();
      }
    }
  });

  it("does not promote an absent variable to false when a neighbour is switched off", () => {
    for (const entry of OWN_VARIABLE) {
      const status = resolveMirrorStatus({ [entry.name]: entry.off });

      expect(status[entry.field]).toBe(entry.expectedOff);
      for (const field of ALL_FLAG_FIELDS) {
        if (field === entry.field) continue;
        expect(status[field]).toBeNull();
        expect(status[field]).not.toBe(false);
      }
    }
  });

  it("reports the cap and nothing else when only the daily cap was mirrored", () => {
    const status = resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_DAILY_CAP: "7" });

    expect(status.dailyCap).toBe(7);
    expect(status.enabled).toBeNull();
    expect(status.enabled).not.toBe(false);
    expect(status.visibility).toBe("unknown");
  });

  it("ties visibility to the master switch's OWN variable", () => {
    // Present: the master switch is a real answer, whatever the rest looks like.
    expect(resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_ENABLED: "false" }).visibility).toBe(
      "visible",
    );

    // Absent: everything else can be configured and it is still unknown.
    const withoutMaster: MirrorEnv = {};
    for (const entry of OWN_VARIABLE) {
      if (entry.name === "COPY_TRADE_AUTOMIRROR_ENABLED") continue;
      withoutMaster[entry.name] = entry.on;
    }
    const status = resolveMirrorStatus(withoutMaster);
    expect(status.visibility).toBe("unknown");
    expect(status.enabled).toBeNull();
    expect(status.allowLive).toBe(true);
    expect(status.dailyCap).toBe(7);
  });

  it("covers every variable the module declares", () => {
    // A new COPY_TRADE_AUTOMIRROR_* var must be given its own field and row
    // here, otherwise it silently escapes the per-variable contract above.
    expect(OWN_VARIABLE.map((entry) => entry.name).sort()).toEqual([...AUTOMIRROR_ENV_VARS].sort());
  });
});

describe("resolveMirrorStatus: a real configuration is reported as-is", () => {
  it("reports a fully armed deployment", () => {
    const status = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "true",
      COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      COPY_TRADE_AUTOMIRROR_DAILY_CAP: "7",
      COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: "250",
      HYPERLIQUID_NETWORK: "mainnet",
    });

    expect(status).toEqual({
      visibility: "visible",
      enabled: true,
      allowLive: true,
      perpsEnabled: true,
      perpsMainnetAllowed: true,
      network: "mainnet",
      dailyCap: 7,
      maxOrderDollars: 250,
      defaults: {
        dailyCap: DEFAULT_MIRROR_DAILY_CAP,
        maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
      },
    });
  });

  it("reports a cap the deployment configured, matching what the worker would apply", () => {
    const env = {
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_DAILY_CAP: "7",
      COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: "250",
    };
    const status = resolveMirrorStatus(env);

    // The same numbers the worker would apply to the same env.
    const workerCaps = workerResolveGuardrails(env);
    expect(status.dailyCap).toBe(workerCaps.dailyCap);
    expect(status.maxOrderDollars).toBe(workerCaps.maxOrderDollars);
  });

  it("leaves an unconfigured cap null and exposes the shared constants as defaults", () => {
    // The compiled-in fallback is what the process APPLYING the caps uses. It
    // is not a configuration this process was handed, so it is reported under
    // `defaults` (from the shared constants, never re-typed literals) and the
    // field itself stays null.
    const status = resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_ENABLED: "true" });

    expect(status.dailyCap).toBeNull();
    expect(status.maxOrderDollars).toBeNull();
    expect(status.defaults).toEqual({
      dailyCap: DEFAULT_MIRROR_DAILY_CAP,
      maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    });
    // And the defaults are the ones the worker falls back to for the same env.
    const workerCaps = workerResolveGuardrails({ COPY_TRADE_AUTOMIRROR_ENABLED: "true" });
    expect(status.defaults.dailyCap).toBe(workerCaps.dailyCap);
    expect(status.defaults.maxOrderDollars).toBe(workerCaps.maxOrderDollars);
  });

  it("reports perps as off when the reconciler was switched off under them", () => {
    // The opt-in is necessary but not sufficient: without the reconciler a perp
    // mirror can be opened and never sized or resolved, so the worker refuses.
    const status = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
      HYPERLIQUID_SYNC_ENABLED: "false",
    });

    expect(status.perpsEnabled).toBe(false);
    expect(status.enabled).toBe(true);
  });

  it("reports no network when HYPERLIQUID_NETWORK was never set", () => {
    // The venue package hard-defaults to mainnet. Passing that default through
    // would announce "mainnet" for a deployment nobody configured.
    const status = resolveMirrorStatus({ COPY_TRADE_AUTOMIRROR_ENABLED: "true" });
    expect(status.network).toBeNull();
  });

  it("reports testnet only with the explicit testnet opt-in", () => {
    const withoutOptIn = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      HYPERLIQUID_NETWORK: "testnet",
    });
    expect(withoutOptIn.network).toBeNull();

    const withOptIn = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      HYPERLIQUID_NETWORK: "testnet",
      HYPERLIQUID_ALLOW_TESTNET: "true",
    });
    expect(withOptIn.network).toBe("testnet");
  });

  it("does not widen a cap from a hostile override", () => {
    const status = resolveMirrorStatus({
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_DAILY_CAP: "-1",
      COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: "abc",
    });

    expect(status.dailyCap).toBe(DEFAULT_MIRROR_DAILY_CAP);
    expect(status.maxOrderDollars).toBe(DEFAULT_MIRROR_MAX_ORDER_DOLLARS);
  });
});

describe("API and worker read the flags identically", () => {
  it("agrees on the master kill switch across the value matrix", () => {
    for (const value of BOOLEAN_VALUES) {
      const env = { COPY_TRADE_AUTOMIRROR_ENABLED: value };
      expect(isAutoMirrorEnabled(env)).toBe(workerIsAutoMirrorEnabled(env));
    }
  });

  it("agrees on the live-account opt-in across the value matrix", () => {
    for (const value of BOOLEAN_VALUES) {
      const env = { COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: value };
      expect(isAutoMirrorLiveAllowed(env)).toBe(workerIsAutoMirrorLiveAllowed(env));
    }
  });

  it("agrees on the perps mainnet opt-in across the value matrix", () => {
    for (const value of BOOLEAN_VALUES) {
      const env = { COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: value };
      expect(isPerpsMainnetAllowed(env)).toBe(workerIsPerpsMainnetAllowed(env));
    }
  });

  it("agrees on the raw perps flag and the reconciler precondition", () => {
    for (const perps of BOOLEAN_VALUES) {
      for (const sync of BOOLEAN_VALUES) {
        const env = {
          COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: perps,
          HYPERLIQUID_SYNC_ENABLED: sync,
        };
        expect(readPerpsAutoMirrorFlag(env)).toBe(workerReadPerpsAutoMirrorFlag(env));
        expect(isPerpReconcilerEnabled(env)).toBe(workerIsPerpReconcilerEnabled(env));
        expect(isPerpsAutoMirrorEnabled(env)).toBe(workerIsPerpsAutoMirrorEnabled(env));
      }
    }
  });

  it("agrees on whether the Hyperliquid network was explicitly chosen", () => {
    for (const network of [undefined, "", "mainnet", "testnet", "MAINNET", "devnet"]) {
      for (const allowTestnet of BOOLEAN_VALUES) {
        const env = { HYPERLIQUID_NETWORK: network, HYPERLIQUID_ALLOW_TESTNET: allowTestnet };
        expect(isHyperliquidNetworkExplicit(env)).toBe(workerIsHyperliquidNetworkExplicit(env));
        // The reported network is never a value the predicate calls implicit.
        const resolved = resolveExplicitHyperliquidNetwork(env);
        expect(resolved === null).toBe(!workerIsHyperliquidNetworkExplicit(env));
      }
    }
  });

  it("agrees on both dollar guardrails across the value matrix", () => {
    for (const dailyCap of NUMERIC_VALUES) {
      for (const maxOrder of NUMERIC_VALUES) {
        const env = {
          COPY_TRADE_AUTOMIRROR_DAILY_CAP: dailyCap,
          COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: maxOrder,
        };
        expect(resolveGuardrails(env)).toEqual(workerResolveGuardrails(env));
      }
    }
  });

});

describe("copyTrade.mirrorStatus procedure", () => {
  it("is exposed on the router", () => {
    expect(Object.keys(copyTradeRouter._def.procedures)).toContain("mirrorStatus");
  });

  it("returns unknown when the API process has none of the worker's flags", async () => {
    await withEnv({}, async () => {
      const status = await createCaller().mirrorStatus();
      expect(status.visibility).toBe("unknown");
      expect(status.enabled).toBeNull();
      expect(status.dailyCap).toBeNull();
      expect(status.defaults.dailyCap).toBe(DEFAULT_MIRROR_DAILY_CAP);
    });
  });

  it("reports the process env when the flags ARE present", async () => {
    await withEnv(
      {
        COPY_TRADE_AUTOMIRROR_ENABLED: "true",
        COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "false",
        COPY_TRADE_AUTOMIRROR_DAILY_CAP: "3",
      },
      async () => {
        const status = await createCaller().mirrorStatus();
        expect(status.visibility).toBe("visible");
        expect(status.enabled).toBe(true);
        expect(status.allowLive).toBe(false);
        expect(status.dailyCap).toBe(3);
        // Never mirrored onto this process, so unknown rather than "off"/"default".
        expect(status.perpsEnabled).toBeNull();
        expect(status.maxOrderDollars).toBeNull();
        expect(status.defaults.maxOrderDollars).toBe(DEFAULT_MIRROR_MAX_ORDER_DOLLARS);
      },
    );
  });

  it("never leaks an env VALUE, only the resolved decision", async () => {
    await withEnv(
      {
        COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      },
      async () => {
        const status = await createCaller().mirrorStatus();
        const keys = Object.keys(status).sort();
        expect(keys).toEqual([
          "allowLive",
          "dailyCap",
          "defaults",
          "enabled",
          "maxOrderDollars",
          "network",
          "perpsEnabled",
          "perpsMainnetAllowed",
          "visibility",
        ]);
        // No env var NAME or raw string value rides along in the payload.
        const serialized = JSON.stringify(status);
        for (const name of AUTOMIRROR_ENV_VARS) {
          expect(serialized).not.toContain(name);
        }
      },
    );
  });
});

describe("copyTrade.recentFailures procedure", () => {
  it("returns a user-safe, follower-scoped leverage cancellation", async () => {
    let whereSeen: unknown;
    const caller = copyTradeRouter.createCaller({
      db: {
        query: {
          copyMirrorDeliveries: {
            findMany: async (query: { where: unknown }) => {
              whereSeen = query.where;
              return [{
                id: "delivery-1",
                candidate: {
                  symbol: "HYPE",
                  copySourceLabel: "SOL Decoder",
                  perpLeverage: 2,
                  perpMarginMode: "cross",
                },
                lastError: "raw error must not be exposed",
                completedAt: new Date("2026-09-14T05:19:13.303Z"),
                notificationReadAt: null,
              }];
            },
          },
        },
      } as never,
      session: { userId: "user-1" },
      userId: "user-1",
      logger: createLogger(),
    } as never);

    const failures = await caller.recentFailures();

    expect(whereSeen).toBeDefined();
    expect(failures).toEqual([{
      id: "delivery-1",
      symbol: "HYPE",
      sourceLabel: "SOL Decoder",
      completedAt: "2026-09-14T05:19:13.303Z",
      readAt: null,
      message:
        "HYPE copy from SOL Decoder was canceled. We couldn't confirm 2× cross leverage with Hyperliquid, so no order was placed. Your funds were not affected.",
    }]);
  });
});

describe("copyTrade.recentNotifications procedure", () => {
  it("merges recent fills with copy failures in newest-first order", async () => {
    const caller = copyTradeRouter.createCaller({
      db: {
        query: {
          orders: {
            findMany: async () => [{
              id: "11111111-1111-4111-8111-111111111111",
              symbol: "LIT",
              tradeAction: "Buy",
              executedQuantity: 12,
              executedSizeDecimal: "12.5",
              executedPrice: "3.25",
              executedAt: new Date("2026-09-16T17:31:52.852Z"),
              notificationReadAt: null,
            }],
          },
          copyMirrorDeliveries: {
            findMany: async () => [{
              id: "22222222-2222-4222-8222-222222222222",
              candidate: {
                symbol: "HYPE",
                copySourceLabel: "SOL Decoder",
                perpLeverage: 2,
                perpMarginMode: "cross",
              },
              completedAt: new Date("2026-09-16T18:00:00.000Z"),
              notificationReadAt: new Date("2026-09-16T18:01:00.000Z"),
            }],
          },
        },
      } as never,
      session: { userId: "user-1" },
      userId: "user-1",
      logger: createLogger(),
    } as never);

    expect(await caller.recentNotifications()).toEqual([
      {
        kind: "copy_failure",
        id: "22222222-2222-4222-8222-222222222222",
        symbol: "HYPE",
        occurredAt: "2026-09-16T18:00:00.000Z",
        readAt: "2026-09-16T18:01:00.000Z",
        message:
          "HYPE copy from SOL Decoder was canceled. We couldn't confirm 2× cross leverage with Hyperliquid, so no order was placed. Your funds were not affected.",
      },
      {
        kind: "fill",
        id: "11111111-1111-4111-8111-111111111111",
        symbol: "LIT",
        occurredAt: "2026-09-16T17:31:52.852Z",
        readAt: null,
        message: "LIT buy filled: 12.5 LIT at $3.25.",
      },
    ]);
  });

  it("marks all unread fill and copy-failure notifications as read", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const returnedRows = [
      [{ id: "11111111-1111-4111-8111-111111111111" }],
      [{ id: "22222222-2222-4222-8222-222222222222" }],
    ];
    let updateIndex = 0;
    const caller = copyTradeRouter.createCaller({
      db: {
        update: () => {
          const index = updateIndex++;
          return {
            set: (values: Record<string, unknown>) => {
              updates.push(values);
              return {
                where: () => ({
                  returning: async () => returnedRows[index],
                }),
              };
            },
          };
        },
      } as never,
      session: { userId: "user-1" },
      userId: "user-1",
      logger: createLogger(),
    } as never);

    expect(await caller.markAllNotificationsRead()).toEqual({ markedRead: 2 });
    expect(updates).toHaveLength(2);
    expect(updates[0]?.notificationReadAt).toBeInstanceOf(Date);
    expect(updates[1]?.notificationReadAt).toEqual(updates[0]?.notificationReadAt);
  });
});
