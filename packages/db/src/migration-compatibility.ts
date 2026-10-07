import { sql, type SQL } from "drizzle-orm";

export const WORKER_ORDER_ID_MIGRATION = "0029_free_whirlwind";
export const WORKER_CANONICAL_INGESTION_MIGRATION = "0031_useful_pixie";
export const WORKER_COPY_MIRROR_INDEX_MIGRATION = "0035_restore_copy_mirror_indexes";
export const WORKER_COPY_TRADE_LEVERAGE_MIGRATION = "0038_copy_trade_leverage_caps";
export const WORKER_WALLET_COPY_CURSOR_MIGRATION = "0039_hl_wallet_copy_cursors";
export const WORKER_COPY_TRADE_CAP_MIGRATION = "0041_copy_trade_cap_constraints";
export const WORKER_COPY_MIRROR_DESTINATIONS_MIGRATION = "0042_independent_copy_mirrors";

type CompatibilityResult = { rows?: readonly unknown[] };
type CompatibilityDb = { execute(query: SQL): Promise<unknown> };

// The canonical form pg_get_expr returns for the shared millisecond key used
// by the pagination helper and migrations 0032/0035. Keep expression matching exact,
// so an index on the other signal timestamp cannot satisfy this gate.
//
// These strings are transcribed from live PostgreSQL 17 output, not written by
// hand. pg_get_expr wraps an index expression in its own parentheses, and the
// first version of this gate omitted that outer pair, so the comparison below
// could never be true and the worker crash-looped on a correctly migrated
// database. Re-capture against a database with the current 0035 repair applied:
//
//   select pg_get_expr(indexprs, indrelid) from pg_index
//   where indexrelid = 'signals_created_at_id_idx'::regclass;
const CREATED_AT_INDEX_EXPRESSION =
  "(date_trunc('milliseconds'::text, (created_at AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text)";
const TIMESTAMP_INDEX_EXPRESSION =
  "(date_trunc('milliseconds'::text, (\"timestamp\" AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text)";

type CopyMirrorIndexSpec = {
  indexSchema: string;
  tableSchema: string;
  tableName: string;
  indexName: string;
  totalAttributeCount: number;
  keyAttributeCount: number;
  keyColumns: readonly (string | null)[];
  keyOptions: readonly number[];
  keyOperatorClasses: readonly string[];
  keyCollations: readonly (string | null)[];
  indexedExpression: string;
};

const COPY_MIRROR_INDEX_SPECS: readonly CopyMirrorIndexSpec[] = [
  {
    indexSchema: "public",
    tableSchema: "public",
    tableName: "copy_trade_follows",
    indexName: "copy_trade_follows_follower_created_at_id_idx",
    totalAttributeCount: 3,
    keyAttributeCount: 3,
    keyColumns: ["follower_user_id", null, "id"],
    keyOptions: [0, 0, 0],
    keyOperatorClasses: [
      "pg_catalog.text_ops",
      "pg_catalog.timestamptz_ops",
      "pg_catalog.uuid_ops",
    ],
    keyCollations: ["pg_catalog.default", null, null],
    indexedExpression: CREATED_AT_INDEX_EXPRESSION,
  },
  {
    indexSchema: "public",
    tableSchema: "public",
    tableName: "copy_trade_follows",
    indexName: "copy_trade_follows_auto_mirror_created_at_id_idx",
    totalAttributeCount: 3,
    keyAttributeCount: 3,
    keyColumns: ["auto_mirror", null, "id"],
    keyOptions: [0, 0, 0],
    keyOperatorClasses: [
      "pg_catalog.bool_ops",
      "pg_catalog.timestamptz_ops",
      "pg_catalog.uuid_ops",
    ],
    keyCollations: [null, null, null],
    indexedExpression: CREATED_AT_INDEX_EXPRESSION,
  },
  {
    indexSchema: "public",
    tableSchema: "public",
    tableName: "signals",
    indexName: "signals_created_at_id_idx",
    totalAttributeCount: 2,
    keyAttributeCount: 2,
    keyColumns: [null, "id"],
    keyOptions: [0, 0],
    keyOperatorClasses: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
    keyCollations: [null, null],
    indexedExpression: CREATED_AT_INDEX_EXPRESSION,
  },
  {
    indexSchema: "public",
    tableSchema: "public",
    tableName: "signals",
    indexName: "signals_timestamp_id_idx",
    totalAttributeCount: 2,
    keyAttributeCount: 2,
    keyColumns: [null, "id"],
    keyOptions: [0, 0],
    keyOperatorClasses: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
    keyCollations: [null, null],
    indexedExpression: TIMESTAMP_INDEX_EXPRESSION,
  },
  {
    indexSchema: "public",
    tableSchema: "public",
    tableName: "social_trades",
    indexName: "social_trades_created_at_id_idx",
    totalAttributeCount: 2,
    keyAttributeCount: 2,
    keyColumns: [null, "id"],
    keyOptions: [0, 0],
    keyOperatorClasses: ["pg_catalog.timestamptz_ops", "pg_catalog.uuid_ops"],
    keyCollations: [null, null],
    indexedExpression: CREATED_AT_INDEX_EXPRESSION,
  },
];

/** Pure result decoder so the startup gate is testable without a database. */
export function workerSchemaHasOrderId(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  return record.has_order_id === true || record.hasOrderId === true;
}

/** Pure result decoder for the canonical identity and ingestion cursor gate. */
export function workerSchemaHasCanonicalIngestion(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  return (
    record.has_canonical_ingestion === true ||
    record.hasCanonicalIngestion === true
  );
}

/** Pure result decoder for the copy-trade leverage-cap schema gate. */
export function workerSchemaHasCopyTradeLeverage(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;

  if (
    record.has_copy_trade_leverage === true ||
    record.hasCopyTradeLeverage === true
  ) {
    return true;
  }

  return (
    record.has_user_copy_perp_max_leverage === true &&
    record.has_copy_trade_follows_perp_max_leverage === true &&
    record.has_users_copy_perp_max_leverage_range_check === true &&
    record.has_copy_trade_follows_perp_max_leverage_range_check === true
  );
}

/** Pure result decoder for the independent stock/perp mirror schema gate. */
export function workerSchemaHasCopyMirrorDestinations(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  return (
    record.has_copy_mirror_destination_columns === true &&
    record.has_copy_mirror_destination_foreign_keys === true &&
    record.has_copy_mirror_destination_constraints === true &&
    record.has_copy_mirror_destination_indexes === true
  );
}

/** Pure decoder for migration 0041's persisted dollar-cap contract. */
export function workerSchemaHasCopyTradeCaps(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;

  const hasConstraintDefinitions =
    "max_trade_size_range_check_definition" in record ||
    "max_coin_size_range_check_definition" in record;
  if (hasConstraintDefinitions) {
    return (
      record.has_exact_copy_trade_cap_columns === true &&
      isExactCopyTradeCapConstraint(
        record.max_trade_size_range_check_definition,
        "max_trade_size",
      ) &&
      isExactCopyTradeCapConstraint(
        record.max_coin_size_range_check_definition,
        "max_coin_size",
      )
    );
  }

  if (
    record.has_copy_trade_caps === true ||
    record.hasCopyTradeCaps === true
  ) {
    return true;
  }

  return (
    record.has_exact_copy_trade_cap_columns === true &&
    record.has_max_trade_size_range_check === true &&
    record.has_max_coin_size_range_check === true
  );
}

type CopyTradeCapToken = {
  kind: "number" | "symbol" | "word";
  value: string;
};

type CopyTradeCapExpression =
  | { kind: "and" | "or"; left: CopyTradeCapExpression; right: CopyTradeCapExpression }
  | { kind: "comparison"; column: string; operator: ">" | "<="; value: string }
  | { kind: "is-null"; column: string };

function tokenizeCopyTradeCapConstraint(value: unknown): CopyTradeCapToken[] | null {
  if (typeof value !== "string") return null;

  const tokens: CopyTradeCapToken[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character && /\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === '"') {
      let end = index + 1;
      let identifier = "";
      while (end < value.length) {
        const quotedCharacter = value[end];
        if (quotedCharacter === '"') {
          if (value[end + 1] === '"') {
            identifier += '"';
            end += 2;
            continue;
          }
          break;
        }
        identifier += quotedCharacter;
        end += 1;
      }
      if (end >= value.length || value[end] !== '"' || identifier.length === 0) {
        return null;
      }
      tokens.push({ kind: "word", value: identifier.toLowerCase() });
      index = end + 1;
      continue;
    }

    if (character && /[a-z_]/i.test(character)) {
      const match = value.slice(index).match(/^[a-z_][a-z0-9_$]*/i);
      if (!match) return null;
      tokens.push({ kind: "word", value: match[0].toLowerCase() });
      index += match[0].length;
      continue;
    }

    if (
      (character && /[0-9]/.test(character)) ||
      (character === "." && /[0-9]/.test(value[index + 1] ?? ""))
    ) {
      const match = value
        .slice(index)
        .match(/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?/i);
      if (!match) return null;
      tokens.push({ kind: "number", value: match[0] });
      index += match[0].length;
      continue;
    }

    const twoCharacterSymbol = value.slice(index, index + 2);
    if (["::", "<=", ">="].includes(twoCharacterSymbol)) {
      tokens.push({ kind: "symbol", value: twoCharacterSymbol });
      index += 2;
      continue;
    }
    if (["(", ")", ".", ">", "<"].includes(character ?? "")) {
      tokens.push({ kind: "symbol", value: character ?? "" });
      index += 1;
      continue;
    }

    return null;
  }

  return tokens;
}

class CopyTradeCapConstraintParser {
  private index = 0;

  constructor(private readonly tokens: readonly CopyTradeCapToken[]) {}

  parse(): CopyTradeCapExpression | null {
    if (!this.consumeWord("check") || !this.consumeSymbol("(")) return null;
    const expression = this.parseOr();
    if (!expression || !this.consumeSymbol(")") || !this.atEnd()) return null;
    return expression;
  }

  private parseOr(): CopyTradeCapExpression | null {
    let expression = this.parseAnd();
    while (expression && this.consumeWord("or")) {
      const right = this.parseAnd();
      if (!right) return null;
      expression = { kind: "or", left: expression, right };
    }
    return expression;
  }

  private parseAnd(): CopyTradeCapExpression | null {
    let expression = this.parsePrimary();
    while (expression && this.consumeWord("and")) {
      const right = this.parsePrimary();
      if (!right) return null;
      expression = { kind: "and", left: expression, right };
    }
    return expression;
  }

  private parsePrimary(): CopyTradeCapExpression | null {
    const start = this.index;
    const column = this.parseIdentifier();
    if (column) {
      const predicate = this.parsePredicate(column);
      if (predicate) return predicate;
    }
    this.index = start;

    if (!this.consumeSymbol("(")) return null;
    const expression = this.parseOr();
    if (!expression || !this.consumeSymbol(")")) return null;
    return expression;
  }

  private parsePredicate(column: string): CopyTradeCapExpression | null {
    if (this.consumeWord("is")) {
      if (!this.consumeWord("null")) return null;
      return { kind: "is-null", column };
    }

    const operator = this.consumeOperator();
    if (!operator) return null;
    const value = this.parseNumericValue();
    if (value === null) return null;
    return { kind: "comparison", column, operator, value };
  }

  private parseIdentifier(): string | null {
    if (this.consumeSymbol("(")) {
      const identifier = this.parseIdentifier();
      if (!identifier || !this.consumeSymbol(")")) return null;
      return identifier;
    }

    const token = this.peek();
    if (!token || token.kind !== "word") return null;
    if (["and", "check", "is", "null", "or"].includes(token.value)) return null;
    this.index += 1;
    return token.value;
  }

  private parseNumericValue(): string | null {
    let value: string | null;
    if (this.consumeSymbol("(")) {
      value = this.parseNumericValue();
      if (value === null || !this.consumeSymbol(")")) return null;
    } else {
      const token = this.peek();
      if (!token || token.kind !== "number") return null;
      this.index += 1;
      value = token.value;
    }

    while (this.consumeSymbol("::")) {
      if (!this.parseNumericTypeName()) return null;
    }
    return value;
  }

  private parseNumericTypeName(): boolean {
    const first = this.consumeWordToken();
    if (!first) return false;
    if (first === "numeric") return true;
    return (
      first === "pg_catalog" &&
      this.consumeSymbol(".") &&
      this.consumeWord("numeric")
    );
  }

  private consumeOperator(): ">" | "<=" | null {
    const token = this.peek();
    if (!token || token.kind !== "symbol") return null;
    if (token.value === ">" || token.value === "<=") {
      this.index += 1;
      return token.value;
    }
    return null;
  }

  private consumeWord(value: string): boolean {
    const token = this.peek();
    if (!token || token.kind !== "word" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private consumeWordToken(): string | null {
    const token = this.peek();
    if (!token || token.kind !== "word") return null;
    this.index += 1;
    return token.value;
  }

  private consumeSymbol(value: string): boolean {
    const token = this.peek();
    if (!token || token.kind !== "symbol" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private peek(): CopyTradeCapToken | undefined {
    return this.tokens[this.index];
  }

  private atEnd(): boolean {
    return this.index === this.tokens.length;
  }
}

function numericLiteralEquals(value: string, expected: "0" | "1000000"): boolean {
  const match = value.match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return false;

  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return false;

  let digits = `${match[1]}${match[2] ?? ""}`.replace(/^0+(?=\d)/, "");
  let decimalPlaces = (match[2]?.length ?? 0) - exponent;
  if (digits === "0") return expected === "0";
  while (decimalPlaces > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    decimalPlaces -= 1;
  }
  if (decimalPlaces < 0) digits += "0".repeat(-decimalPlaces);
  return decimalPlaces <= 0 && digits === expected;
}

function isExactCopyTradeCapConstraint(value: unknown, column: string): boolean {
  const tokens = tokenizeCopyTradeCapConstraint(value);
  if (!tokens) return false;
  const expression = new CopyTradeCapConstraintParser(tokens).parse();
  if (!expression || expression.kind !== "or") return false;
  if (
    expression.left.kind !== "is-null" ||
    expression.left.column !== column ||
    expression.right.kind !== "and"
  ) {
    return false;
  }

  const comparisons = [expression.right.left, expression.right.right];
  const lowerBound = comparisons.find(
    (entry) =>
      entry.kind === "comparison" &&
      entry.column === column &&
      entry.operator === ">" &&
      numericLiteralEquals(entry.value, "0"),
  );
  const upperBound = comparisons.find(
    (entry) =>
      entry.kind === "comparison" &&
      entry.column === column &&
      entry.operator === "<=" &&
      numericLiteralEquals(entry.value, "1000000"),
  );
  return Boolean(lowerBound && upperBound);
}

/** Pure decoder for migration 0039's durable wallet-source cursor contract. */
export function workerSchemaHasWalletCopyCursor(result: unknown): boolean {
  const row = (result as CompatibilityResult | null | undefined)?.rows?.[0];
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  return (
    record.has_wallet_copy_cursor_table === true &&
    record.has_exact_wallet_copy_cursor_columns === true &&
    record.has_wallet_copy_cursor_primary_key === true &&
    record.has_wallet_copy_cursor_user_foreign_key === true &&
    record.has_wallet_copy_cursor_follower_index === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactArray<T>(value: unknown, expected: readonly T[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((entry, index) => value[index] === entry)
  );
}

/**
 * Compare index expressions without being hostage to pg_get_expr formatting.
 *
 * The gate stays structurally exact: operator classes, collations, column
 * order and key counts are still matched byte for byte. Only the deparsed
 * expression is normalized, because its rendering is a PostgreSQL
 * implementation detail that has already changed once (the outer parenthesis
 * pair) and differs in whitespace between major versions. A mismatch there
 * means a correctly migrated production database refuses to start the worker,
 * which is a far worse failure than accepting a semantically identical
 * expression that was spelled slightly differently.
 */
export function normalizeIndexExpression(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s+/g, " ");

  // Strip redundant outer parentheses, but only when the leading "(" is
  // actually closed by the trailing ")". Without that check, "(a) AT TIME ZONE
  // (b)" would be mangled into "a) AT TIME ZONE (b".
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wrapsWholeString = true;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index < text.length - 1) {
          wrapsWholeString = false;
          break;
        }
      }
    }
    if (!wrapsWholeString || depth !== 0) break;
    text = text.slice(1, -1).trim();
  }

  return text;
}

function matchesCopyMirrorIndexSpec(
  row: unknown,
  spec: CopyMirrorIndexSpec,
): boolean {
  if (!isRecord(row)) return false;
  return (
    row.index_schema === spec.indexSchema &&
    row.table_schema === spec.tableSchema &&
    row.table_name === spec.tableName &&
    row.index_name === spec.indexName &&
    row.is_valid === true &&
    row.is_ready === true &&
    row.access_method === "btree" &&
    row.total_attribute_count === spec.totalAttributeCount &&
    row.key_attribute_count === spec.keyAttributeCount &&
    row.has_no_predicate === true &&
    normalizeIndexExpression(row.indexed_expression) ===
      normalizeIndexExpression(spec.indexedExpression) &&
    hasExactArray(row.key_columns, spec.keyColumns) &&
    hasExactArray(row.key_options, spec.keyOptions) &&
    hasExactArray(row.key_operator_classes, spec.keyOperatorClasses) &&
    hasExactArray(row.key_collations, spec.keyCollations)
  );
}

/** Pure result decoder for the structurally exact copy-mirror index gate. */
export function workerSchemaHasCopyMirrorIndexes(result: unknown): boolean {
  const rows = (result as CompatibilityResult | null | undefined)?.rows;
  if (!Array.isArray(rows) || rows.length !== COPY_MIRROR_INDEX_SPECS.length) {
    return false;
  }

  return COPY_MIRROR_INDEX_SPECS.every((spec) => {
    const matchingRows = rows.filter(
      (row) => isRecord(row) && row.index_name === spec.indexName,
    );
    return matchingRows.length === 1 && matchesCopyMirrorIndexSpec(matchingRows[0], spec);
  });
}

/** Block worker jobs until the live schema can persist social order links. */
export async function assertWorkerSchemaCompatibility(db: CompatibilityDb): Promise<void> {
  const result = await db.execute(sql`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'social_trades'
        and column_name = 'order_id'
    ) as has_order_id
  `);
  if (workerSchemaHasOrderId(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_ORDER_ID_MIGRATION} is required: ` +
    `public.social_trades.order_id is missing. Apply committed migrations before starting Railway worker jobs.`,
  );
}

/** Block signal consumers until canonical identity and cursor tables exist. */
export async function assertWorkerCanonicalIngestionCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select (
      exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'source_author_identities'
      )
      and exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
      )
      and exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'source'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'source_event_id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'source_author_id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'symbol'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'content'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'url'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'timestamp'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'metadata'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signals'
          and column_name = 'created_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'source'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'cursor'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'cursor_sequence'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'backfill_cursor'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'backfill_complete'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'watermark'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'status'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'last_error'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'created_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and column_name = 'updated_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'source'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'source_author_id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'canonical_key'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'current_handle'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'current_display_name'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'avatar_url'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'first_seen_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'last_seen_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'created_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_identities'
          and column_name = 'updated_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'identity_id'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'source'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'alias'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'alias_type'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'first_seen_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'last_seen_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'created_at'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'source_author_aliases'
          and column_name = 'updated_at'
      )
      and exists (
        select 1
        from pg_class index_rel
        inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'signals'
          and index_rel.relname = 'signals_source_event_unique_idx'
          and index_meta.indisunique
          and index_meta.indpred is not null
          and pg_get_indexdef(index_rel.oid) ilike '%source%source_event_id%'
          and pg_get_expr(index_meta.indpred, index_meta.indrelid) ilike '%source_event_id%is not null%'
      )
      and exists (
        select 1
        from pg_class index_rel
        inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'signals'
          and index_rel.relname = 'signals_source_author_idx'
      )
      and exists (
        select 1
        from pg_class index_rel
        inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'source_author_aliases'
          and index_rel.relname = 'source_author_aliases_source_alias_lookup_idx'
      )
      and exists (
        select 1
        from pg_class index_rel
        inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'source_author_aliases'
          and index_rel.relname = 'source_author_aliases_identity_lookup_idx'
      )
      and exists (
        select 1
        from pg_class index_rel
        inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'source_author_identities'
          and index_rel.relname = 'source_author_identities_source_lookup_idx'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_aliases'
          and constraint_type = 'PRIMARY KEY'
          and constraint_name = 'source_author_aliases_pkey'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_identities'
          and constraint_type = 'PRIMARY KEY'
          and constraint_name = 'source_author_identities_pkey'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_aliases'
          and constraint_type = 'FOREIGN KEY'
          and constraint_name = 'source_author_aliases_identity_id_source_author_identities_id_fk'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_aliases'
          and constraint_type = 'UNIQUE'
          and constraint_name = 'source_author_aliases_identity_alias_unique'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_identities'
          and constraint_type = 'UNIQUE'
          and constraint_name = 'source_author_identities_source_author_unique'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'source_author_identities'
          and constraint_type = 'UNIQUE'
          and constraint_name = 'source_author_identities_canonical_key_unique'
      )
      and exists (
        select 1
        from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'signal_ingestion_cursors'
          and constraint_type = 'PRIMARY KEY'
          and constraint_name = 'signal_ingestion_cursors_pkey'
      )
    ) as has_canonical_ingestion
  `);
  if (workerSchemaHasCanonicalIngestion(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_CANONICAL_INGESTION_MIGRATION} is required: ` +
      "canonical source identity tables, signal ingestion cursors, or signal event columns are missing. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}

/** Block copy-trade perps until migration 0038's leverage-cap schema is exact. */
export async function assertWorkerCopyTradeLeverageCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'users'
          and column_name = 'copy_perp_max_leverage'
          and data_type = 'integer'
          and udt_schema = 'pg_catalog'
          and udt_name = 'int4'
          and is_nullable = 'NO'
          and column_default = '1'
      ) as has_user_copy_perp_max_leverage,
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'copy_trade_follows'
          and column_name = 'perp_max_leverage'
          and data_type = 'integer'
          and udt_schema = 'pg_catalog'
          and udt_name = 'int4'
          and is_nullable = 'YES'
          and column_default is null
      ) as has_copy_trade_follows_perp_max_leverage,
      exists (
        select 1
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'users'
          and constraint_rel.conname = 'users_copy_perp_max_leverage_range_check'
          and constraint_rel.contype = 'c'
          and constraint_rel.convalidated
          and regexp_replace(
            lower(pg_get_constraintdef(constraint_rel.oid, true)),
            '[[:space:]]+',
            '',
            'g'
          ) = 'check(copy_perp_max_leverage>=1andcopy_perp_max_leverage<=100)'
      ) as has_users_copy_perp_max_leverage_range_check,
      exists (
        select 1
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          and constraint_rel.conname = 'copy_trade_follows_perp_max_leverage_range_check'
          and constraint_rel.contype = 'c'
          and constraint_rel.convalidated
          and regexp_replace(
            lower(pg_get_constraintdef(constraint_rel.oid, true)),
            '[[:space:]]+',
            '',
            'g'
          ) = 'check(perp_max_leverageisnullorperp_max_leverage>=1andperp_max_leverage<=100)'
      ) as has_copy_trade_follows_perp_max_leverage_range_check
  `);
  if (workerSchemaHasCopyTradeLeverage(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_COPY_TRADE_LEVERAGE_MIGRATION} is required: ` +
      "copy-trade leverage columns or their exact 1..100 range constraints are missing or have the wrong definition. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}

/** Block copy-trade workers until migration 0041's dollar-cap schema is exact. */
export async function assertWorkerCopyTradeCapsCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select
      (
        select count(*) = 2 and count(*) filter (where
          data_type = 'numeric'
          and numeric_precision = 12
          and numeric_scale = 2
          and is_nullable = 'YES'
          and column_default is null
        ) = 2
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'copy_trade_follows'
          and column_name in ('max_trade_size', 'max_coin_size')
      ) as has_exact_copy_trade_cap_columns,
      (
        select pg_get_constraintdef(constraint_rel.oid, true)
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          and constraint_rel.conname = 'copy_trade_follows_max_trade_size_range_check'
          and constraint_rel.contype = 'c'
          and constraint_rel.convalidated
        limit 1
      ) as max_trade_size_range_check_definition,
      (
        select pg_get_constraintdef(constraint_rel.oid, true)
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          and constraint_rel.conname = 'copy_trade_follows_max_coin_size_range_check'
          and constraint_rel.contype = 'c'
          and constraint_rel.convalidated
        limit 1
      ) as max_coin_size_range_check_definition
  `);
  if (workerSchemaHasCopyTradeCaps(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_COPY_TRADE_CAP_MIGRATION} is required: ` +
      "copy-trade dollar-cap columns or their positive 1..1000000 range constraints are missing or malformed. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}

/** Block both mirror execution paths until migration 0042 is structurally complete. */
export async function assertWorkerCopyMirrorDestinationsCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select
      (
        select count(*) = 9 and count(*) filter (where
          (column_name in ('stock_credential_id', 'perp_credential_id')
            and data_type = 'uuid'
            and is_nullable = 'YES'
            and column_default is null)
          or (column_name in ('stock_auto_mirror', 'perp_auto_mirror')
            and data_type = 'boolean'
            and is_nullable = 'NO'
            and column_default = 'false')
          or (column_name in ('stock_sizing_mode', 'perp_sizing_mode')
            and data_type = 'text'
            and is_nullable = 'NO'
            and column_default = '''pct''::text')
          or (column_name in ('stock_sizing_value', 'perp_sizing_value')
            and data_type = 'numeric'
            and numeric_precision = 12
            and numeric_scale = 2
            and is_nullable = 'NO'
            and column_default = '''5''::numeric')
          or (column_name = 'destination_policy_initialized'
            and data_type = 'boolean'
            and is_nullable = 'NO'
            and column_default = 'false')
        ) = 9
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'copy_trade_follows'
          and column_name in (
            'stock_credential_id', 'stock_auto_mirror', 'stock_sizing_mode', 'stock_sizing_value',
            'perp_credential_id', 'perp_auto_mirror', 'perp_sizing_mode', 'perp_sizing_value',
            'destination_policy_initialized'
          )
      ) as has_copy_mirror_destination_columns,
      (
        select count(*) = 2
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        inner join pg_class foreign_rel on foreign_rel.oid = constraint_rel.confrelid
        inner join pg_namespace foreign_ns on foreign_ns.oid = foreign_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          -- PostgreSQL truncates identifiers to NAMEDATALEN - 1 (63 bytes),
          -- so compare the generated Drizzle names after that normalization.
          and constraint_rel.conname in (
            left('copy_trade_follows_stock_credential_id_user_api_credentials_id_fk', 63),
            left('copy_trade_follows_perp_credential_id_user_api_credentials_id_fk', 63)
          )
          and constraint_rel.contype = 'f'
          and constraint_rel.convalidated
          and constraint_rel.confdeltype = 'n'
          and foreign_ns.nspname = 'public'
          and foreign_rel.relname = 'user_api_credentials'
      ) as has_copy_mirror_destination_foreign_keys,
      (
        select count(*) = 3
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          and constraint_rel.conname in (
            'copy_trade_follows_auto_mirror_valid_check',
            'copy_trade_follows_stock_auto_mirror_valid_check',
            'copy_trade_follows_perp_auto_mirror_valid_check'
          )
          and constraint_rel.contype = 'c'
          and constraint_rel.convalidated
      ) as has_copy_mirror_destination_constraints,
      (
        select count(*) = 2
        from pg_index index_meta
        inner join pg_class index_rel on index_rel.oid = index_meta.indexrelid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        inner join pg_am access_method on access_method.oid = index_rel.relam
        where table_ns.nspname = 'public'
          and table_rel.relname = 'copy_trade_follows'
          and index_rel.relname in (
            'copy_trade_follows_stock_auto_mirror_created_at_id_idx',
            'copy_trade_follows_perp_auto_mirror_created_at_id_idx'
          )
          and access_method.amname = 'btree'
          and index_meta.indisvalid
          and index_meta.indisready
          and index_meta.indpred is null
      ) as has_copy_mirror_destination_indexes
  `);
  if (workerSchemaHasCopyMirrorDestinations(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_COPY_MIRROR_DESTINATIONS_MIGRATION} is required: ` +
      "the independent stock/perp mirror columns, sizing constraints, credential ownership constraints, or eligibility indexes are missing or malformed. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}

/** Block wallet-source polling until migration 0039 is structurally complete. */
export async function assertWorkerWalletCopyCursorCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select
      exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'hl_wallet_copy_cursors'
      ) as has_wallet_copy_cursor_table,
      (
        select count(*) = 5 and count(*) filter (where
          (column_name = 'follower_user_id' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'wallet_address' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'watermark_ms' and data_type = 'bigint' and is_nullable = 'NO' and column_default = '0')
          or (column_name = 'watermark_tid' and data_type = 'bigint' and is_nullable = 'NO' and column_default = '0')
          or (column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO' and column_default = 'now()')
        ) = 5
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'hl_wallet_copy_cursors'
      ) as has_exact_wallet_copy_cursor_columns,
      exists (
        select 1
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'hl_wallet_copy_cursors'
          and constraint_rel.conname = 'hl_wallet_copy_cursors_follower_user_id_wallet_address_pk'
          and constraint_rel.contype = 'p'
          and constraint_rel.convalidated
          and constraint_rel.conkey = array[
            (select attnum from pg_attribute where attrelid = table_rel.oid and attname = 'follower_user_id'),
            (select attnum from pg_attribute where attrelid = table_rel.oid and attname = 'wallet_address')
          ]::smallint[]
      ) as has_wallet_copy_cursor_primary_key,
      exists (
        select 1
        from pg_constraint constraint_rel
        inner join pg_class table_rel on table_rel.oid = constraint_rel.conrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        inner join pg_class foreign_rel on foreign_rel.oid = constraint_rel.confrelid
        inner join pg_namespace foreign_ns on foreign_ns.oid = foreign_rel.relnamespace
        where table_ns.nspname = 'public'
          and table_rel.relname = 'hl_wallet_copy_cursors'
          and constraint_rel.conname = 'hl_wallet_copy_cursors_follower_user_id_users_id_fk'
          and constraint_rel.contype = 'f'
          and constraint_rel.convalidated
          and foreign_ns.nspname = 'public'
          and foreign_rel.relname = 'users'
          and constraint_rel.confdeltype = 'c'
          and constraint_rel.confupdtype = 'a'
          and constraint_rel.conkey = array[
            (select attnum from pg_attribute where attrelid = table_rel.oid and attname = 'follower_user_id')
          ]::smallint[]
          and constraint_rel.confkey = array[
            (select attnum from pg_attribute where attrelid = foreign_rel.oid and attname = 'id')
          ]::smallint[]
      ) as has_wallet_copy_cursor_user_foreign_key,
      exists (
        select 1
        from pg_index index_meta
        inner join pg_class index_rel on index_rel.oid = index_meta.indexrelid
        inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
        inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
        inner join pg_am access_method on access_method.oid = index_rel.relam
        where table_ns.nspname = 'public'
          and table_rel.relname = 'hl_wallet_copy_cursors'
          and index_rel.relname = 'hl_wallet_copy_cursors_follower_idx'
          and access_method.amname = 'btree'
          and index_meta.indisvalid
          and index_meta.indisready
          and index_meta.indpred is null
          and index_meta.indexprs is null
          and index_meta.indnkeyatts = 1
          and index_meta.indnatts = 1
          and index_meta.indkey[0] = (
            select attnum
            from pg_attribute
            where attrelid = table_rel.oid
              and attname = 'follower_user_id'
          )
      ) as has_wallet_copy_cursor_follower_index
  `);
  if (workerSchemaHasWalletCopyCursor(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_WALLET_COPY_CURSOR_MIGRATION} is required: ` +
      "the durable Hyperliquid wallet-copy cursor table, keys, foreign key, columns, or index are missing or malformed. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}

/** Block the worker until every paged mirror key has an exact valid index. */
export async function assertWorkerCopyMirrorCompatibility(
  db: CompatibilityDb,
): Promise<void> {
  const result = await db.execute(sql`
    select
      index_ns.nspname as index_schema,
      table_ns.nspname as table_schema,
      table_rel.relname as table_name,
      index_rel.relname as index_name,
      index_meta.indisvalid as is_valid,
      index_meta.indisready as is_ready,
      access_method.amname as access_method,
      index_meta.indnatts as total_attribute_count,
      index_meta.indnkeyatts as key_attribute_count,
      (index_meta.indpred is null) as has_no_predicate,
      pg_get_expr(index_meta.indexprs, index_meta.indrelid) as indexed_expression,
      array(
        select key_attribute.attname::text
        from generate_subscripts(index_meta.indkey, 1) as key_position(position)
        left join pg_attribute key_attribute
          on key_attribute.attrelid = index_meta.indrelid
         and key_attribute.attnum = index_meta.indkey[key_position.position]
        order by key_position.position
      )::text[] as key_columns,
      array(
        select index_meta.indoption[key_position.position]::integer
        from generate_subscripts(index_meta.indkey, 1) as key_position(position)
        order by key_position.position
      )::integer[] as key_options,
      array(
        select case
          when key_operator_class.oid is null then null
          else key_operator_class_namespace.nspname::text || '.' || key_operator_class.opcname::text
        end
        from generate_subscripts(index_meta.indkey, 1) as key_position(position)
        left join pg_opclass key_operator_class
          on key_operator_class.oid = index_meta.indclass[key_position.position]
        left join pg_namespace key_operator_class_namespace
          on key_operator_class_namespace.oid = key_operator_class.opcnamespace
        order by key_position.position
      )::text[] as key_operator_classes,
      array(
        select case
          when index_meta.indcollation[key_position.position] = 0 then null
          else key_collation_namespace.nspname::text || '.' || key_collation.collname::text
        end
        from generate_subscripts(index_meta.indkey, 1) as key_position(position)
        left join pg_collation key_collation
          on key_collation.oid = index_meta.indcollation[key_position.position]
        left join pg_namespace key_collation_namespace
          on key_collation_namespace.oid = key_collation.collnamespace
        order by key_position.position
      )::text[] as key_collations
    from pg_class index_rel
    inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
    inner join pg_class table_rel on table_rel.oid = index_meta.indrelid
    inner join pg_namespace table_ns on table_ns.oid = table_rel.relnamespace
    inner join pg_namespace index_ns on index_ns.oid = index_rel.relnamespace
    inner join pg_am access_method on access_method.oid = index_rel.relam
    where index_rel.relname in (
      'copy_trade_follows_follower_created_at_id_idx',
      'copy_trade_follows_auto_mirror_created_at_id_idx',
      'signals_created_at_id_idx',
      'signals_timestamp_id_idx',
      'social_trades_created_at_id_idx'
    )
  `);
  if (workerSchemaHasCopyMirrorIndexes(result)) return;

  throw new Error(
    `[worker schema compatibility] ${WORKER_COPY_MIRROR_INDEX_MIGRATION} is required: ` +
      "one or more copy-mirror normalized key indexes is missing, invalid, or has the wrong definition. " +
      "Apply committed migrations before starting Railway worker jobs.",
  );
}
