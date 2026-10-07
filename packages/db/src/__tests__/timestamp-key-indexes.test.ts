import { describe, expect, it } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { copyTradeFollows, signals, socialTrades } from "../schema/index";

type TableForIndexes = Parameters<typeof getTableConfig>[0];
type IndexColumn = { name?: string };

const dialect = new PgDialect();

function indexColumns(table: TableForIndexes, name: string): readonly unknown[] {
  const index = getTableConfig(table).indexes.find((entry) => entry.config.name === name);
  expect(index).toBeDefined();
  return index?.config.columns ?? [];
}

function columnSql(column: unknown): string {
  return dialect.sqlToQuery(column as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

function assertNormalizedTimestampIndex(
  table: TableForIndexes,
  indexName: string,
  timestampColumn: string,
  leadingColumn?: string,
): void {
  const columns = indexColumns(table, indexName);
  const expressionColumn = leadingColumn ? columns[1] : columns[0];
  const tieBreakColumn = columns.at(-1) as IndexColumn | undefined;

  expect(columns).toHaveLength(leadingColumn ? 3 : 2);
  if (leadingColumn) {
    expect((columns[0] as IndexColumn).name).toBe(leadingColumn);
  }
  expect(columnSql(expressionColumn)).toContain(`date_trunc('milliseconds'`);
  expect(columnSql(expressionColumn)).toContain(`"${timestampColumn}"`);
  expect(columnSql(expressionColumn)).toContain("AT TIME ZONE 'UTC'");
  expect(tieBreakColumn?.name).toBe("id");
}

describe("normalized timestamp pagination indexes", () => {
  it("matches every paged query key with an immutable expression and id tie-breaker", () => {
    assertNormalizedTimestampIndex(
      copyTradeFollows,
      "copy_trade_follows_follower_created_at_id_idx",
      "created_at",
      "follower_user_id",
    );
    assertNormalizedTimestampIndex(
      copyTradeFollows,
      "copy_trade_follows_auto_mirror_created_at_id_idx",
      "created_at",
      "auto_mirror",
    );
    assertNormalizedTimestampIndex(signals, "signals_created_at_id_idx", "created_at");
    assertNormalizedTimestampIndex(signals, "signals_timestamp_id_idx", "timestamp");
    assertNormalizedTimestampIndex(socialTrades, "social_trades_created_at_id_idx", "created_at");
  });
});
