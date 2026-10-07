import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { schema } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { userSettingsRouter } from "../routers/user-settings";
import { encrypt } from "@trade-bot/utils";

// The API suite has process-wide mocks for this module in other files. Import
// a fresh source-module identity so this security assertion always exercises
// the real credentials service.
const { getDecryptedCredentials } = await import("../lib/credentials.ts?alpaca-recovery-test");

const ALPACA_RECOVERY_MESSAGE = "Alpaca credentials need to be re-entered in Settings.";

function withEncryptionKey<T>(key: string | null, operation: () => T): T {
  const original = process.env.ENCRYPTION_KEY;
  if (key === null) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;

  try {
    return operation();
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
}

async function withEncryptionKeyAsync<T>(key: string | null, operation: () => Promise<T>): Promise<T> {
  const original = process.env.ENCRYPTION_KEY;
  if (key === null) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;

  try {
    return await operation();
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
}

function createAlpacaCredentialRow(
  encryptedAccessToken: string,
  overrides: Partial<{
    id: string;
    userId: string;
    provider: string;
    accountId: string | null;
    accountType: string | null;
    username: string | null;
    baseUrl: string | null;
    encryptedRefreshToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    userId: "settings-user",
    provider: "alpaca",
    accountId: "ACCOUNT-PRIVATE-401",
    accountType: "PAPER",
    username: "KEY-ID-PRIVATE-401",
    baseUrl: null,
    encryptedAccessToken,
    encryptedRefreshToken: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function createHyperliquidCredentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000499",
    userId: "settings-user",
    provider: "hyperliquid",
    accountId: null,
    accountType: "LIVE",
    username: null,
    baseUrl: null,
    encryptedAccessToken: "must-not-be-projected-or-decrypted",
    encryptedRefreshToken: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function createCaller(db: unknown, userId = "settings-user") {
  return userSettingsRouter.createCaller({
    userId,
    session: { userId },
    db,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as never);
}

type CredentialRow = ReturnType<typeof createAlpacaCredentialRow>;
type RowPredicate = (row: CredentialRow | ReturnType<typeof createHyperliquidCredentialRow>) => boolean;

function queryFieldName(column: unknown): string {
  if (column && typeof column === "object" && "name" in column) {
    const name = String((column as { name: unknown }).name);
    return ({
      user_id: "userId",
      account_id: "accountId",
      account_type: "accountType",
      created_at: "createdAt",
      updated_at: "updatedAt",
      encrypted_access_token: "encryptedAccessToken",
      encrypted_refresh_token: "encryptedRefreshToken",
    } as Record<string, string>)[name] ?? name;
  }
  const { sql } = new PgDialect().sqlToQuery(column as never);
  if (sql.includes("date_trunc('milliseconds'")) return "createdAt";
  throw new Error(`Unexpected credentials query expression: ${sql}`);
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function createCredentialsQueryDb(
  inputRows: CredentialRow | ReturnType<typeof createHyperliquidCredentialRow> | Array<CredentialRow | ReturnType<typeof createHyperliquidCredentialRow>>,
) {
  const sourceRows = Array.isArray(inputRows) ? inputRows : [inputRows];
  let projection: Record<string, boolean> | undefined;
  const calls: Array<{ columns: Record<string, boolean>; limit?: number }> = [];
  const compare = (column: unknown, expected: unknown, operator: "eq" | "gt"): RowPredicate => {
    const key = queryFieldName(column);
    return (row) => {
      const actual = comparable((row as unknown as Record<string, unknown>)[key]);
      const value = comparable(expected);
      return operator === "eq" ? actual === value : (actual as string | number) > (value as string | number);
    };
  };
  const queryOperators = {
    eq: (column: unknown, value: unknown) => compare(column, value, "eq"),
    gt: (column: unknown, value: unknown) => compare(column, value, "gt"),
    and: (...predicates: RowPredicate[]) => (row: CredentialRow | ReturnType<typeof createHyperliquidCredentialRow>) => predicates.every((predicate) => predicate(row)),
    or: (...predicates: RowPredicate[]) => (row: CredentialRow | ReturnType<typeof createHyperliquidCredentialRow>) => predicates.some((predicate) => predicate(row)),
    asc: (column: unknown) => ({ key: queryFieldName(column), direction: 1 as const }),
  };
  return {
    db: {
      query: {
        userApiCredentials: {
          findMany: async ({
            columns,
            limit,
            where,
            orderBy,
          }: {
            columns: Record<string, boolean>;
            limit?: number;
            where: (credentials: typeof schema.userApiCredentials, operators: typeof queryOperators) => RowPredicate;
            orderBy?: (credentials: typeof schema.userApiCredentials, operators: typeof queryOperators) => Array<{ key: string; direction: 1 }>;
          }) => {
            projection = columns;
            calls.push({ columns, limit });
            const predicate = where(schema.userApiCredentials, queryOperators);
            const order = orderBy?.(schema.userApiCredentials, queryOperators) ?? [];
            const rows = sourceRows
              .filter(predicate)
              .sort((left, right) => {
                for (const item of order) {
                  const a = comparable((left as unknown as Record<string, unknown>)[item.key]);
                  const b = comparable((right as unknown as Record<string, unknown>)[item.key]);
                  if (a === b) continue;
                  return (a as string | number) < (b as string | number) ? -item.direction : item.direction;
                }
                return 0;
              })
              .slice(0, limit);
            return rows.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => columns[key])),
            );
          },
        },
      },
    },
    getProjection: () => projection,
    getCalls: () => calls,
  };
}

describe("hasApiCredentials account label response", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    test(`returns the server ${network} label from the non-secret database projection`, async () => {
      const originalNetwork = process.env.HYPERLIQUID_NETWORK;
      const originalAllow = process.env.HYPERLIQUID_ALLOW_TESTNET;
      try {
        process.env.HYPERLIQUID_NETWORK = network;
        process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
        let projection: Record<string, boolean> | undefined;
        const stored = {
          id: "hl-account", provider: "hyperliquid", accountId: null, accountType: "LIVE",
          username: null, baseUrl: null, createdAt: new Date(0), updatedAt: new Date(0),
        };
        const caller = userSettingsRouter.createCaller({
          userId: "settings-user", session: { userId: "settings-user" },
          db: { query: { userApiCredentials: { findMany: async ({ columns }: { columns: Record<string, boolean> }) => {
            projection = columns;
            return [Object.fromEntries(Object.entries(stored).filter(([key]) => columns[key]))];
          } } } },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        } as never);
        const response = await caller.hasApiCredentials({ provider: "hyperliquid" });
        expect(Object.keys(projection!).sort()).toEqual([
          "accountId", "accountType", "baseUrl", "createdAt", "id", "provider", "updatedAt", "username",
        ]);
        expect(response).toEqual({
          hasCredentials: true,
          isComplete: true,
          nextCursor: null,
          accounts: [{
            id: stored.id, provider: stored.provider, accountId: null, accountType: "LIVE",
            username: null, baseUrl: null, updatedAt: stored.updatedAt,
            credentialAccountLabel: `Hyperliquid ${network} perps`,
          }],
        });
      } finally {
        if (originalNetwork === undefined) delete process.env.HYPERLIQUID_NETWORK;
        else process.env.HYPERLIQUID_NETWORK = originalNetwork;
        if (originalAllow === undefined) delete process.env.HYPERLIQUID_ALLOW_TESTNET;
        else process.env.HYPERLIQUID_ALLOW_TESTNET = originalAllow;
      }
    });
  }
});

describe("Alpaca ciphertext recovery status", () => {
  test("keeps recovery classification, server configuration, and credential reads distinct", async () => {
    const encrypted = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-SECRET-401"));
    const db = createCredentialsQueryDb(createAlpacaCredentialRow(encrypted));
    const response = await withEncryptionKeyAsync("2".repeat(64), () =>
      createCaller(db.db).hasApiCredentials({ provider: "alpaca" }),
    );

    expect(db.getProjection()?.encryptedAccessToken).toBe(true);
    expect(response.accounts[0]).toMatchObject({ needsReentry: true });
    expect(response.accounts[0]).not.toHaveProperty("encryptedAccessToken");
    expect(response.accounts[0]).not.toHaveProperty("encryptedRefreshToken");
    const serialized = JSON.stringify(response);
    for (const privateValue of [encrypted, "ALPACA-SECRET-401", "Unsupported state or unable to authenticate data"]) {
      expect(serialized).not.toContain(privateValue);
    }

    const missingKeyCiphertext = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-SECRET-402"));
    const missingKeyDb = createCredentialsQueryDb(createAlpacaCredentialRow(missingKeyCiphertext));
    const configurationError = await withEncryptionKeyAsync(null, () =>
      createCaller(missingKeyDb.db).hasApiCredentials({ provider: "alpaca" }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );

    expect(configurationError).toBeInstanceOf(Error);
    expect(configurationError).toMatchObject({
      message: "ENCRYPTION_KEY environment variable is not set",
    });
    expect(configurationError).not.toMatchObject({ message: ALPACA_RECOVERY_MESSAGE });

    const encryptedForRequest = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-SECRET-403"));
    const row = createAlpacaCredentialRow(encryptedForRequest);
    const error = await withEncryptionKeyAsync("2".repeat(64), () =>
      getDecryptedCredentials(
        { query: { userApiCredentials: { findFirst: async () => row } } } as never,
        row.userId,
        { provider: "alpaca", credentialId: row.id },
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );

    expect(error).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: ALPACA_RECOVERY_MESSAGE,
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const surfaced = `${(error as Error).name}: ${(error as Error).message}`;
    for (const privateValue of [
      "ALPACA-SECRET-403",
      row.accountId!,
      row.username!,
      encryptedForRequest,
      "Unsupported state or unable to authenticate data",
    ]) {
      expect(surfaced).not.toContain(privateValue);
    }
  });

  test("sanitizes malformed ciphertext errors without treating them as key re-entry", async () => {
    const db = createCredentialsQueryDb(createAlpacaCredentialRow(""));
    const error = await withEncryptionKeyAsync("1".repeat(64), () =>
      createCaller(db.db).hasApiCredentials({ provider: "alpaca" }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not verify saved Alpaca credentials.",
    });
    expect(String(error)).not.toContain("Invalid initialization vector");
    expect(String(error)).not.toContain("Unsupported state or unable to authenticate data");
  });

  test("fetches one bounded page and never decrypts its lookahead row", async () => {
    const encrypted = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-PAGE-SECRET"));
    const rows = Array.from({ length: 51 }, (_, index) =>
      createAlpacaCredentialRow(index === 50 ? "not-a-valid-ciphertext" : encrypted, {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        createdAt: new Date(index),
      }),
    );
    const db = createCredentialsQueryDb(rows);

    const response = await withEncryptionKeyAsync("1".repeat(64), () =>
      createCaller(db.db).hasApiCredentials({ provider: "alpaca" }),
    );

    expect(db.getCalls().map((call) => call.limit)).toEqual([51]);
    expect(response.accounts).toHaveLength(50);
    expect(response.accounts.some((account) => account.id === rows[50]!.id)).toBe(false);
    expect(response.isComplete).toBe(false);
    expect(response.nextCursor).toEqual(expect.any(String));
    expect(response.nextCursor).not.toBeNull();
  });

  test("traverses oldest-first exactly once and classifies a later-page flagged account", async () => {
    const healthyCiphertext = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-HEALTHY"));
    const flaggedCiphertext = withEncryptionKey("2".repeat(64), () => encrypt("ALPACA-FLAGGED"));
    const rows = Array.from({ length: 123 }, (_, index) =>
      createAlpacaCredentialRow(index === 67 ? flaggedCiphertext : healthyCiphertext, {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        createdAt: new Date(Math.floor(index / 3) * 1_000),
      }),
    );
    const expectedIds = [...rows]
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map((row) => row.id);
    const db = createCredentialsQueryDb(rows);
    const caller = createCaller(db.db);
    const traversed: Array<(typeof rows)[number] & { needsReentry?: boolean }> = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await withEncryptionKeyAsync("1".repeat(64), () =>
        caller.hasApiCredentials({ provider: "alpaca", ...(cursor ? { cursor } : {}) }),
      );
      pageSizes.push(page.accounts.length);
      traversed.push(...page.accounts);
      expect(page.nextCursor === null).toBe(page.isComplete);
      if (page.isComplete) break;
      expect(page.nextCursor).toEqual(expect.any(String));
      cursor = page.nextCursor!;
    }

    expect(pageSizes).toEqual([50, 50, 23]);
    expect(db.getCalls().map((call) => call.limit)).toEqual([51, 51, 51]);
    expect(traversed.map((account) => account.id)).toEqual(expectedIds);
    expect(new Set(traversed.map((account) => account.id)).size).toBe(rows.length);
    expect(traversed.filter((account) => account.id === rows[67]!.id)).toHaveLength(1);
    expect(traversed.find((account) => account.id === rows[67]!.id)).toMatchObject({ needsReentry: true });
  });

  test("binds cursors to the authenticated user and normalized provider filter", async () => {
    const encrypted = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-CURSOR"));
    const rows = Array.from({ length: 51 }, (_, index) =>
      createAlpacaCredentialRow(encrypted, {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        createdAt: new Date(index),
      }),
    );
    const db = createCredentialsQueryDb(rows);
    const caller = createCaller(db.db);
    const firstPage = await withEncryptionKeyAsync("1".repeat(64), () =>
      caller.hasApiCredentials({ provider: "alpaca" }),
    );
    const cursor = firstPage.nextCursor!;

    const otherUserError = await createCaller(db.db, "another-user")
      .hasApiCredentials({ provider: "alpaca", cursor })
      .then(() => undefined, (error: unknown) => error);
    const otherProviderError = await caller.hasApiCredentials({ provider: "hyperliquid", cursor })
      .then(() => undefined, (error: unknown) => error);
    const unfilteredError = await caller.hasApiCredentials({ cursor })
      .then(() => undefined, (error: unknown) => error);
    const malformedError = await caller.hasApiCredentials({ provider: "alpaca", cursor: "not-a-cursor!" })
      .then(() => undefined, (error: unknown) => error);

    for (const error of [otherUserError, otherProviderError, unfilteredError, malformedError]) {
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid credentials pagination cursor.",
      });
    }
  });

  test("rejects a correctly scoped cursor with a non-UUID id before querying", async () => {
    const db = createCredentialsQueryDb([]);
    const cursor = Buffer.from(JSON.stringify({
      version: 1,
      createdAt: new Date(0).toISOString(),
      id: "not-a-uuid",
      scope: createHash("sha256")
        .update("settings-user\0alpaca")
        .digest("hex"),
    }), "utf8").toString("base64url");

    const error = await createCaller(db.db)
      .hasApiCredentials({ provider: "alpaca", cursor })
      .then(() => undefined, (cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid credentials pagination cursor.",
    });
    expect(db.getCalls()).toEqual([]);
  });

  test("filters providers in the database and does not decrypt Hyperliquid credentials", async () => {
    const encrypted = withEncryptionKey("1".repeat(64), () => encrypt("ALPACA-FILTERED"));
    const rows = [
      createAlpacaCredentialRow(encrypted, { id: "alpaca-1", createdAt: new Date(1) }),
      createHyperliquidCredentialRow({ id: "hyperliquid-1", createdAt: new Date(2) }),
      createAlpacaCredentialRow(encrypted, { id: "alpaca-2", createdAt: new Date(3) }),
    ];
    const db = createCredentialsQueryDb(rows);

    const alpaca = await withEncryptionKeyAsync("1".repeat(64), () =>
      createCaller(db.db).hasApiCredentials({ provider: "alpaca" }),
    );
    const hyperliquid = await withEncryptionKeyAsync(null, () =>
      createCaller(db.db).hasApiCredentials({ provider: "hyperliquid" }),
    );

    expect(alpaca.accounts.map((account) => account.provider)).toEqual(["alpaca", "alpaca"]);
    expect(hyperliquid.accounts.map((account) => account.provider)).toEqual(["hyperliquid"]);
    expect(db.getProjection()).not.toHaveProperty("encryptedAccessToken", true);
    expect(hyperliquid.accounts[0]).not.toHaveProperty("needsReentry");
    expect(JSON.stringify(hyperliquid)).not.toContain("must-not-be-projected-or-decrypted");
  });
});
