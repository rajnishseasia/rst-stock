/**
 * Copy-Mirror Poller — decision-logic unit tests.
 *
 * These tests exercise the PURE decision surface of the auto-mirror service
 * (decideMirror / the env-flag gates / guardrail resolution) without touching a
 * real broker or DB. They lock in the safety-critical behaviors:
 *
 *   - the kill switch (COPY_TRADE_AUTOMIRROR_ENABLED) is off by default
 *   - paper-first: LIVE accounts are skipped unless explicitly allowed
 *   - idempotency: a duplicate source trade is skipped
 *   - the daily + per-order dollar caps skip over-limit candidates
 *   - the happy path computes the expected qty + deterministic client_order_id
 *
 * No CopyMirrorPoller instance is started here — start() would schedule timers
 * and (when enabled) read the DB; the gates are validated via the exported pure
 * functions instead, which is exactly what start() consults.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  clampSellToMirroredExposure,
  decideMirror,
  decidePerpMirror,
  decidePerpReduceOnlyMirror,
  decideSellMirrorQty,
  isHyperliquidMainnet,
  isHyperliquidNetworkExplicit,
  isMirrorableAsset,
  isAutoMirrorEnabled,
  isAutoMirrorLiveAllowed,
  isPerpsAutoMirrorEnabled,
  isPerpsMainnetAllowed,
  netMirroredEquityQty,
  resolveGuardrails,
  CopyMirrorPoller,
  type MirrorCandidate,
  type MirroredEquityOrderRow,
  type MirrorSourceCandidate,
} from "../copy-mirror";
import {
  computeMirrorQty,
  mirrorIdempotencyKey,
  DEFAULT_MIRROR_DAILY_CAP,
  DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
} from "../../../../api/src/lib/copy-mirror";
import { traderKey } from "../../../../api/src/lib/trader-identity";
import { schema } from "@trade-bot/db";
import { createBrokerClientOrderId } from "@trade-bot/alpaca";
import { HyperliquidOrderRejectedError, toCloid } from "@trade-bot/hyperliquid";
import { resolveMirrorAuthorMatchKeys } from "../copy-mirror-candidate-sources";
import { resolveEffectivePerpLeverage } from "../copy-mirror-perp-leverage";

/**
 * Perp mirroring has a PRECONDITION beyond its opt-in flag: the Hyperliquid
 * reconciler (HYPERLIQUID_SYNC_ENABLED) must be on, or every perp path refuses.
 * The tests in this file are about the OTHER perp gates, so the precondition is
   * satisfied for the whole file. The refusal itself is asserted directly, against
   * explicit env objects, in "perps safety flags" below and in
 * copy-mirror-perp-sync-gate.test.ts.
 */
const previousSyncFlag = process.env.HYPERLIQUID_SYNC_ENABLED;
beforeAll(() => {
  process.env.HYPERLIQUID_SYNC_ENABLED = "true";
});
afterAll(() => {
  if (previousSyncFlag === undefined) delete process.env.HYPERLIQUID_SYNC_ENABLED;
  else process.env.HYPERLIQUID_SYNC_ENABLED = previousSyncFlag;
});

/**
 * The live follow row the perp path re-reads before placing. Consent is checked
 * against the DATABASE at execution time, not against the frozen candidate, so
 * every perp test that expects an order has to supply one that still says yes.
 */
const LIVE_FOLLOW = {
  id: "44444444-4444-4444-8444-444444444444",
  followerUserId: "follower-perp",
  autoMirror: true,
  credentialId: "11111111-1111-4111-8111-111111111111",
  destinationPolicyInitialized: true,
  stockAutoMirror: true,
  stockCredentialId: "11111111-1111-4111-8111-111111111111",
  stockSizingMode: "usd",
  stockSizingValue: "500",
  perpAutoMirror: true,
  perpCredentialId: "11111111-1111-4111-8111-111111111111",
  perpSizingMode: "usd",
  perpSizingValue: "500",
  perpMaxLeverage: null,
  copyPerpMaxLeverage: 50,
};

/** Add a deterministic transaction/row-lock trace to a lightweight worker DB. */
function addPolicyTransactionTrace(
  db: Record<string, any>,
  events: string[],
  follow: Record<string, unknown> = LIVE_FOLLOW,
  lockedFollow: Record<string, unknown> = follow,
  recordOrderLock = false,
) {
  let policyTransactionActive = false;
  const baseSelect = db.select;
  db.select = (projection?: Record<string, unknown>) => {
    const keys = projection ? Object.keys(projection) : [];
    const isOrderPolicy = keys.includes("clientOrderId") && keys.includes("status");
    const isUserPolicy = keys.includes("copyPerpMaxLeverage") &&
      !keys.includes("currentUserMaxLeverage");
    const isFollowPolicy = keys.includes("currentUserMaxLeverage") ||
      keys.includes("currentFollowMaxLeverage") ||
      keys.includes("perpMaxLeverage");
    const isCredentialPolicy = keys.includes("provider") && keys.includes("accountType");
    const isPhaseUserProjection = keys.length === 1 && keys.includes("id");
    if (!isUserPolicy && !isFollowPolicy && !isCredentialPolicy && !isOrderPolicy && !isPhaseUserProjection) return baseSelect(projection);

    // The initial policy read happens before the locked transaction and must
    // see `follow`; the callback's locked reread must see `lockedFollow`.
    const policyFollow = policyTransactionActive ? lockedFollow : follow;
    const rows = isOrderPolicy
      ? [{ id: "policy-order", status: "PENDING" }]
      : isUserPolicy
      ? [{ id: policyFollow.followerUserId, copyPerpMaxLeverage: policyFollow.copyPerpMaxLeverage }]
      : isCredentialPolicy
        ? [{ id: policyFollow.credentialId, provider: "hyperliquid", accountType: "LIVE" }]
        : [{
          id: policyFollow.id,
          followerUserId: policyFollow.followerUserId,
          autoMirror: policyFollow.autoMirror,
          credentialId: policyFollow.credentialId,
          perpAutoMirror: policyFollow.perpAutoMirror,
          perpCredentialId: policyFollow.perpCredentialId,
          perpSizingMode: policyFollow.perpSizingMode,
          perpSizingValue: policyFollow.perpSizingValue,
          currentUserMaxLeverage: policyFollow.copyPerpMaxLeverage,
          currentFollowMaxLeverage: policyFollow.perpMaxLeverage ?? null,
          perpMaxLeverage: policyFollow.perpMaxLeverage ?? null,
          perpTakeProfitPct: policyFollow.perpTakeProfitPct ?? null,
          perpStopLossPct: policyFollow.perpStopLossPct ?? null,
        }];
    let phaseADailyUser = false;
    const getRows = () => phaseADailyUser
      ? [{ id: lockedFollow.followerUserId }]
      : rows;
    const query: any = {
      from: (table: unknown) => {
        phaseADailyUser = table === schema.users && !isUserPolicy;
        return query;
      },
      innerJoin: () => query,
      where: () => query,
      limit: () => query,
      for: (mode: string) => {
        if (isOrderPolicy && recordOrderLock) events.push(`lock:order:${mode}`);
        else if (phaseADailyUser || isUserPolicy) events.push(`lock:user:${mode}`);
        else if (!isOrderPolicy) events.push(`lock:follow:${mode}`);
        return Promise.resolve(getRows());
      },
      // eslint-disable-next-line unicorn/no-thenable
      then: (resolve: (value: unknown[]) => void, reject: (error: unknown) => void) =>
        Promise.resolve(getRows()).then(resolve, reject),
    };
    return query;
  };
  db.transaction = async (callback: (tx: Record<string, any>) => Promise<unknown>) => {
    events.push("transaction:begin");
    policyTransactionActive = true;
    try {
      return await callback(db);
    } finally {
      policyTransactionActive = false;
      events.push("transaction:commit");
    }
  };
  return db;
}

/**
 * Build a production-shaped policy transaction fake with a distinct tx handle.
 * Root DB writes are rejected while the policy callback is active; a failed
 * post-venue write poisons only the current savepoint, not the outer policy
 * transaction. This is intentionally stricter than the lightweight trace
 * helper above, which reuses one object and cannot prove handle propagation.
 */
function makeDistinctPolicyTransactionDb(
  baseDb: Record<string, any>,
  events: string[],
  lockedFollow: Record<string, unknown> = LIVE_FOLLOW,
  options: {
    failTxStatusWrite?: boolean;
    failProtectionWrite?: boolean;
    failRootUpdateAfterCommit?: boolean;
    failPolicyCommit?: boolean;
    failPolicyBeforeCallback?: boolean;
    recordOrderLock?: boolean;
    claimMismatch?: boolean;
  } = {},
  seedDurableRows: Array<Record<string, unknown>> = [],
) {
  let policyTransactionActive = false;
  let poisoned = false;
  let phaseATransactionSeen = false;
  let policyCommitFailureConsumed = false;
  const durableRows: Array<Record<string, unknown>> = [...seedDurableRows];
  const rootInsert = baseDb.insert;
  const rootUpdate = baseDb.update;
  const rootSelect = baseDb.select;
  const assertRootWriteAllowed = () => {
    if (policyTransactionActive) throw new Error("root DB handle used inside policy transaction");
    if (options.failRootUpdateAfterCommit) throw new Error("post-commit protection write failed");
  };

  const policySelect = (projection?: Record<string, unknown>) => {
    const keys = projection ? Object.keys(projection) : [];
    const isOrderPolicy = keys.includes("clientOrderId") && keys.includes("status");
    const isUserPolicy = keys.includes("copyPerpMaxLeverage") &&
      !keys.includes("currentUserMaxLeverage");
    const isFollowPolicy = keys.includes("currentUserMaxLeverage") ||
      keys.includes("currentFollowMaxLeverage") ||
      keys.includes("perpMaxLeverage");
    const isCredentialPolicy = keys.includes("provider") && keys.includes("accountType");
    const isPhaseUserProjection = keys.length === 1 && keys.includes("id");
    if (!isUserPolicy && !isFollowPolicy && !isCredentialPolicy && !isOrderPolicy && !isPhaseUserProjection) return rootSelect(projection);
    const rows = isOrderPolicy
      ? options.claimMismatch
        ? []
        : [{ id: "policy-order", status: "PENDING" }]
      : isUserPolicy
      ? [{ id: lockedFollow.followerUserId, copyPerpMaxLeverage: lockedFollow.copyPerpMaxLeverage }]
      : isCredentialPolicy
        ? [{ id: lockedFollow.credentialId, provider: "hyperliquid", accountType: "LIVE" }]
        : [{
          id: lockedFollow.id,
          followerUserId: lockedFollow.followerUserId,
          autoMirror: lockedFollow.autoMirror,
          credentialId: lockedFollow.credentialId,
          perpAutoMirror: lockedFollow.perpAutoMirror,
          perpCredentialId: lockedFollow.perpCredentialId,
          perpSizingMode: lockedFollow.perpSizingMode,
          perpSizingValue: lockedFollow.perpSizingValue,
          currentUserMaxLeverage: lockedFollow.copyPerpMaxLeverage,
          currentFollowMaxLeverage: lockedFollow.perpMaxLeverage ?? null,
          perpTakeProfitPct: lockedFollow.perpTakeProfitPct ?? null,
          perpStopLossPct: lockedFollow.perpStopLossPct ?? null,
        }];
    let phaseADailyUser = false;
    const getRows = () => phaseADailyUser
      ? [{ id: lockedFollow.followerUserId }]
      : rows;
    const query: any = {
      from: (table: unknown) => {
        phaseADailyUser = table === schema.users && !isUserPolicy;
        return query;
      },
      innerJoin: () => query,
      where: () => query,
      limit: () => query,
      for: (mode: string) => {
        if (isOrderPolicy && options.recordOrderLock) events.push(`lock:order:${mode}`);
        else if (phaseADailyUser || isUserPolicy) events.push(`lock:user:${mode}`);
        else if (!isOrderPolicy) events.push(`lock:follow:${mode}`);
        return Promise.resolve(getRows());
      },
      // eslint-disable-next-line unicorn/no-thenable
      then: (resolve: (value: unknown[]) => void, reject: (error: unknown) => void) =>
        Promise.resolve(getRows()).then(resolve, reject),
    };
    return query;
  };

  const tx: Record<string, any> = {
    ...baseDb,
    select: policySelect,
    insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (seedDurableRows.length > 0) return [];
              events.push("phase-a:pending");
              const row = { ...value, id: "tx-order", status: "PENDING" };
            durableRows.push(row);
            return [row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const isStatusExpression = values.status !== undefined && typeof values.status === "object";
          if (options.failTxStatusWrite && (values.status === "SUBMITTED" || isStatusExpression)) {
            poisoned = true;
            throw new Error("status write failed after venue acceptance");
          }
          if (
            options.failProtectionWrite &&
            ("perpProtectionStatus" in values || "perpProtection" in values)
          ) {
            poisoned = true;
            throw new Error("post-commit protection write failed");
          }
          const durableRow =
            durableRows.find((row) => row.id === "tx-order") ?? durableRows[0];
          const persistedValues = isStatusExpression
            ? { ...values, status: "SUBMITTED" }
            : values;
          if (durableRow) Object.assign(durableRow, persistedValues);
          const result = Object.assign(Promise.resolve([{ id: "tx-order" }]), {
            returning: async () => [{ id: "tx-order" }],
          });
          return result;
        },
      }),
    }),
  };
  tx.transaction = async (callback: (savepoint: Record<string, any>) => Promise<unknown>) => {
    events.push("savepoint:begin");
    const wasPoisoned = poisoned;
    poisoned = false;
    try {
      const result = await callback(tx);
      if (poisoned) throw new Error("savepoint remained poisoned");
      events.push("savepoint:commit");
      return result;
    } catch (error) {
      poisoned = wasPoisoned;
      events.push("savepoint:rollback");
      throw error;
    }
  };

  baseDb.insert = (...args: unknown[]) => {
    assertRootWriteAllowed();
    const builder = rootInsert(...args);
    const values = builder?.values;
    if (typeof values !== "function") return builder;
    builder.values = (value: Record<string, unknown>) => {
      events.push("phase-a:pending");
      durableRows.push({ ...value, status: "PENDING" });
      return values.call(builder, value);
    };
    return builder;
  };
  baseDb.update = (...args: unknown[]) => {
    assertRootWriteAllowed();
    const builder = rootUpdate(...args);
    const set = builder?.set;
    if (typeof set !== "function") return builder;
    builder.set = (values: Record<string, unknown>) => {
      const result = set.call(builder, values);
      const durableRow = durableRows[0];
      if (durableRow && ("perpProtectionStatus" in values || "perpProtection" in values)) {
        Object.assign(durableRow, values);
      }
      return result;
    };
    return builder;
  };
  baseDb.transaction = async (callback: (transaction: Record<string, any>) => Promise<unknown>) => {
    events.push("transaction:begin");
    const isPhaseATransaction = !phaseATransactionSeen;
    const durableSnapshot = isPhaseATransaction
      ? []
      : durableRows.map((row) => ({ row, values: { ...row } }));
    phaseATransactionSeen = true;
    policyTransactionActive = true;
    let committed = false;
    try {
      if (!isPhaseATransaction && options.failPolicyBeforeCallback) {
        throw new Error("policy transaction unavailable before callback");
      }
      const result = await callback(tx);
      if (poisoned) throw new Error("policy transaction rolled back");
      if (!isPhaseATransaction && options.failPolicyCommit && !policyCommitFailureConsumed) {
        policyCommitFailureConsumed = true;
        throw new Error("policy transaction commit failed");
      }
      events.push("transaction:commit");
      committed = true;
      return result;
    } finally {
      policyTransactionActive = false;
      // Each `db.transaction` is an independent PostgreSQL transaction. A
      // failed Phase-C status write rolls back only that short transaction; a
      // best-effort placedAt stamp must get a fresh transaction and therefore
      // must not inherit the fake's poisoned flag.
      poisoned = false;
      if (!committed && !isPhaseATransaction) {
        durableSnapshot.forEach(({ row, values }) => {
          Object.keys(row).forEach((key) => {
            if (!(key in values)) delete row[key];
          });
          Object.assign(row, values);
        });
      }
      if (!committed) events.push("transaction:rollback");
    }
  };
  return { db: baseDb, durableRows };
}

/**
 * A finalizer race fake: the reconciler wins the PENDING row between the
 * venue response and Phase-C's CAS. The authoritative read is deliberately a
 * different object from the attempted update result so a finalizer that keeps
 * writing by id (or falls back to a blind metadata update) cannot hide the
 * newer state.
 */
function makePerpFinalizerRaceDb(
  status: string,
  options: { throwOnUpdate?: boolean; authoritativeStatuses?: string[] } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  let reads = 0;
  const authoritative = {
    id: "perp-race",
    userId: "follower-perp",
    clientOrderId: "copymirror:follower-perp:user:race",
    status,
  };
  const db = {
    query: {
      orders: {
        findFirst: async () => {
          const statuses = options.authoritativeStatuses ?? [status];
          authoritative.status = statuses[Math.min(reads++, statuses.length - 1)] ?? status;
          return authoritative;
        },
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            if (options.throwOnUpdate) throw new Error("reconciler won the row race");
            // The reconciler's transition committed first, so the finalizer's
            // PENDING CAS must lose. A production implementation must then
            // reread and preserve `authoritative`, without another status or
            // placed-at write that could regress it.
            return [];
          },
        }),
      }),
    }),
  };
  return { db, updates, authoritative };
}

function finalizerRacePrepared() {
  return {
    orderId: "perp-race",
    params: {
      followerUserId: "follower-perp",
      sourceItemId: "user:race",
      brokerAccountId: "0x1111111111111111111111111111111111111111",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      coin: "BTC",
      side: "long" as const,
      sizeCoin: "0.1",
      leverage: 3,
      marginMode: "cross" as const,
      clientOrderId: "copymirror:follower-perp:user:race",
      intent: "open" as const,
    },
    input: {} as never,
    claimToken: "race-token",
    reconcileVenueBeforeSubmit: false,
  };
}

/** A baseline candidate that, by itself, should PLACE. Override per test. */
function candidate(overrides: Partial<MirrorCandidate> = {}): MirrorCandidate {
  return {
    followerUserId: "follower-1",
    sourceItemId: "user:trade-1",
    symbol: "AAPL",
    side: "buy",
    sizingMode: "usd",
    sizingValue: 500,
    buyingPower: 100_000,
    isPaper: true,
    price: 100,
    mirrorsToday: 0,
    alreadyMirrored: false,
    dailyCap: DEFAULT_MIRROR_DAILY_CAP,
    maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    ...overrides,
  };
}

describe("kill switch — isAutoMirrorEnabled", () => {
  it("is DISABLED by default (env unset)", () => {
    expect(isAutoMirrorEnabled({})).toBe(false);
  });

  it("only enables on the exact string 'true'", () => {
    expect(isAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_ENABLED: "true" })).toBe(true);
    expect(isAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_ENABLED: "TRUE" })).toBe(false);
    expect(isAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_ENABLED: "1" })).toBe(false);
    expect(isAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_ENABLED: "false" })).toBe(false);
    expect(isAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_ENABLED: " true " })).toBe(false);
  });
});

describe("live opt-in — isAutoMirrorLiveAllowed", () => {
  it("is OFF by default (paper-only)", () => {
    expect(isAutoMirrorLiveAllowed({})).toBe(false);
  });

  it("only allows live on the exact string 'true'", () => {
    expect(isAutoMirrorLiveAllowed({ COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "true" })).toBe(true);
    expect(isAutoMirrorLiveAllowed({ COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "yes" })).toBe(false);
    expect(isAutoMirrorLiveAllowed({ COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "false" })).toBe(false);
  });
});

describe("perps safety flags", () => {
  it("requires exact explicit opt-ins and treats an unset network as mainnet", () => {
    expect(isPerpsAutoMirrorEnabled({})).toBe(false);
    // The perps opt-in is the ONLY switch an operator sets. The Hyperliquid
    // reconciler is a hard precondition (without it nothing sizes a mirrored
    // fill and nothing ever resolves a PENDING perp order) but it runs by
    // default, so opting into perps is sufficient on a normal deployment.
    expect(isPerpsAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true" })).toBe(true);
    expect(
      isPerpsAutoMirrorEnabled({
        COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
        HYPERLIQUID_SYNC_ENABLED: "true",
      }),
    ).toBe(true);
    // Killing the reconciler withdraws that precondition, so perps refuse.
    expect(
      isPerpsAutoMirrorEnabled({
        COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
        HYPERLIQUID_SYNC_ENABLED: "false",
      }),
    ).toBe(false);
    // The perps opt-in itself stays exact-match: it authorises leverage.
    expect(isPerpsAutoMirrorEnabled({ COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "TRUE" })).toBe(false);
    expect(isPerpsMainnetAllowed({})).toBe(false);
    expect(isPerpsMainnetAllowed({ COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true" })).toBe(true);
    expect(isHyperliquidMainnet({})).toBe(true);
    expect(isHyperliquidMainnet({ HYPERLIQUID_NETWORK: "testnet" })).toBe(true);
    expect(
      isHyperliquidMainnet({
        HYPERLIQUID_NETWORK: "testnet",
        HYPERLIQUID_ALLOW_TESTNET: "true",
      }),
    ).toBe(false);
    expect(isHyperliquidNetworkExplicit({})).toBe(false);
    expect(isHyperliquidNetworkExplicit({ HYPERLIQUID_NETWORK: "mainnet" })).toBe(true);
    expect(isHyperliquidNetworkExplicit({ HYPERLIQUID_NETWORK: "testnet" })).toBe(false);
    expect(isHyperliquidNetworkExplicit({
      HYPERLIQUID_NETWORK: "testnet",
      HYPERLIQUID_ALLOW_TESTNET: "true",
    })).toBe(true);
  });

  it("uses only user-owned and venue policy ceilings for copied leverage", () => {
    expect(resolveEffectivePerpLeverage({
      sourceLeverage: 20,
      stagedUserMaxLeverage: 8,
      stagedFollowMaxLeverage: null,
      currentUserMaxLeverage: 8,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: 10,
    })).toBe(8);
    expect(resolveEffectivePerpLeverage({
      sourceLeverage: 20,
      stagedUserMaxLeverage: 50,
      stagedFollowMaxLeverage: null,
      currentUserMaxLeverage: 50,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: 10,
    })).toBe(10);
    expect(resolveEffectivePerpLeverage({
      sourceLeverage: undefined,
      stagedUserMaxLeverage: 20,
      stagedFollowMaxLeverage: null,
      currentUserMaxLeverage: 20,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: 40,
    })).toBe(1);
  });
});

describe("decidePerpMirror", () => {
  const perpCandidate = {
    followerUserId: "follower-1",
    sourceItemId: "x_signal:perp-1",
    sizingMode: "usd" as const,
    sizingValue: 500,
    freeCollateralUsd: 10_000,
    accountValueUsd: 10_000,
    price: 100,
    markPrice: "100",
    side: "long" as const,
    leverage: 5,
    sizeDecimals: 3,
    mirrorsToday: 0,
    alreadyMirrored: false,
    dailyCap: 20,
    maxOrderDollars: 10.55,
  };

  it("sizes configured dollars as notional without multiplying exposure by leverage", () => {
    expect(decidePerpMirror(perpCandidate)).toEqual({
      action: "place",
      sizeCoin: "0.1",
      orderDollars: 10.5,
      clientOrderId: "copymirror:follower-1:x_signal:perp-1",
    });
  });

  it("truncates fractional coin size to the venue precision", () => {
    expect(decidePerpMirror({ ...perpCandidate, sizingValue: 100, price: 30, markPrice: "30" }).action).toBe("place");
    const result = decidePerpMirror({ ...perpCandidate, sizingValue: 100, price: 30, markPrice: "30" });
    if (result.action !== "place") throw new Error("expected place");
    expect(result.sizeCoin).toBe("0.334");
  });

  it("enforces notional cap, margin availability, daily cap, and idempotency", () => {
    expect(decidePerpMirror({ ...perpCandidate, sizingValue: 1_001 })).toMatchObject({
      action: "place",
      sizeCoin: "0.1",
      orderDollars: 10.5,
    });
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 900,
        freeCollateralUsd: 1,
        leverage: 5,
      }),
    ).toMatchObject({ action: "skip", reason: "insufficient-margin" });
    expect(decidePerpMirror({ ...perpCandidate, mirrorsToday: 20 })).toMatchObject({
      action: "skip",
      reason: "daily-cap",
    });
    expect(decidePerpMirror({ ...perpCandidate, alreadyMirrored: true })).toMatchObject({
      action: "skip",
      reason: "duplicate",
    });
  });

  it("refuses to size or margin-gate anything when free collateral is unknown", () => {
    // Null is not zero and it is not the account total. A usd-sized order needs
    // no balance to compute a size, so this is specifically the margin gate
    // refusing to run against a fabricated base.
    expect(
      decidePerpMirror({ ...perpCandidate, freeCollateralUsd: null }),
    ).toMatchObject({ action: "skip", reason: "margin-unavailable" });
    expect(
      decidePerpMirror({ ...perpCandidate, freeCollateralUsd: Number.NaN }),
    ).toMatchObject({ action: "skip", reason: "margin-unavailable" });
    expect(
      decidePerpMirror({ ...perpCandidate, freeCollateralUsd: 0 }),
    ).toMatchObject({ action: "skip", reason: "insufficient-margin" });
  });

  it("sizes pct_equity from NET EQUITY, not from whatever collateral is free", () => {
    // The documented rule, and what Manage Follows shows as "% eq". An account
    // With $105 equity and $3 committed, equity sizing asks for $10.50, not
    // 10% of the $102 that happens to be free ($10.20). Both fit the immutable
    // cap, so the guards below still decide whether either one may place.
    const equity = decidePerpMirror({
      ...perpCandidate,
      sizingMode: "pct_equity" as const,
      sizingValue: 10,
      freeCollateralUsd: 102,
      accountValueUsd: 105,
      price: 50,
      markPrice: "50",
      side: "short" as const,
      maxOrderDollars: 100_000,
    });
    const pct = decidePerpMirror({
      ...perpCandidate,
      sizingMode: "pct" as const,
      sizingValue: 10,
      freeCollateralUsd: 102,
      accountValueUsd: 105,
      price: 50,
      markPrice: "50",
      side: "short" as const,
      maxOrderDollars: 100_000,
    });

    expect(equity.action).toBe("place");
    expect(pct.action).toBe("place");
    // $10.50 of notional versus $10.20: the two modes are not the same rule.
    expect(Number((equity as { sizeCoin: string }).sizeCoin)).toBeCloseTo(0.221, 3);
    expect(Number((pct as { sizeCoin: string }).sizeCoin)).toBeCloseTo(0.214, 3);
  });

  it("refuses pct_equity when equity is unreadable rather than sizing by another rule", () => {
    // Unknown equity is not zero and it is not the free figure. Silently falling
    // back would place an order the follower never asked for the size of.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingMode: "pct_equity" as const,
        sizingValue: 10,
        accountValueUsd: null,
      }),
    ).toMatchObject({ action: "skip", reason: "margin-unavailable" });
  });

  it("scales pct sizing by FREE collateral, not by total account value", () => {
    // $102 is free. 10% of that is $10.20 of notional, not 10% of the $10,000
    // account value. The immutable cap still applies after this free-collateral
    // calculation.
    //
    // This used to be written against pct_equity, which made it assert the bug:
    // pct_equity is a percent of NET EQUITY by definition, and only `pct` scales
    // the free figure. The distinction is covered directly below.
    const result = decidePerpMirror({
      ...perpCandidate,
      sizingMode: "pct",
      sizingValue: 10,
      freeCollateralUsd: 102,
      accountValueUsd: 10_000,
      side: "short" as const,
    });
    expect(result).toMatchObject({ action: "place", sizeCoin: "0.107", orderDollars: 10.165 });
  });

  it("gates the margin on committed collateral, so a nearly-used account is skipped", () => {
    // $2 free at 5x backs $10.50 of notional at the mark, but the submitted
    // IoC can fill 5% higher, so this exposure needs more margin than the
    // follower has left.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 1_000,
        maxOrderDollars: 10_000,
        freeCollateralUsd: 2,
        leverage: 5,
      }),
    ).toMatchObject({ action: "skip", reason: "insufficient-margin" });
    // The same user-requested order against enough free collateral places.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 1_000,
        maxOrderDollars: 10_000,
        freeCollateralUsd: 250,
        leverage: 5,
      }),
    ).toMatchObject({ action: "place", sizeCoin: "9.523", orderDollars: 999.915 });
  });

  it("uses the pinned mark for the minimum even when a short IOC payload is under $10", () => {
    // The $10 target floors to .105 at the short's $95 IOC limit. Its mark
    // notional is $10.50, so it clears the venue floor; its exact submitted
    // payload is $9.975, which fits the explicit $10 cap.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 10,
        side: "short",
        maxOrderDollars: 10,
      }),
    ).toMatchObject({ action: "place", sizeCoin: "0.105", orderDollars: 9.975 });
    expect(
      decidePerpMirror({ ...perpCandidate, sizingValue: 11, side: "short" }),
    ).toMatchObject({ action: "place", sizeCoin: "0.111", orderDollars: 10.545 });
  });

  it("keeps the mark minimum separate from the aggressive IOC payload cap", () => {
    // The short's $95 payload may be below $10 while its $100 mark notional
    // clears the venue floor.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 10,
        side: "short",
        maxOrderDollars: 10,
      }),
    ).toMatchObject({ action: "place", sizeCoin: "0.105", orderDollars: 9.975 });
    // A long's next mark-clearing increment is .1, but its $105 aggressive
    // payload would exceed the same $10 cap, so it is refused before submit.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 11,
        side: "long",
        maxOrderDollars: 10,
      }),
    ).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("allows a short open when its exact submitted notional fits the cap", () => {
    // The submitted short payload is floored at the exact $95 IOC price and
    // stays inside the follower's configured $11 request/cap. The favorable-side
    // market band is a margin-safety bound, not a reason to reject the actual
    // limit request.
    expect(
      decidePerpMirror({
        ...perpCandidate,
        sizingValue: 11,
        side: "short",
        maxOrderDollars: 11,
      }),
    ).toMatchObject({ action: "place", sizeCoin: "0.115", orderDollars: 10.925 });
  });

  it("does not replace the user's configured notional with the local proof ceiling", () => {
    const result = decidePerpMirror({
      ...perpCandidate,
      sizingValue: 250,
      maxOrderDollars: 1_000,
    });

    expect(result.action).toBe("place");
    if (result.action !== "place") throw new Error("expected place");
    expect(result.orderDollars).toBeGreaterThan(10.55);
    expect(result.orderDollars).toBeLessThanOrEqual(250);
  });

  it("holds the dollar cap against the exact submitted IOC payload", () => {
    // This fixture explicitly configures a $10.55 deployment safeguard. A large
    // request is clamped to it and floored against the $105 submitted long limit,
    // producing $10.50. A later fill at a favorable venue price does not change the payload cap
    // that was approved.
    expect(
      decidePerpMirror({ ...perpCandidate, sizingValue: 1_000 }),
    ).toMatchObject({ action: "place", sizeCoin: "0.1", orderDollars: 10.5 });
    // A smaller request remains below the same configured safeguard.
    expect(
      decidePerpMirror({ ...perpCandidate, sizingValue: 10.5 }),
    ).toMatchObject({ action: "place", sizeCoin: "0.1", orderDollars: 10.5 });
  });
});

describe("decidePerpReduceOnlyMirror", () => {
  const base = {
    sourceSizeDecimal: "0.123456789",
    sourcePositionSizeDecimal: "0.5",
    mirroredExposureSizeDecimal: "0.2",
    sizingMode: "usd" as const,
    sizingValue: 500,
    orderSide: "short" as const,
    sizeDecimals: 8,
  };

  it("closes the same fraction of corresponding mirrored exposure for non-ratio sizing", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        position: { side: "long", size: "0.50000000" },
      }),
    ).toEqual({ action: "place", sizeCoin: "0.04938271" });
  });

  it("reduces a follower short only with a buy-side order", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        orderSide: "long",
        sourceSizeDecimal: "2.75",
        sourcePositionSizeDecimal: "3",
        mirroredExposureSizeDecimal: "1.5",
        position: { side: "short", size: "3.00" },
      }),
    ).toEqual({ action: "place", sizeCoin: "1.375" });
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        orderSide: "short",
        position: { side: "short", size: "3.00" },
      }),
    ).toEqual({ action: "skip", reason: "wrong-side" });
  });

  it("skips when the follower has no live position", () => {
    expect(decidePerpReduceOnlyMirror({ ...base, position: null })).toEqual({
      action: "skip",
      reason: "no-position",
    });
  });

  it("clamps a full source close to corresponding exposure, then the live position", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "90071992.54740991",
        sourcePositionSizeDecimal: "90071992.54740991",
        mirroredExposureSizeDecimal: "0.0000002",
        position: { side: "long", size: "0.00000019" },
      }),
    ).toEqual({ action: "place", sizeCoin: "0.00000019" });
  });

  it("applies ratio sizing without converting the executed size through Number", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sizingMode: "ratio",
        sizingValue: 0.1,
        sourceSizeDecimal: "900719925474099.12345678",
        // Large enough not to be the binding constraint: this test is about
        // decimal precision, and the attribution ceiling is covered below.
        mirroredExposureSizeDecimal: "900719925474099.12345678",
        position: { side: "long", size: "90071992547409.91234567" },
      }),
    ).toEqual({ action: "skip", reason: "no-qty" });
  });

  it("accepts the shared boundary but skips a reduce-only size just above it", () => {
    const boundary = {
      ...base,
      sizingMode: "ratio" as const,
      sizingValue: 1,
      sourceSizeDecimal: "90071992.54740991",
      mirroredExposureSizeDecimal: "90071992.54740991",
      position: { side: "long" as const, size: "90071992.54740991" },
    };
    expect(decidePerpReduceOnlyMirror(boundary)).toEqual({
      action: "place",
      sizeCoin: "90071992.54740991",
    });
    expect(decidePerpReduceOnlyMirror({
      ...boundary,
      sourceSizeDecimal: "90071992.54740992",
    })).toEqual({ action: "skip", reason: "no-qty" });
  });

  it("clamps a RATIO close to the mirror's attributed exposure", () => {
    // The venue position is the follower's total from every source. If the
    // paired mirrored open was skipped (a leverage conflict, say) while they
    // held a same-side position of their own, ratio sizing used to submit
    // sourceSize * ratio reduce-only against THEIR exposure. reduceOnly stops a
    // flip; it does not preserve ownership.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sizingMode: "ratio",
        sizingValue: 1,
        sourceSizeDecimal: "5",
        mirroredExposureSizeDecimal: "0.25",
        position: { side: "long", size: "10" },
      }),
    ).toEqual({ action: "place", sizeCoin: "0.25" });
  });

  it("refuses a RATIO close with no attributed exposure at all", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sizingMode: "ratio",
        sizingValue: 1,
        sourceSizeDecimal: "5",
        mirroredExposureSizeDecimal: undefined,
        position: { side: "long", size: "10" },
      }),
    ).toEqual({ action: "skip", reason: "no-qty" });
  });

  it("fails closed without non-ratio source or mirrored exposure context", () => {
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourcePositionSizeDecimal: undefined,
        position: { side: "long", size: "1" },
      }),
    ).toEqual({ action: "skip", reason: "no-qty" });
  });
});

describe("resolveGuardrails", () => {
  it("falls back to the shared defaults when unset", () => {
    expect(resolveGuardrails({})).toEqual({
      dailyCap: DEFAULT_MIRROR_DAILY_CAP,
      maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    });
  });

  it("uses positive numeric overrides", () => {
    expect(
      resolveGuardrails({
        COPY_TRADE_AUTOMIRROR_DAILY_CAP: "3",
        COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: "250",
      }),
    ).toEqual({ dailyCap: 3, maxOrderDollars: 250 });
  });

  it("ignores invalid / non-positive overrides (falls back to defaults)", () => {
    expect(
      resolveGuardrails({
        COPY_TRADE_AUTOMIRROR_DAILY_CAP: "0",
        COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS: "-100",
      }),
    ).toEqual({
      dailyCap: DEFAULT_MIRROR_DAILY_CAP,
      maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    });
    expect(resolveGuardrails({ COPY_TRADE_AUTOMIRROR_DAILY_CAP: "abc" }).dailyCap).toBe(
      DEFAULT_MIRROR_DAILY_CAP,
    );
  });
});

describe("decideMirror — happy path", () => {
  it("places with the expected qty, dollars, and deterministic client_order_id", () => {
    const c = candidate({ sizingMode: "usd", sizingValue: 500, price: 100 });
    const decision = decideMirror(c, /* liveAllowed */ false);

    expect(decision.action).toBe("place");
    if (decision.action !== "place") throw new Error("expected place");

    // usd target 500 / price 100 = 5 shares.
    expect(decision.qty).toBe(5);
    expect(decision.qty).toBe(
      computeMirrorQty({ sizingMode: "usd", sizingValue: 500, buyingPower: 0, price: 100 }),
    );
    expect(decision.orderDollars).toBe(500);
    expect(decision.clientOrderId).toBe(
      mirrorIdempotencyKey({ followerUserId: "follower-1", sourceItemId: "user:trade-1" }),
    );
    expect(decision.clientOrderId).toBe("copymirror:follower-1:user:trade-1");
  });

  it("sizes a pct rule against buying power", () => {
    // 5% of 100_000 = 5_000 target; / price 50 = 100 shares. orderDollars 5_000.
    const c = candidate({
      sizingMode: "pct",
      sizingValue: 5,
      buyingPower: 100_000,
      price: 50,
      maxOrderDollars: 10_000, // keep under the dollar cap for this case
    });
    const decision = decideMirror(c, false);
    expect(decision.action).toBe("place");
    if (decision.action !== "place") throw new Error("expected place");
    expect(decision.qty).toBe(100);
    expect(decision.orderDollars).toBe(5_000);
  });

  it("sizes options by premium times the 100-share contract multiplier", () => {
    const c = candidate({
      sizingMode: "usd",
      sizingValue: 1_000,
      price: 2.5,
      contractMultiplier: 100,
      maxOrderDollars: 1_000,
    });
    const decision = decideMirror(c, false);
    expect(decision.action).toBe("place");
    if (decision.action !== "place") throw new Error("expected place");
    expect(decision.qty).toBe(4);
    expect(decision.orderDollars).toBe(1_000);
  });

  it("applies the dollar cap to option notional, not just contract premium", () => {
    const decision = decideMirror(
      candidate({
        sizingMode: "usd",
        sizingValue: 1_200,
        price: 4,
        contractMultiplier: 100,
        maxOrderDollars: 1_000,
      }),
      false,
    );

    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("dollar-cap");
  });
});

describe("decideMirror — skips", () => {
  it("skips a duplicate (idempotency) regardless of everything else", () => {
    const decision = decideMirror(candidate({ alreadyMirrored: true }), false);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("duplicate");
  });

  it("skips a LIVE account when live is not allowed", () => {
    const decision = decideMirror(candidate({ isPaper: false }), /* liveAllowed */ false);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("live-not-allowed");
  });

  it("PLACES on a LIVE account once live IS allowed", () => {
    const decision = decideMirror(candidate({ isPaper: false }), /* liveAllowed */ true);
    expect(decision.action).toBe("place");
  });

  it("always allows PAPER accounts regardless of the live flag", () => {
    expect(decideMirror(candidate({ isPaper: true }), false).action).toBe("place");
  });

  it("skips when sizing yields 0 shares (target < one share)", () => {
    const decision = decideMirror(candidate({ sizingValue: 50, price: 100 }), false);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("no-qty");
  });

  it("skips when the order exceeds the per-order dollar cap", () => {
    // usd 5_000 / price 100 = 50 shares => $5_000 order, cap is $1_000.
    const decision = decideMirror(
      candidate({ sizingValue: 5_000, price: 100, maxOrderDollars: 1_000 }),
      false,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("dollar-cap");
    if (decision.reason !== "dollar-cap") throw new Error("expected dollar cap skip");
    expect(decision.orderDollars).toBe(5_000);
    expect(decision.maxOrderDollars).toBe(1_000);
  });

  it.each([
    ["USD", candidate({ sizingMode: "usd", sizingValue: 5_000, price: 100, maxOrderDollars: 1_000 })],
    [
      "buying-power percent",
      candidate({
        sizingMode: "pct",
        sizingValue: 5,
        buyingPower: 100_000,
        price: 50,
        maxOrderDollars: 1_000,
      }),
    ],
    [
      "equity percent",
      candidate({
        sizingMode: "pct_equity",
        sizingValue: 10,
        equity: 30_000,
        price: 100,
        maxOrderDollars: 1_000,
      }),
    ],
  ] as const)("skips %s intent above the configured per-order ceiling", (_mode, c) => {
    const decision = decideMirror(c, false);

    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("dollar-cap");
  });

  it("skips a ratio-sized order whose computed notional exceeds the configured ceiling", () => {
    // 2x the source's 10 shares at $100 = 20 shares / $2,000, above the $1,000 cap.
    const decision = decideMirror(
      candidate({
        sizingMode: "ratio",
        sizingValue: 2,
        sourceQty: 10,
        price: 100,
        maxOrderDollars: 1_000,
      }),
      false,
    );

    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("dollar-cap");
    if (decision.reason !== "dollar-cap") throw new Error("expected dollar cap skip");
    expect(decision.orderDollars).toBe(2_000);
    expect(decision.maxOrderDollars).toBe(1_000);
  });

  it("places orders at and below the configured per-order ceiling", () => {
    expect(
      decideMirror(candidate({ sizingValue: 1_000, price: 100, maxOrderDollars: 1_000 }), false)
        .action,
    ).toBe("place");
    expect(
      decideMirror(candidate({ sizingValue: 900, price: 100, maxOrderDollars: 1_000 }), false).action,
    ).toBe("place");
  });

  it("skips when the follower already hit the daily cap", () => {
    const decision = decideMirror(
      candidate({ mirrorsToday: 20, dailyCap: 20 }),
      false,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("daily-cap");
  });

  it("dedupe takes precedence over the live gate", () => {
    // both duplicate AND a live-not-allowed account -> duplicate wins (checked first).
    const decision = decideMirror(
      candidate({ alreadyMirrored: true, isPaper: false }),
      false,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("duplicate");
  });

  it("dollar cap is evaluated before the daily cap", () => {
    // over the dollar cap AND over the daily cap -> dollar-cap reported first.
    const decision = decideMirror(
      candidate({
        sizingValue: 5_000,
        price: 100,
        maxOrderDollars: 1_000,
        mirrorsToday: 99,
        dailyCap: 1,
      }),
      false,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("expected skip");
    expect(decision.reason).toBe("dollar-cap");
  });
});

describe("client_order_id determinism (dedupe key)", () => {
  it("is stable per (follower, source item) and differs across either", () => {
    const a = decideMirror(candidate(), false).clientOrderId;
    const b = decideMirror(candidate(), false).clientOrderId;
    expect(a).toBe(b); // stable

    const otherFollower = decideMirror(
      candidate({ followerUserId: "follower-2" }),
      false,
    ).clientOrderId;
    const otherTrade = decideMirror(
      candidate({ sourceItemId: "user:trade-2" }),
      false,
    ).clientOrderId;

    expect(otherFollower).not.toBe(a);
    expect(otherTrade).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// HIGH-1: only EQUITY is mirrorable. An OPTION shares the underlying ticker as
// its symbol, so mirroring it as an equity order is a silently wrong instrument.
// ---------------------------------------------------------------------------

describe("isMirrorableAsset", () => {
  it("allows the exact supported asset types", () => {
    expect(isMirrorableAsset("EQUITY")).toBe(true);
    expect(isMirrorableAsset("OPTION")).toBe(true);
  });

  it("is false for any non-supported / unknown / null asset type", () => {
    expect(isMirrorableAsset("CRYPTO")).toBe(false);
    expect(isMirrorableAsset("equity")).toBe(false); // case-sensitive on purpose
    expect(isMirrorableAsset(null)).toBe(false); // legacy rows fail closed
    expect(isMirrorableAsset(undefined)).toBe(false);
  });
});

describe("findMirrorCandidates", () => {
  const SELECTED_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000201";
  // Minimal drizzle-query-builder stub: select().from().where() resolves to the
  // supplied table-specific rows.
  function fakeDb(
    rows:
      | unknown[]
      | {
          socialTradeRows?: unknown[];
          signalRows?: unknown[];
        },
  ) {
    const socialTradeRows = Array.isArray(rows) ? rows : rows.socialTradeRows ?? [];
    const signalRows = Array.isArray(rows) ? [] : rows.signalRows ?? [];
    const authoritativeSocialRows = socialTradeRows.map((value) => {
      if (!value || typeof value !== "object") return value;
      const row = value as Record<string, unknown>;
      // The real select aliases these fields from the authoritative orders
      // join. Keep the fixture compact while still making the join contract
      // explicit for simple rows; rows that intentionally model a missing or
      // conflicting order retain their supplied fields.
      if (typeof row.orderId !== "string" || row.orderId.length === 0) return value;
      const action = typeof row.tradeAction === "string"
        ? row.tradeAction
        : row.side === "buy" ? "Buy" : "Sell";
      const direction = row.orderDirection ??
        (["SellShort", "BuyToCover", "SellToOpen", "BuyToClose"].includes(action)
          ? "short"
          : "long");
      return {
        ...row,
        orderUserId: row.orderUserId ?? row.userId,
        orderSymbol: row.orderSymbol ?? row.symbol,
        orderAssetType: row.orderAssetType ?? row.assetType,
        tradeAction: row.tradeAction ?? action,
        orderDirection: direction,
      };
    });
    return {
      select: () => {
        let selectedRows: unknown[] = [];
        return {
          from(table: unknown) {
            selectedRows = table === schema.signals ? signalRows : authoritativeSocialRows;
            return this;
          },
          leftJoin() {
            return this;
          },
          innerJoin() {
            return this;
          },
          where() {
            return this;
          },
          orderBy() {
            return this;
          },
          limit(limit: number) {
            const windowStart = now.getTime() - 60_000;
            if (limit === 1) {
              const latest = selectedRows
                .filter((value) => (value as { createdAt?: unknown })?.createdAt instanceof Date)
                .sort((left, right) =>
                  (right as { createdAt: Date }).createdAt.getTime() -
                  (left as { createdAt: Date }).createdAt.getTime(),
                )
                .slice(0, 1);
              return Promise.resolve(latest);
            }
            const boundedRows = selectedRows.filter((value) => {
              const createdAt = (value as { createdAt?: unknown })?.createdAt;
              if (!(createdAt instanceof Date)) return true;
              return (
                createdAt.getTime() > windowStart &&
                createdAt.getTime() <= now.getTime()
              );
            });
            return Promise.resolve(boundedRows.slice(0, limit));
          },
        };
      },
    } as never;
  }

  // A "user" follow whose NON-PII target_key matches the SOURCE user via traderKey.
  function userFollow(sourceUserId: string, followerUserId: string) {
    return {
      followerUserId,
      targetType: "user",
      targetKey: traderKey(sourceUserId),
      sizingMode: "usd",
      sizingValue: "500",
      autoMirror: true,
      credentialId: SELECTED_CREDENTIAL_ID,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: SELECTED_CREDENTIAL_ID,
      stockSizingMode: "usd",
      stockSizingValue: "500",
      perpAutoMirror: true,
      perpCredentialId: SELECTED_CREDENTIAL_ID,
      perpSizingMode: "usd",
      perpSizingValue: "500",
    } as never;
  }

  function xAuthorFollow(targetKey: string, followerUserId: string) {
    return {
      followerUserId,
      targetType: "x_author",
      targetKey,
      sizingMode: "usd",
      sizingValue: "500",
      autoMirror: true,
      credentialId: SELECTED_CREDENTIAL_ID,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: SELECTED_CREDENTIAL_ID,
      stockSizingMode: "usd",
      stockSizingValue: "500",
      perpAutoMirror: true,
      perpCredentialId: SELECTED_CREDENTIAL_ID,
      perpSizingMode: "usd",
      perpSizingValue: "500",
    } as never;
  }

  const SOURCE = "source-user-1";
  const FOLLOWER = "follower-1";
  const now = new Date();
  const within = new Date(now.getTime() - 1_000);

  it("holds an ambiguous historical author alias out of mirror matching", () => {
    const first = "source_author:discord:1";
    const second = "source_author:discord:2";

    expect(
      resolveMirrorAuthorMatchKeys(
        { authorName: "Shared Name", canonicalAuthorKey: first, authorAliases: ["shared name"] },
        [
          { alias: "shared name", canonicalKey: first },
          { alias: "shared name", canonicalKey: second },
        ],
        { durableLookupAvailable: true },
      ),
    ).toEqual([first]);
    expect(
      resolveMirrorAuthorMatchKeys(
        { authorName: "Shared Name" },
        [
          { alias: "shared name", canonicalKey: first },
          { alias: "shared name", canonicalKey: second },
        ],
        { durableLookupAvailable: true },
      ),
    ).toEqual([]);
  });

  it("keeps identical aliases isolated between X and Discord", () => {
    const xKey = "source_author:x:1";
    const discordKey = "source_author:discord:1";
    const owners = [
      { alias: "shared name", canonicalKey: xKey, source: "x" },
      { alias: "shared name", canonicalKey: discordKey, source: "discord" },
    ];

    const xKeys = resolveMirrorAuthorMatchKeys(
      {
        authorName: "Shared Name",
        authorSource: "x",
        sourceAuthorId: "1",
        canonicalAuthorKey: xKey,
        authorAliases: ["shared name"],
      },
      owners,
      { durableLookupAvailable: true },
      "x",
    );
    const discordKeys = resolveMirrorAuthorMatchKeys(
      {
        authorName: "Shared Name",
        authorSource: "discord",
        sourceAuthorId: "1",
        canonicalAuthorKey: discordKey,
        authorAliases: ["shared name"],
      },
      owners,
      { durableLookupAvailable: true },
      "discord",
    );

    expect(xKeys).toContain(xKey);
    expect(xKeys).toContain("source_alias:x:shared%20name");
    expect(xKeys).not.toContain(discordKey);
    expect(xKeys).not.toContain("shared name");
    expect(discordKeys).toContain(discordKey);
    expect(discordKeys).toContain("source_alias:discord:shared%20name");
    expect(discordKeys).not.toContain(xKey);
    expect(discordKeys).not.toContain("shared name");
  });

  it("does not turn relay metadata into a mirrorable author key", () => {
    expect(
      resolveMirrorAuthorMatchKeys(
        {
          authorId: "relay-webhook",
          authorName: "TweetShift",
          authorIdentityKind: "relay",
          authorSource: "discord",
        },
        [{ alias: "tweetshift", canonicalKey: "source_author:discord:relay" }],
        { durableLookupAvailable: true },
        "discord",
      ),
    ).toEqual([]);
  });

  function callFind({
    follows = [userFollow(SOURCE, FOLLOWER)],
    socialTradeRows = [],
    signalRows = [],
  }: {
    follows?: unknown[];
    socialTradeRows?: unknown[];
    signalRows?: unknown[];
  } = {}) {
    const poller = new CopyMirrorPoller(fakeDb({ socialTradeRows, signalRows }));
    // Exercise the real (private) resolution path used by the poll cycle.
    return (
      poller as unknown as {
        findMirrorCandidates: (
          follows: unknown[],
          windowStart: Date,
          windowEnd: Date,
          // The REAL candidate type, not a hand-copied shape. This used to
          // re-declare the whole structure inline, so a field added to
          // MirrorSourceCandidate never reached the assertions here and the
          // expectations silently drifted from the type they describe.
        ) => Promise<MirrorSourceCandidate[]>;
      }
    ).findMirrorCandidates(
      follows,
      new Date(now.getTime() - 60_000),
      now,
    );
  }

  it("mirrors an EQUITY trade", async () => {
    const out = await callFind({
      socialTradeRows: [
        { id: "t-eq", userId: SOURCE, symbol: "AAPL", side: "buy", assetType: "EQUITY", orderId: "order-eq", createdAt: within },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.symbol).toBe("AAPL");
    expect(out[0]!.credentialId).toBe(SELECTED_CREDENTIAL_ID);
  });

  it("carries the follow's explicitly selected credential into a Hyperliquid PERP candidate", async () => {
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        socialTradeRows: [
          {
            id: "t-perp",
            userId: SOURCE,
            symbol: "BTC",
            side: "sell",
            assetType: "PERP",
            orderId: "order-perp",
            createdAt: within,
            orderUserId: SOURCE,
            orderSymbol: "BTC",
            orderAssetType: "PERP",
            orderQuantityDecimal: "0.25",
            orderExecutedSizeDecimal: "0.24999999",
            orderDirection: "short",
            orderLeverage: 4,
            orderMarginMode: "isolated",
            orderVenue: "hyperliquid",
            orderReduceOnly: false,
          },
        ],
      });
      expect(out).toEqual([
        {
          followerUserId: FOLLOWER,
          credentialId: SELECTED_CREDENTIAL_ID,
          sourceItemId: "user:t-perp",
          sourceOrderId: "order-perp",
          sourceEventAt: within.toISOString(),
          symbol: "BTC",
          side: "sell",
          sizingMode: "usd",
          sizingValue: 500,
          assetType: "PERP",
          maxTradeSize: null,
          maxCoinSize: null,
          sourceQtyDecimal: "0.24999999",
          sourceUserId: SOURCE,
          perpSide: "short",
          perpReduceOnly: false,
          perpLeverage: 4,
          perpMarginMode: "isolated",
          copySourceLabel: undefined,
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("carries an exact reduce-only PERP fill into the close candidate", async () => {
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        socialTradeRows: [
          {
            id: "t-perp-close",
            userId: SOURCE,
            symbol: "BTC",
            side: "sell",
            assetType: "PERP",
            orderId: "order-perp-close",
            createdAt: within,
            orderUserId: SOURCE,
            orderSymbol: "BTC",
            orderAssetType: "PERP",
            orderQuantityDecimal: "9",
            orderExecutedSizeDecimal: "0.12345678",
            tradeAction: "Sell",
            orderDirection: "short",
            orderLeverage: 20,
            orderMarginMode: "cross",
            orderVenue: "hyperliquid",
            orderReduceOnly: true,
          },
        ],
      });

      expect(out[0]).toMatchObject({
        sourceQtyDecimal: "0.12345678",
        // Native rows already store the submitted execution side.
        perpSide: "short",
        perpReduceOnly: true,
      });
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("mirrors a user OPTION trade only when the joined order carries full contract identity", async () => {
    const out = await callFind({
      socialTradeRows: [
        {
          id: "t-opt",
          userId: SOURCE,
          symbol: "AAPL",
          side: "buy",
          assetType: "OPTION",
          orderId: "order-opt",
          createdAt: within,
          optionExpiration: "260719",
          optionStrike: "250.00",
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
      ],
    });
    expect(out).toEqual([
      {
        followerUserId: FOLLOWER,
        credentialId: SELECTED_CREDENTIAL_ID,
        sourceItemId: "user:t-opt",
        sourceOrderId: "order-opt",
        sourceEventAt: within.toISOString(),
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "OPTION",
        maxTradeSize: null,
        maxCoinSize: null,
        optionExpiration: "260719",
        optionStrike: 250,
        optionType: "CALL",
        tradeAction: "BuyToOpen",
        direction: "long",
        sourceQty: undefined,
        sourceUserId: SOURCE,
        sourceOrderCreatedAt: within.toISOString(),
        copySourceLabel: undefined,
      },
    ]);
  });

  it("ignores an order joined from a different user when broker order ids collide", async () => {
    const out = await callFind({
      socialTradeRows: [
        {
          id: "t-shared-broker-id",
          userId: SOURCE,
          symbol: "AAPL",
          side: "buy",
          assetType: "OPTION",
          orderId: "order-shared-other",
          createdAt: within,
          orderUserId: "different-user",
          orderSymbol: "TSLA",
          orderAssetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: "300.00",
          optionType: "PUT",
          tradeAction: "BuyToOpen",
        },
        {
          id: "t-shared-broker-id",
          userId: SOURCE,
          symbol: "AAPL",
          side: "buy",
          assetType: "OPTION",
          orderId: "order-shared-source",
          createdAt: within,
          orderUserId: SOURCE,
          orderSymbol: "AAPL",
          orderAssetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: "250.00",
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
      ],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      symbol: "AAPL",
      optionStrike: 250,
      optionType: "CALL",
    });
  });

  it("SKIPS conflicting same-user option rows joined by a duplicate broker order id", async () => {
    const out = await callFind({
      socialTradeRows: [
        {
          id: "t-conflicting-contracts",
          userId: SOURCE,
          symbol: "AAPL",
          side: "buy",
          assetType: "OPTION",
          createdAt: within,
          orderUserId: SOURCE,
          orderSymbol: "AAPL",
          orderAssetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: "250.00",
          orderId: "order-conflicting-call",
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
        {
          id: "t-conflicting-contracts",
          userId: SOURCE,
          symbol: "AAPL",
          side: "buy",
          assetType: "OPTION",
          createdAt: within,
          orderUserId: SOURCE,
          orderSymbol: "AAPL",
          orderAssetType: "OPTION",
          optionExpiration: "260719",
          optionStrike: "300.00",
          orderId: "order-conflicting-put",
          optionType: "PUT",
          tradeAction: "BuyToOpen",
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("SKIPS an OPTION trade missing joined contract identity", async () => {
    const out = await callFind({
      socialTradeRows: [
        { id: "t-opt", userId: SOURCE, symbol: "AAPL", side: "buy", assetType: "OPTION", createdAt: within },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("SKIPS a user sell-to-open option trade", async () => {
    const out = await callFind({
      socialTradeRows: [
        {
          id: "t-sto",
          userId: SOURCE,
          symbol: "AAPL",
          side: "sell",
          assetType: "OPTION",
          createdAt: within,
          optionExpiration: "260719",
          optionStrike: "250.00",
          optionType: "CALL",
          tradeAction: "SellToOpen",
        },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("SKIPS a null/legacy asset type (fails closed) while still mirroring a sibling equity", async () => {
    const out = await callFind({
      socialTradeRows: [
        { id: "t-null", userId: SOURCE, symbol: "AAPL", side: "buy", assetType: null, createdAt: within },
        { id: "t-eq", userId: SOURCE, symbol: "MSFT", side: "buy", assetType: "EQUITY", orderId: "order-sibling-eq", createdAt: within },
      ],
    });
    expect(out.map((c) => c.symbol)).toEqual(["MSFT"]);
  });

  it("mirrors an x_author follow by normalized signal author as a buy equity candidate", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-1",
          symbol: "tsla",
          content: "Buying $TSLA here",
          metadata: { authorName: "  Cathie   Wood • TweetShift" },
          timestamp: within,
        },
      ],
    });

    expect(out).toEqual([
      {
        followerUserId: FOLLOWER,
        credentialId: SELECTED_CREDENTIAL_ID,
        sourceItemId: "x_signal:sig-1",
        sourceEventAt: within.toISOString(),
        symbol: "TSLA",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "EQUITY",
        maxTradeSize: null,
        maxCoinSize: null,
        tradeAction: "Buy",
        copySourceLabel: undefined,
      },
    ]);
  });

  it("SKIPS a paste.trade perp/short x_author signal instead of mirroring it as an equity buy", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-perp-short",
          symbol: "GOOGL",
          content: "GOOGL short 20x perp",
          metadata: {
            authorName: "Cathie Wood",
            platform: "hyperliquid",
            instrument: "perp",
            direction: "short",
          },
          timestamp: within,
        },
      ],
    });

    // A perp short must never become a GOOGL equity BUY on the follower's account.
    expect(out).toHaveLength(0);
  });

  it("emits an explicit Hyperliquid PERP candidate only when the perps flag is enabled", async () => {
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        follows: [xAuthorFollow("cathie wood", FOLLOWER)],
        signalRows: [
          {
            id: "sig-perp-enabled",
            symbol: "GOOGL",
            content: "GOOGL short 20x perp",
            metadata: {
              authorName: "Cathie Wood",
              platform: "hyperliquid",
              instrument: "perp",
              direction: "short",
              leverage: 20,
              hlTicker: "xyz:GOOGL",
            },
            timestamp: within,
          },
          {
            id: "sig-perp-long",
            symbol: "BTC",
            content: "BTC long perp",
            metadata: {
              authorName: "Cathie Wood",
              platform: "hyperliquid",
              instrument: "perp",
              direction: "long",
              leverage: 3,
              hlTicker: "BTC",
            },
            timestamp: within,
          },
        ],
      });

      expect(out).toEqual([
        {
          followerUserId: FOLLOWER,
          credentialId: SELECTED_CREDENTIAL_ID,
          sourceItemId: "x_signal:sig-perp-enabled",
          // Staged on whatever network was configured, so a delivery retried
          // after a switch can be refused rather than placed on the wrong chain.
          sourceVenueNetwork: "mainnet",
          sourceEventAt: within.toISOString(),
          symbol: "xyz:GOOGL",
          side: "sell",
          sizingMode: "usd",
          sizingValue: 500,
          assetType: "PERP",
          maxTradeSize: null,
          maxCoinSize: null,
          perpSide: "short",
          perpLeverage: 20,
          perpMarginMode: "isolated",
          copySourceLabel: undefined,
        },
        {
          followerUserId: FOLLOWER,
          credentialId: SELECTED_CREDENTIAL_ID,
          sourceItemId: "x_signal:sig-perp-long",
          // Staged on whatever network was configured, so a delivery retried
          // after a switch can be refused rather than placed on the wrong chain.
          sourceVenueNetwork: "mainnet",
          sourceEventAt: within.toISOString(),
          symbol: "BTC",
          side: "buy",
          sizingMode: "usd",
          sizingValue: 500,
          assetType: "PERP",
          maxTradeSize: null,
          maxCoinSize: null,
          perpSide: "long",
          perpLeverage: 3,
          perpMarginMode: "isolated",
          copySourceLabel: undefined,
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("mirrors an x_author signal whose stated timestamp is stale but was inserted within the window", async () => {
    // paste.trade's own `author_date` can lag several minutes behind when the
    // row actually reaches our board poll, so a signal can arrive with a
    // stated `timestamp` already older than windowStart. Windowing on
    // `timestamp` would let the watermark advance past it before it ever
    // existed in this table, permanently dropping it. `createdAt` (our
    // insertion time) is the correct gate, matching the social-trade path.
    const staleStatedTimestamp = new Date(now.getTime() - 10 * 60_000);
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        follows: [xAuthorFollow("cathie wood", FOLLOWER)],
        signalRows: [
          {
            id: "sig-late-insert",
            symbol: "SNDK",
            content: "SNDK short 10x perp",
            metadata: {
              authorName: "Cathie Wood",
              platform: "hyperliquid",
              instrument: "perps",
              direction: "short",
              leverage: 10,
              hlTicker: "xyz:SNDK",
            },
            timestamp: staleStatedTimestamp,
            createdAt: within,
          },
        ],
      });

      expect(out).toHaveLength(1);
      expect(out[0]!.sourceItemId).toBe("x_signal:sig-late-insert");
      // sourceEventAt still reflects the true stated call time, for staleness
      // checks downstream: only the discovery window's gate changed.
      expect(out[0]!.sourceEventAt).toBe(staleStatedTimestamp.toISOString());
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("SKIPS an x_author signal inserted after the window closes, even with a stale-but-in-window stated timestamp", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-inserted-late",
          symbol: "TSLA",
          content: "Buying $TSLA here",
          metadata: { authorName: "Cathie Wood" },
          timestamp: within,
          createdAt: new Date(now.getTime() + 60_000),
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("dates a perp candidate by the venue fill time, not by when we wrote the row", async () => {
    // The reconciler back-fills synthetic fill children with the venue time in
    // executedAt and lets createdAt default to whenever it caught up. Ordering by
    // createdAt makes an hours-old open look fresh, and makes a batch of catch-up
    // rows look simultaneous, which is how a close ends up sorted before its own
    // open. executedAt is the venue's clock and does not move with our downtime.
    const filledAt = new Date("2020-01-01T09:00:00.000Z");
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        socialTradeRows: [
          {
            id: "t-perp-backfilled",
            userId: SOURCE,
            symbol: "BTC",
            side: "buy",
            assetType: "PERP",
            orderId: "order-backfilled-perp",
            // Row written when reconciliation caught up...
            createdAt: within,
            orderCreatedAt: within,
            // ...but the venue says it filled hours earlier.
            orderExecutedAt: filledAt,
            orderUserId: SOURCE,
            orderSymbol: "BTC",
            orderAssetType: "PERP",
            orderQuantityDecimal: "0.5",
            orderExecutedSizeDecimal: "0.5",
            orderDirection: "long",
            orderVenue: "hyperliquid",
            orderReduceOnly: false,
          },
        ],
      });

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        sourceEventAt: filledAt.toISOString(),
        sourceOrderCreatedAt: filledAt.toISOString(),
      });
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("still stages a reduce-only CLOSE while the perps gate is shut", async () => {
    // Dropping a close at discovery is not the same as refusing to place it.
    // stageWindow advances the checkpoint either way, so a close skipped here is
    // gone for good, and a follower holding a position the mirror opened while
    // the gate was open would have no exit left. Staging is not permission:
    // preflight re-reads the same config per candidate and defers.
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    try {
      const perpRow = (id: string, reduceOnly: boolean) => ({
        id,
        userId: SOURCE,
        symbol: "BTC",
        side: reduceOnly ? "sell" : "buy",
        assetType: "PERP",
        orderId: `order-${id}`,
        createdAt: within,
        orderCreatedAt: within,
        orderUserId: SOURCE,
        orderSymbol: "BTC",
        orderAssetType: "PERP",
        orderQuantityDecimal: "0.25",
        orderExecutedSizeDecimal: "0.25",
        orderDirection: reduceOnly ? "short" : "long",
        orderVenue: "hyperliquid",
        orderReduceOnly: reduceOnly,
      });

      const out = await callFind({
        socialTradeRows: [perpRow("t-perp-open", false), perpRow("t-perp-close", true)],
      });

      // The open is correctly withheld; the close survives to be deferred later.
      expect(out.map((c) => c.sourceItemId)).toEqual(["user:t-perp-close"]);
      expect(out[0]).toMatchObject({ perpReduceOnly: true, assetType: "PERP" });
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  it("stages no perp candidate at all while the Hyperliquid reconciler is off", async () => {
    // Same rows as the test above, which produce two perp candidates when the
    // reconciler is on. With the reconciler deliberately killed, perp intent
    // must not even be staged: a staged delivery is durable and retried, so
    // refusing at discovery keeps the deployment from queueing leveraged work
    // it has no way to reconcile.
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousSync = process.env.HYPERLIQUID_SYNC_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_SYNC_ENABLED = "false";
    try {
      const out = await callFind({
        follows: [xAuthorFollow("cathie wood", FOLLOWER)],
        signalRows: [
          {
            id: "sig-perp-long",
            symbol: "BTC",
            content: "BTC long perp",
            metadata: {
              authorName: "Cathie Wood",
              platform: "hyperliquid",
              instrument: "perp",
              direction: "long",
              leverage: 3,
              hlTicker: "BTC",
            },
            timestamp: within,
          },
        ],
      });

      expect(out).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
      if (previousSync === undefined) delete process.env.HYPERLIQUID_SYNC_ENABLED;
      else process.env.HYPERLIQUID_SYNC_ENABLED = previousSync;
    }
  });

  it("never routes another venue's perp signal into Hyperliquid", async () => {
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const out = await callFind({
        follows: [xAuthorFollow("cathie wood", FOLLOWER)],
        signalRows: [
          {
            id: "sig-dydx",
            symbol: "BTC",
            content: "BTC long perp",
            metadata: {
              authorName: "Cathie Wood",
              platform: "dydx",
              instrument: "perp",
              direction: "long",
            },
            timestamp: within,
          },
        ],
      });
      expect(out).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  });

  /**
   * Routing + input-trust guards on the signal -> perp path. Every case here
   * describes a row that previously produced a LEVERAGED order on a market
   * nobody named. The expected result is always "no candidate": a missed mirror
   * is recoverable, a wrong-market order is not.
   */
  describe("perp routing fails closed on untrusted or ambiguous rows", () => {
    // The perps opt-in is not sufficient on its own: HYPERLIQUID_SYNC_ENABLED is
    // a hard precondition, so a test that wants to reach the perp path has to
    // satisfy both. The refusal itself is tested in copy-mirror-perp-sync-gate.
    function withPerpsEnabled<T>(run: () => Promise<T>): Promise<T> {
      const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      const previousSync = process.env.HYPERLIQUID_SYNC_ENABLED;
      process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
      process.env.HYPERLIQUID_SYNC_ENABLED = "true";
      return run().finally(() => {
        if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
        else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
        if (previousSync === undefined) delete process.env.HYPERLIQUID_SYNC_ENABLED;
        else process.env.HYPERLIQUID_SYNC_ENABLED = previousSync;
      });
    }

    function perpSignal(metadata: Record<string, unknown>, symbol = "BTC") {
      return {
        id: "sig-routing",
        symbol,
        content: "no prose tells here",
        metadata: { authorName: "Cathie Wood", ...metadata },
        timestamp: within,
      };
    }

    it("refuses a Hyperliquid row whose instrument is not a perp", async () => {
      // Hyperliquid lists spot too. Venue alone used to be enough to submit a
      // LEVERAGED perp, so a spot row became a leveraged position.
      const out = await withPerpsEnabled(() =>
        callFind({
          follows: [xAuthorFollow("cathie wood", FOLLOWER)],
          signalRows: [
            perpSignal({
              platform: "hyperliquid",
              instrument: "spot",
              direction: "long",
              hlTicker: "BTC",
              leverage: 5,
            }),
          ],
        }),
      );
      expect(out).toHaveLength(0);
    });

    it("refuses a Hyperliquid row with no instrument at all", async () => {
      const out = await withPerpsEnabled(() =>
        callFind({
          follows: [xAuthorFollow("cathie wood", FOLLOWER)],
          signalRows: [
            perpSignal({ platform: "hyperliquid", direction: "long", hlTicker: "BTC" }),
          ],
        }),
      );
      expect(out).toHaveLength(0);
    });

    it("never falls back to the uppercased ticker when the canonical coin is missing", async () => {
      // signals.symbol is uppercased at ingest, so "kPEPE" arrives as "KPEPE"
      // (an unknown coin) and the bare underlying of a HIP-3 market resolves to
      // a different market entirely. Absent hlTicker means skip, not guess.
      const out = await withPerpsEnabled(() =>
        callFind({
          follows: [xAuthorFollow("cathie wood", FOLLOWER)],
          signalRows: [
            perpSignal(
              { platform: "hyperliquid", instrument: "perp", direction: "long", leverage: 5 },
              "KPEPE",
            ),
          ],
        }),
      );
      expect(out).toHaveLength(0);
    });

    it("refuses a non-canonical hlTicker instead of passing it to the venue", async () => {
      // Surrounding whitespace is trimmed (see the canonical-spelling case
      // below); everything here is a value HL could not resolve as written.
      for (const hlTicker of ["BTC/USD", "BTC USD", "", "xyz:", "a:b:c", "kPEPE-PERP", 42]) {
        const out = await withPerpsEnabled(() =>
          callFind({
            follows: [xAuthorFollow("cathie wood", FOLLOWER)],
            signalRows: [
              perpSignal({
                platform: "hyperliquid",
                instrument: "perp",
                direction: "long",
                hlTicker,
              }),
            ],
          }),
        );
        expect(out).toHaveLength(0);
      }
    });

    it("keeps a canonical coin exactly as upstream spelled it", async () => {
      const out = await withPerpsEnabled(() =>
        callFind({
          follows: [xAuthorFollow("cathie wood", FOLLOWER)],
          signalRows: [
            perpSignal(
              {
                platform: "hyperliquid",
                instrument: "perp",
                direction: "long",
                hlTicker: " kPEPE ",
                leverage: 5,
              },
              "KPEPE",
            ),
          ],
        }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.symbol).toBe("kPEPE");
    });

    it("does not mirror a leverage-only row as an equity BUY", async () => {
      // paste.trade dropping platform/instrument while keeping direction and
      // leverage turned every perp call into a mirrorable equity long. The
      // leverage alone is now enough to keep it off the equity path, and it is
      // not enough to place a perp either.
      const rows = [
        perpSignal({ direction: "long", leverage: 20 }, "GOOGL"),
        perpSignal({ direction: "long", hlTicker: "BTC" }, "BTC"),
      ];
      for (const row of rows) {
        expect(
          await callFind({
            follows: [xAuthorFollow("cathie wood", FOLLOWER)],
            signalRows: [row],
          }),
        ).toHaveLength(0);
        expect(
          await withPerpsEnabled(() =>
            callFind({
              follows: [xAuthorFollow("cathie wood", FOLLOWER)],
              signalRows: [row],
            }),
          ),
        ).toHaveLength(0);
      }
    });

    it("still mirrors a plain equity signal that merely lacks perp fields", async () => {
      const out = await callFind({
        follows: [xAuthorFollow("cathie wood", FOLLOWER)],
        signalRows: [
          {
            id: "sig-plain",
            symbol: "tsla",
            content: "Buying $TSLA here",
            // leverage present but explicitly "none": not a perp tell.
            metadata: { authorName: "Cathie Wood", leverage: null, hlTicker: null },
            timestamp: within,
          },
        ],
      });
      expect(out).toHaveLength(1);
      expect(out[0]!.symbol).toBe("TSLA");
      expect(out[0]!.assetType).toBe("EQUITY");
    });

    it("refuses a source user perp trade whose stored coin is not canonical", async () => {
      const out = await withPerpsEnabled(() =>
        callFind({
          socialTradeRows: [
            {
              id: "t-perp-bad-coin",
              userId: SOURCE,
              symbol: "BTC",
              side: "buy",
              assetType: "PERP",
              createdAt: within,
              orderUserId: SOURCE,
              orderSymbol: "BTC/USD",
              orderAssetType: "PERP",
              orderQuantityDecimal: "0.25",
              orderDirection: "long",
              orderLeverage: 3,
              orderMarginMode: "isolated",
              orderVenue: "hyperliquid",
              orderReduceOnly: false,
            },
          ],
        }),
      );
      expect(out).toHaveLength(0);
    });
  });

  it("SKIPS a short-direction x_author signal even without perp/venue metadata", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-short-only",
          symbol: "TSLA",
          content: "TSLA short",
          metadata: { authorName: "Cathie Wood", direction: "short" },
          timestamp: within,
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("still mirrors a plain equity x_author signal (no perp/short metadata) as a BUY while skipping a sibling perp signal", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-perp",
          symbol: "GOOGL",
          content: "GOOGL long 10x perp",
          metadata: {
            authorName: "Cathie Wood",
            platform: "hyperliquid",
            instrument: "perp",
            direction: "long",
          },
          timestamp: within,
        },
        {
          id: "sig-equity",
          symbol: "tsla",
          content: "Buying $TSLA here",
          metadata: { authorName: "Cathie Wood" },
          timestamp: within,
        },
      ],
    });

    // The perp long is skipped (it is not a spot equity); the plain equity signal
    // still mirrors as a buy exactly as before.
    expect(out).toEqual([
      {
        followerUserId: FOLLOWER,
        credentialId: SELECTED_CREDENTIAL_ID,
        sourceItemId: "x_signal:sig-equity",
        sourceEventAt: within.toISOString(),
        symbol: "TSLA",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "EQUITY",
        maxTradeSize: null,
        maxCoinSize: null,
        tradeAction: "Buy",
        copySourceLabel: undefined,
      },
    ]);
  });

  it("mirrors an x_author option signal when the content has a complete safe contract", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-option",
          symbol: "AAPL",
          content: "BTO $AAPL 250C 7/19",
          metadata: { authorName: "Cathie Wood" },
          timestamp: new Date("2026-06-19T12:00:00.000Z"),
        },
      ],
    });

    expect(out).toEqual([
      {
        followerUserId: FOLLOWER,
        credentialId: SELECTED_CREDENTIAL_ID,
        sourceItemId: "x_signal:sig-option",
        sourceEventAt: "2026-06-19T12:00:00.000Z",
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "OPTION",
        maxTradeSize: null,
        maxCoinSize: null,
        optionExpiration: "260719",
        optionStrike: 250,
        optionType: "CALL",
        tradeAction: "BuyToOpen",
        copySourceLabel: undefined,
      },
    ]);
  });

  it("SKIPS an x_author option-looking signal when the contract is ambiguous", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-ambiguous-option",
          symbol: "AAPL",
          content: "$AAPL calls look interesting",
          metadata: { authorName: "Cathie Wood" },
          timestamp: new Date("2026-06-19T12:00:00.000Z"),
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("SKIPS an x_author option signal whose explicit ticker conflicts with the row symbol", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-mismatched-option",
          symbol: "TSLA",
          content: "BTO $AAPL 250C 7/19",
          metadata: { authorName: "Cathie Wood" },
          timestamp: new Date("2026-06-19T12:00:00.000Z"),
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("SKIPS a ticker-first x_author option signal whose ticker conflicts with the row symbol", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-ticker-first-mismatch",
          symbol: "TSLA",
          content: "AAPL 250C 7/19 BTO",
          metadata: { authorName: "Cathie Wood" },
          timestamp: new Date("2026-06-19T12:00:00.000Z"),
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("SKIPS an x_author signal whose normalized author is unknown", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("unknown", FOLLOWER)],
      signalRows: [
        {
          id: "sig-unknown",
          symbol: "AAPL",
          metadata: { authorName: "Unknown" },
          timestamp: within,
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("SKIPS an x_author signal with a matching author but no symbol", async () => {
    const out = await callFind({
      follows: [xAuthorFollow("cathie wood", FOLLOWER)],
      signalRows: [
        {
          id: "sig-no-symbol",
          symbol: null,
          metadata: { authorName: "Cathie Wood" },
          timestamp: within,
        },
      ],
    });

    expect(out).toHaveLength(0);
  });

  it("emits one x_author candidate for duplicate follow rows to the same signal path", async () => {
    const out = await callFind({
      follows: [
        xAuthorFollow("cathie wood", FOLLOWER),
        xAuthorFollow("cathie wood", FOLLOWER),
      ],
      signalRows: [
        {
          id: "sig-dup",
          symbol: "AAPL",
          metadata: { authorName: "Cathie Wood" },
          timestamp: within,
        },
      ],
    });

    expect(out.map((c) => c.sourceItemId)).toEqual(["x_signal:sig-dup"]);
  });
});

// ---------------------------------------------------------------------------
// HIGH-2: a mirrored SELL must never OPEN a naked short. The sell is clamped to
// the follower's held long; with no long position the sell is skipped.
// ---------------------------------------------------------------------------

describe("decideSellMirrorQty (H-2: no naked short)", () => {
  it("SKIPS (no-long-position) when the follower holds no long", () => {
    const d = decideSellMirrorQty(10, 0);
    expect(d.action).toBe("skip");
    if (d.action !== "skip") throw new Error("expected skip");
    expect(d.reason).toBe("no-long-position");
  });

  it("SKIPS when the held long qty is negative/NaN (e.g. a short position)", () => {
    expect(decideSellMirrorQty(10, -5).action).toBe("skip");
    expect(decideSellMirrorQty(10, Number.NaN).action).toBe("skip");
  });

  it("CLAMPS the sell to the held long when the computed qty exceeds it", () => {
    const d = decideSellMirrorQty(100, 30);
    expect(d.action).toBe("place");
    if (d.action !== "place") throw new Error("expected place");
    expect(d.qty).toBe(30); // never sells more than held -> never flips short
  });

  it("places the full computed qty when the follower holds at least that many", () => {
    const d = decideSellMirrorQty(10, 50);
    expect(d.action).toBe("place");
    if (d.action !== "place") throw new Error("expected place");
    expect(d.qty).toBe(10);
  });

  it("floors a fractional held-long qty before clamping", () => {
    const d = decideSellMirrorQty(100, 7.9);
    expect(d.action).toBe("place");
    if (d.action !== "place") throw new Error("expected place");
    expect(d.qty).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// alpaca-13: a mirrored BUY that has not settled must not count toward the
// attribution ceiling at its REQUESTED size. `decideSellMirrorQty` above only
// bounds a mirrored SELL to the follower's WHOLE long (own shares included),
// so an inflated `mirroredLongQty` is not caught by anything downstream: it
// is spent straight out of shares the follower bought themselves the moment
// the paired open fails to fill (rejected, expired, or simply still queued
// when the source closes). Only `executedQuantity` — what Alpaca reports as
// actually filled — may describe what the mirror put in the account.
// ---------------------------------------------------------------------------

describe("netMirroredEquityQty (alpaca-13: unfilled/partial opens must not over-attribute)", () => {
  function row(partial: Partial<MirroredEquityOrderRow>): MirroredEquityOrderRow {
    return {
      tradeAction: "Buy",
      status: "SUBMITTED",
      quantity: null,
      executedQuantity: null,
      ...partial,
    };
  }

  it("reads a still-working, entirely UNFILLED buy as zero exposure, not its requested size", () => {
    // The order is resting at the broker with nothing filled yet (e.g. a day
    // order queued after hours). Nothing was put in the account, so nothing is
    // attributable to a close.
    const qty = netMirroredEquityQty([
      row({ status: "SUBMITTED", quantity: 100, executedQuantity: 0 }),
    ]);
    expect(qty).toBe(0);
  });

  it("reads a still-working PARTIAL fill as only what has filled so far, not the full request", () => {
    const qty = netMirroredEquityQty([
      row({ status: "PARTIAL", quantity: 100, executedQuantity: 20 }),
    ]);
    expect(qty).toBe(20);
  });

  it("still reads a FILLED row at its executed quantity", () => {
    const qty = netMirroredEquityQty([
      row({ status: "FILLED", quantity: 100, executedQuantity: 100 }),
    ]);
    expect(qty).toBe(100);
  });

  it("still reads a row cancelled after a partial fill at what actually filled", () => {
    const qty = netMirroredEquityQty([
      row({ status: "CANCELLED", quantity: 500, executedQuantity: 20 }),
    ]);
    expect(qty).toBe(20);
  });

  it("still reads a rejected/cancelled/expired row with no fill as zero", () => {
    expect(netMirroredEquityQty([row({ status: "REJECTED", quantity: 100, executedQuantity: 0 })])).toBe(0);
    expect(netMirroredEquityQty([row({ status: "CANCELLED", quantity: 100, executedQuantity: 0 })])).toBe(0);
    expect(netMirroredEquityQty([row({ status: "EXPIRED", quantity: 100, executedQuantity: 0 })])).toBe(0);
  });

  it("the practical consequence: an unfilled open can no longer inflate what a close is allowed to sell", () => {
    // Follower's own 500 hand-bought shares are NOT modeled here at all — that
    // is the point. `mirroredLongQty` must come only from what the mirror
    // itself has filled, so an unfilled 100-share open contributes 0, and a
    // close finds nothing attributable rather than "up to 100" to spend out of
    // the follower's unrelated holding.
    const mirroredLongQty = netMirroredEquityQty([
      row({ status: "SUBMITTED", quantity: 100, executedQuantity: 0 }),
    ]);
    const attributed = clampSellToMirroredExposure(100, mirroredLongQty);
    expect(attributed).toEqual({ action: "skip", reason: "no-mirrored-exposure" });
  });
});

describe("mirroredEquityExposure (alpaca-13: a still-settling open flags its qty as an under-read)", () => {
  function pollerWithOrders(rows: unknown[]) {
    return new CopyMirrorPoller({
      query: { orders: { findMany: async () => rows } },
    } as never);
  }

  function exposureOf(poller: CopyMirrorPoller, cand: Record<string, unknown>) {
    return (
      poller as unknown as {
        mirroredEquityExposure: (cand: unknown) => Promise<{
          qty: number;
          credentialId: string | null;
          accounts: string[];
          unanswerable: null | "spans-accounts" | "scan-saturated";
          hasUnsettledOpen: boolean;
        }>;
      }
    ).mirroredEquityExposure(cand);
  }

  const CAND = {
    followerUserId: "follower-1",
    sourceItemId: "x_signal:exposure-test",
    assetType: "EQUITY",
    symbol: "XYZ",
    side: "sell",
    sizingMode: "ratio",
  };

  it("reads qty as only what has filled, and flags hasUnsettledOpen, while a mirrored open is still working", async () => {
    const poller = pollerWithOrders([
      {
        tradeAction: "Buy",
        clientOrderId: "copymirror:follower-1:x_signal:exposure-test",
        status: "SUBMITTED",
        quantity: 100,
        executedQuantity: 0,
        brokerAccountId: "acct-1",
        brokerCredentialId: "cred-1",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
      },
    ]);
    const exposure = await exposureOf(poller, CAND);
    // Not `unanswerable`: a caller that has no use for `qty` (a BUY, or a
    // close whose live long already reads zero) has no reason to hold on this
    // alone. `hasUnsettledOpen` lets a caller that DOES need `qty` decide for
    // itself whether an under-read matters here.
    expect(exposure.unanswerable).toBeNull();
    expect(exposure.qty).toBe(0);
    expect(exposure.hasUnsettledOpen).toBe(true);
  });

  it("does not flag hasUnsettledOpen once the open has settled (FILLED)", async () => {
    const poller = pollerWithOrders([
      {
        tradeAction: "Buy",
        clientOrderId: "copymirror:follower-1:x_signal:exposure-test",
        status: "FILLED",
        quantity: 100,
        executedQuantity: 100,
        brokerAccountId: "acct-1",
        brokerCredentialId: "cred-1",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
      },
    ]);
    const exposure = await exposureOf(poller, CAND);
    expect(exposure.unanswerable).toBeNull();
    expect(exposure.hasUnsettledOpen).toBe(false);
    expect(exposure.qty).toBe(100);
  });

  it("does not flag hasUnsettledOpen on a still-working DISPOSAL row (a resumed close is not a paired open)", async () => {
    // A PENDING row for THIS close's own resume attempt (or a prior mirrored
    // sell still working) must never block itself forever.
    const poller = pollerWithOrders([
      {
        tradeAction: "Buy",
        clientOrderId: "copymirror:follower-1:x_signal:exposure-test",
        status: "FILLED",
        quantity: 100,
        executedQuantity: 100,
        brokerAccountId: "acct-1",
        brokerCredentialId: "cred-1",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
      },
      {
        tradeAction: "Sell",
        clientOrderId: "copymirror:follower-1:x_signal:exposure-test",
        status: "PENDING",
        quantity: 100,
        executedQuantity: 0,
        brokerAccountId: "acct-1",
        brokerCredentialId: "cred-1",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
      },
    ]);
    const exposure = await exposureOf(poller, CAND);
    expect(exposure.hasUnsettledOpen).toBe(false);
  });
});

describe("option quote safety", () => {
  it("requires an ask for buys and a bid for sells", async () => {
    const poller = new CopyMirrorPoller({} as never);
    const fetchOptionPrice = (
      poller as unknown as {
        fetchOptionPrice: (
          client: unknown,
          symbol: string,
          side: "buy" | "sell",
        ) => Promise<number>;
      }
    ).fetchOptionPrice.bind(poller);

    expect(
      await fetchOptionPrice(
        { getLatestOptionQuote: async () => ({ latestQuote: { bp: 1.25 } }) },
        "AAPL260719C00250000",
        "buy",
      ),
    ).toBe(0);
    expect(
      await fetchOptionPrice(
        { getLatestOptionQuote: async () => ({ latestQuote: { ap: 2.5 } }) },
        "AAPL260719C00250000",
        "sell",
      ),
    ).toBe(0);
    expect(
      await fetchOptionPrice(
        { getLatestOptionQuote: async () => ({ latestQuote: { bp: 1.25, ap: 2.5 } }) },
        "AAPL260719C00250000",
        "buy",
      ),
    ).toBe(2.5);
  });

  it("propagates transient option quote failures for durable retry", async () => {
    const poller = new CopyMirrorPoller({} as never);
    const fetchOptionPrice = (
      poller as unknown as {
        fetchOptionPrice: (
          client: unknown,
          symbol: string,
          side: "buy" | "sell",
        ) => Promise<number>;
      }
    ).fetchOptionPrice.bind(poller);

    await expect(
      fetchOptionPrice(
        {
          getLatestOptionQuote: async () => {
            throw Object.assign(new Error("quote service unavailable"), { status: 503 });
          },
        },
        "AAPL260719C00250000",
        "buy",
      ),
    ).rejects.toThrow("quote service unavailable");
  });
});

describe("broker read retry safety", () => {
  it("retries transient equity quote failures instead of consuming the candidate", async () => {
    const poller = new CopyMirrorPoller({} as never);
    const fetchPrice = (
      poller as unknown as {
        fetchPrice: (client: unknown, candidate: unknown, symbol: string) => Promise<number>;
      }
    ).fetchPrice.bind(poller);

    await expect(
      fetchPrice(
        {
          getLatestTrade: async () => {
            throw Object.assign(new Error("trade feed unavailable"), { status: 503 });
          },
          getSnapshot: async () => {
            throw Object.assign(new Error("snapshot unavailable"), { status: 503 });
          },
        },
        { assetType: "EQUITY", side: "buy" },
        "AAPL",
      ),
    ).rejects.toThrow("snapshot unavailable");
  });

  it("treats a missing position as zero but retries a transient position outage", async () => {
    const poller = new CopyMirrorPoller({} as never);
    const fetchLongQty = (
      poller as unknown as {
        fetchLongQty: (client: unknown, symbol: string) => Promise<number>;
      }
    ).fetchLongQty.bind(poller);

    expect(
      await fetchLongQty(
        {
          getPosition: async () => {
            throw Object.assign(new Error("position not found"), { status: 404 });
          },
        },
        "AAPL",
      ),
    ).toBe(0);

    await expect(
      fetchLongQty(
        {
          getPosition: async () => {
            throw Object.assign(new Error("positions unavailable"), { status: 503 });
          },
        },
        "AAPL",
      ),
    ).rejects.toThrow("positions unavailable");
  });
});

describe("daily mirror cap read safety", () => {
  it("fails closed when today's mirror count cannot be read", async () => {
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => {
            throw new Error("database unavailable");
          },
        },
      },
    } as never);

    const count = await (
      poller as unknown as {
        countMirrorsToday: (userId: string) => Promise<number | null>;
      }
    ).countMirrorsToday("follower-1");
    expect(count).toBeNull();
  });
});

describe("placeMirrorOrder option payload", () => {
  it("stores option fields and submits a cap-safe OCC limit order with position_intent", async () => {
    const followerUserId = "follower-1";
    const inserted: unknown[] = [];
    const updates: unknown[] = [];
    let alpacaRequest: unknown;

    const db = {
      insert: () => ({
        values(value: unknown) {
          inserted.push(value);
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  return Promise.resolve([{ id: "local-order-1" }]);
                },
              };
            },
          };
        },
      }),
      update: () => ({
        set(value: unknown) {
          updates.push(value);
          return {
            where() {
              return { returning: async () => [{ id: "updated-option" }] };
            },
          };
        },
      }),
    } as never;

    const client = {
      createOrder: async (request: unknown) => {
        alpacaRequest = request;
        return { id: "broker-order-1" };
      },
    } as never;

    const poller = new CopyMirrorPoller(db);
    await (
      poller as unknown as {
        placeMirrorOrder: (
          client: unknown,
          params: {
            followerUserId: string;
            symbol: string;
            tradingSymbol: string;
            side: "buy" | "sell";
            qty: number;
            clientOrderId: string;
            brokerAccountId: string | null;
            brokerCredentialId: string | null;
            isPaper: boolean;
            assetType: "OPTION";
            optionExpiration: string;
            optionStrike: number;
            optionType: "CALL";
            tradeAction: "BuyToOpen";
            limitPrice: number;
          },
        ) => Promise<void>;
      }
    ).placeMirrorOrder(client, {
      followerUserId,
      symbol: "AAPL",
      tradingSymbol: "AAPL260719C00250000",
      side: "buy",
      qty: 2,
      clientOrderId: "copymirror:follower-1:x_signal:sig-option",
      brokerAccountId: "paper-account",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      isPaper: true,
      assetType: "OPTION",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
      limitPrice: 2.5,
    });

    expect(inserted[0]).toMatchObject({
      userId: followerUserId,
      symbol: "AAPL",
      assetType: "OPTION",
      orderType: "Limit",
      limitPrice: "2.5",
      tradeAction: "BuyToOpen",
      direction: "long",
      quantity: 2,
      optionExpiration: "260719",
      optionStrike: "250",
      optionType: "CALL",
      clientOrderId: "copymirror:follower-1:x_signal:sig-option",
      brokerClientOrderId: createBrokerClientOrderId(
        "follower-1",
        "copymirror:follower-1:x_signal:sig-option",
        "copy",
      ),
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
    });
    expect(alpacaRequest).toMatchObject({
      symbol: "AAPL260719C00250000",
      qty: 2,
      side: "buy",
      type: "limit",
      limit_price: 2.5,
      time_in_force: "day",
      client_order_id: createBrokerClientOrderId(
        "follower-1",
        "copymirror:follower-1:x_signal:sig-option",
        "copy",
      ),
      extended_hours: false,
      position_intent: "buy_to_open",
    });
    expect(updates[0]).toMatchObject({
      status: "SUBMITTED",
      brokerOrderId: "broker-order-1",
    });
  });

  it("keeps a broker-accepted mirror SYNCING when the local acceptance update fails", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let updateCall = 0;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "local-mirror-1", userId: "follower-1" }],
          }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return {
            where() {
              updateCall += 1;
              if (updateCall === 1) throw new Error("database unavailable after accept");
            },
          };
        },
      }),
    } as never;
    const client = {
      createOrder: async () => ({ id: "broker-mirror-1" }),
    } as never;
    const poller = new CopyMirrorPoller(db);

    await (
      poller as unknown as {
        placeMirrorOrder: (client: unknown, params: Record<string, unknown>) => Promise<void>;
      }
    ).placeMirrorOrder(client, {
      followerUserId: "follower-1",
      symbol: "AAPL",
      tradingSymbol: "AAPL",
      side: "buy",
      qty: 1,
      clientOrderId: "copymirror:follower-1:user:source-1",
      brokerAccountId: "paper-account",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      isPaper: true,
      assetType: "EQUITY",
    });

    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: "SYNCING",
        brokerOrderId: "broker-mirror-1",
      }),
    );
  });

  it("does not claim an Alpaca mirror or publish social when acceptance CAS matches zero rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values(value: Record<string, unknown>) {
          inserts.push(value);
          if (value.status === "PENDING") {
            return {
              onConflictDoNothing: () => ({ returning: async () => [{ id: "local-mirror-cas" }] }),
            };
          }
          return Promise.resolve();
        },
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);

    const outcome = await (
      poller as unknown as {
        placeMirrorOrder: (client: unknown, params: Record<string, unknown>) => Promise<string>;
      }
    ).placeMirrorOrder(
      { createOrder: async () => ({ id: "broker-mirror-cas" }) },
      {
        followerUserId: "follower-cas",
        symbol: "AAPL",
        tradingSymbol: "AAPL",
        side: "buy",
        qty: 1,
        clientOrderId: "copymirror:follower-cas:user:cas",
        brokerAccountId: "paper-account",
        brokerCredentialId: "11111111-1111-4111-8111-111111111111",
        isPaper: true,
        assetType: "EQUITY",
      },
    );

    expect(outcome).toBe("syncing");
    expect(updates.map((update) => update.status)).toEqual(["SUBMITTED", "SYNCING"]);
    expect(inserts).toHaveLength(1);
  });

  it("does not claim an Alpaca mirror or publish social when acceptance CAS returns multiple rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    let updateCall = 0;
    const db = {
      query: { orders: { findFirst: async () => null } },
      insert: () => ({
        values(value: Record<string, unknown>) {
          inserts.push(value);
          if (value.status === "PENDING") {
            return {
              onConflictDoNothing: () => ({ returning: async () => [{ id: "local-mirror-multi" }] }),
            };
          }
          return Promise.resolve();
        },
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return {
            where: () => ({
              returning: async () => {
                updateCall += 1;
                return updateCall === 1
                  ? [{ id: "winner-a" }, { id: "winner-b" }]
                  : [];
              },
            }),
          };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);

    const outcome = await (
      poller as unknown as {
        placeMirrorOrder: (client: unknown, params: Record<string, unknown>) => Promise<string>;
      }
    ).placeMirrorOrder(
      { createOrder: async () => ({ id: "broker-mirror-multi" }) },
      {
        followerUserId: "follower-multi",
        symbol: "AAPL",
        tradingSymbol: "AAPL",
        side: "buy",
        qty: 1,
        clientOrderId: "copymirror:follower-multi:user:multi",
        brokerAccountId: "paper-account",
        brokerCredentialId: "11111111-1111-4111-8111-111111111111",
        isPaper: true,
        assetType: "EQUITY",
      },
    );

    expect(outcome).toBe("syncing");
    expect(inserts).toHaveLength(1);
    expect(inserts.some((value) => value.brokerOrderId === "broker-mirror-multi")).toBe(false);
  });
});

describe("placeMirrorOrder equity payload", () => {
  // Alpaca infers open-vs-close from account state when position_intent is
  // absent (alpaca-14). A mirrored BUY only ever OPENS or ADDS TO a mirrored
  // long — copy-mirror never intentionally opens a short (see the
  // "never open a naked short by mirroring" guards elsewhere in this file) —
  // and a mirrored SELL is only ever sent after fetchLongQty/decideSellMirrorQty
  // confirm it closes an existing mirrored long. Declaring that intent to the
  // broker stops an ambiguous BUY from silently covering a short the follower
  // opened on their own, which is the exact corruption the audit found.
  it("submits an equity BUY mirror with position_intent buy_to_open", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let alpacaRequest: Record<string, unknown> | undefined;

    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "local-equity-buy-1" }],
          }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    } as never;

    const client = {
      createOrder: async (request: Record<string, unknown>) => {
        alpacaRequest = request;
        return { id: "broker-equity-buy-1" };
      },
    } as never;

    const poller = new CopyMirrorPoller(db);
    await (
      poller as unknown as {
        placeMirrorOrder: (client: unknown, params: Record<string, unknown>) => Promise<void>;
      }
    ).placeMirrorOrder(client, {
      followerUserId: "follower-equity-buy",
      symbol: "AAPL",
      tradingSymbol: "AAPL",
      side: "buy",
      qty: 10,
      clientOrderId: "copymirror:follower-equity-buy:user:source-buy",
      brokerAccountId: "paper-account",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      isPaper: true,
      assetType: "EQUITY",
    });

    expect(alpacaRequest).toMatchObject({
      side: "buy",
      position_intent: "buy_to_open",
    });
  });

  it("submits an equity SELL mirror (close) with position_intent sell_to_close", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let alpacaRequest: Record<string, unknown> | undefined;

    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "local-equity-sell-1" }],
          }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    } as never;

    const client = {
      createOrder: async (request: Record<string, unknown>) => {
        alpacaRequest = request;
        return { id: "broker-equity-sell-1" };
      },
    } as never;

    const poller = new CopyMirrorPoller(db);
    await (
      poller as unknown as {
        placeMirrorOrder: (client: unknown, params: Record<string, unknown>) => Promise<void>;
      }
    ).placeMirrorOrder(client, {
      followerUserId: "follower-equity-sell",
      symbol: "AAPL",
      tradingSymbol: "AAPL",
      side: "sell",
      qty: 10,
      clientOrderId: "copymirror:follower-equity-sell:user:source-sell",
      brokerAccountId: "paper-account",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      isPaper: true,
      assetType: "EQUITY",
    });

    expect(alpacaRequest).toMatchObject({
      side: "sell",
      position_intent: "sell_to_close",
    });
  });
});

describe("placeMirrorOrder transient recovery", () => {
  const params = {
    followerUserId: "follower-retry",
    symbol: "AAPL",
    tradingSymbol: "AAPL",
    side: "buy" as const,
    qty: 5,
    clientOrderId: "copymirror:follower-retry:user:source-retry",
    brokerAccountId: "paper-account",
    isPaper: true,
    assetType: "EQUITY" as const,
    tradeAction: "Buy" as const,
  };

  type PlaceMirrorOrder = (
    client: unknown,
    value: typeof params,
  ) => Promise<string>;

  it("leaves the durable local order pending when broker submission fails transiently", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "local-retry" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "updated-rejected" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    await expect(
      place(
        {
          createOrder: async () => {
            throw Object.assign(new Error("gateway timeout"), { status: 503 });
          },
        },
        params,
      ),
    ).rejects.toThrow("gateway timeout");

    expect(updates.some((value) => value.status === "REJECTED")).toBe(false);
  });

  // What Alpaca can actually hold as this mirror's client_order_id. The bounded
  // "rst-copy-<hash>" id is the only form submitted today: the logical key is
  // about 89 chars and the client rejects anything over 48 before the SDK sees
  // it, so a fixture carrying the logical key alone proves nothing about the
  // recovery path. The raw form still appears on mirrors placed before the
  // bounded id existed, which is why both are reconciled.
  const brokerHeldClientIds = [
    {
      label: "the bounded broker-facing client id",
      value: createBrokerClientOrderId(
        params.followerUserId,
        params.clientOrderId,
        "copy",
      ),
    },
    {
      label: "a legacy raw mirror client id",
      value: params.clientOrderId,
    },
  ];

  for (const brokerHeld of brokerHeldClientIds) {
    it(`reconciles an existing pending order by ${brokerHeld.label} before attempting another POST`, async () => {
      const updates: Array<Record<string, unknown>> = [];
      let createCalls = 0;
      const existing = {
        id: "local-existing",
        status: "PENDING",
        brokerOrderId: null,
        clientOrderId: params.clientOrderId,
      };
      const db = {
        query: { orders: { findFirst: async () => existing } },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [] }),
          }),
        }),
        update: () => ({
          set(value: Record<string, unknown>) {
            updates.push(value);
            return { where: () => ({ returning: async () => [{ id: "updated-existing" }] }) };
          },
        }),
      } as never;
      const poller = new CopyMirrorPoller(db);
      const place = (
        poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
      ).placeMirrorOrder.bind(poller);

      const outcome = await place(
        {
          getOrders: async () => [
            {
              id: "broker-existing",
              client_order_id: brokerHeld.value,
            },
          ],
          createOrder: async () => {
            createCalls += 1;
            return { id: "must-not-create" };
          },
        },
        params,
      );

      expect(outcome).toBe("placed");
      expect(createCalls).toBe(0);
      // placedAt is stamped alongside, so the daily cap can count this as a
      // placement made today rather than by the row's creation date.
      expect(updates).toContainEqual({
        status: "SUBMITTED",
        brokerOrderId: "broker-existing",
        placedAt: expect.any(Date),
      });
    });
  }

  it("does not claim a recovered Alpaca mirror when acceptance CAS matches zero rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const existing = {
      id: "local-existing-cas",
      status: "PENDING",
      brokerOrderId: null,
      clientOrderId: params.clientOrderId,
    };
    const db = {
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);

    const outcome = await (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder(
      {
        getOrders: async () => [{ id: "broker-existing-cas", client_order_id: params.clientOrderId }],
        createOrder: async () => ({ id: "must-not-create" }),
      },
      params,
    );

    expect(outcome).toBe("syncing");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "SUBMITTED" });
  });

  it("reuses the original pending quantity when a retry must submit again", async () => {
    let submitted: Record<string, unknown> | undefined;
    const existing = {
      id: "local-existing",
      status: "PENDING",
      brokerOrderId: null,
      clientOrderId: params.clientOrderId,
      quantity: 3,
      limitPrice: null,
    };
    const db = {
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "updated-retry" }] }) }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    await place(
      {
        getOrders: async () => [],
        createOrder: async (request: Record<string, unknown>) => {
          submitted = request;
          return { id: "broker-retried" };
        },
      },
      { ...params, qty: 9 },
    );

    expect(submitted?.qty).toBe(3);
  });
});

/**
 * alpaca-01: an ambiguous create used to be handed to the caller as the
 * ordinary outcome "syncing". poll() marks whatever `processCandidate`
 * returns as `markDeliveryCompleted`, which is terminal, so an outcome we are
 * not even sure happened at the broker retired the delivery forever -- for a
 * CLOSE, the follower's one-shot exit, with nothing left to regenerate it.
 *
 * The fix is the same shape as every other "we cannot tell yet" branch in
 * this file: throw (EAGAIN classifies transient) so markDeliveryFailed
 * requeues instead of completing. The local order row still lands on
 * SYNCING so the reconciler and any operator can see the ambiguity, but the
 * DELIVERY must stay alive so a resumed attempt can resolve it.
 */
describe("placeMirrorOrder ambiguous create", () => {
  const params = {
    followerUserId: "follower-ambiguous",
    symbol: "AAPL",
    tradingSymbol: "AAPL",
    side: "sell" as const,
    qty: 100,
    clientOrderId: "copymirror:follower-ambiguous:user:source-close",
    brokerAccountId: "paper-account",
    isPaper: true,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
  };

  type PlaceMirrorOrder = (
    client: unknown,
    value: typeof params,
  ) => Promise<string>;

  function ambiguousCreateError() {
    return Object.assign(
      new Error("Alpaca create order outcome is ambiguous and is syncing"),
      { code: "ALPACA_AMBIGUOUS_ORDER" },
    );
  }

  it("defers the delivery (throws EAGAIN) instead of completing it, while still recording SYNCING locally", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "local-ambiguous" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    await expect(
      place({ createOrder: async () => { throw ambiguousCreateError(); } }, params),
    ).rejects.toMatchObject({ code: "EAGAIN" });

    expect(updates).toContainEqual(
      expect.objectContaining({
        status: "SYNCING",
        syncReason: "Alpaca copy-mirror submission outcome is ambiguous",
      }),
    );
  });

  it("resumes a SYNCING row with no brokerOrderId on retry instead of retiring it as a duplicate", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let createCalls = 0;
    const brokerClientOrderId = createBrokerClientOrderId(
      params.followerUserId,
      params.clientOrderId,
      "copy",
    );
    const existing = {
      id: "local-existing-syncing",
      status: "SYNCING",
      brokerOrderId: null,
      clientOrderId: params.clientOrderId,
      quantity: params.qty,
      limitPrice: null,
    };
    const db = {
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "order-1" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    const outcome = await place(
      {
        getOrderByClientId: async () => ({
          id: "broker-recovered",
          client_order_id: brokerClientOrderId,
        }),
        getOrders: async () => [
          { id: "broker-recovered", client_order_id: brokerClientOrderId },
        ],
        createOrder: async () => {
          createCalls += 1;
          return { id: "must-not-create" };
        },
      },
      params,
    );

    expect(outcome).toBe("placed");
    expect(createCalls).toBe(0);
    expect(updates).toContainEqual({
      status: "SUBMITTED",
      brokerOrderId: "broker-recovered",
      placedAt: expect.any(Date),
    });
  });

  it("does not repost when exact broker reconciliation is unavailable", async () => {
    let listCalls = 0;
    let createCalls = 0;
    const existing = {
      id: "local-existing-syncing-unresolved",
      status: "SYNCING",
      brokerOrderId: null,
      clientOrderId: params.clientOrderId,
      quantity: params.qty,
      limitPrice: null,
    };
    const db = {
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    await expect(
      place(
        {
          getOrderByClientId: async () => {
            throw Object.assign(new Error("Alpaca unavailable"), { status: 503 });
          },
          getOrders: async () => {
            listCalls += 1;
            return [];
          },
          createOrder: async () => {
            createCalls += 1;
            return { id: "must-not-create" };
          },
        },
        params,
      ),
    ).rejects.toMatchObject({ status: 503 });

    expect(listCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  it("still treats a SYNCING row that already has a brokerOrderId as a duplicate (never resubmit a confirmed broker order)", async () => {
    let createCalls = 0;
    let getOrdersCalls = 0;
    const existing = {
      id: "local-existing-syncing-confirmed",
      status: "SYNCING",
      brokerOrderId: "broker-already-placed",
      clientOrderId: params.clientOrderId,
      quantity: params.qty,
      limitPrice: null,
    };
    const db = {
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placeMirrorOrder: PlaceMirrorOrder }
    ).placeMirrorOrder.bind(poller);

    const outcome = await place(
      {
        getOrders: async () => {
          getOrdersCalls += 1;
          return [];
        },
        createOrder: async () => {
          createCalls += 1;
          return { id: "must-not-create" };
        },
      },
      params,
    );

    expect(outcome).toBe("duplicate");
    expect(createCalls).toBe(0);
    expect(getOrdersCalls).toBe(0);
  });
});

describe("placePerpMirrorOrder", () => {
  const params = {
    followerUserId: "follower-perp",
    brokerAccountId: "0x1111111111111111111111111111111111111111",
    brokerCredentialId: "11111111-1111-4111-8111-111111111111",
    coin: "xyz:GOOGL",
    side: "long" as const,
    sizeCoin: "0.125",
    leverage: 5,
    marginMode: "isolated" as const,
    sizeDecimals: 3,
    markPrice: "100",
    maxOrderDollars: 1_000,
    dailyCap: 20,
    intent: "open" as const,
    clientOrderId: "copymirror:follower-perp:x_signal:perp-1",
    copySourceLabel: "Perp Author",
  };

  type PlacePerpMirror = (
    client: unknown,
    value: Omit<typeof params, "side" | "intent"> & {
      side: "long" | "short";
      intent: "open" | "close" | "resume";
    },
    // `filledSizeCoin` rides out on a reduce-only close: the cumulative size the
    // venue positively reported filling, which the caller's protection retire
    // reads instead of the size that was requested.
  ) => Promise<{ outcome: string; reason?: string; filledSizeCoin?: string }>;

  const pendingPerpRow = (
    id: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    userId: params.followerUserId,
    clientOrderId: params.clientOrderId,
    status: "PENDING",
    brokerOrderId: null,
    symbol: params.coin,
    assetType: "PERP",
    orderType: "Limit",
    direction: "long",
    tradeAction: "Buy",
    quantity: 0,
    quantityDecimal: params.sizeCoin,
    limitPrice: "105",
    priceTrigger: null,
    leverage: params.leverage,
    marginMode: params.marginMode,
    reduceOnly: false,
    brokerAccountId: params.brokerAccountId,
    brokerCredentialId: params.brokerCredentialId,
    venue: "hyperliquid",
    venueNetwork: process.env.HYPERLIQUID_NETWORK ?? "mainnet",
    notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
    copySourceLabel: params.copySourceLabel,
    ...overrides,
  });

  it("persists decimal PERP identity and submits the same deterministic cloid", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    let request: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-local-1" }] }),
          };
        },
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "updated-perp" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        placeOrder: async (value: Record<string, unknown>) => {
          request = value;
          return { status: "ok" };
        },
      },
      params,
    );

    expect(result).toEqual({ outcome: "placed" });
    expect(inserted[0]).toMatchObject({
      userId: "follower-perp",
      symbol: "xyz:GOOGL",
      assetType: "PERP",
      venue: "hyperliquid",
      direction: "long",
      tradeAction: "Buy",
      quantity: 0,
      quantityDecimal: "0.125",
      leverage: 5,
      marginMode: "isolated",
      clientOrderId: params.clientOrderId,
      brokerCredentialId: params.brokerCredentialId,
      copySourceLabel: "Perp Author",
    });
    expect(request).toMatchObject({
      coin: "xyz:GOOGL",
      side: "long",
      size: "0.125",
      orderType: "Limit",
      limitPrice: "105",
      timeInForce: "Ioc",
      reduceOnly: false,
      clientOrderId: params.clientOrderId,
    });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SUBMITTED" }));
    expect(inserted).toHaveLength(1);
  });

  it("persists and submits a short open using the exact sell limit payload", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    let request: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            onConflictDoNothing: () => ({ returning: async () => [{ id: "short-local-1" }] }),
          };
        },
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "updated-short" }] }) }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        placeOrder: async (value: Record<string, unknown>) => {
          request = value;
          return { status: "ok" };
        },
      },
      { ...params, side: "short", clientOrderId: "copymirror:follower-perp:x_signal:short-1" },
    );

    expect(result).toEqual({ outcome: "placed" });
    expect(inserted[0]).toMatchObject({
      direction: "short",
      tradeAction: "Sell",
      quantityDecimal: "0.125",
      leverage: 5,
    });
    expect(request).toMatchObject({
      side: "short",
      size: "0.125",
      orderType: "Limit",
      limitPrice: "95",
      timeInForce: "Ioc",
      reduceOnly: false,
    });
  });

  it("fails closed instead of adopting a PENDING cloid collision with mismatched identity", async () => {
    let placeCalls = 0;
    const db = {
      query: {
        orders: {
          findFirst: async () => ({
            id: "foreign-payload",
            userId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            status: "PENDING",
            symbol: "ETH",
            assetType: "PERP",
            orderType: "Limit",
            direction: "long",
            tradeAction: "Buy",
            quantity: 0,
            quantityDecimal: params.sizeCoin,
            limitPrice: "105",
            reduceOnly: false,
            marginMode: params.marginMode,
            brokerAccountId: params.brokerAccountId,
            brokerCredentialId: params.brokerCredentialId,
            venue: "hyperliquid",
            venueNetwork: process.env.HYPERLIQUID_NETWORK ?? "mainnet",
            notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
            copySourceLabel: params.copySourceLabel,
          }),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const prepare = (
      poller as unknown as { preparePerpMirrorOrder: (value: typeof params) => Promise<unknown> }
    ).preparePerpMirrorOrder.bind(poller);

    const result = await prepare(params);
    expect(result).toEqual({
      result: { outcome: "duplicate", reason: "identity-conflict" },
    });
    expect(placeCalls).toBe(0);
  });

  it("reclaims a stranded open after the mark moves and refreshes its IOC payload", async () => {
    const state = pendingPerpRow("stranded-open", {
      syncReason: null,
      lastSyncAttemptAt: null,
      limitPrice: "105",
    });
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        orders: { findFirst: async () => ({ ...state }) },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          Object.assign(state, values);
          return { where: () => ({ returning: async () => [{ id: state.id }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const prepare = (
      poller as unknown as {
        preparePerpMirrorOrder: (
          value: Omit<typeof params, "intent"> & { intent: "open" | "close" | "resume" },
        ) => Promise<Record<string, unknown>>;
      }
    ).preparePerpMirrorOrder.bind(poller);

    const result = await prepare({ ...params, intent: "resume", markPrice: "101" });

    expect(result).toHaveProperty("prepared");
    expect(updates).toContainEqual(expect.objectContaining({
      quantityDecimal: "0.125",
      limitPrice: "106.05",
      orderType: "Limit",
    }));
  });

  it("fails closed in the legacy placement path when a PENDING cloid has mismatched identity", async () => {
    let placeCalls = 0;
    let venueReads = 0;
    const db = {
      query: {
        orders: {
          findFirst: async () => ({
            id: "legacy-foreign-payload",
            userId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            status: "PENDING",
            brokerOrderId: null,
            symbol: params.coin,
            assetType: "PERP",
            orderType: "Limit",
            direction: "long",
            tradeAction: "Buy",
            quantity: 0,
            // The durable row asks for a different size than the payload this
            // caller built. A cloid alone must never authorize adoption.
            quantityDecimal: "0.250",
            limitPrice: "105",
            priceTrigger: null,
            leverage: params.leverage,
            marginMode: params.marginMode,
            reduceOnly: false,
            brokerAccountId: params.brokerAccountId,
            brokerCredentialId: params.brokerCredentialId,
            venue: "hyperliquid",
            venueNetwork: process.env.HYPERLIQUID_NETWORK ?? "mainnet",
            notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
            copySourceLabel: params.copySourceLabel,
          }),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        userFills: async () => {
          venueReads += 1;
          return [];
        },
        openOrders: async () => {
          venueReads += 1;
          return [];
        },
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      params,
    );

    expect(result).toEqual({ outcome: "duplicate", reason: "identity-conflict" });
    expect(venueReads).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("fails closed on a fresh reduce-only cloid collision with a mismatched payload", async () => {
    let venueReads = 0;
    let placeCalls = 0;
    const db = {
      query: {
        orders: {
          findFirst: async () => pendingPerpRow("fresh-reduce-only-collision", {
            reduceOnly: true,
            orderType: "Market",
            quantityDecimal: "0.250",
            limitPrice: null,
          }),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        orderStatusByClientOrderId: async () => {
          venueReads += 1;
          return { status: "unknownOid" };
        },
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      { ...params, reduceOnly: true, intent: "close" } as typeof params & {
        reduceOnly: boolean;
        intent: "close";
      },
    );

    expect(result).toEqual({ outcome: "duplicate", reason: "identity-conflict" });
    expect(venueReads).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("keeps a reduce-only reconciliation retry live after its mutable note changes", async () => {
    let insertCalls = 0;
    let placeCalls = 0;
    let venueReads = 0;
    let state: Record<string, unknown> | undefined;
    const db = {
      query: {
        orders: {
          findFirst: async () => (state ? { ...state } : undefined),
        },
      },
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              insertCalls += 1;
              if (insertCalls !== 1) return [];
              state = {
                ...value,
                id: "reduce-only-reconcile-row",
                status: "PENDING",
                brokerOrderId: null,
                syncReason: null,
                lastSyncAttemptAt: null,
              };
              return [{ ...state }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          // The reconciliation note path awaits `where(...)` directly,
          // whereas status paths call `returning()`. Apply the fake mutation at
          // `set` time so both SQL shapes carry the changed audit note forward.
          state = state ? { ...state, ...values } : state;
          return { where: () => ({
            returning: async () => {
              return [{ id: "reduce-only-reconcile-row" }];
            },
          }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);
    const client = {
      orderStatusByClientOrderId: async () => {
        venueReads += 1;
        return { status: "unknownOid" };
      },
      placeOrder: async () => {
        placeCalls += 1;
        throw new HyperliquidOrderRejectedError("could not immediately match");
      },
    };
    const closeParams = { ...params, reduceOnly: true, intent: "close" } as Omit<typeof params, "intent"> & {
      reduceOnly: boolean;
      intent: "close";
    };

    await expect(place(client, closeParams)).rejects.toThrow("retrying");
    expect(state?.notes).toContain("kept for reconciliation");

    // The delivery retry resumes the same durable row. Its audit note is
    // intentionally different now, but notes/status annotations are not order
    // identity and must not turn a still-retryable close into a duplicate.
    const resumeParams = { ...closeParams, intent: "resume" } as Omit<typeof params, "intent"> & {
      reduceOnly: boolean;
      intent: "resume";
    };
    await expect(place(client, resumeParams)).rejects.toThrow("retrying");

    expect(venueReads).toBe(2);
    expect(placeCalls).toBe(2);
    expect(state?.status).toBe("PENDING");
    expect(state?.notes).toContain("kept for reconciliation");
  });

  it("lets exactly one concurrent prepare claim a stranded PENDING cloid", async () => {
    const initial = {
      id: "perp-concurrent-claim",
      userId: params.followerUserId,
      clientOrderId: params.clientOrderId,
      status: "PENDING",
      brokerOrderId: null,
      symbol: params.coin,
      assetType: "PERP",
      orderType: "Limit",
      direction: "long",
      tradeAction: "Buy",
      quantity: 0,
      quantityDecimal: params.sizeCoin,
      limitPrice: "105",
      priceTrigger: null,
      leverage: params.leverage,
      marginMode: params.marginMode,
      reduceOnly: false,
      brokerAccountId: params.brokerAccountId,
      brokerCredentialId: params.brokerCredentialId,
      venue: "hyperliquid",
      venueNetwork: process.env.HYPERLIQUID_NETWORK ?? "mainnet",
      syncReason: null,
      lastSyncAttemptAt: null,
      notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
      copySourceLabel: params.copySourceLabel,
    };
    let reads = 0;
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const claims: Array<Record<string, unknown>> = [];
    let state: Record<string, unknown> = { ...initial };
    const db = {
      query: {
        orders: {
          findFirst: async () => {
            reads += 1;
            if (reads === 2) releaseReads();
            await readBarrier;
            return { ...state };
          },
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set(values: Record<string, unknown>) {
          claims.push(values);
          return {
            where: () => ({
              returning: async () => {
                if (state.syncReason !== null || state.lastSyncAttemptAt !== null) return [];
                state = { ...state, ...values };
                return [{ id: initial.id }];
              },
            }),
          };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const prepare = (
      poller as unknown as { preparePerpMirrorOrder: (value: typeof params) => Promise<unknown> }
    ).preparePerpMirrorOrder.bind(poller);

    const results = await Promise.all([prepare(params), prepare(params)]);
    expect(results.filter((result) => "prepared" in (result as object))).toHaveLength(1);
    expect(results.filter((result) => "result" in (result as object))).toEqual([
      { result: { outcome: "syncing", reason: "claim-held" } },
    ]);
    expect(claims).toHaveLength(2);
    const claimedReasons = claims
      .map((claim) => claim.syncReason)
      .filter((reason): reason is string => typeof reason === "string");
    expect(new Set(claimedReasons).size).toBe(2);
    expect(claimedReasons.every((reason) => reason.startsWith("copy-mirror:perp-placement:"))).toBe(true);
  });

  it("fails closed when an expired-claim venue probe is incomplete", async () => {
    let placeCalls = 0;
    const poller = new CopyMirrorPoller({} as never);
    const submission = await (poller as any).submitPerpMirrorOrder(
      {
        userFills: async () => [],
        openOrdersWithStatus: async () => ({ orders: [], complete: false }),
        openOrders: async () => {
          throw new Error("legacy fallback must not run when status is available");
        },
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      {
        orderId: "perp-expired-probe",
        claimToken: "expired-probe-token",
        reconcileVenueBeforeSubmit: true,
        params,
        input: {} as never,
      },
    );

    // Lease expiry is not proof that the venue never saw the old request. An
    // incomplete read must therefore leave the row for reconciliation instead
    // of permitting a duplicate cloid submission.
    expect(submission).toMatchObject({ kind: "not-submitted", reason: "reconcile" });
    expect(placeCalls).toBe(0);
  });

  it("fails closed instead of adopting a cloid collision with a nonzero perp quantity placeholder", async () => {
    const db = {
      query: {
        orders: {
          findFirst: async () => ({
            id: "foreign-quantity-placeholder",
            userId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            status: "PENDING",
            symbol: params.coin,
            assetType: "PERP",
            orderType: "Limit",
            direction: "long",
            tradeAction: "Buy",
            quantity: 1,
            quantityDecimal: params.sizeCoin,
            limitPrice: "105",
            priceTrigger: null,
            reduceOnly: false,
            marginMode: params.marginMode,
            brokerAccountId: params.brokerAccountId,
            brokerCredentialId: params.brokerCredentialId,
            venue: "hyperliquid",
            venueNetwork: process.env.HYPERLIQUID_NETWORK ?? "mainnet",
            notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
            copySourceLabel: params.copySourceLabel,
          }),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const prepare = (
      poller as unknown as { preparePerpMirrorOrder: (value: typeof params) => Promise<unknown> }
    ).preparePerpMirrorOrder.bind(poller);

    await expect(prepare(params)).resolves.toEqual({
      result: { outcome: "duplicate", reason: "identity-conflict" },
    });
  });

  it("refuses an open whose exact venue payload is outside the hard cap", async () => {
    let insertCalls = 0;
    let placeCalls = 0;
    const db = {
      insert: () => {
        insertCalls += 1;
        return {
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [{ id: "should-not-insert" }] }),
          }),
        };
      },
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        placeOrder: async () => {
          placeCalls += 1;
          return { status: "ok" };
        },
      },
      { ...params, maxOrderDollars: 10 },
    );

    expect(result).toEqual({ outcome: "no-qty", reason: "dollar-cap" });
    expect(insertCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("refuses a short open when the submitted sell payload exceeds the hard cap", async () => {
    let insertCalls = 0;
    let placeCalls = 0;
    const db = {
      insert: () => {
        insertCalls += 1;
        return {
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [{ id: "must-not-insert" }] }),
          }),
        };
      },
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        placeOrder: async () => {
          placeCalls += 1;
          return { status: "ok" };
        },
      },
      { ...params, side: "short" as const, maxOrderDollars: 10 },
    );

    expect(result).toEqual({ outcome: "no-qty", reason: "dollar-cap" });
    expect(insertCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("does not claim a Hyperliquid mirror when acceptance CAS matches zero rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-local-cas" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const outcome = await place(
      { placeOrder: async () => ({ status: "ok" }) },
      params,
    );

    expect(outcome).toMatchObject({ outcome: "syncing" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SUBMITTED" }));
  });

  it("does not claim a Hyperliquid mirror when acceptance CAS returns multiple rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: { orders: { findFirst: async () => null } },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-local-multi" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "winner-a" }, { id: "winner-b" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const outcome = await place(
      { placeOrder: async () => ({ status: "ok" }) },
      params,
    );

    expect(outcome).toMatchObject({ outcome: "syncing" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SUBMITTED" }));
  });

  it("retries a stranded pending intent only after the cloid is absent at the venue", async () => {
    let placeCalls = 0;
    const db = {
      query: {
        orders: {
          findFirst: async () => pendingPerpRow("perp-existing"),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "updated-perp-retry" }] }) }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        userFills: async () => [],
        openOrders: async () => [],
        orderStatusByClientOrderId: async () => ({ status: "unknownOid" }),
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      params,
    );
    expect(result).toEqual({ outcome: "placed" });
    expect(placeCalls).toBe(1);
  });

  it("does not repost a pending intent whose deterministic cloid is already at the venue", async () => {
    let placeCalls = 0;
    const db = {
      query: {
        orders: {
          findFirst: async () => pendingPerpRow("perp-existing"),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "updated-perp-recovery" }] }) }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        userFills: async () => [{ cloid: toCloid(params.clientOrderId), oid: 42 }],
        openOrders: async () => [],
        orderStatusByClientOrderId: async () => ({
          status: "order",
          order: { order: { oid: 42 }, status: "filled" },
        }),
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      params,
    );
    expect(result).toEqual({ outcome: "syncing", reason: "recovered-at-venue" });
    expect(placeCalls).toBe(0);
  });

  it("does not double-submit when an expired-owner POST lands between authoritative probes", async () => {
    let placeCalls = 0;
    let oldOwnerSubmitted = false;
    let firstProbeDone!: () => void;
    let releaseSecondProbe!: () => void;
    const firstProbe = new Promise<void>((resolve) => { firstProbeDone = resolve; });
    const secondProbe = new Promise<void>((resolve) => { releaseSecondProbe = resolve; });
    const client = {
      orderStatusByClientOrderId: async () => {
        if (!oldOwnerSubmitted) {
          firstProbeDone();
          await secondProbe;
        }
        return oldOwnerSubmitted
          ? { status: "order", order: { order: { oid: 901 }, status: "filled" } }
          : { status: "unknownOid" };
      },
      placeOrder: async () => {
        placeCalls += 1;
        oldOwnerSubmitted = true;
        return {};
      },
    };
    const poller = new CopyMirrorPoller({} as never);
    const reclaimer = (poller as any).submitPerpMirrorOrder(
      client,
      {
        orderId: "perp-expired-interleave",
        claimToken: "expired-interleave-token",
        reconcileVenueBeforeSubmit: true,
        params,
        input: {} as never,
      },
    );

    await firstProbe;
    // This is the old owner that passed its final claim check before lease
    // expiry and posts while the new owner is between its two status probes.
    await client.placeOrder();
    releaseSecondProbe();
    const submission = await reclaimer;

    expect(submission).toEqual({ kind: "recovered", brokerOrderId: "901" });
    expect(placeCalls).toBe(1);
  });

  it("places both sides at the configured 10.55 ceiling using the exact IOC limit", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-cap-placement" }] }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "perp-cap-placement" }] }) }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);
    const client = {
      placeOrder: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {};
      },
    };

    await expect(place(client, {
      ...params,
      side: "long",
      sizeCoin: "0.100",
      maxOrderDollars: 10.55,
    })).resolves.toMatchObject({ outcome: "placed" });
    await expect(place(client, {
      ...params,
      side: "short",
      sizeCoin: "0.111",
      maxOrderDollars: 10.55,
    })).resolves.toMatchObject({ outcome: "placed" });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ size: "0.1", limitPrice: "105" });
    expect(requests[1]).toMatchObject({ size: "0.111", limitPrice: "95" });
    for (const request of requests) {
      const notional = Number(request.size) * Number(request.limitPrice);
      expect(notional).toBeGreaterThanOrEqual(10);
      expect(notional).toBeLessThanOrEqual(10.55);
    }
  });

  it("recovers protection after a filled Phase-B row with a NULL status", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const wallet = params.brokerAccountId as `0x${string}`;
    const order = {
      id: "perp-filled-before-protection",
      userId: params.followerUserId,
      clientOrderId: params.clientOrderId,
      status: "FILLED",
      assetType: "PERP",
      reduceOnly: false,
      symbol: params.coin,
      brokerAccountId: wallet,
      brokerCredentialId: params.brokerCredentialId,
      executedSizeDecimal: "0.25",
      perpProtectionStatus: null,
      syncReason: null,
      lastSyncAttemptAt: null,
      perpProtection: {
        copyMirrorProtectionIntent: true,
        takeProfitRoePct: 50,
        stopLossRoePct: 25,
        entryPx: "",
        leverage: 0,
        sizeCoin: "",
        legClientOrderIds: [],
      },
    };
    const db = {
      query: {
        userApiCredentials: {
          findFirst: async () => ({
            id: params.brokerCredentialId,
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
        orders: { findFirst: async () => order },
      },
      update: () => ({
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where: () => ({ returning: async () => [{ id: order.id }] }),
          };
        },
      }),
    } as never;
    const submitted: Array<Record<string, unknown>> = [];
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: async () => ({
        walletAddress: wallet,
        client: {
          listPositions: async () => [{
            coin: params.coin,
            side: "long",
            size: "0.5",
            entryPx: "100",
            leverage: 2,
            marginMode: "cross",
          }],
          openOrders: async () => [],
          setPositionTpSl: async (request: Record<string, unknown>) => {
            submitted.push(request);
            return {
              response: {
                data: {
                  statuses: [
                    { resting: { oid: 991 } },
                    { resting: { oid: 992 } },
                  ],
                },
              },
            };
          },
          cancelOrder: async () => ({}),
        },
      } as never),
    });

    const recovery = await (poller as any).recoverPerpProtectionIntent(order, {
      sourceItemId: "user:filled-before-protection",
      followId: "follow-1",
    });

    expect(recovery).toBe("recovered");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ size: "0.25" });
    expect(updates[0]).toMatchObject({
      syncReason: expect.any(String),
      lastSyncAttemptAt: expect.any(Date),
    });
    expect(updates.at(-1)).toMatchObject({
      perpProtectionStatus: "attached",
      syncReason: null,
      lastSyncAttemptAt: null,
    });
  });

  it("does not claim a recovered Hyperliquid mirror when acceptance CAS matches zero rows", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        orders: {
          findFirst: async () => pendingPerpRow("perp-existing-cas"),
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const outcome = await place(
      {
        userFills: async () => [{ cloid: toCloid(params.clientOrderId), oid: 43 }],
        openOrders: async () => [],
        orderStatusByClientOrderId: async () => ({
          status: "order",
          order: { order: { oid: 43 }, status: "filled" },
        }),
        placeOrder: async () => {
          throw new Error("must not repost");
        },
      },
      params,
    );

    expect(outcome).toMatchObject({ outcome: "syncing" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SUBMITTED" }));
  });

  it("leaves an ambiguous transport outcome pending for the Hyperliquid reconciler", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-ambiguous" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "updated-rejected" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    await expect(
      place(
        {
          placeOrder: async () => {
            throw new Error("transport timeout after submit");
          },
        },
        params,
      ),
    ).rejects.toThrow("transport timeout after submit");
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
  });

  /**
   * The reconciler ages a row from `order.placedAt ?? order.createdAt`
   * specifically so a resumed row (hours old at `created_at`) still gets the
   * just-placed grace period once it is actually attempted again. An ambiguous
   * transport failure (HttpRequestError: timeout, abort, non-2xx) means the
   * order MAY have reached the venue, which is exactly the case that grace
   * period exists for. Leaving `placed_at` untouched on this path means the
   * guard reads the stale `created_at` instead and a CANCELLED write can land
   * before the venue evidence ever has a chance to show up.
   */
  it("stamps placed_at on an ambiguous transport failure, not just on confirmed success", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-ambiguous-2" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    await expect(
      place(
        {
          placeOrder: async () => {
            throw new Error("transport timeout after submit");
          },
        },
        params,
      ),
    ).rejects.toThrow("transport timeout after submit");
    expect(updates.some((update) => update.placedAt instanceof Date)).toBe(true);
  });

  /**
   * The rejection class is not a verdict.
   *
   * `placeOrder` funnels EVERY ApiRequestError into HyperliquidOrderRejectedError,
   * including the one family that says the cloid is already in use. That message
   * asserts an order with this identity EXISTS, so writing REJECTED on it drops a
   * possibly-filled leveraged position out of the sync poller, which only scans
   * PENDING / SUBMITTED / PARTIAL. Broker state is the source of truth.
   */
  function rejectingPoller(error: Error) {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-rejected" }] }),
        }),
      }),
      update: () => ({
        set(value: Record<string, unknown>) {
          updates.push(value);
          return { where: () => ({ returning: async () => [{ id: "updated-terminal" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);
    return {
      updates,
      run: () =>
        place(
          {
            placeOrder: async () => {
              throw error;
            },
          },
          params,
        ),
    };
  }

  it("keeps a duplicate-cloid rejection reconcilable instead of marking a live order REJECTED", async () => {
    const { updates, run } = rejectingPoller(
      new HyperliquidOrderRejectedError("Order has duplicate cloid"),
    );

    const result = await run();

    expect(result).toEqual({ outcome: "syncing", reason: "reconcile" });
    // The status is deliberately untouched: PENDING is what the Hyperliquid sync
    // poller scans, and it is the only component that can read whether the
    // original order actually filled.
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(updates.some((update) => update.status !== undefined)).toBe(false);
    expect(updates.some((update) => String(update.notes).includes("reconciliation"))).toBe(true);
  });

  it("keeps an unrecognized rejection reconcilable rather than guessing it is terminal", async () => {
    const { updates, run } = rejectingPoller(
      new HyperliquidOrderRejectedError("some new hyperliquid error nobody has seen"),
    );

    const result = await run();

    expect(result).toEqual({ outcome: "syncing", reason: "reconcile" });
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
  });

  it("still writes REJECTED for a venue answer that definitively refused the order", async () => {
    const { updates, run } = rejectingPoller(
      new HyperliquidOrderRejectedError("Order must have minimum value of $10"),
    );

    const result = await run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(updates.some((update) => update.status === "REJECTED")).toBe(true);
  });

  it("returns syncing even when the reconciliation note fails to write", async () => {
    // A thrown note write would requeue the delivery, and the retry would walk
    // the resume path and attempt a SECOND placement. The note is cosmetic; the
    // PENDING status it annotates is what matters.
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-note-fail" }] }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            throw new Error("database unavailable");
          },
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place(
      {
        placeOrder: async () => {
          throw new HyperliquidOrderRejectedError("cloid already in use");
        },
      },
      params,
    );

    expect(result).toEqual({ outcome: "syncing", reason: "reconcile" });
  });

  /**
   * Case (b), and the one that must NOT be mistaken for case (a).
   *
   * Hyperliquid accepted the submission and the local status write then threw.
   * The order is live, but nothing was read back from the venue: no broker order
   * id, no confirmation that anything filled. The reason has to say so, because
   * the caller's protection gate attaches a real trigger on the recovered case
   * and must not do it here.
   */
  it("names a status write that failed after the venue accepted, not a recovery", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-status-fail" }] }),
        }),
      }),
      // The acceptance write is a CAS, so the failure has to come out of
      // `returning()` the way a real one would.
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              throw new Error("database unavailable");
            },
          }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const result = await place({ placeOrder: async () => ({ status: "ok" }) }, params);

    expect(result).toEqual({ outcome: "syncing", reason: "status-write-failed" });
  });

  it("requeues a reduce-only close left for reconciliation instead of completing it", async () => {
    // "syncing" completes the delivery, which is right for an open: the row
    // stays PENDING and the reconciler owns it. For a close it loses the exit,
    // because the reconciler settles the ORDER and never re-places anything, so
    // once it cancels the row nothing is left to try again.
    const poller = new CopyMirrorPoller({
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: "perp-close-reconcile" }] }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
    } as never);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    await expect(
      place(
        {
          placeOrder: async () => {
            // Outside the definitive allowlist, so it classifies as reconcile.
            throw new HyperliquidOrderRejectedError("could not immediately match");
          },
        },
        // `params` is a literal without reduceOnly; the real placement params
        // carry it, so widen rather than fight the inferred shape.
        { ...params, reduceOnly: true } as typeof params & { reduceOnly: boolean },
      ),
    ).rejects.toThrow("retrying");
  });

  it("sweeps the unfilled remainder of a partially filled IoC close instead of stranding it", async () => {
    // A Market mirror is always submitted IoC: Hyperliquid fills what it can
    // immediately and cancels the rest. This is what that looks like on the
    // wire for a reduce-only close that only partially filled.
    const partialFillResponse = {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "0.3", avgPx: "100", oid: 9001 } }] },
      },
    };
    const fullFillResponse = {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "0.7", avgPx: "99.5", oid: 9002 } }] },
      },
    };
    const inserted: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const placeCalls: Array<Record<string, unknown>> = [];
    let nextId = 1;
    const db = {
      insert: () => ({
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: `perp-sweep-${nextId++}` }],
            }),
          };
        },
      }),
      update: () => ({
        set(values: Record<string, unknown>) {
          updates.push(values);
          return { where: () => ({ returning: async () => [{ id: "order-1" }] }) };
        },
      }),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const place = (
      poller as unknown as { placePerpMirrorOrder: PlacePerpMirror }
    ).placePerpMirrorOrder.bind(poller);

    const closeParams = { ...params, sizeCoin: "1.0", reduceOnly: true } as typeof params & {
      reduceOnly: boolean;
    };
    const result = await place(
      {
        placeOrder: async (request: Record<string, unknown>) => {
          placeCalls.push(request);
          return placeCalls.length === 1 ? partialFillResponse : fullFillResponse;
        },
      },
      closeParams,
    );

    // The cumulative fill travels out with the result (0.3 + 0.7), because the
    // caller's protection retire has to key on what a close actually FILLED
    // rather than what it requested. See copy-mirror-perp-close-fill-shortfall.
    expect(result).toEqual({ outcome: "placed", filledSizeCoin: "1" });
    // The primary attempt requests the full close size, and the sweep
    // requests exactly the unfilled remainder (1.0 - 0.3 = 0.7), never the
    // full size again, which would try to close more than is actually left.
    expect(placeCalls).toHaveLength(2);
    expect(placeCalls[0]).toMatchObject({ size: "1.0", reduceOnly: true });
    expect(placeCalls[1]).toMatchObject({ size: "0.7", reduceOnly: true });
    // The sweep is a SEPARATE order, with its own client_order_id distinct
    // from the primary's (Hyperliquid identifies orders by client order id,
    // and this is a second, differently-sized order).
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ clientOrderId: closeParams.clientOrderId });
    expect(inserted[1]).toMatchObject({
      clientOrderId: `${closeParams.clientOrderId}:sweep`,
      quantityDecimal: "0.7",
    });
    // Both the primary row and the sweep row end up SUBMITTED: the venue
    // accepted both broker calls, so neither may be marked failed locally.
    expect(updates.filter((update) => update.status === "SUBMITTED")).toHaveLength(2);
  });
});

describe("processCandidate destination compatibility", () => {
  it("skips stock and option sources selected for a Hyperliquid destination", async () => {
    const credentialReads: string[] = [];
    const poller = new CopyMirrorPoller({
      query: {
        orders: { findFirst: async () => undefined, findMany: async () => [] },
        userApiCredentials: {
          findFirst: async () => {
            credentialReads.push("hyperliquid");
            return {
              id: "11111111-1111-4111-8111-111111111111",
              provider: "hyperliquid",
            };
          },
        },
      },
    } as never);
    const guards = {
      dailyCap: 20,
      maxOrderDollars: 1_000,
      perpsEnabled: true,
      mainnetAllowed: false,
      liveAllowed: false,
    };

    for (const assetType of ["EQUITY", "OPTION"] as const) {
      const outcome = await (poller as any).processCandidate({
        followerUserId: "follower-1",
        credentialId: "11111111-1111-4111-8111-111111111111",
        sourceItemId: `user:${assetType.toLowerCase()}-1`,
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 100,
        assetType,
      }, guards);

      expect(outcome).toBe("incompatible-destination");
    }
    expect(credentialReads).toEqual(["hyperliquid", "hyperliquid"]);
  });
});

describe("processPerpCandidate reduce-only execution", () => {
  it("recovers the exact stored pending perp intent without recalculating its size", async () => {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      let submitted: Record<string, unknown> | undefined;
      const leverageCalls: Array<Record<string, unknown>> = [];
      const existing = {
        id: "pending-perp",
        userId: "follower-perp",
        symbol: "BTC",
        assetType: "PERP",
        orderType: "Limit",
        tradeAction: "Buy",
        quantity: 0,
        status: "PENDING",
        direction: "long",
        quantityDecimal: "0.125",
        limitPrice: "105",
        priceTrigger: null,
        leverage: 3,
        marginMode: "cross",
        reduceOnly: false,
        clientOrderId: "copymirror:follower-perp:user:source-open",
        venue: "hyperliquid",
        venueNetwork: "testnet",
        brokerCredentialId: "11111111-1111-4111-8111-111111111111",
        brokerOrderId: null,
        brokerAccountId: "0x1111111111111111111111111111111111111111",
        copySourceLabel: "Source",
        notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
      };
      const db = {
        query: {
          userApiCredentials: {
            findFirst: async () => ({
              id: "11111111-1111-4111-8111-111111111111",
              provider: "hyperliquid",
              accountType: "LIVE",
            }),
          },
          copyTradeFollows: { findFirst: async () => LIVE_FOLLOW },
          orders: { findFirst: async () => existing, findMany: async () => [] },
        },
        // Resumed OPENs are re-checked against today's cap.
        select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [] }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => ({
          walletAddress: existing.brokerAccountId,
          client: {
            userFills: async () => [],
            openOrders: async () => [],
            orderStatusByClientOrderId: async () => ({ status: "unknownOid" }),
            resolveAsset: async () => ({ szDecimals: 5, maxLeverage: 50 }),
            allMids: async () => ({ BTC: "100" }),
            perpAccountSnapshot: async () => ({ coveredDexes: [""],
              positions: [],
              crossMargin: { accountValueUsd: "10000", totalMarginUsedUsd: "0" },
            }),
            // Sizing reads collateral through perpCollateral now. Derived from this
            // case's own crossMargin fixture so its intent is unchanged.
            perpCollateral: async () => ({
              freeUsd: "10000",
              accountValueUsd: "10000",
              source: "perp-cross-margin",
            }),
            listPositions: async () => [],
            updateLeverage: async (request: Record<string, unknown>) => {
              leverageCalls.push(request);
              return { status: "ok" };
            },
            placeOrder: async (request: Record<string, unknown>) => {
              submitted = request;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate({
        followerUserId: "follower-perp",
        credentialId: "11111111-1111-4111-8111-111111111111",
        followId: LIVE_FOLLOW.id,
        sourceEventAt: new Date().toISOString(),
        sourceItemId: "user:source-open",
        symbol: "BTC",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 999,
        assetType: "PERP",
        perpSide: "long",
        perpLeverage: 20,
        perpUserMaxLeverage: 50,
        perpFollowMaxLeverage: null,
      }, existing, {
        dailyCap: 20,
        maxOrderDollars: 1_000,
        perpsEnabled: true,
        mainnetAllowed: false,
      });

      expect(outcome).toBe("placed");
      // The stored size is re-sent verbatim, and it is re-priced off the mark the
      // resume just re-checked its caps against rather than one the client would
      // fetch for itself at submit time.
      expect(submitted).toMatchObject({
        size: "0.125",
        side: "long",
        reduceOnly: false,
        markPrice: "100",
      });
      // Leverage is not an order field, so the resume has to re-apply the
      // STORED clamped value. Without this the retry fills at whatever leverage
      // the coin happens to carry while the row still claims 3x.
      expect(leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  });

  it("refuses a non-canonical coin at the last gate before Hyperliquid", async () => {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      let credentialLookups = 0;
      let clientCreations = 0;
      const poller = new CopyMirrorPoller({
        query: {
          userApiCredentials: {
            findFirst: async () => {
              credentialLookups += 1;
              return {
                id: "33333333-3333-4333-8333-333333333333",
                provider: "hyperliquid",
                accountType: "LIVE",
              };
            },
          },
        },
      } as never, {
        createPerpClient: (async () => {
          clientCreations += 1;
          throw new Error("must not create a perp client");
        }) as never,
      });

      const outcome = await (poller as any).processPerpCandidate({
        followerUserId: "follower-perp",
        credentialId: "33333333-3333-4333-8333-333333333333",
        sourceItemId: "user:open-bad-coin",
        // A coin that resolveAsset / updateLeverage / placeOrder would be handed
        // verbatim. It never gets that far.
        symbol: "BTC/USD",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 100,
        assetType: "PERP",
        perpSide: "long",
      }, undefined, {
        dailyCap: 20,
        maxOrderDollars: 1_000,
        perpsEnabled: true,
        mainnetAllowed: false,
      });

      expect(outcome).toBe("unsupported-perp-coin");
      expect(credentialLookups).toBe(0);
      expect(clientCreations).toBe(0);
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  });

  it("rejects a legacy stock-selected follow instead of treating autoMirror as perp consent", async () => {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      let clientCreations = 0;
      const poller = new CopyMirrorPoller({
        query: {
          userApiCredentials: {
            findFirst: async () => ({
              id: "22222222-2222-4222-8222-222222222222",
              provider: "alpaca",
              accountType: "PAPER",
            }),
          },
        },
      } as never, {
        createPerpClient: (async () => {
          clientCreations += 1;
          throw new Error("must not create a perp client");
        }) as never,
      });

      const outcome = await (poller as any).processPerpCandidate({
        followerUserId: "follower-perp",
        credentialId: "22222222-2222-4222-8222-222222222222",
        followId: LIVE_FOLLOW.id,
        // Fresh, so the refusal below is about the credential and nothing else.
        sourceEventAt: new Date().toISOString(),
        sourceItemId: "user:open-1",
        symbol: "BTC",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 100,
        assetType: "PERP",
        perpSide: "long",
      }, undefined, {
        dailyCap: 20,
        maxOrderDollars: 1_000,
        perpsEnabled: true,
        mainnetAllowed: false,
      });

      expect(outcome).toBe("missing-hyperliquid-account");
      expect(clientCreations).toBe(0);
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  });

  it("derives close context from published fill children without counting cumulative parents", async () => {
    const closeAt = new Date("2026-07-31T12:00:00.000Z");
    let orderReads = 0;
    const db = {
      query: {
        orders: {
          findMany: async () => {
            orderReads += 1;
            if (orderReads === 1) {
              return [
                {
                  id: "source-open-parent",
                  brokerOrderId: "source-open-venue-id",
                  direction: "long",
                  executedSizeDecimal: "1",
                  createdAt: new Date("2026-07-31T11:00:00.000Z"),
                },
                {
                  id: "source-open-fill-1",
                  brokerOrderId: "source-open-fill-event-1",
                  direction: "long",
                  executedSizeDecimal: "0.4",
                  createdAt: new Date("2026-07-31T11:00:01.000Z"),
                },
                {
                  id: "source-open-fill-2",
                  brokerOrderId: "source-open-fill-event-2",
                  direction: "long",
                  executedSizeDecimal: "0.6",
                  createdAt: new Date("2026-07-31T11:00:02.000Z"),
                },
                {
                  id: "source-close-parent",
                  brokerOrderId: "source-close-venue-id",
                  direction: "short",
                  executedSizeDecimal: "0.25",
                  createdAt: closeAt,
                },
                {
                  id: "source-close-fill",
                  brokerOrderId: "source-close-fill-event",
                  direction: "short",
                  executedSizeDecimal: "0.25",
                  createdAt: closeAt,
                },
              ];
            }
            return [
              {
                clientOrderId: "copymirror:follower-perp:user:source-social-open",
                direction: "long",
                executedSizeDecimal: "0.4",
                createdAt: new Date("2026-07-31T11:01:00.000Z"),
              },
              {
                clientOrderId: "manual-order",
                direction: "long",
                executedSizeDecimal: "5",
                createdAt: new Date("2026-07-31T11:02:00.000Z"),
              },
            ];
          },
        },
        socialTrades: {
          findMany: async () => [
            {
              id: "source-social-open",
              orderId: "source-open-fill-1",
              brokerOrderId: "source-open-fill-event-1",
            },
            {
              id: "source-social-open-2",
              orderId: "source-open-fill-2",
              brokerOrderId: "source-open-fill-event-2",
            },
            {
              id: "source-social-close",
              orderId: "source-close-fill",
              brokerOrderId: "source-close-fill-event",
            },
          ],
        },
      },
    } as never;
    const poller = new CopyMirrorPoller(db);

    const context = await (poller as any).loadPerpCloseContext({
      followerUserId: "follower-perp",
      sourceItemId: "user:source-social-close",
      sourceUserId: "source-user",
      sourceOrderId: "source-close-fill",
      sourceOrderCreatedAt: closeAt.toISOString(),
      symbol: "BTC",
      perpSide: "short",
    }, { side: "long", size: "0.4" });

    expect(context).toEqual({
      sourcePositionSizeDecimal: "1",
      mirroredExposureSizeDecimal: "0.4",
      // The same rows the exposure was summed from, reported individually. The
      // manual order is absent because it carries no source event, which is what
      // scopes a protection cancel to the source that actually closed.
      attributedClientOrderIds: ["copymirror:follower-perp:user:source-social-open"],
    });
  });

  // Hyperliquid is the authority on what the follower holds. These two pin the
  // line between "the venue may supply the size" and "attribution is unclear, so
  // it may not".
  const venueFallbackDb = (followerRows: unknown[]) => ({
    query: {
      orders: {
        // The source read selects `id`, the follower read selects `clientOrderId`.
        findMany: async (args: any) =>
          args?.columns?.id
            ? [
                {
                  id: "source-open",
                  brokerOrderId: "source-open-fill-event",
                  direction: "long",
                  executedSizeDecimal: "2",
                  createdAt: new Date("2026-07-31T11:00:00.000Z"),
                },
              ]
            : followerRows,
      },
      socialTrades: {
        findMany: async () => [
          { id: "source-social-open", brokerOrderId: "source-open-fill-event" },
        ],
      },
    },
  }) as never;

  const venueFallbackCand = {
    followerUserId: "follower-perp",
    sourceItemId: "user:source-social-close",
    sourceUserId: "source-user",
    sourceOrderId: "source-close-fill",
    sourceOrderCreatedAt: new Date("2026-07-31T12:00:00.000Z").toISOString(),
    symbol: "BTC",
    perpSide: "short",
  };

  it("correlates the follower's open by its source event, not by when it filled", async () => {
    // A fast source close: the source opened at 11:00 and closed at 11:00:05,
    // but the follower's copy did not fill until 11:00:30. Comparing the
    // follower's own time against the source-close cutoff drops the very
    // position being closed, and with any manual history in the coin the venue
    // fallback does not apply, so the close resolves to no-qty and is consumed.
    // The client order id already says which source event it copies.
    const openedAt = new Date("2026-07-31T11:00:00.000Z");
    const closedAt = new Date("2026-07-31T11:00:05.000Z");
    const followerFilledAt = new Date("2026-07-31T11:00:30.000Z");
    const db = {
      query: {
        orders: {
          findMany: async (args: any) =>
            args?.columns?.id
              ? [
                  {
                    id: "source-open",
                    brokerOrderId: "source-open-fill-event",
                    direction: "long",
                    executedSizeDecimal: "2",
                    createdAt: openedAt,
                    executedAt: openedAt,
                  },
                ]
              : [
                  {
                    clientOrderId: "copymirror:follower-perp:user:source-social-open",
                    direction: "long",
                    executedSizeDecimal: "0.5",
                    createdAt: followerFilledAt,
                  },
                  // Manual history, so mirrorOwnsWholePosition is false and the
                  // reconstruction is the only thing that can size this close.
                  {
                    clientOrderId: "manual-order",
                    direction: "long",
                    executedSizeDecimal: "3",
                    createdAt: openedAt,
                  },
                ],
        },
        socialTrades: {
          findMany: async () => [
            { id: "source-social-open", brokerOrderId: "source-open-fill-event" },
          ],
        },
      },
    } as never;

    const context = await (new CopyMirrorPoller(db) as any).loadPerpCloseContext(
      {
        followerUserId: "follower-perp",
        sourceItemId: "user:source-social-close",
        sourceUserId: "source-user",
        sourceOrderId: "source-close-fill",
        sourceOrderCreatedAt: closedAt.toISOString(),
        symbol: "BTC",
        perpSide: "short",
      },
      { side: "long", size: "0.5" },
    );

    expect(context).toEqual({
      sourcePositionSizeDecimal: "2",
      mirroredExposureSizeDecimal: "0.5",
      attributedClientOrderIds: ["copymirror:follower-perp:user:source-social-open"],
    });
  });

  it("does not spend the history cap on orders that post-date the close", async () => {
    // Both reads are newest-first over a coin's all-time history, so a source who
    // kept trading after this close could fill the entire cap with rows the
    // reconstruction would discard, leaving nothing to size from and tripping
    // the saturation guard on irrelevant history. The cutoff belongs in SQL.
    const cutoff = new Date("2026-07-31T12:00:00.000Z");
    let sourceWhereBound: string[] = [];
    let followerWhereBound: string[] = [];
    // Seen-set rather than a depth bound: the network predicate sits inside an
    // `or` nested in the `and`, deeper than a shallow walk reaches, and the
    // drizzle graph is cyclic so depth alone does not terminate.
    const boundValues = (root: any): string[] => {
      const out: string[] = [];
      const seen = new WeakSet<object>();
      const walk = (node: any) => {
        if (!node || typeof node !== "object" || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) return node.forEach(walk);
        if (node.value instanceof Date) out.push(node.value.toISOString());
        else if (typeof node.value === "string") out.push(node.value);
        Object.values(node).forEach(walk);
      };
      walk(root);
      return out;
    };
    const db = {
      query: {
        orders: {
          findMany: async (args: any) => {
            if (args?.columns?.clientOrderId) {
              followerWhereBound = boundValues(args.where);
              return [];
            }
            if (args?.columns?.executedSizeDecimal) {
              sourceWhereBound = boundValues(args.where);
              return [
                {
                  id: "source-open",
                  brokerOrderId: "source-open-event",
                  direction: "long",
                  executedSizeDecimal: "2",
                  createdAt: new Date("2026-07-31T11:00:00.000Z"),
                  executedAt: new Date("2026-07-31T11:00:00.000Z"),
                },
              ];
            }
            // The third order read checks whether a legacy broker id is
            // ambiguous across account/credential/venue scopes. It is kept
            // separate so it cannot overwrite either history query capture.
            return [];
          },
        },
        socialTrades: {
          findMany: async () => [{ id: "source-social-open", brokerOrderId: "source-open-event" }],
        },
      },
    } as never;

    await (new CopyMirrorPoller(db) as any).loadPerpCloseContext(
      {
        followerUserId: "follower-perp",
        sourceItemId: "user:source-social-close",
        sourceUserId: "source-user",
        sourceOrderId: "source-close-fill",
        sourceOrderCreatedAt: cutoff.toISOString(),
        symbol: "BTC",
        perpSide: "short",
      },
      { side: "long", size: "0.5" },
    );

    // The cutoff is bound into the SOURCE query itself, not applied only in memory.
    expect(sourceWhereBound).toContain(cutoff.toISOString());
    // And BOTH histories are scoped to one network: orders from testnet and
    // mainnet belong to separate clearinghouses, so netting them together
    // produces exposure that exists on neither, and the live-position clamp
    // bounds the size without fixing the proportion.
    expect(sourceWhereBound).toContain("mainnet");
    expect(followerWhereBound).toContain("mainnet");
    // NOT asserted here: that a row with an UNPROVEN (null) network is excluded
    // from close attribution. `isNull` binds no value, so it is invisible to a
    // bound-value walker, and these db mocks ignore the WHERE clause entirely,
    // so a behavioural test cannot see it either. An assertion was written for
    // it and removed after it passed against both forms, which is worse than no
    // assertion. The reasoning is in the comment on `onActiveNetwork`.
    // And the cutoff is NOT bound into the follower query. Their copies carry
    // the time the mirror placed and filled them, never which source event they
    // copy, so a source that closes quickly produces a copy stamped after its
    // own close. Cutting on that drops the position being closed, which is the
    // failure the client-order-id correlation exists to avoid.
    //
    // Asserted as "no date", not "no bounds": the follower query legitimately
    // binds the client-order-id prefix and the network. The earlier version of
    // this assertion said toEqual([]) and only passed because the walker it used
    // could not see string values at all.
    expect(followerWhereBound).not.toContain(cutoff.toISOString());
  });

  it("holds the close when the source history scan saturates", async () => {
    // A missing published fill drops out of sourceBefore, the close resolves to
    // no-qty, and a one-shot exit is consumed while the position is still open.
    const db = {
      query: {
        orders: {
          findMany: async (args: any) =>
            args?.columns?.id
              ? Array.from({ length: args.limit }, (_u, i) => ({
                  id: `source-${i}`,
                  brokerOrderId: `evt-${i}`,
                  direction: "long",
                  executedSizeDecimal: "1",
                  createdAt: new Date("2026-07-31T11:00:00.000Z"),
                  executedAt: new Date("2026-07-31T11:00:00.000Z"),
                }))
              : [],
        },
        socialTrades: { findMany: async () => [] },
      },
    } as never;

    await expect(
      (new CopyMirrorPoller(db) as any).loadPerpCloseContext(
        {
          followerUserId: "follower-perp",
          sourceItemId: "user:source-social-close",
          sourceUserId: "source-user",
          sourceOrderId: "source-close-fill",
          sourceOrderCreatedAt: new Date("2026-07-31T12:00:00.000Z").toISOString(),
          symbol: "BTC",
          perpSide: "short",
        },
        { side: "long", size: "0.5" },
      ),
    ).rejects.toThrow("saturated");
  });

  it("reads close history on the venue clock, not on when the rows were written", async () => {
    // The outage case. The open filled at 11:00 and the close at 12:00, both on
    // the venue, but reconciliation wrote BOTH rows at 20:00. The cutoff is the
    // close's venue time, so comparing it against createdAt would put the open
    // after its own close, drop it from the reconstruction, and resolve the
    // close to no-qty while the follower still holds the position.
    const filledAt = new Date("2026-07-31T11:00:00.000Z");
    const closedAt = new Date("2026-07-31T12:00:00.000Z");
    const writtenAt = new Date("2026-07-31T20:00:00.000Z");
    const db = {
      query: {
        orders: {
          findMany: async (args: any) =>
            args?.columns?.id
              ? [
                  {
                    id: "source-open",
                    brokerOrderId: "source-open-fill-event",
                    direction: "long",
                    executedSizeDecimal: "2",
                    createdAt: writtenAt,
                    executedAt: filledAt,
                  },
                ]
              : [
                  {
                    clientOrderId: "copymirror:follower-perp:user:source-social-open",
                    direction: "long",
                    executedSizeDecimal: "0.5",
                    createdAt: writtenAt,
                    executedAt: filledAt,
                  },
                ],
        },
        socialTrades: {
          findMany: async () => [
            { id: "source-social-open", brokerOrderId: "source-open-fill-event" },
          ],
        },
      },
    } as never;

    const context = await (new CopyMirrorPoller(db) as any).loadPerpCloseContext(
      {
        followerUserId: "follower-perp",
        sourceItemId: "user:source-social-close",
        sourceUserId: "source-user",
        sourceOrderId: "source-close-fill",
        sourceOrderCreatedAt: closedAt.toISOString(),
        symbol: "BTC",
        perpSide: "short",
      },
      { side: "long", size: "0.5" },
    );

    expect(context).toEqual({
      sourcePositionSizeDecimal: "2",
      mirroredExposureSizeDecimal: "0.5",
      attributedClientOrderIds: ["copymirror:follower-perp:user:source-social-open"],
    });
  });

  it("will not size a close from the venue position, even when every row is the mirror's", async () => {
    // The tempting inference is that a follower whose only rows carry the
    // mirror's prefix must hold a mirror-owned position, so the live size can be
    // used while the fill is unrecorded. It does not hold: a position opened
    // DIRECTLY on Hyperliquid has no row here at all, and the open guard
    // deliberately lets the mirror scale into a matching same-side position. The
    // venue figure would then be theirs plus ours, and a full close would take
    // their own position with it.
    //
    // Null is the right answer, and it is not the same as consuming the close:
    // the unreconciled open keeps the delivery ambiguous, so it defers and is
    // sized correctly once the fill lands.
    const context = await (new CopyMirrorPoller(venueFallbackDb([
      {
        clientOrderId: "copymirror:follower-perp:user:source-social-open",
        direction: "long",
        executedSizeDecimal: null,
        createdAt: new Date("2026-07-31T11:01:00.000Z"),
      },
    ])) as any).loadPerpCloseContext(venueFallbackCand, { side: "long", size: "0.75" });

    expect(context).toBeNull();
  });

  it("sizes from recorded mirror fills once they exist", async () => {
    // The reconstruction is the only attribution we have, and it is sufficient
    // as soon as the fill is recorded.
    const context = await (new CopyMirrorPoller(venueFallbackDb([
      {
        clientOrderId: "copymirror:follower-perp:user:source-social-open",
        direction: "long",
        executedSizeDecimal: "0.5",
        createdAt: new Date("2026-07-31T11:01:00.000Z"),
      },
      // Manual history is irrelevant to the reconstruction: only rows carrying
      // the mirror's prefix and a known source event are counted.
      {
        clientOrderId: "manual-order",
        direction: "long",
        executedSizeDecimal: "3",
        createdAt: new Date("2026-07-31T11:02:00.000Z"),
      },
    ])) as any).loadPerpCloseContext(venueFallbackCand, { side: "long", size: "3.5" });

    expect(context).toEqual({
      sourcePositionSizeDecimal: "2",
      mirroredExposureSizeDecimal: "0.5",
      attributedClientOrderIds: ["copymirror:follower-perp:user:source-social-open"],
    });
  });

  it("reads the live long, clamps the close, and skips leverage updates", async () => {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      let submitted: Record<string, unknown> | undefined;
      let leverageUpdates = 0;
      const db = {
        query: {
          userApiCredentials: {
            findFirst: async () => ({
              id: "11111111-1111-4111-8111-111111111111",
              provider: "hyperliquid",
              accountType: "LIVE",
            }),
          },
          copyTradeFollows: { findFirst: async () => LIVE_FOLLOW },
          orders: { findFirst: async () => undefined, findMany: async () => [] },
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [{ id: "close-local" }] }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => ({
          walletAddress: "0x1111111111111111111111111111111111111111",
          client: {
            resolveAsset: async () => ({ szDecimals: 8, maxLeverage: 50 }),
            listPositions: async () => [{
              coin: "BTC",
              side: "long",
              size: "0.25",
              leverage: 3,
              marginMode: "cross",
            }],
            perpAccountSnapshot: async () => ({ positions: [{
              coin: "BTC",
              side: "long",
              size: "0.25",
              leverage: 3,
              marginMode: "cross",
            }], crossMargin: null, coveredDexes: [""] }),
            // This case sets crossMargin: null to assert the unavailable path.
            perpCollateral: async () => null,
            // $100 x 0.25 BTC clears the venue's $10 minimum with room to
            // spare, so this stays a "places normally" fixture.
            allMids: async () => ({ BTC: "100" }),
            updateLeverage: async () => { leverageUpdates += 1; },
            placeOrder: async (request: Record<string, unknown>) => {
              submitted = request;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          followerUserId: "follower-perp",
          credentialId: "11111111-1111-4111-8111-111111111111",
          followId: LIVE_FOLLOW.id,
          sourceItemId: "user:close-1",
          symbol: "BTC",
          side: "sell",
          sizingMode: "usd",
          sizingValue: 500,
          assetType: "PERP",
          perpSide: "short",
          perpReduceOnly: true,
          sourceQtyDecimal: "10.12345678",
          sourcePositionSizeDecimal: "10.12345678",
          mirroredExposureSizeDecimal: "0.25",
        },
        undefined,
        {
          dailyCap: 20,
          maxOrderDollars: 1_000,
          perpsEnabled: true,
          mainnetAllowed: false,
        },
      );

      expect(outcome).toBe("placed");
      expect(leverageUpdates).toBe(0);
      expect(submitted).toMatchObject({
        side: "short",
        size: "0.25",
        reduceOnly: true,
      });
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  });

  it("still closes a position whose market has been delisted", async () => {
    // The tradability gate is deliberately asymmetric. Refusing to OPEN a
    // delisted market costs a missed mirror; refusing to CLOSE one strands a
    // follower inside a leveraged position on a market that is winding down.
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      let submitted: Record<string, unknown> | undefined;
      const db = {
        query: {
          userApiCredentials: {
            findFirst: async () => ({
              id: "11111111-1111-4111-8111-111111111111",
              provider: "hyperliquid",
              accountType: "LIVE",
            }),
          },
          copyTradeFollows: { findFirst: async () => LIVE_FOLLOW },
          orders: { findFirst: async () => undefined, findMany: async () => [] },
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [{ id: "close-delisted" }] }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => ({
          walletAddress: "0x1111111111111111111111111111111111111111",
          client: {
            resolveAsset: async () => ({
              szDecimals: 8,
              maxLeverage: 50,
              isDelisted: true,
            }),
            listPositions: async () => [{
              coin: "BTC",
              side: "long",
              size: "0.25",
              leverage: 3,
              marginMode: "cross",
            }],
            perpAccountSnapshot: async () => ({ positions: [{
              coin: "BTC",
              side: "long",
              size: "0.25",
              leverage: 3,
              marginMode: "cross",
            }], crossMargin: null, coveredDexes: [""] }),
            // This case sets crossMargin: null to assert the unavailable path.
            perpCollateral: async () => null,
            // $100 x 0.25 BTC clears the venue's $10 minimum with room to
            // spare, so this stays a "places normally" fixture.
            allMids: async () => ({ BTC: "100" }),
            updateLeverage: async () => undefined,
            placeOrder: async (request: Record<string, unknown>) => {
              submitted = request;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          followerUserId: "follower-perp",
          credentialId: "11111111-1111-4111-8111-111111111111",
          followId: LIVE_FOLLOW.id,
          sourceItemId: "user:close-delisted",
          symbol: "BTC",
          side: "sell",
          sizingMode: "usd",
          sizingValue: 500,
          assetType: "PERP",
          perpSide: "short",
          perpReduceOnly: true,
          sourceQtyDecimal: "10.12345678",
          sourcePositionSizeDecimal: "10.12345678",
          mirroredExposureSizeDecimal: "0.25",
        },
        undefined,
        {
          dailyCap: 20,
          maxOrderDollars: 1_000,
          perpsEnabled: true,
          mainnetAllowed: false,
        },
      );

      expect(outcome).toBe("placed");
      expect(submitted).toMatchObject({ reduceOnly: true, size: "0.25" });
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  });
});

describe("processPerpCandidate opening execution", () => {
  const WALLET = "0x1111111111111111111111111111111111111111";
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

  const guards = {
    dailyCap: 20,
    maxOrderDollars: 1_000,
    perpsEnabled: true,
    mainnetAllowed: false,
    liveAllowed: false,
  };

  const openCandidate = {
    // withPerpEnv configures testnet, and preflight now requires the source
    // network to be PROVEN and to match, so the fixtures state it.
    sourceVenueNetwork: "testnet",
    followerUserId: "follower-perp",
    credentialId: CREDENTIAL_ID,
    followId: LIVE_FOLLOW.id,
    // Fresh intent: an OPEN is only mirrored while it is still a copy of the
    // source trade rather than an unreviewed entry at a much later price.
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:open-sized",
    symbol: "BTC",
    side: "buy" as const,
    sizingMode: "pct" as const,
    sizingValue: 50,
    assetType: "PERP" as const,
    perpSide: "long" as const,
    perpLeverage: 5,
    perpUserMaxLeverage: 50,
    perpFollowMaxLeverage: null,
    perpMarginMode: "cross" as const,
  };

  function makeDb() {
    return {
      query: {
        userApiCredentials: {
          findFirst: async () => ({
            id: CREDENTIAL_ID,
            provider: "hyperliquid",
            accountType: "LIVE",
          }),
        },
        copyTradeFollows: { findFirst: async () => LIVE_FOLLOW },
        orders: { findFirst: async () => undefined, findMany: async () => [] },
      },
      select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "open-local", ...value }],
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
    } as never;
  }

  // HYPERLIQUID_SYNC_ENABLED is part of the perp environment now: the reconciler
  // is a precondition of perp mirroring, not an optional extra.
  async function withPerpEnv<T>(run: () => Promise<T>): Promise<T> {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousSync = process.env.HYPERLIQUID_SYNC_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_SYNC_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      return await run();
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousSync === undefined) delete process.env.HYPERLIQUID_SYNC_ENABLED;
      else process.env.HYPERLIQUID_SYNC_ENABLED = previousSync;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  }

  async function executePolicyOpen(
    follow: Record<string, unknown>,
    candidateOverrides: Record<string, unknown> = {},
    events?: string[],
    lockedFollow: Record<string, unknown> = follow,
    dbOverride?: Record<string, any>,
    options: {
      placeError?: Error;
      submitError?: Error;
      protectionError?: Error;
      insertedValues?: Array<Record<string, unknown>>;
      submittedRequests?: Array<Record<string, unknown>>;
      recordOrderLock?: boolean;
    } = {},
  ) {
    const leverageCalls: Array<Record<string, unknown>> = [];
    let placements = 0;
    const baseDb = (dbOverride ?? makeDb()) as Record<string, any>;
    if (options.insertedValues && !dbOverride) {
      const rootInsert = baseDb.insert;
      baseDb.insert = (...args: unknown[]) => {
        const builder = rootInsert(...args);
        const values = builder?.values;
        if (typeof values !== "function") return builder;
        builder.values = (value: Record<string, unknown>) => {
          events?.push("phase-a:pending");
          options.insertedValues?.push(value);
          return values.call(builder, value);
        };
        return builder;
      };
    }
    baseDb.query = {
      ...baseDb.query,
      copyTradeFollows: { findFirst: async () => follow },
    };
    const db = baseDb as never;
    if (events && !dbOverride) {
      addPolicyTransactionTrace(
        db as Record<string, any>,
        events,
        follow,
        lockedFollow,
        options.recordOrderLock ?? false,
      );
    }
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({
        walletAddress: WALLET,
        client: {
          resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 50, isolatedOnly: false }),
          allMids: async () => ({ BTC: "100" }),
          perpAccountSnapshot: async () => ({ coveredDexes: [""], positions: [], crossMargin: null }),
          perpCollateral: async () => ({
            freeUsd: "1000",
            accountValueUsd: "1000",
            source: "perp-cross-margin",
          }),
          updateLeverage: async (request: Record<string, unknown>) => {
            events?.push("apply");
            leverageCalls.push(request);
            return { status: "ok" };
          },
          placeOrder: async (request: Record<string, unknown>) => {
            events?.push("place");
            placements += 1;
            options.submittedRequests?.push(request);
            if (options.placeError) throw options.placeError;
            return { status: "ok" };
          },
        },
      })) as never,
    });
    if (options.protectionError) {
      // The production path catches this post-commit hook independently from
      // the durable order finalization. This deliberately bypasses the venue
      // protection implementation so the test isolates transaction lifetime.
      (poller as any).attachPerpProtection = async () => {
        throw options.protectionError;
      };
    }
    if (options.submitError) {
      // This is deliberately outside the client's placeOrder fake: the real
      // Phase-B wrapper converts a transport error into an explicit ambiguous
      // submission. A throw here models a lower-level helper failure where no
      // submission value was returned, so the policy catch must not claim
      // exposure or create an unprotected backlog row.
      (poller as any).submitPerpMirrorOrder = async () => {
        throw options.submitError;
      };
    }
    const outcome = await (poller as any).processPerpCandidate(
      { ...openCandidate, ...candidateOverrides },
      undefined,
      guards,
    );
    return { outcome, leverageCalls, placements };
  }

  it("sizes off free cross collateral and submits at the mark the caps were checked against", async () => {
    await withPerpEnv(async () => {
      let submitted: Record<string, unknown> | undefined;
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            resolveAsset: async () => ({
              szDecimals: 3,
              maxLeverage: 50,
              isolatedOnly: false,
            }),
            allMids: async () => ({ BTC: "100" }),
            // $10,000 of account value with $9,000 posted as margin: $1,000 is
            // free. The old read (total account value) would have sized this at
            // 50 coins instead of 5.
            perpAccountSnapshot: async () => ({ coveredDexes: [""],
              positions: [],
              crossMargin: { accountValueUsd: "10000", totalMarginUsedUsd: "9000" },
            }),
            // Sizing reads collateral through perpCollateral now. Derived from this
            // case's own crossMargin fixture so its intent is unchanged.
            perpCollateral: async () => ({
              freeUsd: "1000",
              accountValueUsd: "10000",
              source: "perp-cross-margin",
            }),
            updateLeverage: async () => undefined,
            placeOrder: async (request: Record<string, unknown>) => {
              submitted = request;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        openCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(submitted).toMatchObject({
        coin: "BTC",
        side: "long",
        size: "4.761",
        orderType: "Limit",
        limitPrice: "105",
        timeInForce: "Ioc",
        reduceOnly: false,
        // The mark is retained for the audit context, while the preformatted
        // limit above is what pins the actual IOC payload.
        markPrice: "100",
        slippage: 0.05,
      });
    });
  });

  it("keeps fresh short opens enabled when the exact sell payload fits the cap", async () => {
    await withPerpEnv(async () => {
      const result = await executePolicyOpen(
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 5, perpMaxLeverage: null },
        {
          sourceItemId: "user:open-short-payload",
          side: "sell",
          perpSide: "short",
          sizingValue: 50,
          perpLeverage: 5,
          perpUserMaxLeverage: 5,
          perpFollowMaxLeverage: null,
        },
      );

      expect(result.outcome).toBe("placed");
      expect(result.placements).toBe(1);
    });
  });

  it.each([
    {
      name: "global",
      follow: { ...LIVE_FOLLOW, copyPerpMaxLeverage: 101, perpMaxLeverage: null },
    },
    {
      name: "follow",
      follow: { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: 101 },
    },
  ])("refuses a fresh open before venue action when the locked $name cap is outside the shared contract", async ({ follow }) => {
    await withPerpEnv(async () => {
      const result = await executePolicyOpen(
        follow,
        {
          sourceItemId: `user:open-${follow.perpMaxLeverage === 101 ? "follow" : "global"}-over-max`,
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        [],
        follow,
      );

      expect(result.outcome).toBe("leverage-policy-unavailable");
      expect(result.leverageCalls).toEqual([]);
      expect(result.placements).toBe(0);
    });
  });

  it.each([
    ["long", "buy", "0.1", "105"],
    ["short", "sell", "0.111", "95"],
  ] as const)(
    "runs the phased $10.55 %s open through Phase A and Phase B with the exact IOC payload",
    async (perpSide, side, expectedSize, expectedLimitPrice) => {
      await withPerpEnv(async () => {
        const events: string[] = [];
        const insertedValues: Array<Record<string, unknown>> = [];
        const submittedRequests: Array<Record<string, unknown>> = [];
        const result = await executePolicyOpen(
          { ...LIVE_FOLLOW, copyPerpMaxLeverage: 5, perpMaxLeverage: null },
          {
            sourceItemId: `user:phased-10-55-${perpSide}`,
            side,
            perpSide,
            sizingMode: "usd",
            sizingValue: 10.55,
            perpLeverage: 5,
            perpUserMaxLeverage: 5,
            perpFollowMaxLeverage: null,
          },
          events,
          { ...LIVE_FOLLOW, copyPerpMaxLeverage: 5, perpMaxLeverage: null },
          undefined,
          { insertedValues, submittedRequests },
        );

        expect(result.outcome).toBe("placed");
        expect(result.placements).toBe(1);
        expect(insertedValues).toHaveLength(1);
        expect(submittedRequests[0]).toMatchObject({
          coin: "BTC",
          side: perpSide,
          size: expectedSize,
          orderType: "Limit",
          limitPrice: expectedLimitPrice,
          timeInForce: "Ioc",
          reduceOnly: false,
          slippage: 0.05,
        });
        expect(events).toContain("phase-a:pending");
        expect(events).toContain("place");
      });
    },
  );

  it("snapshots the follow protection policy in the Phase-A intent", async () => {
    await withPerpEnv(async () => {
      const insertedValues: Array<Record<string, unknown>> = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 5,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
        perpStopLossPct: "10.00",
      };
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-protection-snapshot",
          perpLeverage: 5,
          perpUserMaxLeverage: 5,
          perpFollowMaxLeverage: null,
          sourceInitialTakeProfitPx: "130",
          sourceInitialStopLossPx: "80",
        },
        undefined,
        stagedFollow,
        undefined,
        { insertedValues },
      );

      expect(result.outcome).toBe("placed");
      expect(insertedValues[0]?.perpProtection).toMatchObject({
        copyMirrorProtectionIntent: true,
        takeProfitRoePct: 25,
        stopLossRoePct: 10,
      });
      expect(insertedValues[0]?.perpProtection).not.toHaveProperty("takeProfitPx");
      expect(insertedValues[0]?.perpProtection).not.toHaveProperty("stopLossPx");
    });
  });

  it("snapshots source initial protection when the follower has no override", async () => {
    await withPerpEnv(async () => {
      const insertedValues: Array<Record<string, unknown>> = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 5,
        perpMaxLeverage: null,
        perpTakeProfitPct: null,
        perpStopLossPct: null,
      };
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-source-protection-snapshot",
          perpLeverage: 5,
          perpUserMaxLeverage: 5,
          perpFollowMaxLeverage: null,
          sourceInitialTakeProfitPx: "130",
          sourceInitialStopLossPx: "80",
        },
        undefined,
        stagedFollow,
        undefined,
        { insertedValues },
      );

      expect(result.outcome).toBe("placed");
      expect(insertedValues[0]?.perpProtection).toMatchObject({
        copyMirrorProtectionIntent: true,
        takeProfitPx: "130",
        stopLossPx: "80",
      });
    });
  });

  it("holds the fresh open policy lock through leverage and placement", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-policy-lock-order",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        loweredFollow,
      );
      expect(result.outcome).toBe("syncing");
      expect(result.leverageCalls).toEqual([]);
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
      ]);
    });
  });

  it("does not call the venue when a locked fresh cap must lower durable leverage", async () => {
    await withPerpEnv(async () => {
      const insertedValues: Array<Record<string, unknown>> = [];
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-durable-leverage-floor",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        loweredFollow,
        undefined,
        { insertedValues },
      );

      expect(result.outcome).toBe("syncing");
      expect(result.leverageCalls).toEqual([]);
      expect(result.placements).toBe(0);
      // Phase A still records the pre-lock 8x intent; the locked transaction
      // must durably lower it before returning this retryable result.
      expect(insertedValues[0]?.leverage).toBe(8);
    });
  });

  it("does not call the venue and rolls back the lower on a policy commit failure", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        loweredFollow,
        { failPolicyCommit: true },
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-durable-leverage-commit-failure",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        loweredFollow,
        distinct.db,
      )).rejects.toThrow("policy transaction commit failed");

      expect(distinct.durableRows[0]).toMatchObject({ status: "PENDING", leverage: 8 });
      expect(events).not.toContain("apply");
      expect(events).not.toContain("place");
    });
  });

  it("locks the prepared fresh order after the user and through venue placement", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const follow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const result = await executePolicyOpen(
        follow,
        {
          sourceItemId: "user:open-policy-order-lock",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        follow,
        undefined,
        { recordOrderLock: true, insertedValues: [] },
      );

      expect(result.outcome).toBe("placed");
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "lock:order:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("uses a distinct transaction handle and keeps a venue-accepted intent durable when finalization fails", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const baseDb = makeDb() as Record<string, any>;
      const distinct = makeDistinctPolicyTransactionDb(
        baseDb,
        events,
        stagedFollow,
        { failTxStatusWrite: true },
      );
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-distinct-policy-tx",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
      );

      expect(result.outcome).toBe("syncing");
      expect(result.placements).toBe(1);
      expect(distinct.durableRows).toHaveLength(1);
      expect(distinct.durableRows[0]).toMatchObject({ status: "PENDING" });
      // Phase A commits before the policy transaction. During the policy
      // transaction every write-capable operation is reached through its
      // distinct tx handle; Phase C starts only after the lock transaction has
      // committed, so a status-write failure cannot roll the intent away.
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:rollback",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("does not requeue a fresh open when post-commit protection fails", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
      );
      const result = await executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-protection-after-commit",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
        { protectionError: new Error("protection request failed") },
      );

      expect(result.outcome).toBe("placed");
      expect(result.placements).toBe(1);
      // Phase C has already committed the venue acceptance before protection
      // starts. A protection failure therefore cannot roll the opening row
      // back or make the delivery retry the same cloid.
      expect(distinct.durableRows[0]).toMatchObject({ status: "SUBMITTED" });
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("leaves a fresh ambiguous venue submission PENDING for reconciliation", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
      );
      const transportError = new Error("venue request timed out");

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-ambiguous-venue",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
        { placeError: transportError },
      )).rejects.toThrow("venue request timed out");

      expect(distinct.durableRows[0]).toMatchObject({
        status: "PENDING",
        placedAt: expect.any(Date),
      });
      // The policy transaction commits before the ambiguous error is surfaced;
      // Phase C stamps the already-committed intent in its own transaction.
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("records protection as unprotected before surfacing an ambiguous fresh submission", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 50,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-ambiguous-protection-record",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
        { placeError: new Error("venue request timed out") },
      )).rejects.toThrow("venue request timed out");

      expect(distinct.durableRows[0]).toMatchObject({
        status: "PENDING",
        perpProtectionStatus: "unprotected",
        perpProtection: expect.objectContaining({
          copyMirrorProtectionIntent: true,
          takeProfitRoePct: 25,
        }),
      });
    });
  });

  it("leaves a fresh accepted intent PENDING when the policy transaction rolls back", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const baseDb = makeDb() as Record<string, any>;
      const distinct = makeDistinctPolicyTransactionDb(
        baseDb,
        events,
        stagedFollow,
        { failPolicyCommit: true },
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-policy-rollback",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
      )).rejects.toThrow("policy transaction commit failed");

      expect(distinct.durableRows).toHaveLength(1);
      expect(distinct.durableRows[0]).toMatchObject({ status: "PENDING" });
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:rollback",
      ]);
    });
  });

  it("records protection as unprotected when the policy transaction cannot commit", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 50,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
        { failPolicyCommit: true },
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-policy-rollback-protection-record",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
      )).rejects.toThrow("policy transaction commit failed");

      expect(distinct.durableRows[0]).toMatchObject({
        status: "PENDING",
        perpProtectionStatus: "unprotected",
      });
    });
  });

  it("does not record protection when the fresh policy transaction fails before venue submission", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 50,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
        { failPolicyBeforeCallback: true },
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-policy-before-venue",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
      )).rejects.toThrow("policy transaction unavailable before callback");

      // Phase A keeps the immutable rule snapshot on the durable intent, but
      // an unprotected backlog entry is only valid once Phase B reached venue
      // submission. A lock/read failure must not claim non-existent exposure.
      expect(distinct.durableRows[0]).toMatchObject({ status: "PENDING" });
      expect(distinct.durableRows[0]).not.toHaveProperty("perpProtectionStatus");
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "transaction:rollback",
      ]);
    });
  });

  it("does not record protection when fresh Phase B throws before returning a submission", async () => {
    await withPerpEnv(async () => {
      const events: string[] = [];
      const stagedFollow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 50,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const distinct = makeDistinctPolicyTransactionDb(
        makeDb() as Record<string, any>,
        events,
        stagedFollow,
      );

      await expect(executePolicyOpen(
        stagedFollow,
        {
          sourceItemId: "user:open-phase-b-throw",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        events,
        stagedFollow,
        distinct.db,
        { submitError: new Error("phase-b helper failed before returning") },
      )).rejects.toThrow("phase-b helper failed before returning");

      // `submitPerpMirrorOrder` was entered but returned no value. That is not
      // an accepted/ambiguous/reconcile Phase-B result, so the catch must not
      // invent unprotected exposure for a configured follow.
      expect(distinct.durableRows[0]).toMatchObject({ status: "PENDING" });
      expect(distinct.durableRows[0]).not.toHaveProperty("perpProtectionStatus");
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "phase-a:pending",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "transaction:rollback",
      ]);
    });
  });

  it("caps a staged 10x source at the current user's staged 2x policy", async () => {
    await withPerpEnv(async () => {
      const leverageCalls: Array<Record<string, unknown>> = [];
      const baseDb = makeDb() as Record<string, any>;
      const db = {
        ...baseDb,
        query: {
          ...baseDb.query,
          copyTradeFollows: {
            findFirst: async () => ({
              ...LIVE_FOLLOW,
              perpMaxLeverage: null,
              copyPerpMaxLeverage: 2,
            }),
          },
        },
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 50, isolatedOnly: false }),
            allMids: async () => ({ BTC: "100" }),
            perpAccountSnapshot: async () => ({ coveredDexes: [""], positions: [], crossMargin: null }),
            perpCollateral: async () => ({
              freeUsd: "1000",
              accountValueUsd: "1000",
              source: "perp-cross-margin",
            }),
            updateLeverage: async (request: Record<string, unknown>) => {
              leverageCalls.push(request);
              return { status: "ok" };
            },
            placeOrder: async () => ({ status: "ok" }),
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...openCandidate,
          sourceItemId: "user:open-policy-global-2",
          perpLeverage: 10,
          perpUserMaxLeverage: 2,
          perpFollowMaxLeverage: null,
        },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(leverageCalls).toEqual([{ coin: "BTC", leverage: 2, marginMode: "cross" }]);
    });
  });

  it("lets a current follow cap of 1x lower a staged and global 2x policy", async () => {
    await withPerpEnv(async () => {
      const result = await executePolicyOpen(
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 2, perpMaxLeverage: 1 },
        {
          sourceItemId: "user:open-policy-follow-1",
          perpLeverage: 10,
          perpUserMaxLeverage: 2,
          perpFollowMaxLeverage: 2,
        },
      );

      expect(result.outcome).toBe("placed");
      expect(result.leverageCalls).toEqual([{ coin: "BTC", leverage: 1, marginMode: "cross" }]);
    });
  });

  it("lets a lower current global cap win over the staged policy", async () => {
    await withPerpEnv(async () => {
      const result = await executePolicyOpen(
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 2, perpMaxLeverage: null },
        {
          sourceItemId: "user:open-policy-current-global-2",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
      );

      expect(result.outcome).toBe("placed");
      expect(result.leverageCalls).toEqual([{ coin: "BTC", leverage: 2, marginMode: "cross" }]);
    });
  });

  it("does not let raised current policy values raise a staged queued trade", async () => {
    await withPerpEnv(async () => {
      const result = await executePolicyOpen(
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 8, perpMaxLeverage: null },
        {
          sourceItemId: "user:open-policy-raised-current",
          perpLeverage: 10,
          perpUserMaxLeverage: 2,
          perpFollowMaxLeverage: null,
        },
      );

      expect(result.outcome).toBe("placed");
      expect(result.leverageCalls).toEqual([{ coin: "BTC", leverage: 2, marginMode: "cross" }]);
    });
  });

  it("uses the live venue maximum as the final leverage ceiling", async () => {
    const result = await withPerpEnv(async () => {
      const leverageCalls: Array<Record<string, unknown>> = [];
      const baseDb = makeDb() as Record<string, any>;
      const db = {
        ...baseDb,
        query: {
          ...baseDb.query,
          copyTradeFollows: {
            findFirst: async () => ({ ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null }),
          },
        },
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 3, isolatedOnly: false }),
            allMids: async () => ({ BTC: "100" }),
            perpAccountSnapshot: async () => ({ coveredDexes: [""], positions: [], crossMargin: null }),
            perpCollateral: async () => ({ freeUsd: "1000", accountValueUsd: "1000", source: "perp-cross-margin" }),
            updateLeverage: async (request: Record<string, unknown>) => {
              leverageCalls.push(request);
              return { status: "ok" };
            },
            placeOrder: async () => ({ status: "ok" }),
          },
        })) as never,
      });
      const outcome = await (poller as any).processPerpCandidate(
        {
          ...openCandidate,
          sourceItemId: "user:open-policy-venue-3",
          perpLeverage: 10,
          perpUserMaxLeverage: 8,
          perpFollowMaxLeverage: null,
        },
        undefined,
        guards,
      );
      return { outcome, leverageCalls };
    });

    expect(result.outcome).toBe("placed");
    expect(result.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
  });

  it("fails closed before creating a venue client when current policy is unreadable", async () => {
    await withPerpEnv(async () => {
      let clients = 0;
      const baseDb = makeDb() as Record<string, any>;
      const db = {
        ...baseDb,
        query: {
          ...baseDb.query,
          copyTradeFollows: {
            findFirst: async () => ({
              id: LIVE_FOLLOW.id,
              followerUserId: LIVE_FOLLOW.followerUserId,
              autoMirror: true,
              credentialId: CREDENTIAL_ID,
              destinationPolicyInitialized: true,
              stockAutoMirror: true,
              stockCredentialId: CREDENTIAL_ID,
              stockSizingMode: "usd",
              stockSizingValue: "500",
              perpAutoMirror: true,
              perpCredentialId: CREDENTIAL_ID,
              perpSizingMode: "usd",
              perpSizingValue: "500",
            }),
          },
        },
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => {
          clients += 1;
          throw new Error("venue client must not be created");
        }) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(openCandidate, undefined, guards);

      expect(outcome).toBe("leverage-policy-unavailable");
      expect(clients).toBe(0);
    });
  });

  it("fails closed when the re-read follow belongs to another user", async () => {
    await withPerpEnv(async () => {
      let clients = 0;
      const baseDb = makeDb() as Record<string, any>;
      const db = {
        ...baseDb,
        query: {
          ...baseDb.query,
          copyTradeFollows: {
            findFirst: async () => ({
              ...LIVE_FOLLOW,
              followerUserId: "foreign-user",
              copyPerpMaxLeverage: 2,
            }),
          },
        },
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => {
          clients += 1;
          throw new Error("venue client must not be created");
        }) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(openCandidate, undefined, guards);

      expect(outcome).toBe("consent-withdrawn");
      expect(clients).toBe(0);
    });
  });

  it("fails closed when the re-read follow has been deleted", async () => {
    await withPerpEnv(async () => {
      let clients = 0;
      const baseDb = makeDb() as Record<string, any>;
      const db = {
        ...baseDb,
        query: {
          ...baseDb.query,
          copyTradeFollows: { findFirst: async () => undefined },
        },
      } as never;
      const poller = new CopyMirrorPoller(db, {
        createPerpClient: (async () => {
          clients += 1;
          throw new Error("venue client must not be created");
        }) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(openCandidate, undefined, guards);

      expect(outcome).toBe("consent-withdrawn");
      expect(clients).toBe(0);
    });
  });

  it("skips the mirror when the cross-margin summary is unavailable", async () => {
    await withPerpEnv(async () => {
      let placements = 0;
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            resolveAsset: async () => ({
              szDecimals: 3,
              maxLeverage: 50,
              isolatedOnly: false,
            }),
            allMids: async () => ({ BTC: "100" }),
            // The client degrades an unreadable summary to null on purpose.
            // There is no safe substitute, so nothing is sent.
            perpAccountSnapshot: async () => ({ coveredDexes: [""], positions: [], crossMargin: null }),
            // This case sets crossMargin: null to assert the unavailable path.
            perpCollateral: async () => null,
            updateLeverage: async () => undefined,
            placeOrder: async () => {
              placements += 1;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-no-margin" },
        undefined,
        guards,
      );

      expect(outcome).toBe("margin-unavailable");
      expect(placements).toBe(0);
    });
  });

  it("skips a copy worth less than the venue minimum instead of writing a rejection", async () => {
    await withPerpEnv(async () => {
      let placements = 0;
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            resolveAsset: async () => ({
              szDecimals: 3,
              maxLeverage: 50,
              isolatedOnly: false,
            }),
            allMids: async () => ({ BTC: "100" }),
            perpAccountSnapshot: async () => ({ coveredDexes: [""],
              positions: [],
              crossMargin: { accountValueUsd: "500", totalMarginUsedUsd: "480" },
            }),
            // Sizing reads collateral through perpCollateral now. Derived from this
            // case's own crossMargin fixture so its intent is unchanged.
            perpCollateral: async () => ({
              freeUsd: "20",
              accountValueUsd: "500",
              source: "perp-cross-margin",
            }),
            updateLeverage: async () => undefined,
            placeOrder: async () => {
              placements += 1;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      // 50% of $20 free is a $10 target. The long-side floor at the IOC price
      // initially falls below $10 at the mark; its next mark-clearing .1 size
      // would submit $10.50 and exceed this test's explicit $10 cap.
      const outcome = await (poller as any).processPerpCandidate(
        {
          ...openCandidate,
          sourceItemId: "user:open-dust",
          side: "buy" as const,
          perpSide: "long" as const,
        },
        undefined,
        { ...guards, maxOrderDollars: 10 },
      );

      expect(outcome).toBe("below-min-notional");
      expect(placements).toBe(0);
    });
  });

  /**
   * The open path used to fetch only the asset, the mid and the balance, then
   * issue a bare `updateLeverage` and a non-reduce-only market order. Hyperliquid
   * nets exposure per coin and keeps leverage per coin, so both of those touch a
   * position the follower may have opened themselves.
   */
  function openClient(
    positions: ReadonlyArray<Record<string, unknown>>,
    sink: { leverageCalls: Array<Record<string, unknown>>; placements: number },
    options: { leverageThrows?: Error; leverageFailuresBeforeSuccess?: number } = {},
  ) {
    let leverageFailures = 0;
    return (async () => ({
      walletAddress: WALLET,
      client: {
        resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 50, isolatedOnly: false }),
        allMids: async () => ({ BTC: "100" }),
        perpAccountSnapshot: async () => ({ coveredDexes: [""],
          positions,
          crossMargin: { accountValueUsd: "10000", totalMarginUsedUsd: "9000" },
        }),
        // Sizing reads collateral through perpCollateral now. Derived from this
        // case's own crossMargin fixture so its intent is unchanged.
        perpCollateral: async () => ({
          freeUsd: "1000",
          accountValueUsd: "10000",
          source: "perp-cross-margin",
        }),
        updateLeverage: async (request: Record<string, unknown>) => {
          sink.leverageCalls.push(request);
          if (options.leverageThrows) throw options.leverageThrows;
          if (leverageFailures < (options.leverageFailuresBeforeSuccess ?? 0)) {
            leverageFailures += 1;
            throw new Error("temporary Hyperliquid timeout");
          }
          return { status: "ok" };
        },
        placeOrder: async () => {
          sink.placements += 1;
          return { status: "ok" };
        },
      },
    })) as never;
  }

  it("refuses to open a delisted market, which resolves fine but is winding down", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: (async () => ({
          walletAddress: WALLET,
          client: {
            // Delisted assets keep their universe entry so asset indexes stay
            // stable, so resolveAsset succeeds and the old path went straight on
            // to write leverage and submit a market order.
            resolveAsset: async () => ({
              szDecimals: 3,
              maxLeverage: 50,
              isolatedOnly: false,
              isDelisted: true,
            }),
            allMids: async () => ({ BTC: "100" }),
            perpAccountSnapshot: async () => ({ coveredDexes: [""],
              positions: [],
              crossMargin: { accountValueUsd: "10000", totalMarginUsedUsd: "0" },
            }),
            // Sizing reads collateral through perpCollateral now. Derived from this
            // case's own crossMargin fixture so its intent is unchanged.
            perpCollateral: async () => ({
              freeUsd: "10000",
              accountValueUsd: "10000",
              source: "perp-cross-margin",
            }),
            updateLeverage: async (request: Record<string, unknown>) => {
              sink.leverageCalls.push(request);
              return { status: "ok" };
            },
            placeOrder: async () => {
              sink.placements += 1;
              return { status: "ok" };
            },
          },
        })) as never,
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-delisted" },
        undefined,
        guards,
      );

      expect(outcome).toBe("coin-not-tradable");
      expect(sink.placements).toBe(0);
      expect(sink.leverageCalls).toEqual([]);
    });
  });

  it("refuses to open against the follower's opposite position, which it would reduce or flip", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient(
            [{ coin: "BTC", side: "short", size: "2", leverage: 5, marginMode: "cross" }],
            sink,
          ),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-vs-short" },
        undefined,
        guards,
      );

      expect(outcome).toBe("opposing-position");
      expect(sink.placements).toBe(0);
      // The leverage write must not happen either: it precedes the order and
      // would re-base the margin on the position it is about to net against.
      expect(sink.leverageCalls).toEqual([]);
    });
  });

  it("refuses to rewrite leverage on a coin the follower already holds at another leverage", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient(
            // Same side, so nothing would be netted away, but the follower chose
            // 20x and the mirror wants 5x. Writing it moves their liq price.
            [{ coin: "BTC", side: "long", size: "2", leverage: 20, marginMode: "cross" }],
            sink,
          ),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-vs-leverage" },
        undefined,
        guards,
      );

      expect(outcome).toBe("leverage-conflict");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses when the follower's margin mode differs from the one the mirror would set", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient(
            [{ coin: "BTC", side: "long", size: "2", leverage: 5, marginMode: "isolated" }],
            sink,
          ),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-vs-margin-mode" },
        undefined,
        guards,
      );

      expect(outcome).toBe("leverage-conflict");
      expect(sink.placements).toBe(0);
    });
  });

  it("still scales into a matching same-side position at the same leverage", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient(
            [{ coin: "BTC", side: "long", size: "2", leverage: 5, marginMode: "cross" }],
            sink,
          ),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-scale-in" },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
      expect(sink.leverageCalls).toEqual([{ coin: "BTC", leverage: 5, marginMode: "cross" }]);
    });
  });

  it("ignores another coin's position when guarding this open", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient(
            [{ coin: "ETH", side: "short", size: "9", leverage: 20, marginMode: "isolated" }],
            sink,
          ),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-other-coin" },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
    });
  });

  it("ends the delivery when the leverage write fails instead of retrying it forever", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient([], sink, {
            // A cross-vs-isolated conflict is a standing property of the
            // account's open margin, not a blip. Awaiting it bare threw into the
            // transient handler and re-armed the delivery every 15 minutes.
            leverageThrows: new Error("cannot switch margin mode with an open position"),
          }),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-leverage-throw" },
        undefined,
        guards,
      );

      expect(outcome).toBe("leverage-unconfirmed");
      expect(sink.placements).toBe(0);
    });
  });

  it("recovers a copied open when a transient leverage response fails twice", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const poller = new CopyMirrorPoller(
        makeDb(),
        {
          createPerpClient: openClient([], sink, { leverageFailuresBeforeSuccess: 2 }),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceItemId: "user:open-leverage-transient" },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.leverageCalls).toHaveLength(3);
      expect(sink.placements).toBe(1);
    });
  });
});

/**
 * A PENDING perp row is resumed by re-sending the STORED intent. Leverage is not
 * an order field, so the resume has to re-apply it or refuse: otherwise the
 * retry fills at whatever leverage the coin carries at that moment while the row
 * keeps claiming the clamped value.
 */
describe("processPerpCandidate pending resume leverage", () => {
  const WALLET = "0x1111111111111111111111111111111111111111";
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

  const guards = {
    dailyCap: 20,
    maxOrderDollars: 1_000,
    perpsEnabled: true,
    mainnetAllowed: false,
    liveAllowed: false,
  };

  const candidate = {
    // withPerpEnv configures testnet, and preflight now requires the source
    // network to be PROVEN and to match, so the fixtures state it.
    sourceVenueNetwork: "testnet",
    followerUserId: "follower-perp",
    credentialId: CREDENTIAL_ID,
    followId: LIVE_FOLLOW.id,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-open",
    symbol: "BTC",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 999,
    assetType: "PERP" as const,
    perpSide: "long" as const,
    perpLeverage: 20,
    perpUserMaxLeverage: 50,
    perpFollowMaxLeverage: null,
  };
  const currentGlobalThreeFollow = {
    ...LIVE_FOLLOW,
    copyPerpMaxLeverage: 3,
  };
  const currentGlobalOneFollow = {
    ...LIVE_FOLLOW,
    copyPerpMaxLeverage: 1,
  };

  function storedRow(overrides: Record<string, unknown> = {}) {
    const row = {
      id: "pending-perp",
      userId: "follower-perp",
      symbol: "BTC",
      assetType: "PERP",
      orderType: "Limit",
      tradeAction: "Buy",
      quantity: 0,
      venue: "hyperliquid",
      venueNetwork: "testnet",
      status: "PENDING",
      direction: "long",
      quantityDecimal: "0.125",
      limitPrice: "105",
      priceTrigger: null,
      leverage: 3,
      marginMode: "cross",
      reduceOnly: false,
      clientOrderId: "copymirror:follower-perp:user:source-open",
      brokerAccountId: WALLET,
      brokerCredentialId: CREDENTIAL_ID,
      brokerOrderId: null,
      notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
      copySourceLabel: "Source",
      perpProtection: null as unknown,
      perpProtectionStatus: null as string | null,
      perpProtectionError: null as string | null,
      ...overrides,
    };
    return {
      ...row,
      tradeAction: row.direction === "short" ? "Sell" : "Buy",
      limitPrice: "limitPrice" in overrides
        ? row.limitPrice
        : row.direction === "short"
          ? "95"
          : "105",
    };
  }

  interface ResumeSink {
    leverageCalls: Array<Record<string, unknown>>;
    placements: number;
    /** Durable claim/lease writes made before a resumed placement. */
    attemptClaims?: Array<Record<string, unknown>>;
    /** Every `markPrice` the resume handed the venue wrapper, in order. */
    markPrices?: Array<unknown>;
    /** Every leverage value written back to the stored row, in order. */
    leverageWrites?: Array<unknown>;
    /** Make the venue reject the leverage update, exercising the restore. */
    leverageApplyFails?: boolean;
    /** Make the venue transport outcome ambiguous after the request starts. */
    placeError?: Error;
    /** Make Phase B throw before returning a submission value. */
    submitError?: Error;
    /** Make the post-commit protection hand-off throw. */
    protectionAttachFails?: boolean;
  /**
   * How many rows the leverage UPDATE matches. Undefined means one (the normal
   * case). Zero models the row having left PENDING between the read and the
   * write, which is the only case the clamp guard exists for.
   */
  leverageUpdateMatches?: number;
}

  function makePoller(
    existing: Record<string, unknown>,
    positions: ReadonlyArray<Record<string, unknown>>,
    sink: ResumeSink,
    asset: Record<string, unknown> = { szDecimals: 5, maxLeverage: 50 },
    market: {
      /** BTC mid, as Hyperliquid's own decimal string. Undefined means unquoted. */
      mid?: unknown;
      crossMargin?: { accountValueUsd: string; totalMarginUsedUsd: string } | null;
    } = {},
    /** Mirrors already placed TODAY, for the resumed-open cap check. */
    mirrorsToday = 0,
    follow: Record<string, unknown> = LIVE_FOLLOW,
    settledPositions: ReadonlyArray<Record<string, unknown>> = positions,
    events?: string[],
    lockedFollow: Record<string, unknown> = follow,
    transactionOptions?: {
      failTxStatusWrite?: boolean;
      failProtectionWrite?: boolean;
      failPolicyCommit?: boolean;
      failPolicyBeforeCallback?: boolean;
      recordOrderLock?: boolean;
      claimMismatch?: boolean;
    },
  ) {
    const mid = "mid" in market ? market.mid : "100";
    const crossMargin = "crossMargin" in market
      ? market.crossMargin ?? null
      : { accountValueUsd: "10000", totalMarginUsedUsd: "0" };
    const db = {
      query: {
        userApiCredentials: {
          findFirst: async () => ({
            id: CREDENTIAL_ID,
            provider: "hyperliquid",
            accountType: "LIVE",
          }),
        },
        copyTradeFollows: { findFirst: async () => follow },
        orders: {
          findFirst: async () => existing,
          // A reduce-only resume re-derives attribution before resending, so the
          // source order and the follower's mirrored fill both have to be here.
          findMany: async (args: any) =>
            args?.columns?.id
              ? [
                  {
                    id: "source-open",
                    brokerOrderId: "source-open-event",
                    direction: "long",
                    executedSizeDecimal: "1",
                    createdAt: new Date("2026-08-01T10:00:00.000Z"),
                    executedAt: new Date("2026-08-01T10:00:00.000Z"),
                  },
                ]
              : [
                  {
                    clientOrderId: "copymirror:follower-perp:user:source-open",
                    direction: "long",
                    executedSizeDecimal: "1",
                    createdAt: new Date("2026-08-01T10:00:00.000Z"),
                  },
                ],
        },
        socialTrades: {
          findMany: async () => [{ id: "source-open", brokerOrderId: "source-open-event" }],
        },
      },
      // A resumed OPEN is checked against TODAY's cap, since a row stranded
      // before midnight is invisible to every count taken after it. The real
      // query excludes the row being resumed, so the mock has to as well: with a
      // blanket count the resumed row blocks itself and the test proves nothing.
      select: () => ({
        from: () => ({
          where: async (clause: unknown) => {
            const bound: string[] = [];
            const walk = (node: any, depth = 0) => {
              if (depth > 10 || !node) return;
              if (Array.isArray(node)) return node.forEach((c) => walk(c, depth + 1));
              if (typeof node === "object") {
                if (typeof node.value === "string") bound.push(node.value);
                Object.values(node).forEach((c) => walk(c, depth + 1));
              }
            };
            walk(clause);
            const excludesResumedRow = bound.includes(existing.id as string);
            // Clamped at zero: withinDailyCap fails closed on a negative count,
            // which would make every default-fixture test read as capped.
            return [{
              value: excludesResumedRow ? Math.max(0, mirrorsToday - 1) : mirrorsToday,
            }];
          },
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          if ("leverage" in values) sink.leverageWrites?.push(values.leverage);
          if ("leverage" in values) existing.leverage = values.leverage;
          if (typeof values.syncReason === "string" || "lastSyncAttemptAt" in values) {
            sink.attemptClaims?.push(values);
          }
          // Models the real driver: `where` is chainable and `returning` reports
          // the rows the UPDATE actually matched. `leverageUpdateMatches` lets a
          // test say "the row was no longer PENDING", which is the case the
          // clamp guard exists for and which a stub that always resolved
          // successfully could not express.
          // The clamp race knob models the leverage metadata CAS. Phase A now
          // claims an existing row first, and that claim has its own CAS which
          // must succeed before this test can exercise a lost clamp write.
          const matched =
            "leverage" in values && sink.leverageUpdateMatches !== undefined
              ? sink.leverageUpdateMatches
              : 1;
          const rows = Array.from({ length: matched }, () => ({ id: "order-1" }));
          // A real Promise carrying an extra `returning`, so both shapes the
          // production code uses work: `await ...where(...)` for the plain
          // updates, and `await ...where(...).returning(...)` for the clamp.
          // Hand-rolling a `then` property instead would be a thenable object,
          // which the lint rule rejects for good reason.
          const result = Object.assign(Promise.resolve(rows), {
            returning: async () => rows,
          });
          return { where: () => result };
        },
      }),
    } as never;
    if (events && !transactionOptions) {
      addPolicyTransactionTrace(
        db as Record<string, any>,
        events,
        follow,
        lockedFollow,
        false,
      );
    }
    const pollerDb = transactionOptions
      ? makeDistinctPolicyTransactionDb(
          db as Record<string, any>,
          events ?? [],
          lockedFollow,
          transactionOptions,
          [existing],
        ).db
      : db;
    const poller = new CopyMirrorPoller(pollerDb as never, {
      createPerpClient: (async () => ({
        walletAddress: WALLET,
        client: {
          userFills: async () => [],
          openOrders: async () => [],
          orderStatusByClientOrderId: async () => ({ status: "unknownOid" }),
          resolveAsset: async () => asset,
          allMids: async () => (mid === undefined ? {} : { BTC: mid }),
          perpAccountSnapshot: async () => ({ coveredDexes: [""], positions, crossMargin }),
          // The resume path re-checks the money through perpCollateral, same as
          // a fresh open. Derived from this suite's own crossMargin knob so the
          // `crossMargin: null` cases still exercise the unavailable path.
          perpCollateral: async () =>
            crossMargin
              ? {
                  freeUsd: String(
                    Number(crossMargin.accountValueUsd) -
                      Number(crossMargin.totalMarginUsedUsd),
                  ),
                  accountValueUsd: crossMargin.accountValueUsd,
                  source: "perp-cross-margin",
                }
              : null,
          listPositions: async () => settledPositions,
          updateLeverage: async (request: Record<string, unknown>) => {
            events?.push("apply");
            sink.leverageCalls.push(request);
            // Models the venue refusing the leverage change, which is what the
            // restore path exists for.
            if (sink.leverageApplyFails) throw new Error("leverage update rejected");
            return { status: "ok" };
          },
          placeOrder: async (request: Record<string, unknown>) => {
            events?.push("place");
            sink.placements += 1;
            sink.markPrices?.push(request.markPrice);
            if (sink.placeError) throw sink.placeError;
            return { status: "ok" };
          },
        },
      })) as never,
    });
    if (sink.protectionAttachFails) {
      // Keep protection outside the policy transaction. The production path
      // catches this hook only after Phase C has committed the durable row.
      (poller as any).attachPerpProtection = async () => {
        throw new Error("post-commit protection attach failed");
      };
    }
    if (sink.submitError) {
      // Unlike the client placeOrder fake (which the production Phase-B method
      // turns into an explicit ambiguous result), this models a helper throw
      // before any submission value is returned. The policy catch must leave
      // the durable intent pending without recording false exposure.
      (poller as any).submitPerpMirrorOrder = async () => {
        throw sink.submitError;
      };
    }
    return poller;
  }

  // HYPERLIQUID_SYNC_ENABLED is part of the perp environment now: the reconciler
  // is a precondition of perp mirroring, not an optional extra.
  async function withPerpEnv<T>(run: () => Promise<T>): Promise<T> {
    const previousEnabled = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    const previousSync = process.env.HYPERLIQUID_SYNC_ENABLED;
    const previousNetwork = process.env.HYPERLIQUID_NETWORK;
    const previousAllowTestnet = process.env.HYPERLIQUID_ALLOW_TESTNET;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_SYNC_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    try {
      return await run();
    } finally {
      if (previousEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousEnabled;
      if (previousSync === undefined) delete process.env.HYPERLIQUID_SYNC_ENABLED;
      else process.env.HYPERLIQUID_SYNC_ENABLED = previousSync;
      if (previousNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previousNetwork;
      if (previousAllowTestnet === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
      else process.env.HYPERLIQUID_ALLOW_TESTNET = previousAllowTestnet;
    }
  }

  it("refuses to resume when the clamp matched no PENDING row", async () => {
    // Codex P1 on the first version of this guard. The write is scoped to
    // status PENDING so it cannot overwrite a row the reconciler has since
    // learned is live at the venue. But an UPDATE matching zero rows RESOLVES,
    // it does not throw, so the original guard reported success on exactly the
    // case it existed to catch and the resume carried on into a live position.
    // Zero matched rows must refuse, not proceed.
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
        leverageUpdateMatches: 0,
      };
      const existing = storedRow({ leverage: 8 });
      const poller = makePoller(existing, [], sink, undefined, {}, 0, currentGlobalThreeFollow);

      // Same setup as the successful re-clamp above, except the UPDATE matches
      // nothing because the row left PENDING in the meantime.
      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("leverage-unconfirmed");
      // The clamp was attempted, and nothing was placed once it did not stick.
      expect(sink.leverageWrites).toEqual([3]);
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("writes NOTHING back when there is no position to confirm against", async () => {
    // An absent position is not evidence the leverage update was lost. This
    // branch exists precisely because the update can be accepted after the call
    // times out, and the position it applies to is the one that can still be in
    // flight and unsurfaced, so restoring the stored value there is an active
    // write of something the venue may already have replaced.
    //
    // Hyperliquid reports per-coin leverage only inside an open position, so
    // with none there is nothing to confirm against and no honest value to
    // write. The clamp stands and the row stays PENDING for the reconciler.
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
        // The venue refuses the leverage update.
        leverageApplyFails: true,
      };
      const existing = storedRow({ leverage: 8 });
      const poller = makePoller(existing, [], sink, undefined, {}, 0, currentGlobalThreeFollow);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("leverage-unconfirmed");
      expect(sink.placements).toBe(0);
      // Clamped down to 3 before the venue call, and then left alone. The mock
      // holds no position in the coin, so there is nothing to read the truth
      // from and no second write.
      expect(sink.leverageWrites).toEqual([3]);
    });
  });

  it("repairs a stale resume leverage when the locked policy lowered after the pre-read", async () => {
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
        leverageApplyFails: true,
      };
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      // The unlocked snapshot still sees the old 50x ceiling, but the exact
      // user row reread under FOR UPDATE is now 3x. There is no live position
      // report to reconcile, so the effective locked clamp itself must replace
      // the stale stored value when leverage application fails.
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null },
        [],
        events,
        { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null },
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("syncing");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.leverageWrites).toEqual([3]);
      expect(sink.placements).toBe(0);
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
      ]);
    });
  });

  it("keeps the venue's leverage when an unconfirmed update actually applied", async () => {
    // applyPerpLeverage returns false for a transport error as well as a
    // definitive rejection, and updateLeverage is a non-retried state-changing
    // call whose timeout can land AFTER the venue accepted it. Restoring the
    // stored value there would make the row describe a leverage the venue has
    // already replaced, so the live position is asked instead.
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
        leverageApplyFails: true,
      };
      const existing = storedRow({ leverage: 8 });
      // The venue holds the position at the CLAMPED value: the update landed,
      // the response did not.
      const poller = makePoller(
        existing,
        [{ coin: "BTC", side: "long", size: "1", leverage: 3, marginMode: "cross" }],
        sink,
        undefined,
        {},
        0,
        currentGlobalThreeFollow,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("leverage-unconfirmed");
      // Clamped to 3, and left at 3 because that is what the venue holds.
      expect(sink.leverageWrites).toEqual([3, 3]);
    });
  });

  it("never persists venue-reported leverage above the effective resume clamp", async () => {
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
        leverageApplyFails: true,
      };
      const existing = storedRow({ leverage: 8 });
      const poller = makePoller(
        existing,
        // The venue reports 25x after the leverage update failed. The current
        // user policy still clamps this resumed intent to 3x. The initial
        // snapshot remains compatible with the 3x guard; the later settlement
        // read is the deliberately unsafe venue report.
        [{ coin: "BTC", side: "long", size: "1", leverage: 3, marginMode: "cross" }],
        sink,
        undefined,
        {},
        0,
        currentGlobalThreeFollow,
        [{ coin: "BTC", side: "long", size: "1", leverage: 25, marginMode: "cross" }],
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("leverage-unconfirmed");
      expect(sink.placements).toBe(0);
      // Persist the lower effective clamp, never the venue's unsafe report.
      expect(sink.leverageWrites).toEqual([3, 3]);
    });
  });

  it("refuses to resume when the stored row carries no usable leverage", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const existing = storedRow({ leverage: null });
      const poller = makePoller(existing, [], sink, undefined, {}, 0, currentGlobalThreeFollow);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      // The old code defaulted to 1x here, which is a leverage the clamp never
      // produced and a liquidation profile nobody chose.
      expect(outcome).toBe("leverage-unconfirmed");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume an open into a market that has since been delisted", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const existing = storedRow();
      const poller = makePoller(existing, [], sink, {
        szDecimals: 5,
        maxLeverage: 50,
        isDelisted: true,
      });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      // A resume re-sends an intent that may be hours old, so the market is
      // re-checked rather than assumed. The row keeps PENDING: the first attempt
      // may already have reached the venue, and only the reconciler can tell.
      expect(outcome).toBe("coin-not-tradable");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume an open into a position that has since flipped the other way", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const existing = storedRow();
      const poller = makePoller(
        existing,
        [{ coin: "BTC", side: "short", size: "1", leverage: 3, marginMode: "cross" }],
        sink,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("opposing-position");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume when the coin now carries a different leverage", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const existing = storedRow();
      const poller = makePoller(
        existing,
        // The follower (or a sibling mirror) moved BTC to 25x between attempts.
        [{ coin: "BTC", side: "long", size: "1", leverage: 25, marginMode: "cross" }],
        sink,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("leverage-conflict");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("does NOT adopt the leverage of a position it cannot attribute", async () => {
    // Repairing the row from the live position was tried here and backed out.
    // A PENDING row has no broker order id, and perp positions are fungible and
    // net per coin per account, so a live position may be the follower's own
    // manual one rather than this order's delayed fill. Adopting its leverage
    // makes the conflict vanish on the next resume, and the mirror then places
    // onto that manual position at a leverage nobody chose: a money error in
    // place of a reporting one.
    await withPerpEnv(async () => {
      const sink = {
        leverageCalls: [] as Array<Record<string, unknown>>,
        placements: 0,
        leverageWrites: [] as unknown[],
      };
      const existing = storedRow({ leverage: 3 });
      const poller = makePoller(
        existing,
        [{ coin: "BTC", side: "long", size: "1", leverage: 25, marginMode: "cross" }],
        sink,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("leverage-conflict");
      expect(sink.placements).toBe(0);
      // The refusal stands and the row is left alone, so the next resume
      // refuses again rather than proceeding at 25x.
      expect(sink.leverageWrites).toEqual([]);
    });
  });

  // ---- PARITY WITH THE FRESH OPEN ----------------------------------------
  // A resume used to trust everything the row was written with: the leverage was
  // re-applied after only a positive-integer check, and no mark was passed at
  // all, so the client priced the order off its own mid and neither money cap
  // was re-checked. A queued delivery could therefore outlive the ceiling it was
  // clamped under and resume at a notional the cap never approved.

  function freshSink() {
    return {
      leverageCalls: [] as Array<Record<string, unknown>>,
      placements: 0,
      markPrices: [] as Array<unknown>,
      leverageWrites: [] as Array<unknown>,
      attemptClaims: [] as Array<Record<string, unknown>>,
    };
  }

  it("re-clamps a resumed leverage down to the current user ceiling", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 8 });
      const poller = makePoller(existing, [], sink, undefined, {}, 0, currentGlobalThreeFollow);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("placed");
      // 8x was written to the venue before. The current user ceiling is what the
      // retry gets.
      expect(sink.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
      // And the row stops claiming a leverage the follower is not carrying.
      expect(sink.leverageWrites).toEqual([3]);
    });
  });

  it("holds the resumed open policy lock through leverage and placement", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        loweredFollow,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("syncing");
      expect(sink.leverageCalls).toEqual([]);
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
      ]);
    });
  });

  it("does not call the venue when a locked resumed cap must lower durable leverage", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        loweredFollow,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("syncing");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
      expect(sink.leverageWrites).toEqual([3]);
    });
  });

  it("does not call the venue and keeps the old resume leverage on commit failure", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        loweredFollow,
        { failPolicyCommit: true },
      );

      await expect(
        (poller as any).processPerpCandidate(candidate, existing, guards),
      ).rejects.toThrow("policy transaction commit failed");
      expect(existing.leverage).toBe(8);
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("does not call the venue when the exact resume claim no longer matches", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        undefined,
        loweredFollow,
        { claimMismatch: true },
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("leverage-policy-unavailable");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
      expect(sink.leverageWrites).toEqual([]);
    });
  });

  it("keeps a lower durable ceiling across an ambiguous retry after policy increases", async () => {
    await withPerpEnv(async () => {
      const existing = storedRow({ leverage: 8 });
      const firstSink = freshSink();
      const firstEvents: string[] = [];
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const firstPoller = makePoller(
        existing,
        [],
        firstSink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        firstEvents,
        loweredFollow,
      );

      const firstOutcome = await (firstPoller as any).processPerpCandidate(candidate, existing, guards);
      expect(firstOutcome).toBe("syncing");
      expect(existing.leverage).toBe(3);
      expect(firstSink.leverageCalls).toEqual([]);
      expect(firstSink.placements).toBe(0);

      const retrySink = { ...freshSink(), placeError: new Error("venue request timed out") };
      const retryPoller = makePoller(existing, [], retrySink);
      await expect(
        (retryPoller as any).processPerpCandidate(candidate, existing, guards),
      ).rejects.toThrow("venue request timed out");

      // The current policy is back at 50x, but the same cloid can only resume
      // at the lower leverage durably established by the earlier locked cap.
      expect(retrySink.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
      expect(retrySink.placements).toBe(1);
      expect(retrySink.leverageWrites).toEqual([]);
      expect(existing.leverage).toBe(3);
    });
  });

  it("submits a successful retry at the lower durable ceiling after policy increases", async () => {
    await withPerpEnv(async () => {
      const existing = storedRow({ leverage: 8 });
      const firstSink = freshSink();
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const loweredFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const firstPoller = makePoller(
        existing,
        [],
        firstSink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        [],
        loweredFollow,
      );

      expect(await (firstPoller as any).processPerpCandidate(candidate, existing, guards)).toBe("syncing");
      expect(existing.leverage).toBe(3);

      const retrySink = freshSink();
      const retryPoller = makePoller(existing, [], retrySink);
      expect(await (retryPoller as any).processPerpCandidate(candidate, existing, guards)).toBe("placed");
      expect(retrySink.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
      expect(retrySink.placements).toBe(1);
      expect(existing.leverage).toBe(3);
    });
  });

  it("locks the prepared resumed order after the user and through venue placement", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const follow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 3, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        follow,
        [],
        events,
        follow,
        { recordOrderLock: true },
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("placed");
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "lock:order:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("claims an active lease before resuming an old PENDING open", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        lastSyncAttemptAt: null,
        syncReason: null,
      });
      const poller = makePoller(existing, [], sink);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("placed");
      expect(sink.attemptClaims).toHaveLength(1);
      expect(sink.attemptClaims[0]).toMatchObject({
        syncReason: expect.stringMatching(/^copy-mirror:perp-placement:/),
        lastSyncAttemptAt: expect.any(Date),
      });
    });
  });

  it("keeps a resumed venue acceptance reconcilable when finalization rolls back", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        stagedFollow,
        { failTxStatusWrite: true },
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("syncing");
      expect(sink.placements).toBe(1);
      // The existing PENDING row is never made un-reconcilable by the failed
      // status transaction.
      expect(sink.leverageWrites).toEqual([]);
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:rollback",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("does not record protection when the resumed policy transaction fails before venue submission", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 8 });
      const follow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 3,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        follow,
        [],
        undefined,
        follow,
        { failPolicyBeforeCallback: true },
      );
      let protectionNotes = 0;
      (poller as any).notePerpProtectionUnattached = async () => {
        protectionNotes += 1;
      };

      await expect(
        (poller as any).processPerpCandidate(candidate, existing, guards),
      ).rejects.toThrow("policy transaction unavailable before callback");

      expect(sink.placements).toBe(0);
      expect(protectionNotes).toBe(0);
    });
  });

  it("does not record protection when resumed Phase B throws before returning a submission", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink() as ResumeSink;
      sink.submitError = new Error("resumed Phase-B helper failed before returning");
      const existing = storedRow({ leverage: 8 });
      const follow = {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 3,
        perpMaxLeverage: null,
        perpTakeProfitPct: "25.00",
      };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        follow,
        [],
        undefined,
        follow,
        {},
      );
      let protectionNotes = 0;
      (poller as any).notePerpProtectionUnattached = async () => {
        protectionNotes += 1;
      };

      await expect(
        (poller as any).processPerpCandidate(candidate, existing, guards),
      ).rejects.toThrow("resumed Phase-B helper failed before returning");

      expect(sink.placements).toBe(0);
      expect(protectionNotes).toBe(0);
    });
  });

  it("does not requeue a resumed open when post-commit protection fails", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink() as ResumeSink;
      sink.protectionAttachFails = true;
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        stagedFollow,
        {},
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
      // Protection is attempted only after the independent Phase-C commit, so
      // an attach exception cannot erase the resumed durable intent.
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("leaves a resumed ambiguous venue submission PENDING for reconciliation", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink() as ResumeSink;
      sink.placeError = new Error("resumed venue request timed out");
      const events: string[] = [];
      const existing = storedRow({ leverage: 8 });
      const stagedFollow = { ...LIVE_FOLLOW, copyPerpMaxLeverage: 50, perpMaxLeverage: null };
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        0,
        stagedFollow,
        [],
        events,
        stagedFollow,
        {},
      );

      await expect(
        (poller as any).processPerpCandidate(candidate, existing, { ...guards }),
      ).rejects.toThrow("resumed venue request timed out");

      expect(sink.placements).toBe(1);
      expect(events).toEqual([
        "transaction:begin",
        "lock:user:update",
        "transaction:commit",
        "transaction:begin",
        "lock:user:update",
        "apply",
        "place",
        "transaction:commit",
        "transaction:begin",
        "transaction:commit",
      ]);
    });
  });

  it("keeps resumed short opens enabled when the exact sell payload fits the cap", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({
        direction: "short",
        leverage: 3,
      });
      const poller = makePoller(existing, [], sink, undefined, {}, 0, {
        ...LIVE_FOLLOW,
        copyPerpMaxLeverage: 3,
        perpMaxLeverage: null,
      });

      const outcome = await (poller as any).processPerpCandidate({
        ...candidate,
        side: "sell",
        perpSide: "short",
        perpLeverage: 3,
        perpUserMaxLeverage: 3,
        perpFollowMaxLeverage: null,
      }, existing, guards);

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
      expect(sink.markPrices).toEqual(["100"]);
      expect(sink.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
    });
  });

  it("re-clamps a resumed leverage down to the coin's current max leverage", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 3 });
      // Hyperliquid cut this market's max leverage between attempts.
      const poller = makePoller(existing, [], sink, { szDecimals: 5, maxLeverage: 2 });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("placed");
      expect(sink.leverageCalls).toEqual([{ coin: "BTC", leverage: 2, marginMode: "cross" }]);
      expect(sink.leverageWrites).toEqual([2]);
    });
  });

  it("never raises a resumed leverage when the ceiling has been lifted", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 3 });
      const poller = makePoller(existing, [], sink);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      // A raised ceiling does not entitle the retry to more leverage than the
      // intent it is resuming, and an unchanged clamp rewrites nothing.
      expect(outcome).toBe("placed");
      expect(sink.leverageCalls).toEqual([{ coin: "BTC", leverage: 3, marginMode: "cross" }]);
      expect(sink.leverageWrites).toEqual([]);
    });
  });

  it("prices a resumed open off the mark its caps were checked against", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ limitPrice: "263" });
      const poller = makePoller(existing, [], sink, undefined, { mid: "250.5" });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("placed");
      // Without this the client fetches its own mid at submit time and
      // synthesizes an aggressive IoC around a number no cap has seen.
      expect(sink.markPrices).toEqual(["250.5"]);
    });
  });

  it("refuses to resume when the stored size now breaches the per-order dollar cap", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      // BTC ran from 100 to 100k while the delivery sat in the queue: 0.125 coin
      // is now $12.5k against a $1k cap.
      const poller = makePoller(existing, [], sink, undefined, { mid: "100000" });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("dollar-cap");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume when free collateral can no longer back the order", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      const poller = makePoller(existing, [], sink, undefined, {
        crossMargin: { accountValueUsd: "1000", totalMarginUsedUsd: "999" },
      });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("insufficient-margin");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume when free collateral cannot be read at all", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      const poller = makePoller(existing, [], sink, undefined, { crossMargin: null });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      // Unknown collateral is not "plenty". It is a read we could not make.
      expect(outcome).toBe("margin-unavailable");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to resume when the venue quotes no usable mid", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      const poller = makePoller(existing, [], sink, undefined, { mid: undefined });

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("no-qty");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(0);
    });
  });

  it("re-sizes a resumed close against the live position instead of resending the stored size", async () => {
    // Closes retry indefinitely on transient failures, so an arbitrary amount of
    // time can pass between attempts. If the follower reduced the mirrored
    // position in between, resending the stored quantity reduces whatever is
    // there now. reduceOnly stops a flip; it does not preserve ownership.
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const placed: Array<Record<string, unknown>> = [];
      const existing = storedRow({
        reduceOnly: true,
        direction: "short",
        leverage: null,
        quantityDecimal: "1",
      });
      const poller = makePoller(
        existing,
        // Only 0.25 left on the venue, against a stored close of 1.
        [{ coin: "BTC", side: "long", size: "0.25", leverage: 25, marginMode: "cross" }],
        sink,
      );
      (poller as any).placePerpMirrorOrder = async (_client: unknown, params: any) => {
        placed.push(params);
        return { outcome: "placed" };
      };

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...candidate,
          perpSide: "short" as const,
          perpReduceOnly: true,
          sourceUserId: "source-user",
          sourceOrderId: "source-close",
          sourceOrderCreatedAt: new Date("2026-08-01T11:00:00.000Z").toISOString(),
        },
        existing,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(placed).toHaveLength(1);
      expect(placed[0]!.sizeCoin).toBe("0.25");
      expect(placed[0]!.reduceOnly).toBe(true);
      // Same cloid, so the re-send stays idempotent at the venue.
      expect(placed[0]!.clientOrderId).toBe(existing.clientOrderId);
    });
  });

  it("does not rewrite a PENDING row's leverage when the resume is refused", async () => {
    // A PENDING row may already describe a LIVE position: the first placement
    // can have reached Hyperliquid with its response lost, which is why the row
    // is kept PENDING rather than rejected. If the ceiling has since been
    // lowered, writing the clamp before the position guard leaves the row
    // claiming a leverage the follower is not carrying, and the reconciler's
    // synthetic fill children then publish that exposure at the wrong value.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ leverage: 20 });
      const poller = makePoller(
        existing,
        // Live position at the ORIGINAL leverage, which is what makes the
        // position guard refuse once the ceiling drops.
        [{ coin: "BTC", side: "long", size: "1", leverage: 20, marginMode: "cross" }],
        sink,
        undefined,
        {},
        0,
        currentGlobalOneFollow,
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, {
        ...guards,
      });

      expect(outcome).not.toBe("placed");
      expect(sink.placements).toBe(0);
      // The row still describes the position the venue actually holds.
      expect(sink.leverageWrites ?? []).toEqual([]);
    });
  });

  it("refuses to resume an OPEN that belongs to another network", async () => {
    // The client is built for whatever network is configured now. Resuming a
    // testnet-staged row while on mainnet finds no matching cloid there, submits
    // the old intent on mainnet, and leaves the row labelled testnet, at which
    // point the network-filtered reconciler skips it and nothing settles it.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ venueNetwork: "mainnet" });
      const poller = makePoller(existing, [], sink);

      // withPerpEnv configures testnet, so the stored row is the odd one out.
      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("perp-network-mismatch");
      expect(sink.placements).toBe(0);
      expect(sink.leverageCalls).toEqual([]);
    });
  });

  it("holds a CLOSE that belongs to another network rather than consuming it", async () => {
    // Switching the network back or draining the order is a thing a person can
    // do, so the exit is kept rather than spent.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ venueNetwork: "mainnet", reduceOnly: true, direction: "short" });
      const poller = makePoller(existing, [], sink);

      await expect(
        (poller as any).processPerpCandidate(
          { ...candidate, perpSide: "short" as const, perpReduceOnly: true },
          existing,
          guards,
        ),
      ).rejects.toThrow("perp-network-mismatch");
      expect(sink.placements).toBe(0);
    });
  });

  it("counts the daily cap by PLACEMENT time, falling back to row creation", async () => {
    // A row stranded PENDING before midnight and resumed after it was counted
    // against neither day: not today, because it was created yesterday, and not
    // yesterday's total, which is already spent. Counting by placed_at closes
    // that, and coalescing to created_at keeps rows written before the column
    // existed counting as they always did.
    let where: unknown;
    const poller = new CopyMirrorPoller({
      select: () => ({
        from: () => ({
          where: async (clause: unknown) => {
            where = clause;
            return [{ value: 0 }];
          },
        }),
      }),
    } as never);

    expect(await (poller as any).countMirrorsToday("follower-perp")).toBe(0);

    // Drizzle keeps raw SQL as StringChunks whose `value` is a string ARRAY, so
    // the walkers used elsewhere in this file (which look for string values)
    // do not see it and would pass against any clause at all.
    const seen = new WeakSet<object>();
    const literals: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (Array.isArray(node.value) && node.value.every((v: unknown) => typeof v === "string")) {
        literals.push(node.value.join(""));
      }
      Object.values(node).forEach(walk);
    };
    walk(where);
    expect(literals.join(" ")).toContain("coalesce");

    // And the creation-time fallback excludes rows that never reached the
    // venue: a definitive rejection leaves placed_at null, and counting it
    // spends a cap slot on an order the follower never received.
    const seenValues = new WeakSet<object>();
    const bound: string[] = [];
    const walkValues = (node: any) => {
      if (!node || typeof node !== "object" || seenValues.has(node)) return;
      seenValues.add(node);
      if (Array.isArray(node)) return node.forEach(walkValues);
      if (typeof node.value === "string") bound.push(node.value);
      Object.values(node).forEach(walkValues);
    };
    walkValues(where);
    expect(bound).toContain("REJECTED");
    expect(bound).toContain("CANCELLED");
  });

  it("counts a resumed OPEN against TODAY's cap, not the day it was staged", async () => {
    // countMirrorsToday counts by created_at, so a row stranded PENDING before
    // midnight is invisible to every count taken after it. Without this check it
    // could place on top of a full day of fresh mirrors, putting the follower one
    // order over a cap that exists to bound what the mirror can do in a day.
    //
    // dailyCap + 1 so that excluding the resumed row still leaves a full day of
    // OTHER mirrors: the cap is genuinely reached by orders that are not this one.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      const poller = makePoller(
        existing,
        [],
        sink,
        undefined,
        {},
        guards.dailyCap + 1,
        undefined,
        undefined,
        [],
      );

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("daily-cap");
      expect(sink.placements).toBe(0);
      // applyPerpLeverage writes an ACCOUNT-WIDE, per-coin setting at the venue.
      // A refused resume must leave no trace there, or the follower's next
      // manual trade in this coin inherits leverage set for an order that never
      // placed.
      expect(sink.leverageCalls).toEqual([]);
    });
  });

  it("does not let a same-day resumed OPEN block itself on the cap", async () => {
    // The count ignores status, so a row stranded earlier TODAY is already
    // inside it. Counting it while deciding whether to re-place that same row
    // means the order holding the last slot reads the cap as full and is
    // refused, leaving the slot occupied by an order that never went out. A
    // resume is the same mirror finishing, not another one.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow();
      // Exactly at the cap, and the resumed row is one of those orders.
      const poller = makePoller(existing, [], sink, undefined, {}, guards.dailyCap);

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).not.toBe("daily-cap");
      expect(sink.placements).toBe(1);
    });
  });

  it("keeps a claim-held resume retryable without recording unprotected protection", async () => {
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({
        // Another worker owns the placement lease. The resume may inspect the
        // venue, but it must not annotate protection or attach anything from a
        // caller that never acquired the durable claim.
        syncReason: "copy-mirror:perp-placement:active-owner",
        lastSyncAttemptAt: new Date(),
      });
      const poller = makePoller(existing, [], sink);
      let notes = 0;
      let attaches = 0;
      (poller as any).notePerpProtectionUnattached = async () => { notes += 1; };
      (poller as any).attachPerpProtection = async () => { attaches += 1; };

      const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

      expect(outcome).toBe("syncing");
      expect(notes).toBe(0);
      expect(attaches).toBe(0);
      expect(sink.placements).toBe(0);
    });
  });

  it.each(["attached", "cancelled"] as const)(
    "does not mutate %s protection while a resume claim is held by another owner",
    async (protectionStatus) => {
      await withPerpEnv(async () => {
        const sink = freshSink();
        const protection = {
          copyMirrorProtectionIntent: true,
          takeProfitRoePct: 25,
          stopLossRoePct: 10,
          legClientOrderIds: ["copymirror:follower-perp:user:source-open:tpsl:tp:125"],
        };
        const existing = storedRow({
          perpProtectionStatus: protectionStatus,
          perpProtection: protection,
          syncReason: "copy-mirror:perp-placement:active-owner",
          lastSyncAttemptAt: new Date(),
        });
        const poller = makePoller(existing, [], sink);
        const outcome = await (poller as any).processPerpCandidate(candidate, existing, guards);

        expect(outcome).toBe("syncing");
        expect(existing.perpProtectionStatus).toBe(protectionStatus);
        expect(existing.perpProtection).toEqual(protection);
        expect(sink.placements).toBe(0);
      });
    },
  );

  it("does not apply the daily cap to a resumed CLOSE", async () => {
    // An exit is not new exposure, and a daily cap must never be the reason a
    // follower cannot get out of a leveraged position.
    await withPerpEnv(async () => {
      const sink = freshSink();
      const existing = storedRow({ reduceOnly: true, direction: "short", leverage: null });
      const poller = makePoller(
        existing,
        [{ coin: "BTC", side: "long", size: "1", leverage: 25, marginMode: "cross" }],
        sink,
        undefined,
        {},
        guards.dailyCap,
      );

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...candidate,
          perpSide: "short" as const,
          perpReduceOnly: true,
          sourceUserId: "source-user",
          sourceOrderId: "source-close",
          sourceOrderCreatedAt: new Date("2026-08-01T11:00:00.000Z").toISOString(),
        },
        existing,
        guards,
      );

      expect(outcome).not.toBe("daily-cap");
    });
  });

  it("resumes a reduce-only close without touching leverage", async () => {
    await withPerpEnv(async () => {
      const sink = { leverageCalls: [] as Array<Record<string, unknown>>, placements: 0 };
      const events: string[] = [];
      const position = { coin: "BTC", side: "long" as const, size: "1", leverage: 25, marginMode: "cross" as const };
      const existing = storedRow({ reduceOnly: true, direction: "short", leverage: null });
      const poller = makePoller(
        existing,
        [position],
        sink,
        undefined,
        {},
        0,
        LIVE_FOLLOW,
        [position],
        events,
      );

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...candidate,
          perpSide: "short" as const,
          perpReduceOnly: true,
          // Attribution inputs: a resume re-derives the mirrored exposure rather
          // than trusting the size frozen on the row.
          sourceUserId: "source-user",
          sourceOrderId: "source-close",
          sourceOrderCreatedAt: new Date("2026-08-01T11:00:00.000Z").toISOString(),
        },
        existing,
        guards,
      );

      // A close can only shrink a position, and a follower must never be blocked
      // from exiting because a leverage write conflicted with their open margin.
      expect(outcome).toBe("placed");
      expect(sink.leverageCalls).toEqual([]);
      expect(sink.placements).toBe(1);
      // The close still places its exit, but it never enters the open-policy
      // transaction or acquires the users-row lock.
      expect(events).toEqual(["place"]);
    });
  });
});

describe("perp Phase-C finalizer races", () => {
  it.each(["PARTIAL", "FILLED"])(
    "accepted finalization preserves a newer reconciler %s state",
    async (status) => {
      const race = makePerpFinalizerRaceDb(status);
      const poller = new CopyMirrorPoller(race.db as never);

      const result = await (poller as any).finalizePerpMirrorOrder(
        finalizerRacePrepared(),
        { kind: "accepted" },
        race.db,
      );

      expect(result).toEqual({ outcome: "placed" });
      expect(race.authoritative.status).toBe(status);
      // The stale finalizer attempted one guarded status transition only. It
      // must not follow a lost CAS with a blind placedAt/status write.
      expect(race.updates).toHaveLength(1);
      expect(race.updates[0]?.status).toEqual(expect.any(Object));
    },
  );

  it("accepted finalization rereads before any placedAt fallback after an update exception", async () => {
    const race = makePerpFinalizerRaceDb("FILLED", {
      throwOnUpdate: true,
      authoritativeStatuses: ["PENDING", "FILLED"],
    });
    const poller = new CopyMirrorPoller(race.db as never);

    const result = await (poller as any).finalizePerpMirrorOrder(
      finalizerRacePrepared(),
      { kind: "accepted" },
      race.db,
    );

    expect(result).toEqual({ outcome: "placed" });
    expect(race.authoritative.status).toBe("FILLED");
    // The exception path's fallback is itself PENDING-guarded. Once its CAS
    // loses, the second authoritative reread sees the terminal state and no
    // blind by-identity placedAt write is issued.
    expect(race.updates).toHaveLength(2);
  });

  it("ambiguous finalization does not stamp a terminal row after its metadata CAS throws", async () => {
    const race = makePerpFinalizerRaceDb("CANCELLED", {
      throwOnUpdate: true,
      authoritativeStatuses: ["PENDING", "CANCELLED"],
    });
    const poller = new CopyMirrorPoller(race.db as never);

    const result = await (poller as any).finalizePerpMirrorOrder(
      finalizerRacePrepared(),
      { kind: "ambiguous", error: new Error("venue timeout") },
      race.db,
    );

    expect(result).toEqual({ outcome: "rejected" });
    expect(race.authoritative.status).toBe("CANCELLED");
    // The ambiguous placedAt/lease stamp and its guarded fallback each fail;
    // the second authoritative reread then prevents any blind terminal-row
    // write.
    expect(race.updates).toHaveLength(2);
  });

  it("rejected finalization cannot regress a newer filled state", async () => {
    const race = makePerpFinalizerRaceDb("FILLED");
    const poller = new CopyMirrorPoller(race.db as never);

    const result = await (poller as any).finalizePerpMirrorOrder(
      finalizerRacePrepared(),
      { kind: "rejected", error: "venue rejected" },
      race.db,
    );

    expect(result).toEqual({ outcome: "placed" });
    expect(race.authoritative.status).toBe("FILLED");
    expect(race.updates).toHaveLength(1);
    expect(race.updates[0]?.status).toEqual(expect.any(Object));
  });

  it("reconcile annotation rereads and preserves a terminal state after its PENDING CAS loses", async () => {
    const race = makePerpFinalizerRaceDb("FILLED");
    const poller = new CopyMirrorPoller(race.db as never);

    const result = await (poller as any).finalizePerpMirrorOrder(
      finalizerRacePrepared(),
      { kind: "reconcile", reason: "reconcile", error: "cloid may already exist" },
      race.db,
    );

    expect(result).toEqual({ outcome: "placed" });
    expect(race.authoritative.status).toBe("FILLED");
    expect(race.updates).toHaveLength(1);
    expect(race.updates[0]?.notes).toContain("reconciliation");
  });

  it.each(["CANCELLED", "REJECTED", "EXPIRED"])(
    "rejected finalization preserves a newer terminal %s state without retry",
    async (status) => {
      const race = makePerpFinalizerRaceDb(status);
      const poller = new CopyMirrorPoller(race.db as never);

      const result = await (poller as any).finalizePerpMirrorOrder(
        finalizerRacePrepared(),
        { kind: "rejected", error: "venue rejected" },
        race.db,
      );

      expect(result).toEqual({ outcome: "rejected" });
      expect(race.authoritative.status).toBe(status);
      expect(race.updates).toHaveLength(1);
      expect(race.updates[0]?.status).toEqual(expect.any(Object));
    },
  );
});

/**
 * Consent and staleness at the point of execution.
 *
 * A staged delivery is durable and retried, so everything it carries is a
 * SNAPSHOT of what the follower wanted when it was discovered. These tests cover
 * the checks that stand between that snapshot and a real leveraged order.
 */
describe("processPerpCandidate consent and staleness", () => {
  const WALLET = "0x1111111111111111111111111111111111111111";
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

  const guards = {
    dailyCap: 20,
    maxOrderDollars: 1_000,
    perpsEnabled: true,
    mainnetAllowed: false,
    liveAllowed: false,
  };

  const openCandidate = {
    // withPerpEnv configures testnet, and preflight now requires the source
    // network to be PROVEN and to match, so the fixtures state it.
    sourceVenueNetwork: "testnet",
    followerUserId: "follower-perp",
    credentialId: CREDENTIAL_ID,
    followId: LIVE_FOLLOW.id,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:consent-open",
    symbol: "BTC",
    side: "buy" as const,
    sizingMode: "pct" as const,
    sizingValue: 50,
    assetType: "PERP" as const,
    perpSide: "long" as const,
    perpLeverage: 5,
    perpMarginMode: "cross" as const,
  };

  const closeCandidate = {
    // sourceVenueNetwork comes from openCandidate below.
    ...openCandidate,
    sourceItemId: "user:consent-close",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 500,
    perpSide: "short" as const,
    perpReduceOnly: true,
    sourceQtyDecimal: "10.12345678",
    sourcePositionSizeDecimal: "10.12345678",
    mirroredExposureSizeDecimal: "0.25",
  };

  function makeDb(
    follow: unknown = LIVE_FOLLOW,
    extras: {
      queuedDeliveries?: unknown[];
      syncingOrders?: unknown[];
      onFollowRead?: () => void;
    } = {},
  ) {
    return {
      query: {
        userApiCredentials: {
          findFirst: async () => ({
            id: CREDENTIAL_ID,
            provider: "hyperliquid",
            accountType: "LIVE",
          }),
        },
        copyTradeFollows: {
          findFirst: async () => {
            extras.onFollowRead?.();
            return follow;
          },
        },
        copyMirrorDeliveries: { findMany: async () => extras.queuedDeliveries ?? [] },
        orders: {
          findFirst: async () => undefined,
          // Orders behind "syncing" deliveries. Empty means none landed locally,
          // which the ambiguity check treats as still-unresolved (fail closed).
          findMany: async () => extras.syncingOrders ?? [],
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            // The production INSERT returning row carries the Phase-A
            // leverage that the pre-venue durable-floor check rereads.
            returning: async () => [{ id: "consent-local", leverage: 1, status: "PENDING" }],
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
    } as never;
  }

  function makeClient(
    sink: { placements: number; abstractionReads: number; migrations: number },
    options: {
      abstraction?: string;
      positions?: ReadonlyArray<Record<string, unknown>>;
      // Which dexes the position read actually covered. Defaults to main plus
      // "xyz" so the HIP-3 cases here exercise their own subject rather than
      // being refused by the coverage guard.
      coveredDexes?: readonly string[];
    } = {},
  ) {
    return (async () => ({
      walletAddress: WALLET,
      client: {
        resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 50, isolatedOnly: false }),
        allMids: async () => ({ BTC: "100", "xyz:GOOGL": "100" }),
        perpAccountSnapshot: async () => ({
          coveredDexes: options.coveredDexes ?? ["", "xyz"],
          positions: options.positions ?? [],
          crossMargin: { accountValueUsd: "10000", totalMarginUsedUsd: "9000" },
        }),
        // Sizing reads collateral through perpCollateral now. Derived from this
        // case's own crossMargin fixture so its intent is unchanged.
        perpCollateral: async () => ({
          freeUsd: "1000",
          accountValueUsd: "10000",
          source: "perp-cross-margin",
        }),
        listPositions: async () => options.positions ?? [],
        userAbstraction: async () => {
          sink.abstractionReads += 1;
          return options.abstraction ?? "default";
        },
        ensureDexAbstraction: async () => {
          sink.migrations += 1;
        },
        updateLeverage: async () => ({ status: "ok" }),
        placeOrder: async () => {
          sink.placements += 1;
          return { status: "ok" };
        },
      },
    })) as never;
  }

  function newSink() {
    return { placements: 0, abstractionReads: 0, migrations: 0 };
  }

  async function withPerpEnv<T>(
    run: () => Promise<T>,
    env: Record<string, string> = {},
  ): Promise<T> {
    const keys = [
      "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
      // Precondition, not an extra: perp mirroring is refused without it.
      "HYPERLIQUID_SYNC_ENABLED",
      "HYPERLIQUID_NETWORK",
      "HYPERLIQUID_ALLOW_TESTNET",
      "COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET",
      "COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const applied: Record<string, string> = {
      COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
      HYPERLIQUID_SYNC_ENABLED: "true",
      HYPERLIQUID_NETWORK: "testnet",
      HYPERLIQUID_ALLOW_TESTNET: "true",
      ...env,
    };
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(applied)) process.env[key] = value;
    try {
      return await run();
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("stops an order whose follow has since turned auto-mirror off", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(
        makeDb({ ...LIVE_FOLLOW, autoMirror: false, perpAutoMirror: false }),
        {
        createPerpClient: makeClient(sink),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        openCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("consent-withdrawn");
      expect(sink.placements).toBe(0);
    });
  });

  it("stops an order whose follow has since been deleted", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(null), {
        createPerpClient: makeClient(sink),
      });

      const outcome = await (poller as any).processPerpCandidate(
        openCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("consent-withdrawn");
      expect(sink.placements).toBe(0);
    });
  });

  it("stops an order whose follow now points at a different destination account", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(
        makeDb({
          ...LIVE_FOLLOW,
          credentialId: "99999999-9999-4999-8999-999999999999",
          perpCredentialId: "99999999-9999-4999-8999-999999999999",
        }),
        { createPerpClient: makeClient(sink) },
      );

      const outcome = await (poller as any).processPerpCandidate(
        openCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("consent-withdrawn");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses a delivery that cannot be tied back to a follow row at all", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink),
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, followId: undefined },
        undefined,
        guards,
      );

      expect(outcome).toBe("consent-unverifiable");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses an OPEN whose source trade is hours old", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink),
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...openCandidate,
          sourceEventAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        },
        undefined,
        guards,
      );

      expect(outcome).toBe("stale-intent");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses an OPEN whose age cannot be established rather than assuming it is fresh", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink),
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, sourceEventAt: undefined },
        undefined,
        guards,
      );

      expect(outcome).toBe("stale-intent");
      expect(sink.placements).toBe(0);
    });
  });

  it("still places a late CLOSE, because refusing it would strand the follower in the position", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink, {
          positions: [
            { coin: "BTC", side: "long", size: "0.25", leverage: 3, marginMode: "cross" },
          ],
        }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...closeCandidate,
          sourceEventAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
    });
  });

  it("still closes a position the mirror opened after the follower turned auto-mirror off", async () => {
    // Withdrawing consent stops NEW exposure. It must never abandon exposure
    // the mirror already created: gating the close here leaves the follower
    // holding a leveraged position with its only exit instruction consumed.
    await withPerpEnv(async () => {
      const sink = newSink();
      let followReads = 0;
      const poller = new CopyMirrorPoller(
        makeDb({ ...LIVE_FOLLOW, autoMirror: false, perpAutoMirror: false }, {
          onFollowRead: () => {
            followReads += 1;
          },
        }),
        {
          createPerpClient: makeClient(sink, {
            positions: [
              { coin: "BTC", side: "long", size: "0.25", leverage: 3, marginMode: "cross" },
            ],
          }),
        },
      );

      const outcome = await (poller as any).processPerpCandidate(
        closeCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
      // The follow row is not even read for a close: there is no consent
      // question a reduce-only order could fail.
      expect(followReads).toBe(0);
    });
  });

  it("still closes after the follow was deleted or re-pointed at another account", async () => {
    await withPerpEnv(async () => {
      for (const follow of [
        null,
        {
          ...LIVE_FOLLOW,
          credentialId: "99999999-9999-4999-8999-999999999999",
          perpCredentialId: "99999999-9999-4999-8999-999999999999",
        },
      ]) {
        const sink = newSink();
        const poller = new CopyMirrorPoller(makeDb(follow), {
          createPerpClient: makeClient(sink, {
            positions: [
              { coin: "BTC", side: "long", size: "0.25", leverage: 3, marginMode: "cross" },
            ],
          }),
        });

        const outcome = await (poller as any).processPerpCandidate(
          closeCandidate,
          undefined,
          guards,
        );

        expect(outcome).toBe("placed");
        expect(sink.placements).toBe(1);
      }
    });
  });

  it("consumes a close without a credential when no mirrored perp history exists", async () => {
    // A stock-only follow may observe a source perp close even though this
    // follower never opened a mirrored perp. Do not require an active HL agent
    // or retry forever when our durable order history proves there is no
    // attributable position to close.
    const poller = new CopyMirrorPoller({
      query: {
        orders: { findFirst: async () => undefined, findMany: async () => [] },
        userApiCredentials: { findFirst: async () => undefined },
      },
    } as never);

    await withPerpEnv(async () => {
      await expect(
        (poller as any).processPerpCandidate(
          {
            followerUserId: "follower-perp",
            sourceItemId: "user:orphaned-close",
            symbol: "BTC",
            side: "sell",
            sizingMode: "usd",
            sizingValue: 100,
            assetType: "PERP",
            perpSide: "short",
            perpReduceOnly: true,
            sourceQtyDecimal: "0.5",
          },
          undefined,
          {
            dailyCap: 20,
            maxOrderDollars: 1_000,
            perpsEnabled: true,
            mainnetAllowed: true,
            liveAllowed: true,
          },
        ),
      ).resolves.toBe("no-position");
    });
  });

  it("routes a close to the credential that received the open, not the follow's current one", async () => {
    // A follow is mutable: repointed to another Hyperliquid account, switched to
    // Alpaca, reprovisioned. The open is not. Routing the exit by the follow
    // sends it at an account holding no such position, and
    // missing-hyperliquid-account is a skip, so the exit would be consumed while
    // the original leveraged position stayed open.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            { brokerCredentialId: "cred-that-holds-the-position", brokerAccountId: WALLET, reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" },
          ],
        },
      },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({
      credentialId: "cred-that-holds-the-position",
      ambiguous: false,
      accounts: [WALLET],
    });
  });

  it("falls back to the follow's credential when no mirrored open is on file", async () => {
    const poller = new CopyMirrorPoller({
      query: { orders: { findMany: async () => [] } },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({
      credentialId: null,
      ambiguous: false,
      accounts: [],
      hasMirrorHistory: false,
    });
  });

  it("ignores attempts that never held exposure when deciding account agreement", async () => {
    // A rejected wallet-A attempt put nothing on any wallet. Counting it made
    // the account sets disagree with a filled wallet-B open, and every close for
    // the real B exposure then held forever. Refusing to route is the safe
    // answer to a genuine conflict, not to a failed attempt.
    let where: unknown;
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async (args: any) => {
            where = args.where;
            // The query itself excludes the rejected row, so the DB returns only
            // the wallet-B open.
            return [{ brokerCredentialId: "wallet-b-cred", brokerAccountId: "0xbbbb", reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" }];
          },
        },
      },
    } as never);

    const result = await (poller as any).mirroredExposureCredentialId({
      followerUserId: "follower-perp",
      symbol: "BTC",
    });
    expect(result).toEqual({
      credentialId: "wallet-b-cred",
      ambiguous: false,
      accounts: ["0xbbbb"],
    });

    // Pin the exclusion in the query rather than trusting the mock's return: a
    // recorded fill of any status, or a row that has not settled yet.
    // These values sit inside an `or` nested in the `and`, deeper than the other
    // walkers here reach. The drizzle graph is cyclic, so depth alone is not a
    // safe bound: a seen-set is what makes the deeper walk terminate.
    const bound: string[] = [];
    const seen = new WeakSet<object>();
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.value === "string") bound.push(node.value);
      Object.values(node).forEach(walk);
    };
    walk(where);
    expect(bound).toContain("0");
    expect(bound).toContain("PENDING");
    expect(bound).toContain("SUBMITTED");
    expect(bound).toContain("PARTIAL");
  });

  it("ignores an account whose mirrored exposure has been fully closed", async () => {
    // An opening row keeps its executed size forever, so a coin the follower
    // opened and then fully closed on wallet A would otherwise look active for
    // the rest of time. A later wallet-B mirror then reads as a two-account
    // conflict and every close for the real B position holds forever.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            // Wallet A: opened 1, closed 1. Flat.
            {
              brokerCredentialId: "wallet-a-cred",
              brokerAccountId: "0xaaaa",
              reduceOnly: false,
              executedSizeDecimal: "1",
              status: "FILLED",
            },
            {
              brokerCredentialId: "wallet-a-cred",
              brokerAccountId: "0xaaaa",
              reduceOnly: true,
              executedSizeDecimal: "1",
              status: "FILLED",
            },
            // Wallet B: the live one.
            {
              brokerCredentialId: "wallet-b-cred",
              brokerAccountId: "0xbbbb",
              reduceOnly: false,
              executedSizeDecimal: "2",
              status: "FILLED",
            },
          ],
        },
      },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({ credentialId: "wallet-b-cred", ambiguous: false, accounts: ["0xbbbb"] });
  });

  it("treats one wallet stored in two casings as one account", async () => {
    // Addresses are validated case-insensitively at enablement, so the same
    // wallet can be persisted checksummed on one row and lowercase on another.
    // Exact-string grouping split it into two accounts, read as a conflict, and
    // held every close for a position that lives on a single Hyperliquid
    // account.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            {
              brokerCredentialId: "same-cred",
              brokerAccountId: "0xAbCdEf0000000000000000000000000000000001",
              reduceOnly: false,
              executedSizeDecimal: "1",
              status: "FILLED",
            },
            {
              brokerCredentialId: "same-cred",
              brokerAccountId: "0xabcdef0000000000000000000000000000000001",
              reduceOnly: false,
              executedSizeDecimal: "1",
              status: "FILLED",
            },
          ],
        },
      },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({
      credentialId: "same-cred",
      ambiguous: false,
      accounts: ["0xabcdef0000000000000000000000000000000001"],
    });
  });

  it("nets FRACTIONAL opens and closes exactly, without float residue", async () => {
    // 0.1 + 0.2 - 0.3 is 2.8e-17 in IEEE-754, which is greater than zero, so a
    // flat wallet A would read as active forever and wedge every later close on
    // wallet B. Perp sizes are decimal strings and have to be netted as such.
    const row = (account: string, reduceOnly: boolean, size: string) => ({
      brokerCredentialId: `${account}-cred`,
      brokerAccountId: account,
      reduceOnly,
      executedSizeDecimal: size,
      status: "FILLED",
    });
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          // Newest first, as the real query orders them.
          findMany: async () => [
            row("0xbbbb", false, "2"),
            row("0xaaaa", true, "0.3"),
            row("0xaaaa", false, "0.2"),
            row("0xaaaa", false, "0.1"),
          ],
        },
      },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({ credentialId: "0xbbbb-cred", ambiguous: false, accounts: ["0xbbbb"] });
  });

  it("still counts an account holding an UNSETTLED row, even with no recorded fill", async () => {
    // Netting to zero is not proof of flat when a row has not settled: the venue
    // may hold a position we have not recorded yet.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            {
              brokerCredentialId: "wallet-a-cred",
              brokerAccountId: "0xaaaa",
              reduceOnly: false,
              executedSizeDecimal: null,
              status: "SUBMITTED",
            },
            {
              brokerCredentialId: "wallet-b-cred",
              brokerAccountId: "0xbbbb",
              reduceOnly: false,
              executedSizeDecimal: "2",
              status: "FILLED",
            },
          ],
        },
      },
    } as never);

    expect(
      (await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      })).ambiguous,
    ).toBe(true);
  });

  it("sees a DELETED opening credential through its broker account", async () => {
    // Deleting a connection nulls brokerCredentialId through the foreign key, so
    // the credential set alone holds one value here and would route confidently
    // at wallet B. brokerAccountId is the wallet address rather than a foreign
    // key, survives the delete, and makes the disagreement visible.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            { brokerCredentialId: "wallet-b-cred", brokerAccountId: "0xbbbb", reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" },
            { brokerCredentialId: null, brokerAccountId: "0xaaaa", reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" },
          ],
        },
      },
    } as never);

    expect(
      (await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      })).ambiguous,
    ).toBe(true);
  });

  it("refuses to pick an account when the coin's mirrored opens span two of them", async () => {
    // Open BTC on wallet A, disconnect, reconnect as wallet B, and have another
    // BTC mirror land there. Taking the newest row routes the close for A's
    // exposure at B, where it reduces an unrelated position and leaves A's open.
    // Correlating a close to its specific opening exposure needs the durable
    // record, so disagreement is unanswerable here rather than guessed.
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findMany: async () => [
            { brokerCredentialId: "wallet-b", brokerAccountId: "0xbbbb", reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" },
            { brokerCredentialId: "wallet-a", brokerAccountId: "0xaaaa", reduceOnly: false, executedSizeDecimal: "1", status: "FILLED" },
          ],
        },
      },
    } as never);

    expect(
      await (poller as any).mirroredExposureCredentialId({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toEqual({ credentialId: null, ambiguous: true, accounts: ["0xbbbb", "0xaaaa"] });
  });

  it("holds a close while a mirrored open in the coin has not settled", async () => {
    // An unsettled open may already hold a position the venue has not reported
    // yet, so consuming the close against a stale "no position" would leave
    // nothing to exit that exposure. Asked of the ORDERS now: a "placed"
    // delivery whose order is still SUBMITTED is exactly this case.
    const queries: Array<Record<string, unknown>> = [];
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findFirst: async (args: any) => {
            queries.push(args);
            return { id: "unsettled-open" };
          },
        },
      },
    } as never);

    expect(
      await (poller as any).pairedOpenOutcomeAmbiguous({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toBe(true);
    // One narrow query, not a follower-wide all-time delivery scan. That scan
    // never drained, so past its cap every later close for the follower held
    // forever, which is a wedge rather than a guard.
    expect(queries).toHaveLength(1);
  });

  it("does not hold a close once every mirrored open in the coin has settled", async () => {
    const poller = new CopyMirrorPoller({
      query: { orders: { findFirst: async () => undefined } },
    } as never);

    expect(
      await (poller as any).pairedOpenOutcomeAmbiguous({
        followerUserId: "follower-perp",
        symbol: "BTC",
      }),
    ).toBe(false);
  });

  it("asks only about unsettled, non-reduce-only mirror orders in THIS coin", async () => {
    // The bound values are the contract: another coin or a settled order must
    // not hold this close. (The LIKE prefix binds its parameter in a shape this
    // walker does not reach, so the coin and the unsettled statuses are what is
    // asserted here.)
    let where: unknown;
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findFirst: async (args: any) => {
            where = args.where;
            return undefined;
          },
        },
      },
    } as never);
    await (poller as any).pairedOpenOutcomeAmbiguous({
      followerUserId: "follower-perp",
      symbol: "BTC",
    });

    const bound: string[] = [];
    const walk = (node: any, depth = 0) => {
      if (depth > 10 || !node) return;
      if (Array.isArray(node)) return node.forEach((c) => walk(c, depth + 1));
      if (typeof node === "object") {
        if (typeof node.value === "string") bound.push(node.value);
        Object.values(node).forEach((c) => walk(c, depth + 1));
      }
    };
    walk(where);

    expect(bound).toContain("BTC");
    expect(bound).toContain("PENDING");
    // And scoped to the active network: a testnet row is not reconciled while
    // mainnet is configured, so it can never settle and would otherwise hold
    // every mainnet close forever.
    expect(bound).toContain("mainnet");
    expect(bound).toContain("SUBMITTED");
    expect(bound).toContain("PARTIAL");
  });

  it("does not consume a close that found no position while its open is still queued", async () => {
    // The open sorted first and THREW, so it is back in the queue. Marking this
    // close completed would spend the only instruction that ever exits the
    // position the open's retry is about to create.
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(
        makeDb(LIVE_FOLLOW, {
          queuedDeliveries: [
            {
              sourceItemId: "user:consent-open",
              followerUserId: "follower-perp",
              candidate: {
                sourceItemId: "user:consent-open",
                followerUserId: "follower-perp",
                symbol: "BTC",
                assetType: "PERP",
                sourceEventAt: new Date(Date.now() - 30_000).toISOString(),
                perpReduceOnly: false,
              },
            },
          ],
        }),
        { createPerpClient: makeClient(sink, { positions: [] }) },
      );

      await expect(
        (poller as any).processPerpCandidate(closeCandidate, undefined, guards),
      ).rejects.toThrow("perp close held back");
      expect(sink.placements).toBe(0);
    });
  });

  it("consumes a close that found no position once nothing is queued behind it", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(LIVE_FOLLOW, { queuedDeliveries: [] }), {
        createPerpClient: makeClient(sink, { positions: [] }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        closeCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("no-position");
      expect(sink.placements).toBe(0);
    });
  });

  it("places a HIP-3 close even when the account is not in a shared-collateral mode", async () => {
    // THIS ASSERTION WAS INVERTED ON PURPOSE. It previously expected the close
    // to be held back with "dex-abstraction-required", and its comment argued
    // that deferring beat returning because returning completes the one-shot
    // delivery, so a follower who enabled the mode later could never retry the
    // exit. The first half of that reasoning is right and still holds. The
    // conclusion was not: `deferClose` throws EAGAIN every cycle, so a follower
    // who never migrates has the exit requeued forever and the position is
    // stranded just the same, only silently.
    //
    // The gate does not belong on this path at all. `perpDexModeReady` answers
    // "which ledger funds this order", which only an OPEN needs to know. A
    // reduce-only close commits no collateral, and Hyperliquid independently
    // rejects any reduce-only order that would increase the position, so the
    // venue is the backstop. Both original escape hatches (the position
    // predates the guard, or the follower switched modes) now simply exit.
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(LIVE_FOLLOW, { queuedDeliveries: [] }), {
        createPerpClient: makeClient(sink, {
          positions: [
            { coin: "xyz:GOOGL", side: "long", size: "1", leverage: 3, marginMode: "cross" },
          ],
          abstraction: "standard",
        }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...closeCandidate, symbol: "xyz:GOOGL" },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.placements).toBe(1);
    });
  });

  it("holds a HIP-3 close when the position read never covered that dex", async () => {
    // perpAccountSnapshot swallows HIP-3 discovery and per-dex clearinghouse
    // failures on purpose, so slow metadata cannot hold up ordinary positions.
    // That makes an absent HIP-3 position ambiguous: flat, or never read. Read
    // as flat, the close decides no-position and spends the follower's only
    // exit on a position that is still open.
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(LIVE_FOLLOW, { queuedDeliveries: [] }), {
        // Main dex only: the "xyz" read failed or was never discovered.
        createPerpClient: makeClient(sink, { positions: [], coveredDexes: [""] }),
      });

      await expect(
        (poller as any).processPerpCandidate(
          { ...closeCandidate, symbol: "xyz:GOOGL" },
          undefined,
          guards,
        ),
      ).rejects.toThrow("did not cover this dex");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses a HIP-3 OPEN on an uncovered dex rather than deferring it", async () => {
    // The position guard cannot say whether this would net against or rewrite an
    // existing position without having read the market. Withholding new exposure
    // costs nothing, so an open skips where a close holds.
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink, { positions: [], coveredDexes: [""], abstraction: "unifiedAccount" }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        {
          ...closeCandidate,
          symbol: "xyz:GOOGL",
          perpReduceOnly: false,
          side: "buy" as const,
          perpSide: "long" as const,
          sourceEventAt: new Date().toISOString(),
        },
        undefined,
        guards,
      );

      expect(outcome).toBe("position-unreadable");
      expect(sink.placements).toBe(0);
    });
  });

  it("refuses to migrate the follower's account mode and skips the HIP-3 mirror instead", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink, { abstraction: "default" }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, symbol: "xyz:GOOGL" },
        undefined,
        guards,
      );

      expect(outcome).toBe("dex-abstraction-required");
      // The mode was READ, never written. A migration here would re-base the
      // follower's collateral and change what later mirrors are sized against.
      expect(sink.abstractionReads).toBe(1);
      expect(sink.migrations).toBe(0);
      expect(sink.placements).toBe(0);
    });
  });

  it("mirrors a HIP-3 market normally once the follower has migrated themselves", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink, { abstraction: "unifiedAccount" }),
      });

      const outcome = await (poller as any).processPerpCandidate(
        { ...openCandidate, symbol: "xyz:GOOGL" },
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.migrations).toBe(0);
      expect(sink.placements).toBe(1);
    });
  });

  it("never asks about the account mode for a main-DEX coin", async () => {
    await withPerpEnv(async () => {
      const sink = newSink();
      const poller = new CopyMirrorPoller(makeDb(), {
        createPerpClient: makeClient(sink),
      });

      const outcome = await (poller as any).processPerpCandidate(
        openCandidate,
        undefined,
        guards,
      );

      expect(outcome).toBe("placed");
      expect(sink.abstractionReads).toBe(0);
    });
  });

  it("refuses a staged perp delivery when the Hyperliquid reconciler is off", async () => {
    // The delivery was staged while everything looked fine; the reconciler is
    // off NOW. Placing anyway would open leveraged exposure that nothing sizes
    // and nothing ever resolves, so the precondition is re-checked per candidate
    // and no venue client is even constructed.
    await withPerpEnv(
      async () => {
        let clientCreations = 0;
        const poller = new CopyMirrorPoller(makeDb(), {
          createPerpClient: (async () => {
            clientCreations += 1;
            throw new Error("must not create a perp client");
          }) as never,
        });

        const outcome = await (poller as any).processPerpCandidate(
          openCandidate,
          undefined,
          guards,
        );

        // NOT "perps-disabled": the operator did set the perps flag, and a
        // refusal that named the wrong variable would send them nowhere useful.
        expect(outcome).toBe("perps-sync-disabled");
        expect(clientCreations).toBe(0);
      },
      { HYPERLIQUID_SYNC_ENABLED: "false" },
    );
  });

  it("refuses a Hyperliquid MAINNET mirror while the paper-first live gate is off", async () => {
    await withPerpEnv(
      async () => {
        let clientCreations = 0;
        const poller = new CopyMirrorPoller(makeDb(), {
          createPerpClient: (async () => {
            clientCreations += 1;
            throw new Error("must not create a perp client");
          }) as never,
        });

        const outcome = await (poller as any).processPerpCandidate(
          { ...openCandidate, sourceVenueNetwork: "mainnet" },
          undefined,
          { ...guards, mainnetAllowed: true, liveAllowed: false },
        );

        expect(outcome).toBe("live-not-allowed");
        expect(clientCreations).toBe(0);
      },
      {
        HYPERLIQUID_NETWORK: "mainnet",
        COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      },
    );
  });

  it("allows a Hyperliquid MAINNET mirror once the live gate is explicitly on", async () => {
    await withPerpEnv(
      async () => {
        const sink = newSink();
        const poller = new CopyMirrorPoller(makeDb(), {
          createPerpClient: makeClient(sink),
        });

        const outcome = await (poller as any).processPerpCandidate(
          { ...openCandidate, sourceVenueNetwork: "mainnet" },
          undefined,
          { ...guards, mainnetAllowed: true, liveAllowed: true },
        );

        expect(outcome).toBe("placed");
        expect(sink.placements).toBe(1);
      },
      {
        HYPERLIQUID_NETWORK: "mainnet",
        COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      },
    );
  });
});

describe("Task 4 durable perp candidate snapshots", () => {
  function capturingPoller() {
    const staged: Array<Record<string, unknown>> = [];
    const tx = {
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => {
          staged.push(...rows);
          return { onConflictDoNothing: async () => undefined };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ consumer: "copy-mirror-v1" }] }),
        }),
      }),
    };
    const poller = new CopyMirrorPoller({
      transaction: async (run: (t: typeof tx) => Promise<void>) => run(tx),
    } as never);
    return { poller, staged };
  }

  it("serializes both leverage policy snapshots without changing candidate identity fields", async () => {
    const { poller, staged } = capturingPoller();
    const sourceItemId = "user:durable-policy-open";
    const candidate = {
      followerUserId: "follower-policy",
      credentialId: "00000000-0000-4000-8000-000000000501",
      sourceItemId,
      symbol: "BTC",
      side: "buy" as const,
      sizingMode: "usd" as const,
      sizingValue: 100,
      assetType: "PERP" as const,
      perpLeverage: 11,
      perpUserMaxLeverage: 7,
      perpFollowMaxLeverage: 3,
    };

    await (poller as any).stageWindow(
      new Date("2026-08-29T00:00:00.000Z"),
      new Date("2026-08-29T00:01:00.000Z"),
      [candidate],
    );

    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      followerUserId: candidate.followerUserId,
      sourceItemId,
      candidate: {
        perpLeverage: 11,
        perpUserMaxLeverage: 7,
        perpFollowMaxLeverage: 3,
      },
    });
  });

  it("keeps a legacy candidate's absent global snapshot absent so policy resolution fails down to 1x", async () => {
    const { poller, staged } = capturingPoller();
    const legacyCandidate = {
      followerUserId: "follower-policy",
      credentialId: "00000000-0000-4000-8000-000000000502",
      sourceItemId: "user:legacy-policy-open",
      symbol: "BTC",
      side: "buy" as const,
      sizingMode: "usd" as const,
      sizingValue: 100,
      assetType: "PERP" as const,
      perpLeverage: 20,
      perpFollowMaxLeverage: null,
    };

    await (poller as any).stageWindow(
      new Date("2026-08-29T00:00:00.000Z"),
      new Date("2026-08-29T00:01:00.000Z"),
      [legacyCandidate],
    );

    const frozen = staged[0]!.candidate as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(frozen, "perpUserMaxLeverage")).toBe(false);
    expect(resolveEffectivePerpLeverage({
      sourceLeverage: frozen.perpLeverage,
      stagedUserMaxLeverage: frozen.perpUserMaxLeverage,
      stagedFollowMaxLeverage: frozen.perpFollowMaxLeverage,
      currentUserMaxLeverage: 8,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: 50,
    })).toBe(1);
  });
});

/**
 * Consent and staleness on the ALPACA path, at the point of execution.
 *
 * The same rules as "processPerpCandidate consent and staleness" above, for the
 * same reason: the equity branch also runs off a candidate payload frozen at
 * discovery, and the delivery queue that carries it is durable and retried. For
 * a long time only perps were protected, so turning auto-mirror off, switching
 * the destination account or unfollowing outright did not stop a stock or option
 * order that was already staged. This block is deliberately shaped like the perp
 * one so the two paths stay comparable.
 */
describe("processCandidate consent and staleness (Alpaca path)", () => {
  const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_CREDENTIAL_ID = "99999999-9999-4999-8999-999999999999";

  /** The live follow row the equity path now re-reads before placing. */
  const EQUITY_FOLLOW = {
    id: "55555555-5555-4555-8555-555555555555",
    followerUserId: "follower-equity",
    autoMirror: true,
    credentialId: CREDENTIAL_ID,
    destinationPolicyInitialized: true,
    stockAutoMirror: true,
    stockCredentialId: CREDENTIAL_ID,
    stockSizingMode: "usd",
    stockSizingValue: "500",
    perpAutoMirror: true,
    perpCredentialId: CREDENTIAL_ID,
    perpSizingMode: "usd",
    perpSizingValue: "500",
  };

  const guards = {
    dailyCap: 20,
    maxOrderDollars: 1_000,
    perpsEnabled: false,
    mainnetAllowed: false,
    liveAllowed: false,
  };

  const openCandidate = {
    followerUserId: "follower-equity",
    credentialId: CREDENTIAL_ID,
    followId: EQUITY_FOLLOW.id,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:equity-consent-open",
    symbol: "AAPL",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 500,
    assetType: "EQUITY" as const,
    tradeAction: "Buy" as const,
  };

  /**
   * The equity equivalent of a reduce-only perp close: a mirrored SELL, which
   * the sizing path clamps to the follower's real long and skips entirely when
   * there is none, so it can only ever shrink a holding.
   */
  const sellCandidate = {
    ...openCandidate,
    sourceItemId: "user:equity-consent-sell",
    side: "sell" as const,
    tradeAction: "Sell" as const,
  };

  interface DbState {
    credentialReads: number;
    followReads: number;
  }

  function newState(): DbState {
    return { credentialReads: 0, followReads: 0 };
  }

  /**
   * The credential lookup answers the destination check on its FIRST read and
   * then deliberately runs out, because the second read is the one inside
   * `getDecryptedCredentials`. So nothing here can reach Alpaca, and the two
   * outcomes are unambiguous: a candidate the gate stops RETURNS a skip reason
   * with exactly one credential read, and a candidate the gate lets through
   * THROWS out of credential resolution instead.
   */
  function makeDb(follow: unknown, state: DbState) {
    return {
      query: {
        orders: { findFirst: async () => undefined, findMany: async () => [] },
        userApiCredentials: {
          findFirst: async () => {
            state.credentialReads += 1;
            return state.credentialReads === 1
              ? { id: CREDENTIAL_ID, provider: "alpaca" }
              : undefined;
          },
        },
        copyTradeFollows: {
          findFirst: async () => {
            state.followReads += 1;
            return follow;
          },
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
    } as never;
  }

  function run(candidate: Record<string, unknown>, follow: unknown, state: DbState) {
    const poller = new CopyMirrorPoller(makeDb(follow, state));
    return (poller as any).processCandidate(candidate, guards) as Promise<string>;
  }

  /** The marker that a candidate got PAST the gate: see makeDb. */
  const PAST_THE_GATE = "Credentials not found";

  /**
   * Own the credential step for this block instead of inheriting it.
   *
   * The marker above is what the REAL `getDecryptedCredentials` throws once the
   * db stub runs out of rows, and it is the only thing separating "the gate let
   * this through" from "the gate stopped it". `bun test` runs every file in one
   * process and `mock.module` is process-wide, so another suite that replaces
   * this module (apps/api/src/__tests__/alpaca-live-credentials.test.ts does)
   * silently turns the marker into a different error and these cases fail for a
   * reason that has nothing to do with consent. Stubbing it here makes the
   * boundary explicit and the result independent of which files ran first; the
   * previous module is put back afterwards so nothing downstream inherits this.
   */
  const CREDENTIALS_MODULE = "../../../../api/src/lib/credentials";
  let ambientCredentials: Record<string, unknown> = {};

  beforeAll(async () => {
    ambientCredentials = { ...(await import(CREDENTIALS_MODULE)) };
    mock.module(CREDENTIALS_MODULE, () => ({
      ...ambientCredentials,
      getDecryptedCredentials: async () => {
        throw new Error(PAST_THE_GATE);
      },
    }));
  });

  afterAll(() => {
    mock.module(CREDENTIALS_MODULE, () => ambientCredentials);
  });

  async function withEquityEnv<T>(
    env: Record<string, string>,
    body: () => Promise<T>,
  ): Promise<T> {
    const keys = [
      "COPY_TRADE_AUTOMIRROR_EQUITY_MAX_INTENT_AGE_MS",
      "COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    try {
      return await body();
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("lets a fresh OPEN whose follow still says yes through the gate", async () => {
    // The other half of every refusal below: a gate that stopped everything
    // would pass those tests for the wrong reason.
    const state = newState();

    await expect(run(openCandidate, EQUITY_FOLLOW, state)).rejects.toThrow(PAST_THE_GATE);
    // Read from the DATABASE, not taken from the frozen candidate payload.
    expect(state.followReads).toBe(1);
  });

  it("stops an OPEN whose follow has since turned auto-mirror off", async () => {
    const state = newState();

    const outcome = await run(
      openCandidate,
      { ...EQUITY_FOLLOW, autoMirror: false, stockAutoMirror: false },
      state,
    );

    expect(outcome).toBe("consent-withdrawn");
    // One read is the destination check. A second would be the decryption the
    // refusal exists to prevent.
    expect(state.credentialReads).toBe(1);
  });

  it("stops an OPEN whose follow has since been deleted", async () => {
    const state = newState();

    const outcome = await run(openCandidate, null, state);

    expect(outcome).toBe("consent-withdrawn");
    expect(state.credentialReads).toBe(1);
  });

  it("stops an OPEN whose follow now points at a different destination account", async () => {
    const state = newState();

    const outcome = await run(
      openCandidate,
      {
        ...EQUITY_FOLLOW,
        credentialId: OTHER_CREDENTIAL_ID,
        stockCredentialId: OTHER_CREDENTIAL_ID,
      },
      state,
    );

    expect(outcome).toBe("consent-withdrawn");
    expect(state.credentialReads).toBe(1);
  });

  it("does not degrade short equity actions into ordinary SELL/BUY mirrors", async () => {
    for (const action of [
      { tradeAction: "SellShort", side: "sell" },
      { tradeAction: "BuyToCover", side: "buy" },
    ] as const) {
      const state = newState();
      const outcome = await run(
        { ...openCandidate, sourceItemId: `user:${action.tradeAction}`, ...action },
        EQUITY_FOLLOW,
        state,
      );
      expect(outcome).toBe("unsupported-trade-action");
      // Unsupported intent is rejected before credential decryption or broker
      // reads, so it cannot silently become an ordinary action.
      expect(state.credentialReads).toBe(0);
      expect(state.followReads).toBe(0);
    }
  });

  it("does not degrade unsupported option open/close intent", async () => {
    for (const action of [
      { tradeAction: "SellToOpen", side: "sell" },
      { tradeAction: "BuyToClose", side: "buy" },
    ] as const) {
      const state = newState();
      const outcome = await run(
        {
          ...openCandidate,
          sourceItemId: `user:${action.tradeAction}`,
          assetType: "OPTION",
          optionExpiration: "260918",
          optionStrike: 250,
          optionType: "CALL",
          ...action,
        },
        EQUITY_FOLLOW,
        state,
      );
      expect(outcome).toBe("unsupported-trade-action");
      expect(state.credentialReads).toBe(0);
    }
  });

  it("refuses a delivery that cannot be tied back to a follow row at all", async () => {
    const state = newState();

    const outcome = await run({ ...openCandidate, followId: undefined }, EQUITY_FOLLOW, state);

    expect(outcome).toBe("consent-unverifiable");
    expect(state.credentialReads).toBe(1);
  });

  it("refuses an OPEN whose source trade is hours old", async () => {
    const state = newState();

    const outcome = await run(
      { ...openCandidate, sourceEventAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString() },
      EQUITY_FOLLOW,
      state,
    );

    expect(outcome).toBe("stale-intent");
    expect(state.credentialReads).toBe(1);
  });

  it("refuses an OPEN whose age cannot be established rather than assuming it is fresh", async () => {
    const state = newState();

    const outcome = await run({ ...openCandidate, sourceEventAt: undefined }, EQUITY_FOLLOW, state);

    expect(outcome).toBe("stale-intent");
  });

  it("bounds the equity intent independently of the perp override", async () => {
    // An operator widening the bound for Hyperliquid outages must not silently
    // widen it for equities, which is why the two read different variables.
    await withEquityEnv(
      { COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS: String(6 * 60 * 60_000) },
      async () => {
        const state = newState();

        const outcome = await run(
          {
            ...openCandidate,
            sourceEventAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
          },
          EQUITY_FOLLOW,
          state,
        );

        expect(outcome).toBe("stale-intent");
      },
    );
  });

  it("honours its own equity age override", async () => {
    await withEquityEnv(
      { COPY_TRADE_AUTOMIRROR_EQUITY_MAX_INTENT_AGE_MS: "60000" },
      async () => {
        const state = newState();

        const outcome = await run(
          { ...openCandidate, sourceEventAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          EQUITY_FOLLOW,
          state,
        );

        // Five minutes is inside the 15-minute default and outside this one.
        expect(outcome).toBe("stale-intent");
      },
    );
  });

  it("still sells after the follower turned auto-mirror off", async () => {
    // Withdrawing consent stops NEW exposure. It must never be the reason a
    // follower cannot get out of a position the mirror opened for them.
    const state = newState();

    await expect(
      run(
        sellCandidate,
        { ...EQUITY_FOLLOW, autoMirror: false, stockAutoMirror: false },
        state,
      ),
    ).rejects.toThrow(PAST_THE_GATE);
    // The follow row is not even read for a sell: there is no consent question
    // an order that can only shrink a holding could fail.
    expect(state.followReads).toBe(0);
  });

  it("still sells after the follow was deleted or re-pointed at another account", async () => {
    for (const follow of [
      null,
      {
        ...EQUITY_FOLLOW,
        credentialId: OTHER_CREDENTIAL_ID,
        stockCredentialId: OTHER_CREDENTIAL_ID,
      },
    ]) {
      const state = newState();

      await expect(run(sellCandidate, follow, state)).rejects.toThrow(PAST_THE_GATE);
      expect(state.followReads).toBe(0);
    }
  });

  it("still sells on a source close that is hours old", async () => {
    // A late entry is a trade nobody asked for. A late exit is still the exit.
    const state = newState();

    await expect(
      run(
        { ...sellCandidate, sourceEventAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString() },
        EQUITY_FOLLOW,
        state,
      ),
    ).rejects.toThrow(PAST_THE_GATE);
  });

  it("still sells a delivery that cannot be tied back to a follow row", async () => {
    const state = newState();

    await expect(
      run({ ...sellCandidate, followId: undefined }, EQUITY_FOLLOW, state),
    ).rejects.toThrow(PAST_THE_GATE);
  });

  it("applies the same rules to OPTION deliveries, and exempts SellToClose", async () => {
    // Options are staged with side "buy"/"sell" alongside the trade action, so
    // an opening BuyToOpen is gated and a closing SellToClose is not.
    const openState = newState();
    const buyToOpen = await run(
      {
        ...openCandidate,
        sourceItemId: "user:equity-consent-option-open",
        assetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
      },
      { ...EQUITY_FOLLOW, autoMirror: false, stockAutoMirror: false },
      openState,
    );
    expect(buyToOpen).toBe("consent-withdrawn");

    const closeState = newState();
    await expect(
      run(
        {
          ...sellCandidate,
          sourceItemId: "user:equity-consent-option-close",
          assetType: "OPTION",
          tradeAction: "SellToClose",
          optionExpiration: "260918",
          optionStrike: 250,
          optionType: "PUT",
        },
        { ...EQUITY_FOLLOW, autoMirror: false, stockAutoMirror: false },
        closeState,
      ),
    ).rejects.toThrow(PAST_THE_GATE);
    expect(closeState.followReads).toBe(0);
  });

  it("stops a wedged PENDING recovery too, not just a first attempt", async () => {
    // The recovery branch re-places a stored PENDING order without re-running
    // sizing, which is exactly the path a delivery wedged behind transient
    // failures takes on its eighth attempt. It is downstream of the gate.
    const state = newState();
    const poller = new CopyMirrorPoller({
      query: {
        orders: {
          findFirst: async () => ({
            id: "local-wedged",
            status: "PENDING",
            brokerOrderId: null,
            clientOrderId: "copymirror:follower-equity:user:equity-consent-open",
            quantity: 4,
            limitPrice: null,
          }),
          findMany: async () => [],
        },
        userApiCredentials: {
          findFirst: async () => {
            state.credentialReads += 1;
            return { id: CREDENTIAL_ID, provider: "alpaca" };
          },
        },
        copyTradeFollows: {
          findFirst: async () => {
            state.followReads += 1;
            return { ...EQUITY_FOLLOW, autoMirror: false, stockAutoMirror: false };
          },
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }) }),
    } as never);

    const outcome = await (poller as any).processCandidate(openCandidate, guards);

    expect(outcome).toBe("consent-withdrawn");
    expect(state.credentialReads).toBe(1);
  });
});
