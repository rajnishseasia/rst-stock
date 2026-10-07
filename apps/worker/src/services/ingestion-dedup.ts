/**
 * The signals event index is partial because legacy rows have no event key.
 * PostgreSQL cannot infer that index from a target column list alone, so the
 * intentional targetless form is used by every source poller.
 */
export function applySourceEventDedup<T extends {
  onConflictDoNothing?: (config?: never) => unknown;
}>(builder: T): unknown {
  return typeof builder.onConflictDoNothing === "function"
    ? builder.onConflictDoNothing()
    : builder;
}
