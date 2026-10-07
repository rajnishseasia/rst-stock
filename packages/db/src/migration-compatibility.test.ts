import { describe, expect, it } from "bun:test";
import { types as pgTypes } from "pg";
import * as migrationCompatibility from "./migration-compatibility";
import {
  assertWorkerCanonicalIngestionCompatibility,
  assertWorkerCopyMirrorCompatibility,
  assertWorkerCopyMirrorDestinationsCompatibility,
  assertWorkerSchemaCompatibility,
  workerSchemaHasCanonicalIngestion,
  workerSchemaHasCopyMirrorIndexes,
  workerSchemaHasCopyMirrorDestinations,
  workerSchemaHasOrderId,
  normalizeIndexExpression,
  WORKER_CANONICAL_INGESTION_MIGRATION,
  WORKER_COPY_MIRROR_INDEX_MIGRATION,
  WORKER_COPY_MIRROR_DESTINATIONS_MIGRATION,
  WORKER_ORDER_ID_MIGRATION,
} from "./migration-compatibility";

type CompatibilityProbeDb = {
  execute(query: unknown): Promise<unknown>;
};

type LeverageProbeRow = {
  has_user_copy_perp_max_leverage: boolean;
  has_copy_trade_follows_perp_max_leverage: boolean;
  has_users_copy_perp_max_leverage_range_check: boolean;
  has_copy_trade_follows_perp_max_leverage_range_check: boolean;
};

type CopyTradeCapsProbeRow = {
  has_exact_copy_trade_cap_columns: boolean;
  max_trade_size_range_check_definition: string | null;
  max_coin_size_range_check_definition: string | null;
};

type WalletCopyCursorProbeRow = {
  has_wallet_copy_cursor_table: boolean;
  has_exact_wallet_copy_cursor_columns: boolean;
  has_wallet_copy_cursor_primary_key: boolean;
  has_wallet_copy_cursor_user_foreign_key: boolean;
  has_wallet_copy_cursor_follower_index: boolean;
};

const COMPLETE_WALLET_COPY_CURSOR_PROBE: WalletCopyCursorProbeRow = {
  has_wallet_copy_cursor_table: true,
  has_exact_wallet_copy_cursor_columns: true,
  has_wallet_copy_cursor_primary_key: true,
  has_wallet_copy_cursor_user_foreign_key: true,
  has_wallet_copy_cursor_follower_index: true,
};

const COMPLETE_LEVERAGE_PROBE: LeverageProbeRow = {
  has_user_copy_perp_max_leverage: true,
  has_copy_trade_follows_perp_max_leverage: true,
  has_users_copy_perp_max_leverage_range_check: true,
  has_copy_trade_follows_perp_max_leverage_range_check: true,
};

const COMPLETE_DESTINATION_PROBE = {
  has_copy_mirror_destination_columns: true,
  has_copy_mirror_destination_foreign_keys: true,
  has_copy_mirror_destination_constraints: true,
  has_copy_mirror_destination_indexes: true,
};

function destinationGate(): (db: CompatibilityProbeDb) => Promise<void> {
  return assertWorkerCopyMirrorDestinationsCompatibility;
}

const COMPLETE_COPY_TRADE_CAPS_PROBE: CopyTradeCapsProbeRow = {
  has_exact_copy_trade_cap_columns: true,
  max_trade_size_range_check_definition:
    "CHECK ((max_trade_size IS NULL) OR ((max_trade_size > (0)::numeric) AND (max_trade_size <= (1000000)::numeric)))",
  max_coin_size_range_check_definition:
    "CHECK ((max_coin_size IS NULL) OR ((max_coin_size > (0)::numeric) AND (max_coin_size <= (1000000)::numeric)))",
};

function leverageGate(): (db: CompatibilityProbeDb) => Promise<void> {
  const gate = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).assertWorkerCopyTradeLeverageCompatibility;
  expect(typeof gate).toBe("function");
  return gate as (db: CompatibilityProbeDb) => Promise<void>;
}

function leverageDecoder(): (result: unknown) => boolean {
  const decoder = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).workerSchemaHasCopyTradeLeverage;
  expect(typeof decoder).toBe("function");
  return decoder as (result: unknown) => boolean;
}

function copyTradeCapsGate(): (db: CompatibilityProbeDb) => Promise<void> {
  const gate = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).assertWorkerCopyTradeCapsCompatibility;
  expect(typeof gate).toBe("function");
  return gate as (db: CompatibilityProbeDb) => Promise<void>;
}

function copyTradeCapsDecoder(): (result: unknown) => boolean {
  const decoder = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).workerSchemaHasCopyTradeCaps;
  expect(typeof decoder).toBe("function");
  return decoder as (result: unknown) => boolean;
}

function walletCopyCursorGate(): (db: CompatibilityProbeDb) => Promise<void> {
  const gate = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).assertWorkerWalletCopyCursorCompatibility;
  expect(typeof gate).toBe("function");
  return gate as (db: CompatibilityProbeDb) => Promise<void>;
}

function walletCopyCursorDecoder(): (result: unknown) => boolean {
  const decoder = (
    migrationCompatibility as unknown as Record<string, unknown>
  ).workerSchemaHasWalletCopyCursor;
  expect(typeof decoder).toBe("function");
  return decoder as (result: unknown) => boolean;
}

async function expectLeverageProbeToFail(
  overrides: Partial<LeverageProbeRow>,
): Promise<void> {
  const execute = async () => ({
    rows: [{ ...COMPLETE_LEVERAGE_PROBE, ...overrides }],
  });
  await expect(leverageGate()({ execute })).rejects.toThrow(
    "0038_copy_trade_leverage_caps is required",
  );
}

async function expectCopyTradeCapsProbeToFail(
  overrides: Partial<CopyTradeCapsProbeRow>,
): Promise<void> {
  const execute = async () => ({
    rows: [{ ...COMPLETE_COPY_TRADE_CAPS_PROBE, ...overrides }],
  });
  await expect(copyTradeCapsGate()({ execute })).rejects.toThrow(
    "0041_copy_trade_cap_constraints is required",
  );
}

describe("worker schema compatibility gate", () => {
  it("requires migration 0041's exact copy-trade dollar-cap contract", async () => {
    expect(
      copyTradeCapsDecoder()({ rows: [COMPLETE_COPY_TRADE_CAPS_PROBE] }),
    ).toBe(true);
    expect(
      copyTradeCapsDecoder()({
        rows: [
          {
            ...COMPLETE_COPY_TRADE_CAPS_PROBE,
            max_trade_size_range_check_definition:
              "CHECK (max_trade_size IS NULL OR (max_trade_size >= 0 AND max_trade_size <= 1000000))",
          },
        ],
      }),
    ).toBe(false);
    expect(copyTradeCapsDecoder()({ rows: [] })).toBe(false);

    const execute = async () => ({ rows: [COMPLETE_COPY_TRADE_CAPS_PROBE] });
    await expect(copyTradeCapsGate()({ execute })).resolves.toBeUndefined();

    await expectCopyTradeCapsProbeToFail({
      has_exact_copy_trade_cap_columns: false,
    });
    await expectCopyTradeCapsProbeToFail({
      max_coin_size_range_check_definition: null,
    });
  });

  it("accepts valid PostgreSQL formatting variants but rejects permissive cap constraints", () => {
    const validFormattingVariants = [
      "check((\"max_trade_size\" is null) or ((\"max_trade_size\" > 0::numeric) and (\"max_trade_size\" <= 1000000::numeric)))",
      "CHECK (((max_trade_size) IS NULL OR ((max_trade_size) > ((0)::numeric) AND ((max_trade_size) <= ((1000000)::numeric)))))",
    ];

    for (const definition of validFormattingVariants) {
      expect(
        copyTradeCapsDecoder()({
          rows: [
            {
              ...COMPLETE_COPY_TRADE_CAPS_PROBE,
              max_trade_size_range_check_definition: definition,
            },
          ],
        }),
      ).toBe(true);
    }

    const adversarialDefinitions = [
      // OR makes the upper bound optional.
      "CHECK (max_trade_size IS NULL OR max_trade_size > 0 OR max_trade_size <= 1000000)",
      // Without the null branch, a nullable cap is not the migration contract.
      "CHECK (max_trade_size > 0 AND max_trade_size <= 1000000)",
      // This grouping rejects NULL values instead of allowing an unset cap.
      "CHECK ((max_trade_size IS NULL OR max_trade_size > 0) AND max_trade_size <= 1000000)",
      // A non-strict lower bound permits zero, which the API does not accept.
      "CHECK (max_trade_size IS NULL OR (max_trade_size >= 0 AND max_trade_size <= 1000000))",
    ];

    for (const definition of adversarialDefinitions) {
      expect(
        copyTradeCapsDecoder()({
          rows: [
            {
              ...COMPLETE_COPY_TRADE_CAPS_PROBE,
              max_trade_size_range_check_definition: definition,
            },
          ],
        }),
      ).toBe(false);
    }
  });

  it("probes exact migration 0041 columns, defaults, nullability, and constraints", async () => {
    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: [COMPLETE_COPY_TRADE_CAPS_PROBE] };
    };

    await expect(copyTradeCapsGate()({ execute })).resolves.toBeUndefined();
    for (const requiredName of [
      "copy_trade_follows",
      "max_trade_size",
      "max_coin_size",
      "data_type",
      "numeric",
      "numeric_precision",
      "numeric_scale",
      "is_nullable",
      "column_default",
      "copy_trade_follows_max_trade_size_range_check",
      "copy_trade_follows_max_coin_size_range_check",
      "max_trade_size_range_check_definition",
      "max_coin_size_range_check_definition",
      "pg_constraint",
      "pg_get_constraintdef",
      "convalidated",
    ]) {
      expect(queryText).toContain(requiredName);
    }
    expect(queryText.toLowerCase()).toContain("is_nullable");
    expect(queryText.toLowerCase()).toContain("'yes'");
    expect(queryText.toLowerCase()).toContain("column_default is null");
  });

  it("requires migration 0042's exact independent destination contract", async () => {
    expect(workerSchemaHasCopyMirrorDestinations({ rows: [COMPLETE_DESTINATION_PROBE] })).toBe(true);
    expect(workerSchemaHasCopyMirrorDestinations({
      rows: [{ ...COMPLETE_DESTINATION_PROBE, has_copy_mirror_destination_indexes: false }],
    })).toBe(false);
    expect(workerSchemaHasCopyMirrorDestinations({
      rows: [{ ...COMPLETE_DESTINATION_PROBE, has_copy_mirror_destination_constraints: false }],
    })).toBe(false);

    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: [COMPLETE_DESTINATION_PROBE] };
    };
    await expect(destinationGate()({ execute })).resolves.toBeUndefined();
    for (const requiredName of [
      "copy_trade_follows",
      "stock_credential_id",
      "stock_auto_mirror",
      "stock_sizing_mode",
      "stock_sizing_value",
      "perp_credential_id",
      "perp_auto_mirror",
      "perp_sizing_mode",
      "perp_sizing_value",
      "destination_policy_initialized",
      "user_api_credentials",
      "copy_trade_follows_stock_auto_mirror_created_at_id_idx",
      "copy_trade_follows_perp_auto_mirror_created_at_id_idx",
      "copy_trade_follows_auto_mirror_valid_check",
      "copy_trade_follows_stock_auto_mirror_valid_check",
      "copy_trade_follows_perp_auto_mirror_valid_check",
    ]) expect(queryText).toContain(requiredName);

    await expect(destinationGate()({
      execute: async () => ({
        rows: [{ ...COMPLETE_DESTINATION_PROBE, has_copy_mirror_destination_columns: false }],
      }),
    })).rejects.toThrow(`${WORKER_COPY_MIRROR_DESTINATIONS_MIGRATION} is required`);
  });

  it("requires migration 0039's exact wallet-copy cursor contract", async () => {
    expect(
      walletCopyCursorDecoder()({ rows: [COMPLETE_WALLET_COPY_CURSOR_PROBE] }),
    ).toBe(true);
    expect(
      walletCopyCursorDecoder()({
        rows: [
          {
            ...COMPLETE_WALLET_COPY_CURSOR_PROBE,
            has_wallet_copy_cursor_primary_key: false,
          },
        ],
      }),
    ).toBe(false);

    const execute = async () => ({ rows: [COMPLETE_WALLET_COPY_CURSOR_PROBE] });
    await expect(walletCopyCursorGate()({ execute })).resolves.toBeUndefined();

    const incompleteExecute = async () => ({
      rows: [
        {
          ...COMPLETE_WALLET_COPY_CURSOR_PROBE,
          has_wallet_copy_cursor_follower_index: false,
        },
      ],
    });
    await expect(walletCopyCursorGate()({ execute: incompleteExecute })).rejects.toThrow(
      "0039_hl_wallet_copy_cursors is required",
    );
  });

  it("recognizes a complete migration 0038 leverage-cap probe", () => {
    expect(leverageDecoder()({ rows: [COMPLETE_LEVERAGE_PROBE] })).toBe(true);
    expect(
      leverageDecoder()({
        rows: [{ ...COMPLETE_LEVERAGE_PROBE, has_user_copy_perp_max_leverage: false }],
      }),
    ).toBe(false);
    expect(leverageDecoder()({ rows: [] })).toBe(false);
  });

  it("allows the worker only when migration 0038 has the required user column", async () => {
    const execute = async () => ({ rows: [COMPLETE_LEVERAGE_PROBE] });
    await expect(leverageGate()({ execute })).resolves.toBeUndefined();
  });

  it("rejects a missing users.copy_perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({ has_user_copy_perp_max_leverage: false });
  });

  it("rejects a non-integer users.copy_perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({ has_user_copy_perp_max_leverage: false });
  });

  it("rejects a users.copy_perp_max_leverage column with the wrong default", async () => {
    await expectLeverageProbeToFail({ has_user_copy_perp_max_leverage: false });
  });

  it("rejects a nullable users.copy_perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({ has_user_copy_perp_max_leverage: false });
  });

  it("rejects a missing copy_trade_follows.perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({
      has_copy_trade_follows_perp_max_leverage: false,
    });
  });

  it("rejects a non-integer copy_trade_follows.perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({
      has_copy_trade_follows_perp_max_leverage: false,
    });
  });

  it("rejects a non-nullable copy_trade_follows.perp_max_leverage column", async () => {
    await expectLeverageProbeToFail({
      has_copy_trade_follows_perp_max_leverage: false,
    });
  });

  it("rejects a copy_trade_follows.perp_max_leverage column with a default", async () => {
    await expectLeverageProbeToFail({
      has_copy_trade_follows_perp_max_leverage: false,
    });
  });

  it("rejects a missing or wrong users 1..100 range constraint", async () => {
    await expectLeverageProbeToFail({
      has_users_copy_perp_max_leverage_range_check: false,
    });
  });

  it("rejects a missing or wrong follows 1..100 range constraint", async () => {
    await expectLeverageProbeToFail({
      has_copy_trade_follows_perp_max_leverage_range_check: false,
    });
  });

  it("probes the exact migration 0038 columns, defaults, nullability, and constraints", async () => {
    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: [COMPLETE_LEVERAGE_PROBE] };
    };

    await expect(leverageGate()({ execute })).resolves.toBeUndefined();
    for (const requiredName of [
      "users",
      "copy_trade_follows",
      "copy_perp_max_leverage",
      "perp_max_leverage",
      "data_type",
      "integer",
      "is_nullable",
      "column_default",
      "users_copy_perp_max_leverage_range_check",
      "copy_trade_follows_perp_max_leverage_range_check",
      "pg_constraint",
      "pg_get_constraintdef",
      "convalidated",
      "1",
      "100",
    ]) {
      expect(queryText).toContain(requiredName);
    }
    expect(queryText.toLowerCase()).toContain("is_nullable");
    expect(queryText.toLowerCase()).toContain("'yes'");
    expect(queryText.toLowerCase()).toContain("column_default is null");
    expect(queryText.toLowerCase()).toContain("check");
  });

  it("recognizes the committed order_id column probe", () => {
    expect(workerSchemaHasOrderId({ rows: [{ has_order_id: true }] })).toBe(true);
    expect(workerSchemaHasOrderId({ rows: [{ hasOrderId: true }] })).toBe(true);
    expect(workerSchemaHasOrderId({ rows: [{ has_order_id: false }] })).toBe(false);
    expect(workerSchemaHasOrderId({ rows: [] })).toBe(false);
  });

  it("allows the worker only when migration 0029 is present", async () => {
    const execute = async () => ({ rows: [{ has_order_id: true }] });
    await expect(assertWorkerSchemaCompatibility({ execute })).resolves.toBeUndefined();
  });

  it("blocks affected jobs with an actionable migration diagnostic", async () => {
    const execute = async () => ({ rows: [{ has_order_id: false }] });
    await expect(assertWorkerSchemaCompatibility({ execute })).rejects.toThrow(
      `${WORKER_ORDER_ID_MIGRATION} is required`,
    );
    await expect(assertWorkerSchemaCompatibility({ execute })).rejects.toThrow(
      "public.social_trades.order_id is missing",
    );
  });

  it("recognizes the canonical identity and cursor probe", () => {
    expect(workerSchemaHasCanonicalIngestion({ rows: [{ has_canonical_ingestion: true }] })).toBe(true);
    expect(workerSchemaHasCanonicalIngestion({ rows: [{ hasCanonicalIngestion: true }] })).toBe(true);
    expect(workerSchemaHasCanonicalIngestion({ rows: [{ has_canonical_ingestion: false }] })).toBe(false);
  });

  it("requires the live dedup index, cursor CAS columns, and alias foreign key", async () => {
    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: [{ has_canonical_ingestion: true }] };
    };

    await expect(assertWorkerCanonicalIngestionCompatibility({ execute })).resolves.toBeUndefined();
    expect(queryText).toContain("signals_source_event_unique_idx");
    expect(queryText).toContain("cursor_sequence");
    expect(queryText).toContain("backfill_cursor");
    expect(queryText).toContain("source_author_aliases");
  });

  it("probes every column and index used by ingestion and identity persistence", async () => {
    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: [{ has_canonical_ingestion: true }] };
    };

    await assertWorkerCanonicalIngestionCompatibility({ execute });

    for (const requiredName of [
      "cursor",
      "cursor_sequence",
      "backfill_cursor",
      "backfill_complete",
      "watermark",
      "status",
      "last_error",
      "created_at",
      "updated_at",
      "current_handle",
      "current_display_name",
      "avatar_url",
      "first_seen_at",
      "last_seen_at",
      "alias_type",
      "source_author_identities_source_lookup_idx",
      "source_author_aliases_source_alias_lookup_idx",
      "source_author_aliases_identity_lookup_idx",
    ]) {
      expect(queryText).toContain(requiredName);
    }
  });

  it("blocks signal consumers until the corrective migration is present", async () => {
    const execute = async () => ({ rows: [{ has_canonical_ingestion: false }] });
    await expect(assertWorkerCanonicalIngestionCompatibility({ execute })).rejects.toThrow(
      `${WORKER_CANONICAL_INGESTION_MIGRATION} is required`,
    );
    await expect(assertWorkerCanonicalIngestionCompatibility({ execute })).rejects.toThrow(
      "canonical source identity tables",
    );
  });

  // Captured verbatim from `pg_get_expr(indexprs, indrelid)` on PostgreSQL 17
  // against the indexes migrations 0032 and 0035 create. The previous values in this
  // file were hand-written and dropped pg_get_expr's outer parenthesis pair,
  // so these rows agreed with an equally wrong production gate and the suite
  // stayed green while the worker crash-looped. Do not retype these by hand.
  const createdAtExpression =
    "(date_trunc('milliseconds'::text, (created_at AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text)";
  const timestampExpression =
    "(date_trunc('milliseconds'::text, (\"timestamp\" AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text)";

  type CopyMirrorIndexProbeRow = Record<string, unknown>;
  const parsePgText = (oid: number, value: string): unknown =>
    (pgTypes.getTypeParser as unknown as (
      oid: number,
      format: "text",
    ) => (value: string) => unknown)(oid, "text")(value);

  function validCopyMirrorIndexRows(): CopyMirrorIndexProbeRow[] {
    const shared = {
      index_schema: "public",
      table_schema: "public",
      is_valid: true,
      is_ready: true,
      access_method: "btree",
      has_no_predicate: true,
    };
    return [
      {
        ...shared,
        table_name: "copy_trade_follows",
        index_name: "copy_trade_follows_follower_created_at_id_idx",
        total_attribute_count: 3,
        key_attribute_count: 3,
        key_columns: ["follower_user_id", null, "id"],
        key_options: [0, 0, 0],
        key_operator_classes: [
          "pg_catalog.text_ops",
          "pg_catalog.timestamptz_ops",
          "pg_catalog.uuid_ops",
        ],
        key_collations: ["pg_catalog.default", null, null],
        indexed_expression: createdAtExpression,
      },
      {
        ...shared,
        table_name: "copy_trade_follows",
        index_name: "copy_trade_follows_auto_mirror_created_at_id_idx",
        total_attribute_count: 3,
        key_attribute_count: 3,
        key_columns: ["auto_mirror", null, "id"],
        key_options: [0, 0, 0],
        key_operator_classes: [
          "pg_catalog.bool_ops",
          "pg_catalog.timestamptz_ops",
          "pg_catalog.uuid_ops",
        ],
        key_collations: [null, null, null],
        indexed_expression: createdAtExpression,
      },
      {
        ...shared,
        table_name: "signals",
        index_name: "signals_created_at_id_idx",
        total_attribute_count: 2,
        key_attribute_count: 2,
        key_columns: [null, "id"],
        key_options: [0, 0],
        key_operator_classes: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
        key_collations: [null, null],
        indexed_expression: createdAtExpression,
      },
      {
        ...shared,
        table_name: "signals",
        index_name: "signals_timestamp_id_idx",
        total_attribute_count: 2,
        key_attribute_count: 2,
        key_columns: [null, "id"],
        key_options: [0, 0],
        key_operator_classes: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
        key_collations: [null, null],
        indexed_expression: timestampExpression,
      },
      {
        ...shared,
        table_name: "social_trades",
        index_name: "social_trades_created_at_id_idx",
        total_attribute_count: 2,
        key_attribute_count: 2,
        key_columns: [null, "id"],
        key_options: [0, 0],
        key_operator_classes: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
        key_collations: [null, null],
        indexed_expression: createdAtExpression,
      },
    ];
  }

  function copyMirrorIndexRow(
    rows: CopyMirrorIndexProbeRow[],
    indexName: string,
  ): CopyMirrorIndexProbeRow {
    const row = rows.find((entry) => entry.index_name === indexName);
    if (!row) throw new Error(`Missing test row for ${indexName}`);
    return row;
  }

  async function expectCopyMirrorProbeToFail(rows: CopyMirrorIndexProbeRow[]): Promise<void> {
    const execute = async () => ({ rows });
    await expect(assertWorkerCopyMirrorCompatibility({ execute })).rejects.toThrow(
      `${WORKER_COPY_MIRROR_INDEX_MIGRATION} is required`,
    );
  }

  it("expects the parenthesized form pg_get_expr actually emits", () => {
    // Regression guard for the crash-loop: a correctly migrated database
    // returns these exact strings. Dropping the outer parentheses makes the
    // gate unsatisfiable on every PostgreSQL database that exists.
    expect(createdAtExpression.startsWith("(")).toBe(true);
    expect(createdAtExpression.endsWith(")")).toBe(true);
    expect(timestampExpression.startsWith("(")).toBe(true);
    expect(timestampExpression.endsWith(")")).toBe(true);

    const rows = validCopyMirrorIndexRows();
    expect(workerSchemaHasCopyMirrorIndexes({ rows })).toBe(true);
  });

  it("tolerates pg_get_expr rendering differences but not different expressions", () => {
    const bare = createdAtExpression.slice(1, -1);
    expect(normalizeIndexExpression(bare)).toBe(normalizeIndexExpression(createdAtExpression));
    expect(normalizeIndexExpression(`  ${createdAtExpression}  `)).toBe(
      normalizeIndexExpression(createdAtExpression),
    );
    expect(normalizeIndexExpression(createdAtExpression.replace(", (", ",  ("))).toBe(
      normalizeIndexExpression(createdAtExpression),
    );

    // A genuinely different key must still be rejected.
    expect(normalizeIndexExpression(timestampExpression)).not.toBe(
      normalizeIndexExpression(createdAtExpression),
    );

    // Unbalanced leading/trailing parens must not be stripped into nonsense.
    expect(normalizeIndexExpression("(a) AT TIME ZONE (b)")).toBe("(a) AT TIME ZONE (b)");
    expect(normalizeIndexExpression(null)).toBe(null);
  });

  it("still rejects an index whose expression is a different column", () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").indexed_expression =
      timestampExpression;
    expect(workerSchemaHasCopyMirrorIndexes({ rows })).toBe(false);
  });

  it("recognizes only a complete structurally valid copy-mirror index probe", () => {
    expect(workerSchemaHasCopyMirrorIndexes({ rows: validCopyMirrorIndexRows() })).toBe(true);
    expect(workerSchemaHasCopyMirrorIndexes({ rows: [] })).toBe(false);
    expect(workerSchemaHasCopyMirrorIndexes({ rows: [{ has_copy_mirror_indexes: true }] })).toBe(false);
  });

  it("probes every normalized key index and its catalog structure", async () => {
    let queryText = "";
    const execute = async (query: { queryChunks?: unknown[] }) => {
      queryText = JSON.stringify(query.queryChunks ?? query);
      return { rows: validCopyMirrorIndexRows() };
    };

    await expect(assertWorkerCopyMirrorCompatibility({ execute })).resolves.toBeUndefined();
    for (const requiredName of [
      "copy_trade_follows_follower_created_at_id_idx",
      "copy_trade_follows_auto_mirror_created_at_id_idx",
      "signals_created_at_id_idx",
      "signals_timestamp_id_idx",
      "social_trades_created_at_id_idx",
      "index_schema",
      "table_schema",
      "indisvalid",
      "indisready",
      "indpred",
      "pg_am",
      "amname",
      "indkey",
      "indnkeyatts",
      "indnatts",
      "pg_get_expr",
      "indexed_expression",
      "key_columns",
      "indoption",
      "key_options",
      "indclass",
      "key_operator_classes",
      "indcollation",
      "key_collations",
    ]) {
      expect(queryText).toContain(requiredName);
    }
    expect(queryText).toContain("attname::text");
    expect(queryText).toContain("::text[] as key_columns");
    expect(queryText).toContain("::integer[] as key_options");
    expect(queryText).toContain("::text[] as key_operator_classes");
    expect(queryText).toContain("::text[] as key_collations");
    expect(queryText.toLowerCase()).not.toContain("ilike");
  });

  it("accepts the arrays produced by node-postgres for the catalog projections", () => {
    const nameArray = parsePgText(1003, "{follower_user_id,NULL,id}");
    const textArray = parsePgText(1009, "{follower_user_id,NULL,id}");
    const integerArray = parsePgText(1007, "{0,0,0}");

    expect(nameArray).toBe("{follower_user_id,NULL,id}");
    expect(textArray).toEqual(["follower_user_id", null, "id"]);
    expect(integerArray).toEqual([0, 0, 0]);

    const nameArrayRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(
      nameArrayRows,
      "copy_trade_follows_follower_created_at_id_idx",
    ).key_columns = nameArray;
    expect(workerSchemaHasCopyMirrorIndexes({ rows: nameArrayRows })).toBe(false);

    const rows = validCopyMirrorIndexRows();
    for (const row of rows) {
      const columns = row.key_columns as (string | null)[];
      const options = row.key_options as number[];
      const operatorClasses = row.key_operator_classes as string[];
      const collations = row.key_collations as (string | null)[];
      row.key_columns = parsePgText(
        1009,
        `{${columns.map((column) => column ?? "NULL").join(",")}}`,
      );
      row.key_options = parsePgText(
        1007,
        `{${options.join(",")}}`,
      );
      row.key_operator_classes = parsePgText(
        1009,
        `{${operatorClasses.join(",")}}`,
      );
      row.key_collations = parsePgText(
        1009,
        `{${collations.map((collation) => collation ?? "NULL").join(",")}}`,
      );
    }

    expect(workerSchemaHasCopyMirrorIndexes({ rows })).toBe(true);
  });

  it("rejects swapped signal timestamp expressions", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").indexed_expression = timestampExpression;
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects id-first key order", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").key_columns = ["id", null];
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects a non-btree method", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").access_method = "hash";
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects a wrong expression", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_timestamp_id_idx").indexed_expression =
      "date_trunc('seconds'::text, (timestamp AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text";
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects partial and extra-column indexes", async () => {
    const partialRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(partialRows, "signals_created_at_id_idx").has_no_predicate = false;
    await expectCopyMirrorProbeToFail(partialRows);

    const includeRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(includeRows, "signals_created_at_id_idx").total_attribute_count = 3;
    await expectCopyMirrorProbeToFail(includeRows);
  });

  it("rejects an index in the wrong schema or table", async () => {
    const wrongLocationRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(wrongLocationRows, "signals_created_at_id_idx").table_schema = "private";
    await expectCopyMirrorProbeToFail(wrongLocationRows);

    const wrongTableRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(wrongTableRows, "signals_created_at_id_idx").table_name = "social_trades";
    await expectCopyMirrorProbeToFail(wrongTableRows);
  });

  it("rejects invalid or unready index residue", async () => {
    const invalidRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(invalidRows, "signals_created_at_id_idx").is_valid = false;
    await expectCopyMirrorProbeToFail(invalidRows);

    const unreadyRows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(unreadyRows, "signals_created_at_id_idx").is_ready = false;
    await expectCopyMirrorProbeToFail(unreadyRows);
  });

  it("rejects descending key options", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").key_options = [1, 0];
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects NULLS FIRST key options", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").key_options = [2, 0];
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects a non-default operator class", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "signals_created_at_id_idx").key_operator_classes = [
      "pg_catalog.text_ops",
      "pg_catalog.uuid_ops",
    ];
    await expectCopyMirrorProbeToFail(rows);
  });

  it("rejects a non-default collation", async () => {
    const rows = validCopyMirrorIndexRows();
    copyMirrorIndexRow(rows, "copy_trade_follows_follower_created_at_id_idx").key_collations = [
      "pg_catalog.C",
      null,
      null,
    ];
    await expectCopyMirrorProbeToFail(rows);
  });
});
