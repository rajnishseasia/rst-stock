export const PERP_CLOSE_SLOW_NOTICE_MS = 4_000;
export const PERP_CLOSE_FAST_POLL_MS = 2_000;
export const PERP_CLOSE_SLOW_POLL_AFTER_MS = 30_000;
export const PERP_CLOSE_BACKGROUND_POLL_MS = 30_000;

export type PerpClosePhase = "submitting" | "confirming";

export interface PerpCloseIntent {
  coin: string;
  initialSize: string;
  cloid: string;
  startedAt: number;
  phase: PerpClosePhase;
}

export type PerpCloseResolution = "pending" | "closed" | "partial" | "failed";

const DEFINITIVE_FAILURE_STATUSES = new Set([
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

export function perpClosePollInterval(startedAt: number, now = Date.now()): number {
  return now - startedAt < PERP_CLOSE_SLOW_POLL_AFTER_MS
    ? PERP_CLOSE_FAST_POLL_MS
    : PERP_CLOSE_BACKGROUND_POLL_MS;
}

export function perpCloseSlowNoticeDelay(startedAt: number, now = Date.now()): number {
  return Math.max(0, PERP_CLOSE_SLOW_NOTICE_MS - (now - startedAt));
}

export function resolvePerpClose(args: {
  initialSize: string;
  currentSize: string | null;
  orderStatus?: string | null;
}): PerpCloseResolution {
  if (args.currentSize === null) return "closed";

  const initial = Number(args.initialSize);
  const current = Number(args.currentSize);
  if (
    Number.isFinite(initial) &&
    Number.isFinite(current) &&
    initial > 0 &&
    current >= 0 &&
    current < initial
  ) {
    return "partial";
  }

  if (args.orderStatus && DEFINITIVE_FAILURE_STATUSES.has(args.orderStatus)) {
    return "failed";
  }

  return "pending";
}
