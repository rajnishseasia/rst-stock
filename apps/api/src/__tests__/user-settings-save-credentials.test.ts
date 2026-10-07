/**
 * alpaca-03: adding a Live Alpaca account must never overwrite an existing
 * Paper credential row in place.
 *
 * `saveApiCredentials` looked up the "existing" row to update by
 * (userId, provider, accountId) only. The shipped UI never sends
 * `accountId` (buildSaveBrokerCredentialsInput sends only
 * {provider, accountType, accessToken, username}), so the `isNull(accountId)`
 * branch matched the user's one Alpaca row regardless of its accountType.
 * "Add Broker Account" -> Live therefore performed an UPDATE that rewrote
 * accountType/username/encryptedAccessToken on the SAME row a follow was
 * armed against, silently re-pointing every armed follow at real money with
 * no explicit act from the user.
 *
 * There is no DB uniqueness constraint on (userId, provider, accountId) for
 * alpaca (packages/db/src/schema/user-credentials.ts: the partial unique
 * index only covers provider = 'hyperliquid', specifically so that "alpaca
 * paper + live rows... keep their existing many-rows-per-user shape"), so
 * inserting a second row for a second account type is safe and matches the
 * schema's documented intent and the Settings UI's plural "Connected
 * Accounts" list.
 *
 * Real module test through the actual router procedure (createCaller) with a
 * mock db; only the network-touching seam (checkAlpacaCredentials) and
 * encrypt() are exercised against real code (encrypt just needs a key).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { schema } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { decrypt, encrypt } from "@trade-bot/utils";

// Captured BEFORE the vi.mock below replaces the module, so the real exports
// can be spread back in. See the comment on that mock.
import * as alpacaCredentialCheckActual from "../lib/alpaca-credential-check.js";

// encrypt()/decrypt() need a key; any 64-hex-char value works for tests.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

/**
 * A SNAPSHOT of the real module, taken before `vi.mock` below replaces it.
 *
 * A namespace import is LIVE-BOUND, so once the mock is installed
 * `alpacaCredentialCheckActual.checkAlpacaCredentials` resolves to the mock
 * itself, not to the original. Reading it at runtime to restore the "real"
 * implementation therefore points the mock at itself, and the first call dies
 * with `RangeError: Maximum call stack size exceeded`.
 *
 * Copying the bindings out here, at module-init time, is what makes the word
 * "actual" true. Everything below uses this, never the namespace.
 */
const actualCredentialCheck = { ...alpacaCredentialCheckActual };

// Defaults to the REAL implementation, and is restored to it after every test
// in this file.
//
// The replacement is process-wide (see the vi.mock comment below), so whatever
// behaviour this mock is left holding is the behaviour every other test file
// gets. A bare `vi.fn()` left resolving `{ ok: true }` from this file's
// `beforeEach` is what made all nine `checkAlpacaCredentials` tests in
// `alpaca-credential-check.test.ts` fail on CI: they exercise the real
// function against a fake `fetch`, and were handed a canned success instead.
//
// Delegating by default means any file other than this one sees the genuine
// implementation, whichever order bun happens to load them in.
const checkAlpacaCredentialsMock = vi.fn(actualCredentialCheck.checkAlpacaCredentials);

// The real module is spread back in, and ONLY `checkAlpacaCredentials` is
// replaced.
//
// A partial factory here is not a local shortcut, it rewrites the module for
// the whole process: `bun test` loads every test file into one process, so
// `vi.mock` is process-wide rather than file-scoped. Returning just the one
// export deleted `resolveAlpacaHost`, `ALPACA_LIVE_HOST` and
// `ALPACA_PAPER_HOST` for every other importer, and
// `alpaca-credential-check.test.ts` imports all three. That file then died at
// load with `SyntaxError: Export named 'resolveAlpacaHost' not found`, taking
// its whole suite with it.
//
// It only bit on CI. Whether it breaks depends on which file loads the module
// first, and that follows directory enumeration order, which differs between
// the Linux runner and a Windows checkout. It reproduces on neither bun 1.3.4
// nor 1.3.6 locally, so treating "passes on my machine" as proof was exactly
// the wrong read.
//
// `vi.importActual` does not exist in bun's `vi` shim, so the originals come
// from `actualCredentialCheck` above, a snapshot taken at module-init time.
// Not from the namespace import directly: that binding is live and would
// resolve to this very mock by the time anything reads it.
vi.mock("../lib/alpaca-credential-check.js", () => ({
  ...actualCredentialCheck,
  checkAlpacaCredentials: checkAlpacaCredentialsMock,
}));

const { userSettingsRouter } = await import("../routers/user-settings.js");

const USER_ID = "user-1";
const PAPER_ROW_ID = "00000000-0000-4000-8000-000000000101";

type CredentialRow = {
  id: string;
  userId: string;
  provider: string;
  accountId: string | null;
  accountType: string | null;
  username: string | null;
  encryptedAccessToken: string;
};

function paperCredentialRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: PAPER_ROW_ID,
    userId: USER_ID,
    provider: "alpaca",
    accountId: "PA123",
    accountType: "PAPER",
    username: "paper-key-id",
    encryptedAccessToken: encrypt("original-secret"),
    ...overrides,
  };
}

function encryptWithKey(value: string, key: string) {
  const original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key;
  try {
    return encrypt(value);
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

// Minimal stand-ins for the drizzle relational-query operators the router's
// `where` callback is built with, evaluated against a plain row so the test
// exercises the REAL matching logic in saveApiCredentials rather than
// hard-coding what findFirst "should" return.
const credsColumns = { userId: "userId", provider: "provider", accountId: "accountId", accountType: "accountType" } as const;
type Predicate = (row: CredentialRow) => boolean;
function eq(column: string, value: unknown): Predicate {
  return (row) => (row as Record<string, unknown>)[column] === value;
}
function isNull(column: string): Predicate {
  return (row) => (row as Record<string, unknown>)[column] == null;
}
function and(...preds: Predicate[]): Predicate {
  return (row) => preds.every((p) => p(row));
}
function or(...preds: Predicate[]): Predicate {
  return (row) => preds.some((p) => p(row));
}

/**
 * Mock db mirroring the shape the router actually calls:
 * ctx.db.query.userApiCredentials.findFirst(...) to look up the row to
 * update, ctx.db.insert(...).values(...) to create a new one, and
 * ctx.db.update(...).set(...).where(...) to overwrite an existing one.
 * `rows` is the fake table content; findFirst runs the router's own `where`
 * callback against it, so the test proves what the real where-clause
 * matches, not what a stub was told to return.
 */
function createDb(rows: CredentialRow[]) {
  const events: string[] = [];
  const queryOperators = { eq, and, isNull, or };
  const findFirst = vi.fn().mockImplementation(async ({ where }: {
    where: (creds: typeof credsColumns, ops: typeof queryOperators) => Predicate;
  }) => {
    const predicate = where(credsColumns, queryOperators);
    return rows.find(predicate);
  });
  const findMany = vi.fn().mockImplementation(async ({ where, columns }: {
    where: (creds: typeof credsColumns, ops: typeof queryOperators) => Predicate;
    columns?: Record<string, boolean>;
  }) => {
    const predicate = where(credsColumns, queryOperators);
    return rows.filter(predicate).map((row) =>
      columns
        ? Object.fromEntries(Object.entries(row).filter(([key]) => columns[key]))
        : row,
    );
  });

  const insertValues = vi.fn().mockImplementation(async (values: Omit<CredentialRow, "id">) => {
    rows.push({ id: crypto.randomUUID(), ...values });
    events.push("insert");
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  let pendingUpdate: Partial<CredentialRow>;
  const updateWhere = vi.fn().mockImplementation(async (where) => {
    const { params } = new PgDialect().sqlToQuery(where);
    expect(params).toHaveLength(1);
    const matched = rows.find((row) => row.id === params[0]);
    expect(matched).toBeDefined();
    Object.assign(matched!, pendingUpdate);
    events.push("update");
  });
  const updateSet = vi.fn().mockImplementation((values: Partial<CredentialRow>) => {
    pendingUpdate = values;
    return { where: updateWhere };
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const select = vi.fn(() => {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      for: vi.fn(async (mode: string) => {
        events.push(`lock:user:${mode}`);
        return [{ id: USER_ID }];
      }),
    };
    return query;
  });
  let db: any;
  const transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
    events.push("transaction:begin");
    const result = await callback(db);
    events.push("transaction:commit");
    return result;
  });

  db = {
    select,
    query: { userApiCredentials: { findFirst, findMany } },
    insert,
    update,
    transaction,
    events,
    rows,
    spies: { findFirst, findMany, insert, insertValues, update, updateSet, updateWhere },
  };
  return db;
}

function createCaller(db: unknown) {
  return userSettingsRouter.createCaller({
    db,
    session: { userId: USER_ID },
    userId: USER_ID,
    logger: createLogger(),
  } as never);
}

describe("saveApiCredentials: Paper/Live are distinct accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkAlpacaCredentialsMock.mockResolvedValue({ ok: true, accountNumber: "PA123", status: "ACTIVE" });
  });

  // `mockResolvedValue` above is persistent, and this mock is installed
  // process-wide, so without this the canned `{ ok: true }` outlives the file
  // and every other caller of `checkAlpacaCredentials` receives it.
  afterEach(() => {
    checkAlpacaCredentialsMock.mockReset();
    checkAlpacaCredentialsMock.mockImplementation(
      actualCredentialCheck.checkAlpacaCredentials,
    );
  });

  it("adding a Live account when a Paper row exists inserts a new row and leaves the Paper row untouched", async () => {
    const db = createDb([paperCredentialRow()]);

    const result = await createCaller(db).saveApiCredentials({
      provider: "alpaca",
      accountType: "LIVE",
      accessToken: "live-secret-key",
      username: "live-key-id",
      // The real UI never sends accountId (broker-credentials-form.ts).
    });

    expect(result.success).toBe(true);
    // The fix: a second row is created for the new account type...
    expect(db.spies.insert).toHaveBeenCalledTimes(1);
    // ...and the existing Paper row is never rewritten with the Live secret.
    expect(db.spies.update).not.toHaveBeenCalled();
  });

  it("re-saving the verified account and environment rotates the same UUID", async () => {
    const db = createDb([paperCredentialRow()]);

    const result = await createCaller(db).saveApiCredentials({
      provider: "alpaca",
      accountType: "PAPER",
      accessToken: "rotated-paper-secret",
      username: "paper-key-id",
    });

    expect(result.success).toBe(true);
    expect(db.spies.update).toHaveBeenCalledTimes(1);
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.spies.updateWhere).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(db.spies.updateWhere.mock.calls[0][0]).params).toEqual([PAPER_ROW_ID]);
    expect(db.spies.update).toHaveBeenCalledWith(schema.userApiCredentials);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].id).toBe(PAPER_ROW_ID);
    expect(decrypt(db.rows[0].encryptedAccessToken)).toBe("rotated-paper-secret");
    expect(db.events).toEqual([
      "transaction:begin",
      "lock:user:update",
      "update",
      "transaction:commit",
    ]);
  });

  it("clears Alpaca recovery status after a successful re-save and refreshed status read", async () => {
    const unreadable = paperCredentialRow({
      encryptedAccessToken: encryptWithKey("old-paper-secret", "b".repeat(64)),
    });
    const db = createDb([unreadable]);
    const caller = createCaller(db);

    const beforeSave = await caller.hasApiCredentials({ provider: "alpaca" });
    expect(beforeSave.accounts).toMatchObject([
      { id: PAPER_ROW_ID, needsReentry: true },
    ]);

    const saved = await caller.saveApiCredentials({
      provider: "alpaca",
      accountType: "PAPER",
      accessToken: "re-entered-paper-secret",
      username: "paper-key-id",
    });
    const refreshedStatus = await caller.hasApiCredentials({ provider: "alpaca" });

    expect(saved.success).toBe(true);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].id).toBe(PAPER_ROW_ID);
    expect(refreshedStatus.accounts).toMatchObject([
      { id: PAPER_ROW_ID, needsReentry: false },
    ]);
  });

  it("adding the first account for a provider inserts (no existing row of any type)", async () => {
    const db = createDb([]);

    const result = await createCaller(db).saveApiCredentials({
      provider: "alpaca",
      accountType: "PAPER",
      accessToken: "paper-secret-key",
      username: "paper-key-id",
    });

    expect(result.success).toBe(true);
    expect(db.spies.insert).toHaveBeenCalledTimes(1);
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.events).toEqual([
      "transaction:begin",
      "lock:user:update",
      "insert",
      "transaction:commit",
    ]);
  });

  it("with both a Paper and a Live row already saved, rotating the Live key updates only the Live row", async () => {
    const liveRow = paperCredentialRow({
      id: "00000000-0000-4000-8000-000000000102",
      accountType: "LIVE",
      username: "live-key-id",
    });
    const db = createDb([paperCredentialRow(), liveRow]);

    const result = await createCaller(db).saveApiCredentials({
      provider: "alpaca",
      accountType: "LIVE",
      accessToken: "rotated-live-secret",
      username: "live-key-id",
    });

    expect(result.success).toBe(true);
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.spies.update).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(db.spies.updateWhere.mock.calls[0][0]).params).toEqual([liveRow.id]);
    expect(decrypt(db.rows[0].encryptedAccessToken)).toBe("original-secret");
    expect(decrypt(db.rows[1].encryptedAccessToken)).toBe("rotated-live-secret");
  });

  it("re-entering the same verified Live account preserves its row UUID and credential references", async () => {
    const liveRow = paperCredentialRow({
      id: "00000000-0000-4000-8000-000000000103",
      accountType: "LIVE",
      username: "live-key-id",
    });
    const db = createDb([liveRow]);
    const credentialReferences = [
      { kind: "stock-follow", credentialId: liveRow.id },
      { kind: "legacy-exposure", credentialId: liveRow.id },
    ];
    const referencesBeforeSave = structuredClone(credentialReferences);

    const result = await createCaller(db).saveApiCredentials({
      provider: "alpaca",
      accountType: "LIVE",
      accessToken: "re-entered-live-secret",
      username: "live-key-id",
    });

    expect(result.success).toBe(true);
    expect(db.spies.update).toHaveBeenCalledTimes(1);
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].id).toBe(liveRow.id);
    expect(db.rows[0].accountId).toBe("PA123");
    expect(db.rows[0].accountType).toBe("LIVE");
    expect(decrypt(db.rows[0].encryptedAccessToken)).toBe("re-entered-live-secret");
    expect(credentialReferences).toEqual(referencesBeforeSave);
    expect(credentialReferences.every(({ credentialId }) =>
      db.rows.some((row: CredentialRow) => row.id === credentialId),
    )).toBe(true);
  });

  it.each([null, "OTHER"])("inserts a distinct verified Live account without moving old links when old identity is %s", async (accountId) => {
    const old = paperCredentialRow({ accountId, accountType: "LIVE" });
    const oldSnapshot = { ...old };
    const db = createDb([old]);
    const references = { stockFollowCredentialId: old.id, exposureCredentialId: old.id };
    await createCaller(db).saveApiCredentials({ provider: "alpaca", accountType: "LIVE", accessToken: "new-secret", username: "new-key" });
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insert).toHaveBeenCalledWith(schema.userApiCredentials);
    expect(db.spies.insertValues).toHaveBeenCalledWith(expect.objectContaining({ accountId: "PA123", accountType: "LIVE", userId: USER_ID }));
    expect(db.spies.insertValues.mock.calls[0][0].id).toBeUndefined();
    expect(old).toEqual(oldSnapshot);
    expect(db.rows).toHaveLength(2);
    expect(db.rows[1].id).not.toBe(old.id);
    for (const credentialId of Object.values(references)) {
      const referenced = db.rows.find((row: CredentialRow) => row.id === credentialId)!;
      expect(referenced).toEqual(oldSnapshot);
      expect(decrypt(referenced.encryptedAccessToken)).toBe("original-secret");
    }
    expect(decrypt(db.rows[1].encryptedAccessToken)).toBe("new-secret");
  });

  it.each(["SIM", "PAPER"] as const)("rotates an identified legacy SIM row through %s", async (accountType) => {
    const db = createDb([paperCredentialRow({ accountType: "SIM" })]);
    await createCaller(db).saveApiCredentials({ provider: "alpaca", accountType, accessToken: "rotated-secret", username: "new-key" });
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.spies.updateSet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "PA123", accountType: "PAPER" }));
  });

  it("fails safely without writes when the verified Paper identity matches PAPER and SIM rows", async () => {
    const paper = paperCredentialRow();
    const sim = paperCredentialRow({
      id: "00000000-0000-4000-8000-000000000104",
      accountType: "SIM",
      username: "legacy-paper-key-id",
    });
    const db = createDb([paper, sim]);
    const before = structuredClone(db.rows);

    const error = await createCaller(db)
      .saveApiCredentials({
        provider: "alpaca",
        accountType: "PAPER",
        accessToken: "re-entered-paper-secret",
        username: "paper-key-id",
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(error).toMatchObject({
      code: "CONFLICT",
      message:
        "Multiple saved Alpaca credential rows match this verified account. No credentials were changed.",
    });
    expect(db.rows).toEqual(before);
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.spies.updateWhere).not.toHaveBeenCalled();
    expect(db.events).toEqual(["transaction:begin", "lock:user:update"]);
  });

  it("does not trust a caller-supplied identity", async () => {
    const db = createDb([paperCredentialRow()]);
    await expect(createCaller(db).saveApiCredentials({ provider: "alpaca", accountType: "PAPER", accountId: "OTHER", accessToken: "secret", username: "key" })).rejects.toThrow(/account/i);
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "another-user" },
    { provider: "hyperliquid" },
    { accountType: "LIVE" },
  ])("does not rotate an identity match outside owned provider/environment: %j", async (overrides) => {
    const db = createDb([paperCredentialRow(overrides)]);
    await createCaller(db).saveApiCredentials({ provider: "alpaca", accountType: "PAPER", accountId: "PA123", accessToken: "secret", username: "key" });
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insertValues).toHaveBeenCalledWith(expect.objectContaining({ accountId: "PA123", accountType: "PAPER", userId: USER_ID, provider: "alpaca" }));
  });

  it("saves Live keys through the real behind-the-scenes account check without changing legacy exposure destinations", async () => {
    const old = paperCredentialRow({ accountId: null, accountType: "LIVE" });
    const db = createDb([old]);
    const fetchAccount = vi.fn(async () => new Response(JSON.stringify({ account_number: "LIVE123", status: "ACTIVE" })));
    checkAlpacaCredentialsMock.mockImplementation((input) => actualCredentialCheck.checkAlpacaCredentials(input, fetchAccount as unknown as typeof fetch));
    await createCaller(db).saveApiCredentials({ provider: "alpaca", accountType: "LIVE", accessToken: " new-secret ", username: " new-key " });
    expect(fetchAccount).toHaveBeenCalledWith(`${actualCredentialCheck.ALPACA_LIVE_HOST}/v2/account`, expect.objectContaining({ headers: { "APCA-API-KEY-ID": "new-key", "APCA-API-SECRET-KEY": "new-secret" } }));
    expect(db.spies.insertValues).toHaveBeenCalledWith(expect.objectContaining({ accountId: "LIVE123", accountType: "LIVE", username: "new-key" }));
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insert.mock.calls.map(([table]: [unknown]) => table)).toEqual([schema.userApiCredentials]);
  });

  it.each([401, 503, 200])("refuses unverified save using real account check, HTTP %s", async (status) => {
    checkAlpacaCredentialsMock.mockImplementation((input) => actualCredentialCheck.checkAlpacaCredentials(input, (async () => new Response("{}", { status })) as typeof fetch));
    const db = createDb([paperCredentialRow()]);
    await expect(createCaller(db).saveApiCredentials({ provider: "alpaca", accountType: "LIVE", accessToken: "secret", username: "key" })).rejects.toThrow();
    expect(db.spies.update).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
  });
});

describe("the alpaca-credential-check mock installed by this file", () => {
  it("replaces only checkAlpacaCredentials and leaves the other exports intact", async () => {
    // `vi.mock` rewrites the module for the ENTIRE process, so a factory that
    // returns only the export this file cares about silently deletes the rest
    // for every other test file. That is not theoretical: it took out
    // `alpaca-credential-check.test.ts` on the Linux CI runner with
    // `SyntaxError: Export named 'resolveAlpacaHost' not found`, while passing
    // on a Windows checkout, because which file loads the module first follows
    // directory enumeration order.
    //
    // Asserting it here rather than there keeps the failure attached to the
    // file that would cause it.
    const mocked = await import("../lib/alpaca-credential-check.js");

    expect(mocked.checkAlpacaCredentials).toBe(checkAlpacaCredentialsMock);
    expect(typeof mocked.resolveAlpacaHost).toBe("function");
    expect(mocked.ALPACA_LIVE_HOST).toBe(actualCredentialCheck.ALPACA_LIVE_HOST);
    expect(mocked.ALPACA_PAPER_HOST).toBe(actualCredentialCheck.ALPACA_PAPER_HOST);
  });

  it("leaves checkAlpacaCredentials behaving like the real one for other files", async () => {
    // Surviving the export check above is not enough. The replacement is
    // process-wide, so the BEHAVIOUR it is left holding is what every other
    // file gets, and a canned `{ ok: true }` outliving this file is precisely
    // what broke `alpaca-credential-check.test.ts` on CI.
    //
    // The `afterEach` restores the real implementation, so by the time this
    // runs the mock should reject a blank key id exactly as the real function
    // does, without reaching for the network.
    const mocked = await import("../lib/alpaca-credential-check.js");

    let calledFetch = false;
    const result = await mocked.checkAlpacaCredentials(
      { keyId: "  ", secretKey: "shhh", accountType: "PAPER" },
      (async () => {
        calledFetch = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    );

    expect(calledFetch).toBe(false);
    expect(result.ok).toBe(false);
  });
});
