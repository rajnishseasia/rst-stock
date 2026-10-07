import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, not } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type PoolDb } from "@trade-bot/db";
import { parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import { classifySignalInstrument } from "@trade-bot/utils";
import {
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
  validOptionContractCondition,
} from "./authoritative-order.js";
import { parseOptionSignal } from "./option-signal-parser.js";
import { isProfessorUser, shardiSignalCondition } from "./signal-visibility.js";
import { tradeActionDirection, tradeActionSide } from "./trade-action.js";

const COPY_SOURCE_ITEM_ID_RE = /^(x_signal|user):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const OPTION_ACTION_OR_INSTRUMENT_RE =
  /\b(?:BTO|STC|STO|BUYTOOPEN|BUYTOCLOSE|SELLTOOPEN|SELLTOCLOSE|BUY\s+TO\s+(?:OPEN|CLOSE)|SELL\s+TO\s+(?:OPEN|CLOSE)|(?:BUY|BOUGHT|BUYING|SELL|SOLD|SELLING|TRADE|TRADING)\s+(?:CALLS?|PUTS?|OPTIONS?)|(?:CALL|PUT)\s+(?:OPTIONS?|CONTRACTS?)|OPTIONS?\s+CONTRACTS?)\b/;
const OPTION_SYMBOL_CONTEXT_RE =
  /\b(?:BUY|BOUGHT|BUYING|SELL|SOLD|SELLING|TRADE|TRADING|OPEN|OPENING|CLOSE|CLOSING)\s+\$?[A-Z]{1,6}\s+(?:CALLS?|PUTS?|OPTIONS?)\b/;
const OPTION_BTC_CONTEXT_RE =
  /\bBTC\s+(?:\$[A-Z]{1,6}\b|OPTIONS?\b|(?:CALL|PUT)\s+OPTIONS?\b)/;
const OPTION_STRIKE_TYPE_RE =
  /\b\d+(?:\.\d{1,4})?\s*(?:C|P)\b/;
const OPTION_TRADE_ACTIONS = new Set([
  "BTO",
  "STC",
  "STO",
  "BTC",
  "BUYTOOPEN",
  "BUYTOCLOSE",
  "SELLTOOPEN",
  "SELLTOCLOSE",
]);

/** Input primitive shared by the stock and perp manual-copy mutations. */
export const copySourceItemIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(COPY_SOURCE_ITEM_ID_RE, "use a canonical feed id in the form x_signal:<uuid> or user:<uuid>");

export type ManualCopySourceKind = "x_signal" | "user";

export type ManualCopyOrderIntent =
  | {
      assetType: "EQUITY";
      symbol: string;
      tradeAction: string;
      direction: "long" | "short";
      signalId?: string;
    }
  | {
      assetType: "OPTION";
      symbol: string;
      tradeAction: string;
      direction: "long" | "short";
      signalId?: string;
    }
  | {
      assetType: "PERP";
      coin: string;
      isLong: boolean;
      reduceOnly: boolean;
    };

export interface ResolvedManualCopySource {
  sourceItemId: string;
  sourceKind: ManualCopySourceKind;
  sourceRecordId: string;
  /** The immutable source order row, present for user feed items only. */
  sourceOrderId: string | null;
  signalId: string | null;
  assetType: "EQUITY" | "PERP";
  symbol: string;
  venue: "alpaca" | "hyperliquid";
  direction: "long" | "short";
}

interface SourceItemParts {
  kind: ManualCopySourceKind;
  recordId: string;
  sourceItemId: string;
}

interface ViewerIdentity {
  email?: string | null;
}

interface SignalMetadataRecord {
  [key: string]: unknown;
}

interface UserSourceRow {
  socialId: string;
  orderId: string;
  orderSymbol: string;
  orderAssetType: string;
  orderTradeAction: string;
  orderDirection: string;
  orderReduceOnly: boolean | null;
  orderVenue: string | null;
}

function invalidCopySource(reason: string): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `copySourceItemId is invalid: ${reason}`,
  });
}

function hiddenCopySource(): never {
  return invalidCopySource(
    "the feed item was not found, is no longer public, or is no longer shared; refresh the copy-trade feed and try again",
  );
}

function parseSourceItemId(raw: string): SourceItemParts {
  const match = COPY_SOURCE_ITEM_ID_RE.exec(raw.trim());
  if (!match) {
    return invalidCopySource(
      "use a canonical feed id in the form x_signal:<uuid> or user:<uuid>",
    );
  }

  const kind = match[1] as ManualCopySourceKind;
  const recordId = match[2]!.toLowerCase();
  return {
    kind,
    recordId,
    sourceItemId: `${kind}:${recordId}`,
  };
}

function metadataRecord(raw: unknown): SignalMetadataRecord | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SignalMetadataRecord)
      : null;
  } catch {
    return null;
  }
}

function hasMalformedSignalMetadata(raw: unknown, record: SignalMetadataRecord | null): boolean {
  // Legacy rows with null metadata are valid plain equity calls. A non-null
  // metadata blob that cannot be represented as a record is not safe to use as
  // a source for a real order, even though display-only callers retain their
  // historical fail-open behavior.
  return raw !== null && raw !== undefined && record === null;
}

function metadataString(
  record: SignalMetadataRecord | null,
  key: string,
): string | null {
  const raw = record?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function sourceDirectionFromSignal(direction: string | null): "long" | "short" | null {
  if (direction === "long") return "long";
  if (direction === "short") return "short";
  return null;
}

function assertSignalIdMatches(
  requestedSignalId: string | undefined,
  sourceSignalId: string,
): void {
  if (
    requestedSignalId !== undefined &&
    requestedSignalId.toLowerCase() !== sourceSignalId.toLowerCase()
  ) {
    invalidCopySource(
      "signalId does not match the resolved x_signal source; remove it or use the source signal id",
    );
  }
}

function hasMeaningfulMetadataValue(record: SignalMetadataRecord | null, key: string): boolean {
  const value = record?.[key];
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/**
 * Option source copying is not part of the manual stock-copy API contract.
 * Keep this check separate from the shared perp/equity classifier because an
 * option is neither a perp nor a short equity call.
 */
function hasStructuredOptionEvidence(
  record: SignalMetadataRecord | null,
  classification: ReturnType<typeof classifySignalInstrument>,
): boolean {
  const declaredAssetType =
    metadataString(record, "assetType") ?? metadataString(record, "asset_type");
  if (declaredAssetType?.toUpperCase() === "OPTION") return true;

  if (classification.instrument?.includes("option")) return true;

  if ([
    "optionExpiration",
    "option_expiration",
    "optionStrike",
    "option_strike",
    "optionType",
    "option_type",
  ].some((key) =>
    hasMeaningfulMetadataValue(record, key),
  )) {
    return true;
  }

  return ["tradeAction", "trade_action", "optionAction", "option_action", "action"].some((key) => {
    const value = record?.[key];
    if (value === null || value === undefined) return false;
    if (typeof value !== "string") return true;
    return OPTION_TRADE_ACTIONS.has(value.replace(/\s+/g, "").toUpperCase());
  });
}

function hasOptionTextEvidence(content: string | null): boolean {
  const text = (content ?? "").toUpperCase();
  return (
    OPTION_ACTION_OR_INSTRUMENT_RE.test(text) ||
    OPTION_SYMBOL_CONTEXT_RE.test(text) ||
    OPTION_BTC_CONTEXT_RE.test(text) ||
    OPTION_STRIKE_TYPE_RE.test(text)
  );
}

function assertSignalCanOpenEquity(
  signal: {
    id: string;
    symbol: string | null;
    metadata: unknown;
    content: string | null;
  },
  intent: Extract<ManualCopyOrderIntent, { assetType: "EQUITY" | "OPTION" }>,
): ResolvedManualCopySource {
  const record = metadataRecord(signal.metadata);
  if (hasMalformedSignalMetadata(signal.metadata, record)) {
    invalidCopySource(
      "the x_signal has malformed structured metadata and cannot be copied safely",
    );
  }

  const classification = classifySignalInstrument(signal.metadata, signal.content);
  if (classification.unrecognizedShape) {
    invalidCopySource(
      "the x_signal has an unrecognized platform, instrument, or direction; it cannot be copied safely",
    );
  }
  if (intent.assetType !== "EQUITY") {
    invalidCopySource(
      "source-linked stock copies support EQUITY only; this source is not an option contract",
    );
  }
  const optionParse = parseOptionSignal(signal.content, { symbolHint: signal.symbol });
  if (
    hasStructuredOptionEvidence(record, classification) ||
    optionParse.kind === "option" ||
    hasOptionTextEvidence(signal.content)
  ) {
    invalidCopySource(
      "the x_signal describes an option contract; source-linked option copying is not supported by the equity route",
    );
  }
  if (!classification.mirrorableEquityLong) {
    invalidCopySource(
      "the x_signal is not a plain opening stock call; use the matching perp route when it is a Hyperliquid source",
    );
  }

  const sourceSymbol = signal.symbol?.trim().toUpperCase();
  if (!sourceSymbol || sourceSymbol !== intent.symbol.trim().toUpperCase()) {
    invalidCopySource(
      `the source symbol is ${sourceSymbol ?? "unknown"}, not ${intent.symbol.toUpperCase()}`,
    );
  }
  if (intent.tradeAction !== "Buy" || intent.direction !== "long") {
    invalidCopySource(
      "the source is an opening long call; copy it with tradeAction Buy and direction long",
    );
  }

  assertSignalIdMatches(intent.signalId, signal.id);
  return {
    sourceItemId: `x_signal:${signal.id.toLowerCase()}`,
    sourceKind: "x_signal",
    sourceRecordId: signal.id,
    sourceOrderId: null,
    signalId: signal.id,
    assetType: "EQUITY",
    symbol: sourceSymbol,
    venue: "alpaca",
    direction: "long",
  };
}

function assertSignalCanOpenPerp(
  signal: {
    id: string;
    metadata: unknown;
    content: string | null;
  },
  intent: Extract<ManualCopyOrderIntent, { assetType: "PERP" }>,
): ResolvedManualCopySource {
  const record = metadataRecord(signal.metadata);
  if (hasMalformedSignalMetadata(signal.metadata, record)) {
    invalidCopySource(
      "the x_signal has malformed structured metadata and cannot be copied safely",
    );
  }

  const classification = classifySignalInstrument(signal.metadata, signal.content);
  if (classification.unrecognizedShape) {
    invalidCopySource(
      "the x_signal has an unrecognized platform, instrument, or direction; it cannot be copied safely",
    );
  }

  const sourcePlatform = classification.platform;
  const sourceDirection = sourceDirectionFromSignal(classification.direction);
  const sourceCoin = parseCanonicalPerpCoin(metadataString(record, "hlTicker"));
  if (
    (sourcePlatform !== "hyperliquid" && sourcePlatform !== "hl") ||
    !classification.perpInstrument ||
    sourceDirection === null ||
    sourceCoin === null
  ) {
    invalidCopySource(
      "the x_signal is not a well-formed Hyperliquid perp call with a canonical hlTicker and explicit long/short direction",
    );
  }
  if (sourceCoin !== intent.coin) {
    invalidCopySource(
      `the source coin is ${sourceCoin}, not ${intent.coin}`,
    );
  }
  if (intent.isLong !== (sourceDirection === "long")) {
    invalidCopySource(
      `the source direction is ${sourceDirection}; the submitted perp side does not match it`,
    );
  }
  if (intent.reduceOnly) {
    invalidCopySource(
      "a source-linked perp copy must open a position; reduceOnly must be false",
    );
  }

  return {
    sourceItemId: `x_signal:${signal.id.toLowerCase()}`,
    sourceKind: "x_signal",
    sourceRecordId: signal.id,
    sourceOrderId: null,
    signalId: signal.id,
    assetType: "PERP",
    symbol: sourceCoin,
    venue: "hyperliquid",
    direction: sourceDirection,
  };
}

function assertUserSourceCanOpen(
  row: UserSourceRow,
  intent: ManualCopyOrderIntent,
): ResolvedManualCopySource {
  if (intent.assetType === "OPTION") {
    invalidCopySource(
      "source-linked stock copies support EQUITY only; option source copying is not part of this API contract",
    );
  }

  if (intent.assetType === "EQUITY") {
    const sourceSymbol = row.orderSymbol.trim().toUpperCase();
    if (row.orderAssetType !== "EQUITY") {
      invalidCopySource("the public source is not an Alpaca equity order");
    }
    if (row.orderVenue?.toLowerCase() !== "alpaca") {
      invalidCopySource("the public source is on the wrong venue for a stock order");
    }
    if (sourceSymbol !== intent.symbol.trim().toUpperCase()) {
      invalidCopySource(
        `the source symbol is ${sourceSymbol}, not ${intent.symbol.toUpperCase()}`,
      );
    }
    if (
      row.orderDirection !== "long" ||
      tradeActionSide(row.orderTradeAction) !== "buy" ||
      tradeActionDirection(row.orderTradeAction) !== "long" ||
      row.orderReduceOnly === true
    ) {
      invalidCopySource(
        "the public source is not an opening long equity trade; copy sources must be Buy/long and non-reducing",
      );
    }
    if (intent.tradeAction !== "Buy" || intent.direction !== "long") {
      invalidCopySource(
        "the source is an opening long call; copy it with tradeAction Buy and direction long",
      );
    }

    return {
      sourceItemId: `user:${row.socialId.toLowerCase()}`,
      sourceKind: "user",
      sourceRecordId: row.socialId,
      sourceOrderId: row.orderId,
      signalId: null,
      assetType: "EQUITY",
      symbol: sourceSymbol,
      venue: "alpaca",
      direction: "long",
    };
  }

  const sourceCoin = parseCanonicalPerpCoin(row.orderSymbol);
  const sourceDirection = row.orderDirection === "long" || row.orderDirection === "short"
    ? row.orderDirection
    : null;
  if (row.orderAssetType !== "PERP") {
    invalidCopySource("the public source is not a Hyperliquid perp order");
  }
  if (row.orderVenue?.toLowerCase() !== "hyperliquid") {
    invalidCopySource("the public perp source is on the wrong venue");
  }
  if (!sourceCoin || sourceDirection === null) {
    invalidCopySource("the public perp source has no canonical coin or explicit direction");
  }
  if (
    row.orderTradeAction !== (sourceDirection === "long" ? "Buy" : "Sell")
  ) {
    invalidCopySource("the public perp source does not describe a coherent opening intent");
  }
  if (sourceCoin !== intent.coin) {
    invalidCopySource(`the source coin is ${sourceCoin}, not ${intent.coin}`);
  }
  if (sourceDirection !== (intent.isLong ? "long" : "short")) {
    invalidCopySource(
      `the source direction is ${sourceDirection}; the submitted perp side does not match it`,
    );
  }
  if (intent.reduceOnly || row.orderReduceOnly !== false) {
    invalidCopySource(
      "a source-linked perp copy must open a position; reduceOnly must be false",
    );
  }

  return {
    sourceItemId: `user:${row.socialId.toLowerCase()}`,
    sourceKind: "user",
    sourceRecordId: row.socialId,
    sourceOrderId: row.orderId,
    signalId: null,
    assetType: "PERP",
    symbol: sourceCoin,
    venue: "hyperliquid",
    direction: sourceDirection,
  };
}

async function resolveSignalSource(
  db: PoolDb,
  viewer: ViewerIdentity | null | undefined,
  parts: SourceItemParts,
  intent: ManualCopyOrderIntent,
): Promise<ResolvedManualCopySource> {
  const maySeeShardi = viewer ? isProfessorUser(viewer) : false;
  const signal = await db.query.signals.findFirst({
    where: and(
      eq(schema.signals.id, parts.recordId),
      maySeeShardi ? undefined : not(shardiSignalCondition()),
    ),
  });
  if (!signal) return hiddenCopySource();

  if (intent.assetType === "PERP") {
    return assertSignalCanOpenPerp(signal, intent);
  }
  return assertSignalCanOpenEquity(signal, intent);
}

async function resolveUserSource(
  db: PoolDb,
  parts: SourceItemParts,
  intent: ManualCopyOrderIntent,
): Promise<ResolvedManualCopySource> {
  if ("signalId" in intent && intent.signalId !== undefined) {
    invalidCopySource("signalId cannot be combined with a user source item");
  }

  const socialTrades = alias(schema.socialTrades, "manual_copy_social_trades");
  const orders = alias(schema.orders, "manual_copy_orders");
  const otherOrders = alias(schema.orders, "manual_copy_other_orders");
  const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
    db,
    socialTrades,
    orders,
    otherOrders,
  );
  const rows = await db
    .select({
      socialId: socialTrades.id,
      orderId: orders.id,
      orderSymbol: orders.symbol,
      orderAssetType: orders.assetType,
      orderTradeAction: orders.tradeAction,
      orderDirection: orders.direction,
      orderReduceOnly: orders.reduceOnly,
      orderVenue: orders.venue,
    })
    .from(socialTrades)
    .innerJoin(schema.users, eq(socialTrades.userId, schema.users.id))
    .innerJoin(orders, authoritativeOrderJoin)
    .where(and(
      eq(socialTrades.id, parts.recordId),
      validOptionContractCondition(orders),
      publiclyEligibleOrderCondition(db, orders),
    ))
    .limit(2);

  if (rows.length !== 1) return hiddenCopySource();
  const row = rows[0] as UserSourceRow | undefined;
  if (!row) return hiddenCopySource();
  return assertUserSourceCanOpen(row, intent);
}

/**
 * Resolve a feed item against the authoritative source record and verify that
 * the requested manual order is the same venue/instrument/opening intent.
 */
export async function resolveManualCopySource(
  db: PoolDb,
  viewer: ViewerIdentity | null | undefined,
  rawSourceItemId: string,
  intent: ManualCopyOrderIntent,
): Promise<ResolvedManualCopySource> {
  const parts = parseSourceItemId(rawSourceItemId);
  if (parts.kind === "x_signal") {
    return resolveSignalSource(db, viewer, parts, intent);
  }
  return resolveUserSource(db, parts, intent);
}

/** Normalize the canonical feed item ID used by the idempotency comparison. */
export function normalizeCopySourceItemId(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  return parseSourceItemId(raw).sourceItemId;
}

/**
 * An idempotency key owns its original manual-copy attribution. Replays may
 * omit the source only when the original row also has no source, and may reuse
 * a source only when the server persisted that exact canonical source. This
 * check deliberately does not resolve the feed item again: an accepted order
 * remains retryable even if its source later becomes hidden or deleted.
 */
export function assertManualCopySourceReplayMatches(
  persistedSourceItemId: string | null | undefined,
  incomingSourceItemId: string | null | undefined,
): void {
  const incoming = normalizeCopySourceItemId(incomingSourceItemId);
  let persisted: string | null;
  try {
    persisted = normalizeCopySourceItemId(persistedSourceItemId);
  } catch {
    // A server-owned field that is malformed is never evidence for a valid
    // incoming source. Keep the replay fail-closed without resolving anything.
    persisted = persistedSourceItemId?.trim().toLowerCase() ?? null;
  }

  if (incoming !== persisted) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The idempotency key is already bound to a different copy source.",
    });
  }
}

/** Server-owned order fields used to persist verified manual-copy provenance. */
export function manualCopyOrderProvenance(
  source: ResolvedManualCopySource,
  notes: string | null | undefined,
): {
  signalId: string | null;
  notes: string | null;
  manualCopySourceItemId: string;
  manualCopySourceOrderId: string | null;
  copySourceLabel: null;
} {
  return {
    signalId: source.signalId,
    notes: notes ?? null,
    manualCopySourceItemId: source.sourceItemId,
    manualCopySourceOrderId: source.sourceOrderId,
    // This field is reserved for automatic mirror orders. Manual copies keep
    // the normal manual-history presentation and never gain a copymirror label.
    copySourceLabel: null,
  };
}
