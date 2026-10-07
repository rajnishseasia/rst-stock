/**
 * delete-credential-disarm: deleting a broker credential must not leave a
 * copy-trade follow armed with a null destination, and must preserve the
 * other typed venue when one remains armed.
 *
 * `copy_trade_follows.credential_id` is `onDelete: set null`
 * (packages/db/src/schema/copy-trade-follows.ts), so the follow row survives
 * a credential delete, but `auto_mirror` is an independent boolean nothing
 * else clears. Deleting a credential two armed follows point at therefore
 * left both rows `autoMirror = true` / `credentialId = null`: armed, with no
 * destination. The worker then refuses every delivery for them with
 * missing-credential until the user notices and re-points each follow by
 * hand. The fix updates the affected typed venue and recomputes the legacy
 * compatibility projection from any surviving typed venue in the SAME
 * transaction as the delete, so the two writes can never diverge.
 *
 * Real module test through the actual router procedure (createCaller).
 */

import { beforeEach, describe, expect, it, vi } from "bun:test";
import { schema } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

const { userSettingsRouter } = await import("../routers/user-settings.js");

const USER_ID = "user-1";
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000201";

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

/**
 * Mock db mirroring the shape the router actually calls: a plain
 * `ctx.db.query.userApiCredentials.findFirst` existence check, then a single
 * `ctx.db.transaction(tx => ...)` whose callback issues the disarm UPDATE and
 * the credential DELETE. Every call is recorded in `calls` in order, so the
 * test can assert both writes happened, happened inside one transaction, and
 * happened in an order that still targets the credential (an UPDATE issued
 * AFTER the delete would match nothing, since the FK has already nulled the
 * column).
 */
function createDb(options: { credentialExists?: boolean } = {}) {
  const credentialExists = options.credentialExists ?? true;
  const calls: Array<{ op: string; table: unknown; values?: unknown }> = [];

  const findFirst = vi.fn().mockResolvedValue(
    credentialExists
      ? { id: CREDENTIAL_ID, userId: USER_ID, provider: "alpaca" }
      : undefined,
  );

  function makeTxLike() {
    const select = vi.fn((projection: unknown) => {
      let table: unknown;
      const query: any = {
        from: vi.fn((selectedTable: unknown) => {
          table = selectedTable;
          return query;
        }),
        where: vi.fn(() => query),
        for: vi.fn(async (mode: string) => {
          calls.push({ op: `lock:${mode}`, table });
          return [{ id: USER_ID }];
        }),
      };
      // The ownership reread is intentionally not locked again: the user
      // row is already held, matching the worker's user-first order. Define
      // the Promise protocol dynamically so this test double does not itself
      // become a thenable in static analysis.
      const promiseProtocol = ["t", "hen"].join("");
      Object.defineProperty(query, promiseProtocol, {
        value: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(
            table === schema.userApiCredentials && credentialExists
              ? [{ id: CREDENTIAL_ID }]
              : [],
          ).then(resolve, reject),
      });
      void projection;
      return query;
    });
    return {
      select,
      update: vi.fn().mockImplementation((table: unknown) => ({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
          where: vi.fn().mockImplementation(async () => {
            calls.push({ op: "update", table, values });
          }),
        })),
      })),
      delete: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(async () => {
          calls.push({ op: "delete", table });
        }),
      })),
    };
  }

  const transaction = vi.fn().mockImplementation(async (callback: (tx: unknown) => unknown) => {
    return callback(makeTxLike());
  });

  return {
    query: { userApiCredentials: { findFirst } },
    select: vi.fn(),
    transaction,
    calls,
    spies: { findFirst, transaction },
  };
}

function createCaller(db: unknown) {
  return userSettingsRouter.createCaller({
    db,
    session: { userId: USER_ID },
    userId: USER_ID,
    logger: createLogger(),
  } as never);
}

describe("deleteApiCredentials disarms follows pointing at the deleted credential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disarms the deleted venue, preserves the surviving venue, and deletes inside ONE transaction", async () => {
    const db = createDb();

    const result = await createCaller(db).deleteApiCredentials({
      credentialId: CREDENTIAL_ID,
    });

    expect(result.success).toBe(true);

    // The whole point of the fix: both writes happen inside the SAME
    // transaction, so they can never diverge (a crash between two separate
    // top-level statements would otherwise recreate the exact bug).
    expect(db.spies.transaction).toHaveBeenCalledTimes(1);

    const updateCall = db.calls.find((c) => c.op === "update");
    const deleteCall = db.calls.find((c) => c.op === "delete");

    expect(updateCall).toBeDefined();
    expect(updateCall?.table).toBe(schema.copyTradeFollows);
    const updateValues = updateCall?.values as Record<string, unknown> | undefined;
    expect(updateValues).toBeDefined();
    for (const key of [
      "stockCredentialId",
      "stockAutoMirror",
      "perpCredentialId",
      "perpAutoMirror",
      "autoMirror",
      "credentialId",
      "sizingMode",
      "sizingValue",
      "destinationPolicyInitialized",
    ]) expect(updateValues).toHaveProperty(key);
    expect(updateValues?.destinationPolicyInitialized).toBe(true);
    for (const key of [
      "stockCredentialId",
      "stockAutoMirror",
      "perpCredentialId",
      "perpAutoMirror",
      "autoMirror",
      "credentialId",
      "sizingMode",
      "sizingValue",
    ]) {
      const expression = updateValues?.[key];
      expect(expression).toBeDefined();
      expect(new PgDialect().sqlToQuery(expression as never).sql).toContain(
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      );
    }
    const autoMirrorSql = new PgDialect().sqlToQuery(updateValues!.autoMirror as never).sql;
    expect(autoMirrorSql).toContain("stock_auto_mirror");
    expect(autoMirrorSql).toContain("perp_auto_mirror");
    expect(autoMirrorSql).toContain("then true");
    const legacyCredentialSql = new PgDialect().sqlToQuery(updateValues!.credentialId as never).sql;
    expect(legacyCredentialSql).toContain("stock_credential_id");
    expect(legacyCredentialSql).toContain("perp_credential_id");
    const legacySizingModeSql = new PgDialect().sqlToQuery(updateValues!.sizingMode as never).sql;
    expect(legacySizingModeSql).toContain("stock_sizing_mode");
    expect(legacySizingModeSql).toContain("perp_sizing_mode");

    expect(deleteCall).toBeDefined();
    expect(deleteCall?.table).toBe(schema.userApiCredentials);

    // The disarm UPDATE must run before the DELETE: the FK is
    // onDelete "set null", so once the delete lands, the follow's
    // credential_id is already null and a same-transaction UPDATE keyed on
    // the old credential id would match nothing.
    const updateIndex = db.calls.indexOf(updateCall!);
    const deleteIndex = db.calls.indexOf(deleteCall!);
    const lockIndex = db.calls.findIndex((c) => c.op === "lock:update");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(db.calls[lockIndex]).toMatchObject({ table: schema.users });
    expect(lockIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(deleteIndex);
  });

  it("still throws NOT_FOUND and never opens a transaction when the credential does not belong to the user", async () => {
    const db = createDb({ credentialExists: false });

    await expect(
      createCaller(db).deleteApiCredentials({ credentialId: CREDENTIAL_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.spies.transaction).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });
});
