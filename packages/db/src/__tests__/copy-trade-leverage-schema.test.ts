import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { copyTradeFollows, users } from "../schema/index.js";

function tableColumn(table: Parameters<typeof getTableConfig>[0], name: string) {
  return getTableConfig(table).columns.find((column) => column.name === name);
}

describe("copy-trade leverage cap schema", () => {
  it("persists a required user cap with a 1x default", () => {
    const column = tableColumn(users, "copy_perp_max_leverage");

    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe("integer");
    expect(column?.notNull).toBe(true);
    expect(column?.hasDefault).toBe(true);
    expect(column?.default).toBe(1);
  });

  it("persists an optional per-follow cap as an integer", () => {
    const column = tableColumn(copyTradeFollows, "perp_max_leverage");

    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe("integer");
    expect(column?.notNull).toBe(false);
  });

  it("persists optional per-follow dollar caps with the API precision", () => {
    for (const name of ["max_trade_size", "max_coin_size"]) {
      const column = tableColumn(copyTradeFollows, name);

      expect(column).toBeDefined();
      expect(column?.getSQLType()).toBe("numeric(12, 2)");
      expect(column?.notNull).toBe(false);
      expect(column?.hasDefault).toBe(false);
    }
  });

  it("keeps the persisted dollar-cap bounds in migration 0041", () => {
    const migration = readFileSync(
      new URL("../../migrations/0041_copy_trade_cap_constraints.sql", import.meta.url),
      "utf8",
    );

    for (const name of ["max_trade_size", "max_coin_size"]) {
      expect(migration).toContain(`"${name}" IS NULL`);
      expect(migration).toContain(`"${name}" > 0`);
      expect(migration).toContain(`"${name}" <= 1000000`);
    }
  });
});
