import { describe, expect, it } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  signalIngestionCursors,
  signals,
  sourceAuthorAliases,
  sourceAuthorIdentities,
} from "../schema/index";

describe("canonical ingestion schema", () => {
  it("stores source-qualified immutable event and author identity fields", () => {
    const signalColumns = getTableConfig(signals).columns.map((column) => column.name);
    expect(signalColumns).toEqual(expect.arrayContaining(["source_event_id", "source_author_id"]));

    const identity = getTableConfig(sourceAuthorIdentities);
    expect(identity.name).toBe("source_author_identities");
    expect(identity.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "source",
        "source_author_id",
        "canonical_key",
        "current_handle",
        "current_display_name",
      ]),
    );

    const aliases = getTableConfig(sourceAuthorAliases);
    expect(aliases.name).toBe("source_author_aliases");
    expect(aliases.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["identity_id", "source", "alias"]),
    );
  });

  it("has one durable cursor namespace per source", () => {
    const cursor = getTableConfig(signalIngestionCursors);
    expect(cursor.name).toBe("signal_ingestion_cursors");
    expect(cursor.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "source",
        "cursor",
        "cursor_sequence",
        "backfill_cursor",
        "backfill_complete",
        "watermark",
        "status",
        "last_error",
      ]),
    );
  });
});
