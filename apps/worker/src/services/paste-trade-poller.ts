/**
 * paste.trade Board Poller
 *
 * Ingests trade calls from paste.trade (the maintainer's own site) into the
 * shared `signals` table. It mirrors the Discord poller in structure and
 * lifecycle: a class with start()/stop(), an interval loop, per-cycle logging,
 * and dedup against previously inserted rows filtered by `source`.
 *
 * Two public endpoints are used (no auth / cookies required):
 *
 *   1. Change detection (cheap, polled every cycle):
 *        GET {BASE}/api/board/version?window=today&lens=max
 *      -> { count, computed_at, prices_as_of, window_end }
 *      We only fetch the full board when `count` or `computed_at` changes.
 *
 *   2. Data (fetched only when the version changed):
 *        GET {BASE}/api/board?window=today&lens=max
 *      -> { rows: [ ... ] }
 *
 * The board MIXES venues: a row can be an equity (platform "robinhood",
 * instrument "stock" / "shares" / "etf") or a Hyperliquid perp (platform
 * "hyperliquid", instrument "perp" / "perps"). We carry `platform` and
 * `instrument` through on the metadata and never assume perps.
 *
 * The board also NESTS. When several callers are in the same ticker, only the
 * lead call is a top-level row; the rest arrive in that row's `crowd` array,
 * each a full call in its own right with a distinct id, author, entry price,
 * thesis and leverage. We flatten one level so those callers are ingested
 * too. Dedup is unaffected: `selectNewPasteTradeRows` keys on the row id, and
 * crowd ids are disjoint from top-level ids.
 *
 * ============================================================================
 *  DEFAULTS OFF. start() does nothing at all unless PASTE_TRADE_POLLER_ENABLED
 *  is exactly the string "true": no interval is scheduled and no network / DB
 *  work happens. This ships the service inert in CI / dev / review.
 * ============================================================================
 */

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { createProductionLogger, type Logger } from "@trade-bot/logger";
// The canonical Hyperliquid coin check. `hl_ticker` is the ONLY field on a board
// row that names a leveraged market to trade, so it is validated here, at the
// trust boundary, the same way `ticker` is.
import { parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import {
  buildCanonicalAuthorMetadata,
  isPlausibleSourceEventTimestamp,
  isStrictSignalTickerShape,
  MAX_SOURCE_EVENT_FUTURE_SKEW_MS,
} from "@trade-bot/utils";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { describeError } from "../lib/log-safe-error";
import { tryObserveCanonicalAuthor } from "./canonical-author-store";
import { applySourceEventDedup } from "./ingestion-dedup";

const defaultLogger = createProductionLogger();

const LOG_SERVICE = "paste.trade";

/** The `source` value written on every row this poller inserts. */
export const PASTE_TRADE_SOURCE = "paste.trade";
export const PASTE_TRADE_CURSOR_SOURCE = "paste.trade:board:today";

const DEFAULT_BASE_URL = "https://paste.trade";
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * How many existing paste.trade rows we scan to build the dedup set each cycle.
 * Bounded (audit H6): the "today" board is small (low hundreds), so the most
 * recent rows always cover today's dedup window. Mirrors the leaderboard scan
 * cap style of a named constant on a `.limit()`.
 */
const DEDUP_SCAN_CAP = 5_000;

/** Sanity cap on stored thesis length (content column is unbounded TEXT). */
const CONTENT_MAX_CHARS = 8_000;

const USER_AGENT = "ReadySetTrade/1.0 (+https://readysettrade.com; paste.trade signal poller)";

/**
 * Timeout for both board endpoints. Mirrors the AbortController pattern in
 * apps/api/src/lib/research/market-research.ts so a hanging paste.trade
 * endpoint cannot wedge a poll cycle forever.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Ticker validation (audit M7). `row.ticker` is untrusted external HTTP input
 * written into the shared `signals.symbol` column, so it must satisfy the same
 * constraints as the shared `symbolSchema` in apps/api/src/routers/orders.ts
 * (min 1, max 21 chars, charset [A-Za-z0-9./-], uppercased). That schema is
 * api-local and the worker does not depend on the api workspace, so the exact
 * constraints are replicated here. Keep the two in sync.
 */
const pasteTradeTickerSchema = z
  .string()
  .min(1)
  .max(21)
  .regex(/^(?:[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*|[A-Za-z0-9]+:[A-Za-z0-9]+)$/, "Symbol contains invalid characters");

/**
 * Validate + normalize an external ticker. Returns the uppercased symbol, or
 * null when the value is missing, oversized, or contains characters outside
 * the shared symbol charset (audit M7). Callers must SKIP such rows.
 */
export function parsePasteTradeTicker(ticker: unknown): string | null {
  const result = pasteTradeTickerSchema.safeParse(ticker);
  if (!result.success || !/[A-Za-z]/.test(result.data) || !isStrictSignalTickerShape(result.data)) return null;
  if (result.data.includes(":")) return parseCanonicalPerpCoin(result.data);
  if (result.data.startsWith("k")) {
    if (!/^k[A-Z0-9]+$/.test(result.data)) return null;
    return parseCanonicalPerpCoin(result.data);
  }
  return result.data.toUpperCase();
}

/** Shape of one row from GET /api/board. Only the fields we consume are typed. */
export interface PasteTradeBoardRow {
  /** Stable id per call. Used as the dedup key. */
  id: string;
  ticker: string;
  display_ticker?: string | null;
  direction?: string | null;
  platform?: string | null;
  instrument?: string | null;
  hl_ticker?: string | null;
  author_id?: string | null;
  author_handle?: string | null;
  author_name?: string | null;
  author_avatar_url?: string | null;
  /** ISO call time. */
  author_date?: string | null;
  created_at?: string | null;
  /** Entry price. */
  author_price?: number | null;
  /** Free-text rationale. Stored VERBATIM (external data). */
  thesis?: string | null;
  leverage?: number | null;
  pnl_display?: string | null;
  people_count?: number | null;
  crowd?: unknown[];
}

interface PasteTradeVersion {
  count?: number;
  computed_at?: string;
  prices_as_of?: string | null;
  window_end?: string | null;
}

interface PasteTradeBoardResponse {
  rows: unknown[];
}

/**
 * What one ingestion pass actually did.
 *
 * Logged on EVERY completed cycle, including the zero-insert case. Without
 * these numbers a healthy poller that inserts nothing (because the board holds
 * only calls we already stored) is indistinguishable from a poller that is not
 * running at all, which is precisely the ambiguity that made "the flag is on
 * but no trades come in" impossible to answer from the logs.
 */
export interface PasteTradeIngestCounts {
  /** Rows the board served and we could parse. */
  boardRowCount: number;
  /** Size of the dedup set read back from `signals`. */
  knownRowIdCount: number;
  /** Board rows we had not seen before. */
  newRowCount: number;
  insertedCount: number;
  duplicateCount: number;
  /** New rows dropped because the ticker failed symbol validation. */
  invalidTickerCount: number;
  /** New rows dropped because neither source timestamp was usable. */
  invalidTimestampCount: number;
}

/** Why a cycle inserted nothing. Named so a log line reads as an answer. */
export type PasteTradeOutcome =
  | "inserted"
  | "all_duplicates"
  | "all_invalid"
  | "no_rows";

export function describePasteTradeOutcome(
  counts: PasteTradeIngestCounts,
): PasteTradeOutcome {
  if (counts.insertedCount > 0) return "inserted";
  if (counts.boardRowCount === 0) return "no_rows";
  // Checked before all_duplicates: a batch whose only NEW rows were rejected
  // for a bad ticker is a data problem, not a quiet steady state.
  if (
    counts.newRowCount > 0 &&
    counts.invalidTickerCount + counts.invalidTimestampCount === counts.newRowCount
  ) {
    return "all_invalid";
  }
  return "all_duplicates";
}

export type PasteTradePollerState =
  | "disabled"
  | "enabled"
  | "healthy"
  | "unchanged"
  | "empty"
  | "auth_failure"
  | "parse_failure"
  | "upstream_failure"
  | "db_failure";

type PasteTradeEndpoint = "version" | "board";

/**
 * Which part of a poll cycle a failure came from.
 *
 * Previously every non-HTTP failure was reported as a bare
 * `{ state: "upstream_failure" }`, so a database outage, a DNS failure and a
 * 10-second fetch timeout all produced the SAME log line, with no message and
 * no stage. That is the line an operator sees when "the poller is enabled but
 * nothing arrives", and it answered nothing.
 */
export type PasteTradeStage =
  | "version"
  | "board"
  | "dedup_read"
  | "insert"
  | "unknown";

/** Why a request failed when there is no HTTP status to classify it by. */
export type PasteTradeFailureReason = "timeout" | "network";

class PasteTradePollError extends Error {
  constructor(
    readonly state: Extract<
      PasteTradePollerState,
      "auth_failure" | "parse_failure" | "upstream_failure"
    >,
    readonly endpoint: PasteTradeEndpoint,
    readonly status?: number,
    readonly reason?: PasteTradeFailureReason,
    /** The original throw, when we wrapped one. Named to avoid Error.cause. */
    readonly underlying?: unknown,
  ) {
    super(`paste.trade ${endpoint} ${state}`);
  }
}

/**
 * A database failure during ingestion.
 *
 * Kept distinct from the HTTP errors because the operator response is
 * completely different: an upstream failure means wait for paste.trade, a
 * db_failure means the worker's own DATABASE_URL_DIRECT connection is broken
 * and NO poller in this process is writing anything.
 */
class PasteTradeDbError extends Error {
  constructor(
    readonly stage: Extract<PasteTradeStage, "dedup_read" | "insert">,
    readonly underlying: unknown,
  ) {
    super(`paste.trade ${stage} failed`);
  }
}


const pasteTradeVersionSchema = z.object({
  count: z.number().int().nonnegative(),
  computed_at: z.string().min(1),
  // paste.trade serves these as explicit `null` (not an omitted key) when no
  // price/window data is available yet, e.g. an empty "today" board. Neither
  // field is read anywhere else in the poller; only `count` and `computed_at`
  // drive dedup/version logic (see pasteTradeVersionKey).
  prices_as_of: z.string().nullable().optional(),
  window_end: z.string().nullable().optional(),
});

const pasteTradeBoardResponseSchema = z.object({ rows: z.array(z.unknown()) });

const pasteTradeBoardRowSchema = z
  .object({
    id: z.string().min(1),
    ticker: z.string().min(1),
    display_ticker: z.string().nullable().optional(),
    direction: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    instrument: z.string().nullable().optional(),
    /**
     * The canonical Hyperliquid coin for this call's market, and the only field
     * on a board row that can select a LEVERAGED market for the copy-trade
     * auto-mirror. The schema checks SHAPE only; the value is validated against
     * HL's canonical coin form by `parseCanonicalPerpCoin` in mapPasteTradeRow,
     * the same split `ticker` uses with `parsePasteTradeTicker` (shape here,
     * charset/length there). Keeping the raw string until then is deliberate:
     * the insert loop logs the dropped value, which is how an upstream format
     * change surfaces instead of silently muting perp mirrors.
     */
    hl_ticker: z.string().nullable().optional(),
    author_id: z.string().nullable().optional(),
    author_handle: z.string().nullable().optional(),
    author_name: z.string().nullable().optional(),
    author_avatar_url: z.string().nullable().optional(),
    author_date: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    author_price: z.number().nullable().optional(),
    thesis: z.string().nullable().optional(),
    leverage: z.number().nullable().optional(),
    pnl_display: z.string().nullable().optional(),
    people_count: z.number().nullable().optional(),
    crowd: z.array(z.unknown()).optional(),
  })
  .passthrough();

type NewSignalInsert = typeof schema.signals.$inferInsert;

function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "custom";
  } catch {
    return "custom";
  }
}

// A type alias rather than an interface: only aliases get TypeScript's implicit
// index signature, which the logger's LoggerContext parameter requires.
export type PasteTradeFailureDiagnostic = {
  state: "auth_failure" | "parse_failure" | "upstream_failure" | "db_failure";
  /** Where in the cycle it died. Always present, so a log line is actionable. */
  stage: PasteTradeStage;
  endpoint?: PasteTradeEndpoint;
  status?: number;
  reason?: PasteTradeFailureReason;
  errorName?: string;
  errorMessage?: string;
};

export function pasteTradeFailureDiagnostic(
  error: unknown,
): PasteTradeFailureDiagnostic {
  if (error instanceof PasteTradePollError) {
    return {
      state: error.state,
      stage: error.endpoint,
      endpoint: error.endpoint,
      status: error.status,
      ...(error.reason ? { reason: error.reason } : {}),
      // Only present when we wrapped a real throw (timeout / network); an HTTP
      // status classification has nothing underneath it to describe.
      ...(error.underlying !== undefined
        ? describeError(error.underlying)
        : {}),
    };
  }
  if (error instanceof PasteTradeDbError) {
    return {
      state: "db_failure",
      stage: error.stage,
      ...describeError(error.underlying),
    };
  }
  // Anything that escaped the wrapping above. Still says what it was, instead
  // of the old bare "upstream_failure" that described every possible cause.
  return {
    state: "upstream_failure",
    stage: "unknown",
    ...describeError(error),
  };
}

/**
 * The master kill switch. start() is inert unless this is exactly "true".
 */
export function isPasteTradePollerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PASTE_TRADE_POLLER_ENABLED === "true";
}

/** Cap on the rendered flag. Long enough to show a typo, short enough to bound. */
const ENABLED_FLAG_MAX_CHARS = 20;

/**
 * Render the kill-switch value for a log line: "unset" when absent, otherwise
 * JSON-quoted so trailing whitespace and casing are visible ("\"True\"",
 * "\"true \""). Those are the values that silently keep the poller inert.
 */
export function describeEnabledFlag(raw: string | undefined): string {
  if (raw === undefined) return "unset";
  return JSON.stringify(raw.slice(0, ENABLED_FLAG_MAX_CHARS));
}

/** Base URL override (default https://paste.trade). Trailing slash trimmed. */
export function resolvePasteTradeBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.PASTE_TRADE_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

/** Poll interval override (default 60000ms). Non-positive / invalid ignored. */
export function resolvePasteTradePollIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env.PASTE_TRADE_POLL_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_POLL_INTERVAL_MS;
}

/**
 * A stable string identity for a board version. The board only needs a refetch
 * when `count` or `computed_at` changes, so we key on both.
 */
export function pasteTradeVersionKey(version: PasteTradeVersion): string {
  return `${version.count ?? ""}:${version.computed_at ?? ""}`;
}

/**
 * Resolve an author avatar path to an absolute URL. paste.trade returns a
 * site-relative path (e.g. "/api/avatars/xyz"); we anchor it to the board base
 * URL so the same `authorAvatar` metadata field the UI already reads renders a
 * real image. Absolute URLs and empty values pass through unchanged.
 */
function resolveAvatarUrl(
  avatar: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!avatar) return null;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  if (avatar.startsWith("/")) return `${baseUrl}${avatar}`;
  return avatar;
}

/**
 * Pure mapper: convert one board row to a `signals` insert.
 *
 * Metadata field naming follows the Discord poller / signals reader where it
 * overlaps (authorId / authorName / authorAvatar / messageId) so the existing
 * feed and chart UI keep working. The row `id` is stored as BOTH `sourceRowId`
 * (the dedup key) and `messageId` (mirroring the Discord dedup-key convention).
 *
 * `thesis` is stored VERBATIM: it is external data and must not be rewritten
 * (em dashes and all).
 *
 * Returns null when the ticker fails the shared symbol constraints (audit M7):
 * the caller must skip the row instead of writing an unvalidated external
 * string into `signals.symbol`.
 *
 * `hl_ticker` gets the same treatment at the field level: it names the
 * Hyperliquid market the copy-trade auto-mirror would lever up, so a value
 * outside HL's canonical coin form is stored as null (the mirror then fails
 * closed) instead of being carried into metadata as-is.
 */
export function mapPasteTradeRow(
  row: PasteTradeBoardRow,
  baseUrl: string = DEFAULT_BASE_URL,
  now: Date = new Date(),
): NewSignalInsert | null {
  const symbol = parsePasteTradeTicker(row.ticker);
  if (symbol === null) return null;
  const thesis = typeof row.thesis === "string" ? row.thesis : "";
  const authorAvatar = resolveAvatarUrl(row.author_avatar_url, baseUrl);
  const rawTimestamp = row.author_date ?? row.created_at;
  if (!rawTimestamp) return null;
  const timestamp = new Date(rawTimestamp);
  if (Number.isNaN(timestamp.getTime())) return null;
  if (!isPlausibleSourceEventTimestamp(timestamp, now)) return null;

  const baseMetadata: Record<string, unknown> = {
    authorId: row.author_id ?? null,
    authorName: row.author_name ?? null,
    authorHandle: row.author_handle ?? null,
    authorAvatar,
    direction: row.direction ?? null,
    leverage: row.leverage ?? null,
    entryPrice: row.author_price ?? null,
    platform: row.platform ?? null,
    instrument: row.instrument ?? null,
    // Validated here as well as in the row schema: this mapper is what writes
    // the metadata, and callers that build a row by hand (tests, a future
    // caller) must not be able to slip an unvalidated coin into it. A
    // non-canonical value becomes null, which the auto-mirror treats as
    // "no coin" and skips.
    hlTicker: parseCanonicalPerpCoin(row.hl_ticker),
    sourceRowId: row.id,
    // Mirror the Discord convention so shared metadata helpers / readers that
    // key on messageId keep working.
    messageId: row.id,
    peopleCount: row.people_count ?? null,
    pnlDisplay: row.pnl_display ?? null,
  };
  const metadata = buildCanonicalAuthorMetadata(baseMetadata, {
    source: PASTE_TRADE_SOURCE,
    sourceAuthorId: row.author_id,
    currentHandle: row.author_handle,
    displayName: row.author_name,
    avatar: authorAvatar,
  });

  return {
    source: PASTE_TRADE_SOURCE,
    sourceEventId: `${PASTE_TRADE_SOURCE}:${row.id}:${symbol}`,
    sourceAuthorId: row.author_id ?? null,
    symbol,
    content: thesis.slice(0, CONTENT_MAX_CHARS),
    // No confirmed per-row permalink on paste.trade, so we link the site root.
    url: baseUrl,
    timestamp,
    metadata,
  };
}

/**
 * Build the set of already-ingested row ids from existing signal metadata.
 * Reads `sourceRowId`, falling back to `messageId`, and tolerates metadata that
 * was persisted as a JSON string.
 */
export function collectExistingSourceRowIds(
  existing: Array<{ metadata: unknown; sourceEventId?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of existing) {
    let meta: unknown = row.metadata;
    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
      } catch {
        meta = null;
      }
    }
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const record = meta as Record<string, unknown>;
      const key = record.sourceRowId ?? record.messageId;
      if (typeof key === "string" && key.length > 0) ids.add(key);
    }
  }
  return ids;
}

export function collectExistingSourceEventIds(
  existing: Array<{ sourceEventId?: unknown }>,
): Set<string> {
  return new Set(
    existing
      .map((row) => row.sourceEventId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

/**
 * Pure dedup selector: keep only rows whose id is neither already stored nor a
 * duplicate earlier in the same batch. Rows without a usable id or ticker are
 * skipped.
 */
export function selectNewPasteTradeRows(
  rows: PasteTradeBoardRow[],
  existingRowIds: Set<string>,
): PasteTradeBoardRow[] {
  const seen = new Set<string>();
  const result: PasteTradeBoardRow[] = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id || !row.ticker) continue;
    if (existingRowIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

export class PasteTradePoller {
  private db: WorkerPoolDb;
  private baseUrl: string;
  private pollIntervalMs: number;
  private enabled: boolean;
  private logger: Logger;
  private fetchFn: typeof fetch;
  private readonly fetchTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last seen board version key; null until the first successful poll. */
  private lastVersionKey: string | null = null;
  /** Consecutive cycles the board version has not moved. */
  private unchangedStreak = 0;
  /** The raw kill-switch value, kept only to explain a disabled start(). */
  private readonly rawEnabledFlag: string | undefined;
  private readonly now: () => Date;
  /**
   * In-flight guard: true while a poll cycle is running. A new interval tick
   * is skipped (not queued) while the previous one is still in flight, so a
   * slow endpoint cannot stack overlapping polls.
   */
  private polling = false;
  private cursorLoaded = false;

  constructor(
    db: WorkerPoolDb,
    options: {
      env?: NodeJS.ProcessEnv;
      logger?: Logger;
      fetch?: typeof fetch;
      /** Override FETCH_TIMEOUT_MS. Injection seam, same as `fetch` above. */
      fetchTimeoutMs?: number;
      now?: () => Date;
    } = {},
  ) {
    const env = options.env ?? process.env;
    this.db = db;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.baseUrl = resolvePasteTradeBaseUrl(env);
    this.pollIntervalMs = resolvePasteTradePollIntervalMs(env);
    this.enabled = isPasteTradePollerEnabled(env);
    this.rawEnabledFlag = env.PASTE_TRADE_POLLER_ENABLED;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
    this.fetchFn = options.fetch ?? fetch;
  }

  private hasDurableCursorSupport(): boolean {
    const dbAny = this.db as any;
    return Boolean(
      dbAny.query?.signalIngestionCursors?.findFirst &&
        typeof dbAny.insert === "function",
    );
  }

  private async readVersionCursor(): Promise<{
    cursor?: string | null;
    cursorSequence?: string | null;
    watermark?: Date | null;
  } | undefined> {
    return await (this.db as any).query.signalIngestionCursors.findFirst({
      where: eq(schema.signalIngestionCursors.source, PASTE_TRADE_CURSOR_SOURCE),
      columns: { cursor: true, cursorSequence: true, watermark: true },
    }) as {
      cursor?: string | null;
      cursorSequence?: string | null;
      watermark?: Date | null;
    } | undefined;
  }

  private adoptDurableVersionCursor(row: { cursor?: string | null } | undefined): void {
    this.lastVersionKey = typeof row?.cursor === "string" ? row.cursor : null;
  }

  private async loadVersionCursor(): Promise<void> {
    if (this.cursorLoaded) return;
    if (!this.hasDurableCursorSupport()) {
      this.cursorLoaded = true;
      return;
    }
    this.adoptDurableVersionCursor(await this.readVersionCursor());
    this.cursorLoaded = true;
  }

  private async refreshDurableVersionCursor(): Promise<void> {
    if (!this.hasDurableCursorSupport()) return;
    this.adoptDurableVersionCursor(await this.readVersionCursor());
  }

  private async persistVersionCursor(
    cursor: string,
    status: "healthy" | "skipped_invalid",
    sequence: number,
    watermark: Date,
  ): Promise<boolean> {
    if (!this.hasDurableCursorSupport()) return false;
    const now = new Date();
    const safeSequence = String(Math.max(0, Math.floor(sequence)));
    const builder = (this.db as any)
      .insert(schema.signalIngestionCursors)
      .values({
        source: PASTE_TRADE_CURSOR_SOURCE,
        cursor,
        cursorSequence: safeSequence,
        backfillCursor: null,
        backfillComplete: true,
        watermark,
        status,
        lastError: null,
        updatedAt: now,
      });
    if (typeof builder.onConflictDoUpdate === "function") {
      const conflictBuilder = builder.onConflictDoUpdate({
        target: schema.signalIngestionCursors.source,
        set: {
          cursor,
          cursorSequence: safeSequence,
          backfillCursor: null,
          backfillComplete: true,
          watermark,
          status,
          lastError: null,
          updatedAt: now,
        },
        setWhere: sql`
          ${schema.signalIngestionCursors.watermark} is null
          or excluded."watermark" > ${schema.signalIngestionCursors.watermark}
          or (
            excluded."watermark" = ${schema.signalIngestionCursors.watermark}
            and (
              ${schema.signalIngestionCursors.cursorSequence} is null
              or ${schema.signalIngestionCursors.cursorSequence}::numeric <= excluded."cursor_sequence"::numeric
            )
          )
        `,
      });
      if (typeof conflictBuilder.returning === "function") {
        const rows = await conflictBuilder.returning({
          source: schema.signalIngestionCursors.source,
        });
        if (!Array.isArray(rows) || rows.length > 0) return true;
        // A second replica committed a newer board version. Adopt it now so
        // the next poll does not request and process the same version again.
        await this.refreshDurableVersionCursor();
        return false;
      }
      await conflictBuilder;
    } else {
      await builder;
    }
    return true;
  }

  /**
   * fetch() with an AbortController timeout (mirrors the fetchJson pattern in
   * apps/api/src/lib/research/market-research.ts). Without this a hanging
   * endpoint holds a poll cycle open indefinitely.
   */
  private async fetchWithTimeout(
    url: string,
    endpoint: PasteTradeEndpoint,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.fetchTimeoutMs);
    try {
      return await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      // A rejected fetch (DNS failure, TLS error, or our own abort) used to
      // escape as a bare Error and be reported as an unattributed
      // "upstream_failure". Attribute it to the endpoint and say whether we
      // gave up on the clock or the network refused us.
      throw new PasteTradePollError(
        "upstream_failure",
        endpoint,
        undefined,
        timedOut ? "timeout" : "network",
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchVersion(): Promise<PasteTradeVersion> {
    const url = `${this.baseUrl}/api/board/version?window=today&lens=max`;
    const response = await this.fetchWithTimeout(url, "version");
    if (!response.ok) {
      throw new PasteTradePollError(
        response.status === 401 || response.status === 403 ? "auth_failure" : "upstream_failure",
        "version",
        response.status,
      );
    }
    try {
      return pasteTradeVersionSchema.parse(await response.json());
    } catch {
      throw new PasteTradePollError("parse_failure", "version");
    }
  }

  private async fetchBoard(): Promise<{
    /** Top-level rows plus their flattened `crowd` co-signers. */
    rows: PasteTradeBoardRow[];
    /** How many of `rows` came from a `crowd` array. */
    crowdRowCount: number;
  }> {
    const url = `${this.baseUrl}/api/board?window=today&lens=max`;
    const response = await this.fetchWithTimeout(url, "board");
    if (!response.ok) {
      throw new PasteTradePollError(
        response.status === 401 || response.status === 403 ? "auth_failure" : "upstream_failure",
        "board",
        response.status,
      );
    }
    let body: PasteTradeBoardResponse;
    try {
      body = pasteTradeBoardResponseSchema.parse(await response.json());
    } catch {
      throw new PasteTradePollError("parse_failure", "board");
    }

    const rows: PasteTradeBoardRow[] = [];
    let rejectedRowCount = 0;
    let crowdRowCount = 0;
    for (const candidate of body.rows) {
      const parsed = pasteTradeBoardRowSchema.safeParse(candidate);
      if (!parsed.success) {
        rejectedRowCount += 1;
        continue;
      }
      rows.push(parsed.data);
      // Co-signers of the same ticker are nested under the lead row rather
      // than served as top-level rows, and each one is a separate call by a
      // DIFFERENT author with its own id, entry price, thesis and leverage.
      // Reading only the top level dropped roughly 40% of the board on the
      // days we measured, so those callers never appeared in the feed at all.
      //
      // One level only: nested entries carry no `crowd` of their own, and
      // recursing on a passthrough schema would let a malformed upstream
      // payload drive unbounded work inside a poll cycle.
      for (const nested of parsed.data.crowd ?? []) {
        const parsedNested = pasteTradeBoardRowSchema.safeParse(nested);
        if (!parsedNested.success) {
          rejectedRowCount += 1;
          continue;
        }
        rows.push(parsedNested.data);
        crowdRowCount += 1;
      }
    }
    if (rejectedRowCount > 0) {
      this.logger.warn(LOG_SERVICE, "Board contained malformed rows", {
        state: "parse_failure",
        endpoint: "board",
        rejectedRowCount,
        acceptedRowCount: rows.length,
      });
    }
    return { rows, crowdRowCount };
  }

  /**
   * Insert board rows that are not already present. Dedup mirrors the Discord
   * poller: read existing rows filtered on source, then skip rows we have seen
   * (here keyed on the paste.trade row id stored in metadata.sourceRowId).
   */
  private async processBoard(
    rows: PasteTradeBoardRow[],
  ): Promise<PasteTradeIngestCounts> {
    let existing: Array<{ metadata: unknown; sourceEventId?: unknown }>;
    try {
      existing = await this.db.query.signals.findMany({
        where: eq(schema.signals.source, PASTE_TRADE_SOURCE),
        orderBy: [desc(schema.signals.timestamp)],
        limit: DEDUP_SCAN_CAP,
        columns: { metadata: true, sourceEventId: true },
      });
    } catch (error) {
      throw new PasteTradeDbError("dedup_read", error);
    }

    const existingRowIds = collectExistingSourceRowIds(existing);
    const existingEventIds = collectExistingSourceEventIds(existing);
    const newRows = selectNewPasteTradeRows(rows, existingRowIds);

    let insertedCount = 0;
    let invalidTickerCount = 0;
    let invalidTimestampCount = 0;
    let racedDuplicateCount = 0;
    for (const row of newRows) {
      const rawTimestamp = row.author_date ?? row.created_at;
      const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp) : null;
      if (
        !rawTimestamp ||
        !parsedTimestamp ||
        Number.isNaN(parsedTimestamp.getTime()) ||
        !isPlausibleSourceEventTimestamp(parsedTimestamp, this.now())
      ) {
        invalidTimestampCount += 1;
        this.logger.warn(LOG_SERVICE, "Skipping row with invalid timestamp", {
          sourceRowId: row.id,
          timestamp: typeof rawTimestamp === "string" ? rawTimestamp.slice(0, 80) : null,
          ...(parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime()) &&
          !isPlausibleSourceEventTimestamp(parsedTimestamp, this.now())
            ? { reason: "future_timestamp", maxFutureSkewMs: MAX_SOURCE_EVENT_FUTURE_SKEW_MS }
            : {}),
        });
        continue;
      }
      const insert = mapPasteTradeRow(row, this.baseUrl, this.now());
      if (insert === null) {
        // Untrusted ticker failed the shared symbol constraints (audit M7).
        // Skip just this row; the rest of the batch still inserts.
        invalidTickerCount += 1;
        this.logger.warn(LOG_SERVICE, "Skipping row with invalid ticker", {
          sourceRowId: row.id,
          ticker: String(row.ticker ?? "").slice(0, 30),
        });
        continue;
      }
      if (typeof insert.sourceEventId === "string" && existingEventIds.has(insert.sourceEventId)) {
        racedDuplicateCount += 1;
        continue;
      }
      if (
        typeof row.hl_ticker === "string" &&
        parseCanonicalPerpCoin(row.hl_ticker) === null
      ) {
        // Kept out of metadata (see mapPasteTradeRow) but not kept quiet: this
        // is how an upstream coin-format change surfaces before it turns into
        // a wave of skipped perp mirrors.
        this.logger.warn(LOG_SERVICE, "Dropping non-canonical hl_ticker", {
          sourceRowId: row.id,
          hlTicker: row.hl_ticker.slice(0, 30),
        });
      }
      const observedAuthor = await tryObserveCanonicalAuthor(this.db, insert.metadata, {
        source: PASTE_TRADE_SOURCE,
        sourceAuthorId: row.author_id,
        currentHandle: row.author_handle,
        displayName: row.author_name,
        avatar: typeof (insert.metadata as Record<string, unknown>).authorAvatar === "string"
          ? (insert.metadata as Record<string, unknown>).authorAvatar as string
          : null,
      });
      const enrichedInsert = {
        ...insert,
        sourceAuthorId: observedAuthor.sourceAuthorId,
        metadata: observedAuthor.metadata,
      };
      try {
        const builder = (this.db.insert(schema.signals).values(enrichedInsert) as any);
        if (typeof builder.onConflictDoNothing === "function") {
          const conflictBuilder = applySourceEventDedup(builder) as any;
          if (typeof conflictBuilder.returning === "function") {
            const insertedRows = await conflictBuilder.returning({ id: schema.signals.id });
            if (Array.isArray(insertedRows) && insertedRows.length === 0) {
              racedDuplicateCount += 1;
              continue;
            }
          } else {
            await conflictBuilder;
          }
        } else {
          await builder;
        }
      } catch (error) {
        throw new PasteTradeDbError("insert", error);
      }
      insertedCount += 1;
      this.logger.info(
        LOG_SERVICE,
        `Inserted signal: ${insert.symbol} from ${row.author_name ?? "unknown"}`,
      );
    }

    if (insertedCount > 0) {
      this.logger.info(LOG_SERVICE, `Inserted ${insertedCount} new signal(s) from board`);
    }

    return {
      boardRowCount: rows.length,
      knownRowIdCount: existingRowIds.size,
      newRowCount: newRows.length,
      insertedCount,
      // Rows the board served that we had already stored (or that repeated
      // within the same snapshot). The overwhelmingly common steady state.
      duplicateCount: rows.length - newRows.length + racedDuplicateCount,
      invalidTickerCount,
      invalidTimestampCount,
    };
  }

  /**
   * One polling cycle: check the cheap version endpoint and only fetch + process
   * the full board when the version changed since the last cycle.
   */
  private async poll(): Promise<void> {
    if (this.polling) {
      this.logger.info(LOG_SERVICE, "Skipping poll tick: previous cycle still in flight", {
        state: "unchanged",
        reason: "in_flight",
      });
      return;
    }
    this.polling = true;
    try {
      await this.loadVersionCursor();
      const version = await this.fetchVersion();
      const key = pasteTradeVersionKey(version);
      if (this.lastVersionKey !== null && key === this.lastVersionKey) {
        this.unchangedStreak += 1;
        this.logger.info(LOG_SERVICE, "Board version unchanged", {
          state: "unchanged",
          rowCount: version.count,
          // How long we have been skipping the board fetch. A streak that
          // climbs forever means paste.trade stopped recomputing the board,
          // which looks identical to a dead poller unless we say so.
          unchangedStreak: this.unchangedStreak,
        });
        return; // Board unchanged since last poll; nothing to fetch.
      }
      this.unchangedStreak = 0;

      const { rows, crowdRowCount } = await this.fetchBoard();
      const versionWatermark = new Date(version.computed_at ?? "");
      const safeVersionWatermark = Number.isNaN(versionWatermark.getTime())
        ? this.now()
        : versionWatermark;
      if (rows.length === 0) {
        if (version.count === 0) {
          // Board is genuinely empty; advance the key so we don't re-poll this version.
          const persisted = await this.persistVersionCursor(
            key,
            "healthy",
            version.count ?? 0,
            safeVersionWatermark,
          );
          if (persisted || !this.hasDurableCursorSupport()) this.lastVersionKey = key;
        } else {
          // Board reported rows but returned none — possible transient upstream inconsistency.
          // Do NOT advance lastVersionKey; the next poll will retry this version.
          this.logger.warn(LOG_SERVICE, "Board returned no usable rows despite non-zero count", {
            state: "empty",
            endpoint: "board",
            versionCount: version.count,
          });
        }
        return;
      }
      const counts = await this.processBoard(rows);
      const persisted = await this.persistVersionCursor(
        key,
        "healthy",
        version.count ?? 0,
        safeVersionWatermark,
      );
      if (persisted || !this.hasDurableCursorSupport()) this.lastVersionKey = key;
      this.logger.info(LOG_SERVICE, "Poll completed", {
        state: "healthy",
        outcome: describePasteTradeOutcome(counts),
        rowCount: rows.length,
        versionCount: version.count,
        crowdRowCount,
        ...counts,
      });
    } catch (error) {
      const diagnostic = pasteTradeFailureDiagnostic(error);
      this.logger.error(LOG_SERVICE, "Poll failed", diagnostic);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Start the poller.
   *
   * KILL SWITCH: if PASTE_TRADE_POLLER_ENABLED is not exactly "true", we log a
   * disabled message and return WITHOUT scheduling anything, so the service is
   * inert by default.
   */
  public async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.info(
        LOG_SERVICE,
        "paste.trade poller disabled (PASTE_TRADE_POLLER_ENABLED!=true)",
        {
          state: "disabled",
          // The exact-match kill switch rejects "True", "TRUE", "1" and any
          // stray whitespace, and the old log said only "disabled" — so an
          // operator who HAD set the variable saw a line that looked like they
          // had not. JSON-quoted to make padding visible. This is a boolean
          // feature flag, not a credential.
          observedFlag: describeEnabledFlag(this.rawEnabledFlag),
        },
      );
      return; // Inert: nothing scheduled, no network, no DB reads.
    }

    this.logger.info(
      LOG_SERVICE,
      "paste.trade poller enabled",
      {
        state: "enabled",
        upstreamHost: upstreamHost(this.baseUrl),
        pollIntervalMs: this.pollIntervalMs,
      },
    );

    // Fetch once immediately, then on the interval.
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  /** Stop the poller and clear the interval. */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info(LOG_SERVICE, "Poller stopped.");
    }
  }
}
