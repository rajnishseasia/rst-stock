import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * All newly paged timestamp readers use this database key. PostgreSQL keeps
 * microseconds, but the application deliberately normalizes the SQL key to
 * milliseconds so node-postgres Date values and the id tie-breaker agree.
 */
export function millisecondTimestamp(column: SQLWrapper): SQL<Date> {
  // The timestamptz overload of date_trunc is STABLE because it depends on the
  // session timezone. Convert through a fixed UTC zone so this exact key is
  // immutable and can be used by expression indexes.
  return sql<Date>`date_trunc('milliseconds', ${column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

/** Normalize a timestamp value to the same millisecond key exposed by SQL. */
export function millisecondTimestampValue(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Date(parsed.getTime()) : null;
}
