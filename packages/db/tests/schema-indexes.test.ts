import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { orders, smartExitLegs } from "../src/schema/orders";
import { signals } from "../src/schema/signals";
import { socialTrades } from "../src/schema/social-trades";
import { userApiCredentials } from "../src/schema/user-credentials";
import { userWatchlistItems } from "../src/schema/watchlist";

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).indexes
    .map((index) => index.config.name)
    .filter((name): name is string => name !== undefined);
}

describe("query-path indexes", () => {
  test("cover ordered user history, signal feeds, and broker credential lookup", () => {
    expect(indexNames(orders)).toContain("orders_user_id_created_at_idx");
    expect(indexNames(signals)).toContain("signals_timestamp_idx");
    expect(indexNames(userApiCredentials)).toContain("user_api_credentials_user_provider_idx");
  });

  test("enforce stable identity for persisted Smart Exit legs", () => {
    const config = getTableConfig(smartExitLegs);
    const uniqueNames = [
      ...config.uniqueConstraints.map((constraint) => constraint.name),
      ...config.indexes.filter((index) => index.config.unique).map((index) => index.config.name),
    ];

    expect(uniqueNames).toContain("smart_exit_legs_entry_order_leg_key_unique");
    expect(uniqueNames).toContain("smart_exit_legs_client_order_id_unique");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["attempts", "claim_token", "claim_expires_at", "next_attempt_at"]),
    );
  });

  test("identifies watchlist instruments by user, venue, and symbol", () => {
    const config = getTableConfig(userWatchlistItems);
    expect(config.columns.map((column) => column.name)).toContain("venue");
    expect(indexNames(userWatchlistItems)).toContain(
      "user_watchlist_items_user_venue_symbol_idx",
    );
  });

  test("links social events to their authoritative order row", () => {
    const config = getTableConfig(socialTrades);
    expect(config.columns.map((column) => column.name)).toContain("order_id");
    expect(indexNames(socialTrades)).toContain("social_trades_order_id_idx");
  });
});
