/**
 * Copy-Trade Follows Router
 *
 * CRUD for a user's followed copy-trade targets (Phase 3). Every procedure is
 * scoped to ctx.userId — a user can only ever see/mutate their own follow rows.
 *
 * A follow row carries a sizing rule and an auto_mirror flag:
 *   - auto_mirror = false -> "Following" feed filter (copyTrade.feed followedOnly).
 *   - auto_mirror = true  -> the flag-gated background worker auto-places orders.
 *
 * target_key is always NON-PII: an x_author normalized key, or a one-way hash of
 * a user id (social.ts traderKey). The raw source user id is never accepted here.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import {
  millisecondTimestamp,
  millisecondTimestampValue,
  schema,
  type PoolDb,
} from "@trade-bot/db";
import { networkFromEnv } from "@trade-bot/hyperliquid";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
  PERP_PROTECTION_BOUNDS,
} from "@trade-bot/types";
import { and, count, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { parseStrictFiniteNumber } from "../lib/strict-number.js";
import {
  canonicalAuthorSource,
  isCanonicalAuthorKey,
  normalizeAuthorAlias,
  parseSourceAuthorAliasKey,
  sourceAuthorAliasKey,
} from "@trade-bot/utils";

const FOLLOW_MEMBERSHIP_SCAN_CAP = 5_000;
export const MAX_COPY_TRADE_FOLLOWS_PER_USER = 500;
export const COPY_TRADE_FOLLOW_PAGE_SIZE = 50;

export type FollowListCursor = { createdAt: string; id: string };

export function encodeFollowListCursor(cursor: FollowListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeFollowListCursor(value: unknown): FollowListCursor | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      parsed.id.length > 128
    ) return null;
    return {
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

// Mirrors CopyTradeItem.followTarget.type and copy_trade_follows.target_type.
const targetTypeSchema = z.enum(["x_author", "user", "politician", "hl_wallet"]);

// 0x-prefixed 20-byte Ethereum/Hyperliquid wallet address.
const walletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid 0x wallet address (40 hex chars)");
// All four sizing modes the worker understands (see SizingMode in copy-mirror.ts):
//   pct        — % of margin buying power (1..100)
//   pct_equity — % of net equity         (1..100)
//   usd        — fixed $ per order        (1..1_000_000)
//   ratio      — multiplier of source qty (0.01..10)
const sizingModeSchema = z.enum(["pct", "usd", "pct_equity", "ratio"]);
export type SizingMode = z.infer<typeof sizingModeSchema>;
type CredentialAccountType = "PAPER" | "LIVE";
type CredentialSummary = {
  id: string;
  provider: "alpaca" | "hyperliquid";
  accountId: string | null;
  accountType: CredentialAccountType;
};

/**
 * Per-mode caps for sizingValue. A flat .max(1_000_000) would let a user save
 * `sizingMode: "pct", sizingValue: 500_000` (i.e. "500,000% of buying power")
 * through the API — the worker's runtime clamp catches it, but defense at the
 * boundary is cheaper and clearer in the error message.
 */
const SIZING_BOUNDS: Record<SizingMode, { min: number; max: number; label: string }> = {
  pct: { min: 0.01, max: 100, label: "1..100 (percent)" },
  pct_equity: { min: 0.01, max: 100, label: "1..100 (percent of equity)" },
  usd: { min: 0.01, max: 1_000_000, label: "$1..$1,000,000" },
  ratio: { min: 0.01, max: 10, label: "0.01..10 (multiplier of source qty)" },
};

export type MirrorDestinationKey = "stock" | "perp";

const mirrorDestinationSchema = z
  .object({
    enabled: z.boolean(),
    credentialId: z.string().uuid().nullable(),
    sizingMode: sizingModeSchema,
    sizingValue: z.number().positive().max(1_000_000),
  })
  .superRefine((data, ctx) => {
    const issue = validateSizingForMode(data.sizingMode, data.sizingValue);
    if (issue) ctx.addIssue({ code: "custom", message: issue, path: ["sizingValue"] });
  });

const mirrorDestinationsSchema = z
  .object({
    stock: mirrorDestinationSchema.optional(),
    perp: mirrorDestinationSchema.optional(),
  })
  .optional();

type MirrorDestinationInput = z.infer<typeof mirrorDestinationSchema>;
type MirrorDestinationsInput = z.infer<typeof mirrorDestinationsSchema>;
type MirrorDestinationState = MirrorDestinationInput;

const destinationProvider: Record<MirrorDestinationKey, "alpaca" | "hyperliquid"> = {
  stock: "alpaca",
  perp: "hyperliquid",
};

function hasOwnValue(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

const TYPED_DESTINATION_KEYS = [
  "stockAutoMirror",
  "stockCredentialId",
  "stockSizingMode",
  "stockSizingValue",
  "perpAutoMirror",
  "perpCredentialId",
  "perpSizingMode",
  "perpSizingValue",
] as const;

function hasTypedDestinationColumns(row: unknown): boolean {
  return TYPED_DESTINATION_KEYS.some((key) => hasOwnValue(row, key));
}

function copyTypedDestinationValues(
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!hasTypedDestinationColumns(row)) return null;
  const values: Record<string, unknown> = {};
  for (const key of TYPED_DESTINATION_KEYS) {
    if (hasOwnValue(row, key)) values[key] = row[key];
  }
  if (hasOwnValue(row, "destinationPolicyInitialized")) {
    values.destinationPolicyInitialized = row.destinationPolicyInitialized;
  }
  return values;
}

function parseDestinationNumber(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDestinationMode(value: unknown): SizingMode | null {
  return value === "pct" || value === "usd" || value === "pct_equity" || value === "ratio"
    ? value
    : null;
}

function disabledDestination(credentialId: string | null = null): MirrorDestinationState {
  return {
    enabled: false,
    credentialId,
    sizingMode: "pct",
    sizingValue: 5,
  };
}

function validDestinationSizing(mode: SizingMode | null, value: number | null): boolean {
  if (mode === null || value === null) return false;
  const bounds = SIZING_BOUNDS[mode];
  return value >= bounds.min && value <= bounds.max;
}

function readDestinationState(
  row: typeof schema.copyTradeFollows.$inferSelect | Record<string, unknown>,
  destination: MirrorDestinationKey,
  legacyProvider?: CredentialSummary["provider"] | null,
): MirrorDestinationState {
  const values = row as Record<string, unknown>;
  const prefix = destination === "stock" ? "stock" : "perp";
  const typed = hasTypedDestinationColumns(values);
  const typedProvider = destination === "stock" ? "alpaca" : "hyperliquid";
  const hasPolicyMarker = hasOwnValue(values, "destinationPolicyInitialized");
  const readCredentialId = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;

  if (typed || hasPolicyMarker) {
    const credentialId = readCredentialId(values[`${prefix}CredentialId`]);
    const sizingMode = parseDestinationMode(values[`${prefix}SizingMode`]);
    const sizingValue = parseDestinationNumber(values[`${prefix}SizingValue`]);
    const typedPolicyInitialized = !hasPolicyMarker || values.destinationPolicyInitialized === true;
    if (
      sizingMode === null ||
      sizingValue === null ||
      !validDestinationSizing(sizingMode, sizingValue)
    ) return disabledDestination(credentialId);
    if (
      !typedPolicyInitialized ||
      values[`${prefix}AutoMirror`] !== true ||
      credentialId === null
    ) {
      return {
        enabled: false,
        credentialId,
        sizingMode,
        sizingValue,
      };
    }
    return { enabled: true, credentialId, sizingMode, sizingValue };
  }

  // A legacy-only row is possible only before migration 0040 or in a small
  // compatibility adapter. Provider proof is mandatory so the old single
  // destination cannot become consent for both venues.
  if (legacyProvider !== typedProvider) return disabledDestination();
  const credentialId = readCredentialId(values.credentialId);
  const sizingMode = parseDestinationMode(values.sizingMode);
  const sizingValue = parseDestinationNumber(values.sizingValue);
  if (
    sizingMode === null ||
    sizingValue === null ||
    !validDestinationSizing(sizingMode, sizingValue)
  ) return disabledDestination(credentialId);
  return {
    enabled: values.autoMirror === true && credentialId !== null,
    credentialId,
    sizingMode,
    sizingValue,
  };
}

function destinationColumnValues(
  states: Record<MirrorDestinationKey, MirrorDestinationState>,
): Record<string, unknown> {
  return {
    stockAutoMirror: states.stock.enabled,
    stockCredentialId: states.stock.credentialId,
    stockSizingMode: states.stock.sizingMode,
    stockSizingValue: states.stock.sizingValue.toFixed(2),
    perpAutoMirror: states.perp.enabled,
    perpCredentialId: states.perp.credentialId,
    perpSizingMode: states.perp.sizingMode,
    perpSizingValue: states.perp.sizingValue.toFixed(2),
    destinationPolicyInitialized: true,
  };
}

function legacyCompatibilityValues(
  states: Record<MirrorDestinationKey, MirrorDestinationState>,
): Record<string, unknown> {
  const enabled = (Object.keys(states) as MirrorDestinationKey[]).filter((key) => states[key].enabled);
  if (enabled.length !== 1) return { autoMirror: false, credentialId: null };
  const state = states[enabled[0]!];
  return {
    autoMirror: true,
    credentialId: state.credentialId,
    sizingMode: state.sizingMode,
    sizingValue: state.sizingValue.toFixed(2),
  };
}

function destinationKeyForLegacyRequest(
  targetType: string,
  credential: CredentialSummary | undefined,
  current: Record<string, unknown> | undefined,
): MirrorDestinationKey {
  if (credential?.provider === "hyperliquid" || targetType === "hl_wallet") return "perp";
  if (credential?.provider === "alpaca") return "stock";
  if (current?.perpAutoMirror === true || current?.perpCredentialId != null) return "perp";
  return "stock";
}

function hasLegacyDestinationInput(input: Record<string, unknown>): boolean {
  return ["autoMirror", "credentialId", "sizingMode", "sizingValue"].some((key) => input[key] !== undefined);
}

function buildDestinationMutation(
  input: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  targetType: string,
  effectiveCredentialId: string | null,
  effectiveAutoMirror: boolean,
  credential: CredentialSummary | undefined,
  preserveCurrentTypedPolicy = false,
): {
  states: Record<MirrorDestinationKey, MirrorDestinationState>;
  nested: boolean;
  preservedValues?: Record<string, unknown>;
} | null {
  const destinations = input.destinations as MirrorDestinationsInput | undefined;
  const legacy = hasLegacyDestinationInput(input);

  const states: Record<MirrorDestinationKey, MirrorDestinationState> = {
    stock: current ? readDestinationState(current, "stock", credential?.provider) : {
      enabled: false,
      credentialId: null,
      sizingMode: "pct",
      sizingValue: 5,
    },
    perp: current ? readDestinationState(current, "perp", credential?.provider) : {
      enabled: false,
      credentialId: null,
      sizingMode: "pct",
      sizingValue: 5,
    },
  };

  if (destinations === undefined && !legacy) {
    const preservedValues = preserveCurrentTypedPolicy && current
      ? copyTypedDestinationValues(current)
      : null;
    return preservedValues ? { states, nested: false, preservedValues } : null;
  }

  if (destinations !== undefined) {
    for (const key of ["stock", "perp"] as const) {
      const patch = destinations[key];
      if (patch) states[key] = patch;
    }
    return { states, nested: true };
  }

  const selected = destinationKeyForLegacyRequest(targetType, credential, current);
  const legacyMode = (input.sizingMode as SizingMode | undefined) ??
    (current === undefined
      ? "pct"
      : typeof current.sizingMode === "string" ? parseDestinationMode(current.sizingMode) : null);
  const legacyValue = input.sizingValue !== undefined
    ? Number(input.sizingValue)
    : current === undefined
      ? 5
      : parseDestinationNumber(current.sizingValue);
  if (
    effectiveAutoMirror &&
    (legacyMode === null || legacyValue === null || !validDestinationSizing(legacyMode, legacyValue))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The saved mirror sizing is invalid; set a valid sizing mode and value before enabling Auto-mirror.",
    });
  }
  states[selected] = {
    enabled: effectiveAutoMirror,
    credentialId: effectiveCredentialId,
    sizingMode: legacyMode ?? "pct",
    sizingValue: legacyValue ?? 5,
  };
  states[selected === "stock" ? "perp" : "stock"] = {
    ...states[selected === "stock" ? "perp" : "stock"],
    enabled: false,
  };
  return { states, nested: false };
}

/**
 * Dollar and coin caps are stored as numeric(12,2). Reject values that would
 * round to zero or carry precision the database cannot preserve, rather than
 * accepting a request that writes a different cap than the user submitted.
 */
const copyTradeCapSchema = z
  .number()
  .min(0.01)
  .max(1_000_000)
  .refine((value) => Number(value.toFixed(2)) === value, {
    message: "must have at most two decimal places",
  });

/**
 * Validate sizingValue against its mode. Returns the issue string when out of
 * range, or null when valid (or when the value/mode wasn't supplied — both
 * fields are optional on partial updates).
 */
function validateSizingForMode(
  mode: SizingMode | undefined,
  value: number | undefined,
): string | null {
  if (mode === undefined || value === undefined) return null;
  const bounds = SIZING_BOUNDS[mode];
  if (value < bounds.min || value > bounds.max) {
    return `sizingValue for mode "${mode}" must be ${bounds.label}; got ${value}`;
  }
  return null;
}

/**
 * Refuse a patch that moves the sizing BASIS while leaving its number behind.
 *
 * Both halves of the rule live in one stored value, so a mode-only patch does
 * not clear the size, it re-reads it: a follow saved as "usd 50" ($50 an order)
 * becomes "pct 50" (half the buying power) on the next mirror, and the reverse
 * turns "pct 5" into $5 an order, under MIRROR_MIN_ORDER_NOTIONAL_USD, which
 * silently skips every mirror instead. Neither is catchable by range: 50 and 5
 * are individually legal in both modes, so only the PAIR carries meaning, and
 * only against what is already stored.
 *
 * The size a follower agreed to may therefore change only when the follower
 * states the number that goes with the new basis. This is the authority for
 * that, not the UI: the router is what the worker's sizing reads back.
 */
function requireSizingValueForModeChange(
  currentMode: string | undefined,
  input: { sizingMode?: SizingMode; sizingValue?: number },
): void {
  // No stored rule yet (a first-time follow) means there is no agreed number to
  // reinterpret, and an unchanged basis leaves the stored number saying exactly
  // what it said before. Only an actual basis MOVE has to bring its own value.
  if (input.sizingMode === undefined) return;
  if (currentMode === undefined || currentMode === input.sizingMode) return;
  if (input.sizingValue !== undefined) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `Changing the sizing basis to "${input.sizingMode}" requires a sizingValue for that basis: ` +
      "the saved size would otherwise be reinterpreted under a different unit.",
  });
}

/**
 * The optional perp exit a follower attaches to every position their mirror
 * opens, in PERCENT OF MARGIN. See PERP_PROTECTION_BOUNDS in packages/types for
 * why margin and not price, and why the stop ceiling sits below 100.
 *
 * `.nullable().optional()` is load bearing and the two are NOT the same request:
 *
 *  - ABSENT means "I am not talking about this field". Every existing partial
 *    patch on this router (a sizing nudge, an arm, an account change) sends no
 *    exit fields at all, and must leave a configured stop exactly where it is.
 *  - NULL means "remove it". That is the only way to clear one.
 *
 * Collapsing them would produce the two failures this distinction exists to
 * prevent: a client that omits the field when the user empties the input leaves
 * a live stop behind a screen showing none, and a client that always sends the
 * current form state as null would wipe a stop set on another device. Neither is
 * catchable by range, because both requests are individually well formed.
 *
 * Unlike the sizing pair, there is no `requireSizingValueForModeChange` analogue
 * to write here. That guard exists because sizing stores a number whose UNIT
 * lives in a second column, so a mode-only patch silently re-reads the number.
 * A percent-of-margin figure has no such second column: 25 means 25% of margin
 * whatever else on the row changes, so no partial patch can reinterpret it.
 */
const perpProtectionPctSchema = (bounds: { min: number; max: number }) =>
  z.number().min(bounds.min).max(bounds.max).nullable().optional();

const perpTakeProfitPctSchema = perpProtectionPctSchema(
  PERP_PROTECTION_BOUNDS.takeProfitPct,
);
const perpStopLossPctSchema = perpProtectionPctSchema(PERP_PROTECTION_BOUNDS.stopLossPct);
const perpMaxLeverageSchema = z
  .number()
  .int()
  .min(COPY_PERP_MAX_LEVERAGE_MIN)
  .max(COPY_PERP_MAX_LEVERAGE_MAX)
  .nullable()
  .optional();

/**
 * Render one perp exit percentage for storage, distinguishing the three cases
 * the column can be in. Undefined means the caller said nothing and the column
 * must not appear in the write at all, which is why this returns undefined
 * rather than null for it.
 */
function perpProtectionColumn(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : value.toFixed(2);
}

/** Format the non-secret destination account details returned to clients. */
function credentialAccountLabel(credential: CredentialSummary): string {
  if (credential.provider === "hyperliquid") {
    return `Hyperliquid ${networkFromEnv()} perps`;
  }
  const kind = credential.accountType === "LIVE" ? "Live" : "Paper";
  return credential.accountId ? `${kind} account ${credential.accountId}` : `${kind} account`;
}

/** Return a ready credential owned by the caller, or undefined for stale state. */
async function findOwnedMirrorCredential(
  db: PoolDb,
  userId: string,
  credentialId: string,
  requiredProvider?: "alpaca" | "hyperliquid",
): Promise<CredentialSummary | undefined> {
  const credential = await db.query.userApiCredentials.findFirst({
    where: (credentials, { and: queryAnd, eq: queryEq }) =>
      queryAnd(
        queryEq(credentials.id, credentialId),
        queryEq(credentials.userId, userId),
      ),
    columns: {
      id: true,
      provider: true,
      accountId: true,
      accountType: true,
    },
  });

  if (
    !credential ||
    (credential.provider !== "alpaca" && credential.provider !== "hyperliquid") ||
    (credential.provider === "alpaca" &&
      credential.accountType !== "PAPER" &&
      credential.accountType !== "LIVE") ||
    (credential.provider === "hyperliquid" && credential.accountType !== "LIVE") ||
    (requiredProvider !== undefined && credential.provider !== requiredProvider)
  ) return undefined;

  return {
    id: credential.id,
    provider: credential.provider,
    accountId: credential.accountId,
    accountType: credential.accountType as CredentialAccountType,
  };
}

/** Require a ready credential owned by the caller for an enabled/new selection. */
async function requireOwnedMirrorCredential(
  db: PoolDb,
  userId: string,
  credentialId: string,
  requiredProvider?: "alpaca" | "hyperliquid",
): Promise<CredentialSummary> {
  const credential = await findOwnedMirrorCredential(db, userId, credentialId, requiredProvider);
  if (credential && (credential.provider !== "alpaca" || credential.accountId?.trim())) {
    return credential;
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "The selected mirror account is unavailable or not ready.",
  });
}

/** Preserve saved legacy links on disarm/unrelated edits; validate new consent. */
async function resolveLegacyCredential(
  db: PoolDb,
  userId: string,
  effectiveCredentialId: string | null,
  currentCredentialId: string | null | undefined,
  inputCredentialId: string | null | undefined,
  effectiveAutoMirror: boolean,
  targetType: string,
  inputAutoMirror: boolean | undefined,
): Promise<{ credentialId: string | null; credential?: CredentialSummary }> {
  if (!effectiveCredentialId) return { credentialId: null };
  const requiredProvider = targetType === "hl_wallet" ? "hyperliquid" : undefined;
  const isSavedSelection = inputCredentialId === undefined || inputCredentialId === currentCredentialId;
  const preservesSavedConsent = inputAutoMirror !== true && currentCredentialId === effectiveCredentialId;
  if (isSavedSelection && (!effectiveAutoMirror || preservesSavedConsent)) {
    const credential = await findOwnedMirrorCredential(
      db,
      userId,
      effectiveCredentialId,
      requiredProvider,
    );
    return credential
      ? { credentialId: effectiveCredentialId, credential }
      : { credentialId: null };
  }
  const credential = await requireOwnedMirrorCredential(
    db,
    userId,
    effectiveCredentialId,
    requiredProvider,
  );
  return { credentialId: effectiveCredentialId, credential };
}

/** Validate destination selections and clear stale saved accounts while disarming. */
async function normalizeDestinationInputs(
  db: PoolDb,
  userId: string,
  destinations: MirrorDestinationsInput | undefined,
  current?: Record<string, unknown>,
): Promise<MirrorDestinationsInput | undefined> {
  if (!destinations) return undefined;
  const normalized: MirrorDestinationsInput = {};
  for (const key of ["stock", "perp"] as const) {
    const destination = destinations[key];
    if (!destination) continue;
    const currentState = current ? readDestinationState(current, key) : undefined;
    const savedCredentialId = currentState?.credentialId ?? (
      current?.destinationPolicyInitialized === false &&
      typeof current.credentialId === "string" &&
      current.credentialId.trim() !== ""
        ? current.credentialId
        : null
    );

    if (destination.enabled) {
      if (!destination.credentialId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Select a ready ${key === "stock" ? "Alpaca" : "Hyperliquid"} account before enabling this mirror destination.`,
        });
      }
      await requireOwnedMirrorCredential(db, userId, destination.credentialId, destinationProvider[key]);
      normalized[key] = destination;
      continue;
    }

    if (!destination.credentialId) {
      normalized[key] = destination;
      continue;
    }

    if (destination.credentialId !== savedCredentialId) {
      // A disabled destination may carry a newly selected account for later,
      // but a foreign or unready account must never be accepted into state.
      await requireOwnedMirrorCredential(db, userId, destination.credentialId, destinationProvider[key]);
      normalized[key] = destination;
      continue;
    }

    // A stale saved id is safe to clear while disarming. A ready saved id may
    // remain selected for the UI and for a later explicit re-arm.
    const savedCredential = await findOwnedMirrorCredential(
      db,
      userId,
      destination.credentialId,
      destinationProvider[key],
    );
    normalized[key] = savedCredential
      ? destination
      : { ...destination, credentialId: null };
  }
  return normalized;
}

/** Map a database row to the client-safe follow contract. */
function toFollowItem(
  row: typeof schema.copyTradeFollows.$inferSelect,
  credential?: CredentialSummary,
  membershipKeys: readonly string[] = [],
  credentialsById?: ReadonlyMap<string, CredentialSummary>,
) {
  const selectedCredential = credential?.id === row.credentialId ? credential : undefined;
  const typedPolicyInitialized = !hasOwnValue(row, "destinationPolicyInitialized") ||
    row.destinationPolicyInitialized === true;
  const destinationItem = (destination: MirrorDestinationKey) => {
    const legacyCredential = credentialsById?.get(row.credentialId ?? "") ?? selectedCredential;
    const state = readDestinationState(row, destination, legacyCredential?.provider);
    const selected = credentialsById?.get(state.credentialId ?? "") ??
      (credential?.id === state.credentialId ? credential : undefined);
    return {
      enabled: state.enabled,
      credentialId: state.credentialId,
      sizingMode: state.sizingMode,
      sizingValue: state.sizingValue,
      credentialAccountLabel: selected ? credentialAccountLabel(selected) : null,
      credentialAccountType: selected?.accountType ?? null,
      credentialProvider: selected?.provider ?? null,
    };
  };
  return {
    id: row.id,
    targetType: row.targetType as "x_author" | "user" | "politician" | "hl_wallet",
    targetKey: row.targetKey,
    targetLabel: row.targetLabel,
    sizingMode: row.sizingMode as SizingMode,
    // numeric(12,2) comes back as a string from pg — surface a number to the client.
    sizingValue: parseStrictFiniteNumber(row.sizingValue) ?? 0,
    maxTradeSize: parseStrictFiniteNumber(row.maxTradeSize) ?? null,
    maxCoinSize: parseStrictFiniteNumber(row.maxCoinSize) ?? null,
    autoMirror: typedPolicyInitialized ? row.autoMirror : false,
    // Integer columns are returned as numbers by pg. Keep null as the
    // inheritance marker rather than coercing it to a false ceiling.
    perpMaxLeverage:
      row.perpMaxLeverage == null ? null : Number(row.perpMaxLeverage),
    credentialId: row.credentialId,
    // numeric(6,2), so pg hands these back as strings too. Null stays null: it
    // is the "no exit configured" state, and coercing it to 0 would read as a
    // stop at zero percent of margin.
    perpTakeProfitPct:
      row.perpTakeProfitPct !== null ? parseFloat(row.perpTakeProfitPct) : null,
    perpStopLossPct: row.perpStopLossPct !== null ? parseFloat(row.perpStopLossPct) : null,
    credentialAccountLabel: selectedCredential
      ? credentialAccountLabel(selectedCredential)
      : null,
    credentialAccountType: selectedCredential?.accountType ?? null,
    credentialProvider: selectedCredential?.provider ?? null,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    ...(hasTypedDestinationColumns(row)
      ? {
          destinations: {
            stock: destinationItem("stock"),
            perp: destinationItem("perp"),
          },
        }
      : {}),
    ...(membershipKeys.length > 0 ? { membershipKeys: [...membershipKeys] } : {}),
  };
}

function followMembershipId(targetType: string, targetKey: string): string {
  return `${targetType}\u0000${targetKey}`;
}

/**
 * Resolve one durable follow membership to all safe keys seen by the feed and
 * leaderboard. The database row remains one row; these are only read-time
 * membership keys. Ambiguous aliases deliberately keep their original key.
 */
async function resolveFollowMemberships(
  db: PoolDb,
  follows: readonly { targetType: string; targetKey: string }[],
): Promise<Map<string, Set<string>>> {
  const memberships = new Map<string, Set<string>>();
  for (const follow of follows) {
    memberships.set(
      followMembershipId(follow.targetType, follow.targetKey),
      new Set([follow.targetKey]),
    );
  }

  const xFollows = follows.filter((follow) => follow.targetType === "x_author");
  if (xFollows.length === 0) return memberships;
  const relational = db as PoolDb & {
    query?: {
      sourceAuthorIdentities?: unknown;
      sourceAuthorAliases?: unknown;
    };
  };
  if (!relational.query?.sourceAuthorIdentities || !relational.query.sourceAuthorAliases) {
    return memberships;
  }
  const canonicalKeys = xFollows
    .map((follow) => follow.targetKey)
    .filter((key) => isCanonicalAuthorKey(key));
  const aliasConditions = xFollows
    .map((follow) => ({
      follow,
      sourceAlias: parseSourceAuthorAliasKey(follow.targetKey),
      alias: normalizeAuthorAlias(follow.targetKey),
    }))
    .filter((value) => value.alias !== null || value.sourceAlias !== null);
  const conditions: SQL[] = [];
  if (canonicalKeys.length > 0) {
    conditions.push(inArray(schema.sourceAuthorIdentities.canonicalKey, canonicalKeys));
  }
  const plainAliases = aliasConditions
    .filter((value) => !value.sourceAlias)
    .map((value) => value.alias)
    .filter((alias): alias is string => alias !== null);
  if (plainAliases.length > 0) {
    conditions.push(inArray(schema.sourceAuthorAliases.alias, [...new Set(plainAliases)]));
  }
  for (const value of aliasConditions) {
    if (!value.sourceAlias) continue;
    conditions.push(and(
      eq(schema.sourceAuthorAliases.source, value.sourceAlias.source),
      eq(schema.sourceAuthorAliases.alias, value.sourceAlias.alias),
    )!);
  }
  if (conditions.length === 0) return memberships;

  try {
    const rows = await db
      .select({
        alias: schema.sourceAuthorAliases.alias,
        source: schema.sourceAuthorAliases.source,
        canonicalKey: schema.sourceAuthorIdentities.canonicalKey,
      })
      .from(schema.sourceAuthorAliases)
      .innerJoin(
        schema.sourceAuthorIdentities,
        eq(
          schema.sourceAuthorIdentities.id,
          schema.sourceAuthorAliases.identityId,
        ),
      )
      .where(or(...conditions)!)
      .limit(FOLLOW_MEMBERSHIP_SCAN_CAP + 1);
    if (rows.length > FOLLOW_MEMBERSHIP_SCAN_CAP) return memberships;

    const ownersByScopedAlias = new Map<string, Set<string>>();
    const ownersByPlainAlias = new Map<string, Set<string>>();
    const sourceByCanonical = new Map<string, string>();
    for (const row of rows) {
      const alias = normalizeAuthorAlias(row.alias);
      if (!alias || !isCanonicalAuthorKey(row.canonicalKey)) continue;
      const source = row.source ?? canonicalAuthorSource(row.canonicalKey);
      if (!source) continue;
      const scoped = `${source}\u0000${alias}`;
      const scopedOwners = ownersByScopedAlias.get(scoped) ?? new Set<string>();
      scopedOwners.add(row.canonicalKey);
      ownersByScopedAlias.set(scoped, scopedOwners);
      const plainOwners = ownersByPlainAlias.get(alias) ?? new Set<string>();
      plainOwners.add(row.canonicalKey);
      ownersByPlainAlias.set(alias, plainOwners);
      sourceByCanonical.set(row.canonicalKey, source);
    }

    for (const follow of xFollows) {
      const membership = memberships.get(followMembershipId(follow.targetType, follow.targetKey))!;
      if (isCanonicalAuthorKey(follow.targetKey)) {
        const source = canonicalAuthorSource(follow.targetKey) ?? sourceByCanonical.get(follow.targetKey);
        if (!source) continue;
        for (const [scoped, owners] of ownersByScopedAlias) {
          if (owners.size !== 1 || !owners.has(follow.targetKey)) continue;
          const separator = scoped.indexOf("\u0000");
          if (separator < 0 || scoped.slice(0, separator) !== source) continue;
          const alias = scoped.slice(separator + 1);
          const key = sourceAuthorAliasKey(source, alias);
          if (key) membership.add(key);
        }
        continue;
      }

      const sourceAlias = parseSourceAuthorAliasKey(follow.targetKey);
      if (sourceAlias) {
        const owners = ownersByScopedAlias.get(`${sourceAlias.source}\u0000${sourceAlias.alias}`);
        if (owners?.size === 1) membership.add([...owners][0]!);
        continue;
      }
      const alias = normalizeAuthorAlias(follow.targetKey);
      const owners = alias ? ownersByPlainAlias.get(alias) : undefined;
      if (owners?.size === 1) {
        const owner = [...owners][0]!;
        membership.add(owner);
        const source = sourceByCanonical.get(owner);
        if (source && alias) {
          const key = sourceAuthorAliasKey(source, alias);
          if (key) membership.add(key);
        }
      }
    }
  } catch {
    // The canonical alias table is additive. A missing migration must not
    // prevent the user from seeing or removing the exact legacy follow row.
  }
  return memberships;
}

async function resolveFollowMutationKey(
  db: PoolDb,
  targetType: string,
  targetKey: string,
): Promise<string> {
  if (targetType !== "x_author") return targetKey;
  const memberships = await resolveFollowMemberships(db, [{ targetType, targetKey }]);
  const keys = memberships.get(followMembershipId(targetType, targetKey));
  return [...(keys ?? [])].find((key) => isCanonicalAuthorKey(key)) ?? targetKey;
}

async function loadCredentialSummaries(
  db: PoolDb,
  userId: string,
): Promise<Map<string, CredentialSummary>> {
  const credentials = await db.query.userApiCredentials.findMany({
    where: (credential, { eq: queryEq }) => queryEq(credential.userId, userId),
    columns: {
      id: true,
      provider: true,
      accountId: true,
      accountType: true,
    },
  });
  const credentialsById = new Map<string, CredentialSummary>();
  for (const credential of credentials) {
    if (credential.provider !== "alpaca" && credential.provider !== "hyperliquid") continue;
    if (
      (credential.provider === "alpaca" &&
        credential.accountType !== "PAPER" &&
        credential.accountType !== "LIVE") ||
      (credential.provider === "hyperliquid" && credential.accountType !== "LIVE")
    ) continue;
    credentialsById.set(credential.id, {
      id: credential.id,
      provider: credential.provider,
      accountId: credential.accountId,
      accountType: credential.accountType as CredentialAccountType,
    });
  }
  return credentialsById;
}

async function readFollowPage(
  db: PoolDb,
  userId: string,
  input: { limit: number; cursor?: string | null },
) {
  const cursor = input.cursor ? decodeFollowListCursor(input.cursor) : null;
  if (input.cursor && !cursor) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid follow list cursor." });
  }
  const conditions: SQL[] = [eq(schema.copyTradeFollows.followerUserId, userId)];
  if (cursor) {
    const createdAt = millisecondTimestampValue(cursor.createdAt);
    if (!createdAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid follow list cursor." });
    }
    const createdAtKey = millisecondTimestamp(schema.copyTradeFollows.createdAt);
    conditions.push(
      or(
        lt(createdAtKey, createdAt),
        and(
          eq(createdAtKey, createdAt),
          lt(schema.copyTradeFollows.id, cursor.id),
        ),
      )!,
    );
  }
  const orderedQuery = db
    .select()
    .from(schema.copyTradeFollows)
    .where(and(...conditions)!)
    .orderBy(
      desc(millisecondTimestamp(schema.copyTradeFollows.createdAt)),
      desc(schema.copyTradeFollows.id),
    );
  type FollowRow = typeof schema.copyTradeFollows.$inferSelect;
  const rows: FollowRow[] = await (
    typeof (orderedQuery as { limit?: unknown }).limit === "function"
      ? (orderedQuery as unknown as {
          limit: (limit: number) => Promise<FollowRow[]>;
        }).limit(input.limit + 1)
      : orderedQuery
  );
  const pageRows = rows.slice(0, input.limit);
  const credentialsById = await loadCredentialSummaries(db, userId);
  const memberships = await resolveFollowMemberships(db, pageRows);
  const items = pageRows.map((row) =>
    toFollowItem(
      row,
      row.credentialId ? credentialsById.get(row.credentialId) : undefined,
      [...(memberships.get(followMembershipId(row.targetType, row.targetKey)) ?? [])]
        .filter((key) => key !== row.targetKey),
      credentialsById,
    ),
  );
  const hasMore = rows.length > input.limit;
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor: hasMore && last
      ? encodeFollowListCursor({
          createdAt: millisecondTimestampValue(last.createdAt)!.toISOString(),
          id: last.id,
        })
      : null,
  };
}

async function withOptionalTransaction<T>(
  db: PoolDb,
  callback: (tx: PoolDb) => Promise<T>,
): Promise<T> {
  const transaction = (db as PoolDb & {
    transaction?: <R>(callback: (tx: PoolDb) => Promise<R>) => Promise<R>;
  }).transaction;
  return transaction
    ? (transaction.call(db, callback) as Promise<T>)
    : callback(db);
}

/**
 * Serialize every follow policy write with a global policy write by locking
 * the authenticated user's row. The row is also the source of truth for the
 * current global cap used to validate a non-null follow override.
 */
async function lockCopyPerpPolicyUser(
  db: PoolDb,
  userId: string,
  requireGlobal = false,
): Promise<number | undefined> {
  const rows = await db
    .select({
      id: schema.users.id,
      copyPerpMaxLeverage: schema.users.copyPerpMaxLeverage,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for("update");
  const user = rows[0];
  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User account is unavailable.",
    });
  }
  // The column is present and NOT NULL in production. Keeping the absent
  // branch tolerant preserves the router's lightweight transaction fallback
  // used by callers that do not change the leverage policy on this patch.
  if (user.copyPerpMaxLeverage === undefined && !requireGlobal) return undefined;
  const globalPerpMaxLeverage = Number(user.copyPerpMaxLeverage);
  if (
    !Number.isSafeInteger(globalPerpMaxLeverage) ||
    globalPerpMaxLeverage < COPY_PERP_MAX_LEVERAGE_MIN ||
    globalPerpMaxLeverage > COPY_PERP_MAX_LEVERAGE_MAX
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The copy-trading leverage policy is unavailable.",
    });
  }
  return globalPerpMaxLeverage;
}

export const copyTradeFollowsRouter = router({
  /** The current user's follows, newest-first. */
  list: protectedProcedure.query(async ({ ctx }) => {
    return (await readFollowPage(ctx.db, ctx.userId, {
      limit: MAX_COPY_TRADE_FOLLOWS_PER_USER,
    })).items;
  }),

  /** Explicit stable pagination for clients that do not need the legacy array contract. */
  listPage: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(COPY_TRADE_FOLLOW_PAGE_SIZE).default(COPY_TRADE_FOLLOW_PAGE_SIZE),
        cursor: z.string().nullable().optional(),
      }),
    )
    .query(({ ctx, input }) => readFollowPage(ctx.db, ctx.userId, input)),

  /**
   * Follow a target (idempotent upsert scoped to ctx.userId). Re-following an
   * existing target updates its label + sizing + auto_mirror in place.
   */
  follow: protectedProcedure
    .input(
      z
        .object({
          targetType: targetTypeSchema,
          targetKey: z.string().min(1).max(256),
          targetLabel: z.string().max(256).optional(),
          sizingMode: sizingModeSchema.optional(),
          sizingValue: z.number().positive().max(1_000_000).optional(),
          maxTradeSize: copyTradeCapSchema.optional().nullable(),
          maxCoinSize: copyTradeCapSchema.optional().nullable(),
          autoMirror: z.boolean().optional(),
          perpMaxLeverage: perpMaxLeverageSchema,
          credentialId: z.string().uuid().nullable().optional(),
          perpTakeProfitPct: perpTakeProfitPctSchema,
          perpStopLossPct: perpStopLossPctSchema,
          destinations: mirrorDestinationsSchema,
        })
        .superRefine((data, ctx) => {
          const issue = validateSizingForMode(data.sizingMode, data.sizingValue);
          if (issue) {
            ctx.addIssue({ code: "custom", message: issue, path: ["sizingValue"] });
          }
          if (data.destinations !== undefined && hasLegacyDestinationInput(data)) {
            ctx.addIssue({
              code: "custom",
              message: "Use destinations instead of mixing legacy mirror fields in one request.",
              path: ["destinations"],
            });
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const hasTransaction = typeof (ctx.db as PoolDb & { transaction?: unknown }).transaction === "function";
      if (input.perpMaxLeverage !== undefined && !hasTransaction) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Copy-trade leverage changes require a transactional database connection.",
        });
      }
      const targetKey = await resolveFollowMutationKey(
        ctx.db,
        input.targetType,
        input.targetKey,
      );
      const memberships = await resolveFollowMemberships(ctx.db, [input]);
      const membershipKeys = [
        ...(memberships.get(followMembershipId(input.targetType, input.targetKey)) ?? [targetKey]),
      ];
      return withOptionalTransaction(ctx.db, async (tx) => {
        const globalPerpMaxLeverage = hasTransaction
          ? await lockCopyPerpPolicyUser(
              tx,
              ctx.userId,
              input.perpMaxLeverage !== undefined && input.perpMaxLeverage !== null,
            )
          : undefined;
        if (
          input.perpMaxLeverage !== undefined &&
          input.perpMaxLeverage !== null &&
          globalPerpMaxLeverage !== undefined &&
          input.perpMaxLeverage > globalPerpMaxLeverage
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The per-follow leverage cap cannot exceed your global copy-trading cap.",
          });
        }

        let followCount: number | null = null;
        if (hasTransaction) {
          const countRows = await tx
            .select({ count: count() })
            .from(schema.copyTradeFollows)
            .where(eq(schema.copyTradeFollows.followerUserId, ctx.userId));
          const rawCount = (countRows[0] as { count?: unknown } | undefined)?.count;
          followCount = Number(rawCount ?? 0);
          if (!Number.isSafeInteger(followCount) || followCount < 0) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Could not verify the follow limit.",
            });
          }
        }

        const existingRows = await tx
          .select()
          .from(schema.copyTradeFollows)
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, input.targetType),
              membershipKeys.length > 1
                ? inArray(schema.copyTradeFollows.targetKey, membershipKeys)
                : eq(schema.copyTradeFollows.targetKey, targetKey),
            ),
          );
        const current = existingRows.find((row) => row.targetKey === targetKey) ??
          existingRows.find((row) => membershipKeys.includes(row.targetKey));
        if (hasTransaction && followCount !== null && followCount >= MAX_COPY_TRADE_FOLLOWS_PER_USER && !current) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `You can follow at most ${MAX_COPY_TRADE_FOLLOWS_PER_USER} targets.`,
          });
        }
        // The schema's own refine only sees THIS request. Switching an existing
        // follow to a mode whose value it never carried needs the STORED mode to
        // notice, which is only knowable once `current` is read.
        requireSizingValueForModeChange(current?.sizingMode, input);
        const adoptingAliasRow = Boolean(current && current.targetKey !== targetKey);

        let effectiveCredentialId =
          input.credentialId !== undefined ? input.credentialId : current?.credentialId ?? null;
        const effectiveAutoMirror =
          input.credentialId === null ? false : input.autoMirror ?? current?.autoMirror ?? false;
        let credential: CredentialSummary | undefined;
        if (input.destinations === undefined) {
          const resolved = await resolveLegacyCredential(
            tx,
            ctx.userId,
            effectiveCredentialId,
            current?.credentialId,
            input.credentialId,
            effectiveAutoMirror,
            input.targetType,
            input.autoMirror,
          );
          effectiveCredentialId = resolved.credentialId;
          credential = resolved.credential;
          if (effectiveAutoMirror && !credential) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Select a ready Alpaca or Hyperliquid account before enabling Auto-mirror.",
            });
          }
        }
        const normalizedDestinations = await normalizeDestinationInputs(
          tx,
          ctx.userId,
          input.destinations,
          current as unknown as Record<string, unknown> | undefined,
        );
        const mutationInput = normalizedDestinations === undefined
          ? input
          : { ...input, destinations: normalizedDestinations };
        const destinationMutation = buildDestinationMutation(
          mutationInput as unknown as Record<string, unknown>,
          current as unknown as Record<string, unknown> | undefined,
          input.targetType,
          effectiveCredentialId,
          effectiveAutoMirror,
          credential,
          adoptingAliasRow,
        );
        const destinationValues = destinationMutation
          ? destinationMutation.preservedValues ?? destinationColumnValues(destinationMutation.states)
          : {};
        const compatibilityValues = destinationMutation?.nested
          ? legacyCompatibilityValues(destinationMutation.states)
          : {};

        // Only set columns the caller provided; otherwise let DB defaults apply on
        // insert and leave existing values untouched on update.
        const sizingValueStr =
          input.sizingValue !== undefined ? input.sizingValue.toFixed(2) : undefined;
        // Undefined here means the caller never mentioned the field, so it is
        // omitted from both the insert and the update set. An explicit null is a
        // clear and is written as one.
        const perpTakeProfit = perpProtectionColumn(input.perpTakeProfitPct);
        const perpStopLoss = perpProtectionColumn(input.perpStopLossPct);

        const insertValues = {
          followerUserId: ctx.userId,
          targetType: input.targetType,
          targetKey,
          targetLabel: input.targetLabel ?? (adoptingAliasRow ? current?.targetLabel : null),
          destinationPolicyInitialized: true,
          ...(input.sizingMode !== undefined
            ? { sizingMode: input.sizingMode }
            : adoptingAliasRow
              ? { sizingMode: current!.sizingMode }
              : {}),
          ...(sizingValueStr !== undefined
            ? { sizingValue: sizingValueStr }
            : adoptingAliasRow
              ? { sizingValue: current!.sizingValue }
              : {}),
          ...(input.maxTradeSize !== undefined
            ? { maxTradeSize: input.maxTradeSize !== null ? input.maxTradeSize.toFixed(2) : null }
            : adoptingAliasRow
              ? { maxTradeSize: current!.maxTradeSize }
              : {}),
          ...(input.maxCoinSize !== undefined
            ? { maxCoinSize: input.maxCoinSize !== null ? input.maxCoinSize.toFixed(2) : null }
            : adoptingAliasRow
              ? { maxCoinSize: current!.maxCoinSize }
              : {}),
          ...(input.autoMirror !== undefined || input.credentialId === null
            ? { autoMirror: effectiveAutoMirror }
            : adoptingAliasRow
              ? { autoMirror: current!.autoMirror }
              : {}),
          ...(input.credentialId !== undefined
            ? { credentialId: input.credentialId }
            : adoptingAliasRow
              ? { credentialId: current!.credentialId }
              : {}),
          ...(input.perpMaxLeverage !== undefined
            ? { perpMaxLeverage: input.perpMaxLeverage }
            : adoptingAliasRow
              ? { perpMaxLeverage: current!.perpMaxLeverage }
              : {}),
          ...(perpTakeProfit !== undefined
            ? { perpTakeProfitPct: perpTakeProfit }
            : adoptingAliasRow
              ? { perpTakeProfitPct: current!.perpTakeProfitPct }
              : {}),
          ...(perpStopLoss !== undefined
            ? { perpStopLossPct: perpStopLoss }
            : adoptingAliasRow
              ? { perpStopLossPct: current!.perpStopLossPct }
              : {}),
          ...destinationValues,
          ...compatibilityValues,
        };

        // LOW-12: on re-follow, only overwrite columns the caller actually sent.
        const updateSet: Record<string, unknown> = {};
        if (input.targetLabel !== undefined) updateSet.targetLabel = input.targetLabel;
        if (input.sizingMode !== undefined) updateSet.sizingMode = input.sizingMode;
        if (sizingValueStr !== undefined) updateSet.sizingValue = sizingValueStr;
        if (input.maxTradeSize !== undefined) {
          updateSet.maxTradeSize = input.maxTradeSize !== null ? input.maxTradeSize.toFixed(2) : null;
        }
        if (input.maxCoinSize !== undefined) {
          updateSet.maxCoinSize = input.maxCoinSize !== null ? input.maxCoinSize.toFixed(2) : null;
        }
        if (input.autoMirror !== undefined || input.credentialId === null) {
          updateSet.autoMirror = effectiveAutoMirror;
        }
        if (input.credentialId !== undefined) updateSet.credentialId = input.credentialId;
        if (input.perpMaxLeverage !== undefined) {
          updateSet.perpMaxLeverage = input.perpMaxLeverage;
        }
        if (perpTakeProfit !== undefined) updateSet.perpTakeProfitPct = perpTakeProfit;
        if (perpStopLoss !== undefined) updateSet.perpStopLossPct = perpStopLoss;
        Object.assign(updateSet, destinationValues, compatibilityValues);
        if (Object.keys(updateSet).length === 0) updateSet.targetKey = targetKey;

        const [row] = await tx
          .insert(schema.copyTradeFollows)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [
              schema.copyTradeFollows.followerUserId,
              schema.copyTradeFollows.targetType,
              schema.copyTradeFollows.targetKey,
            ],
            set: updateSet,
          })
          .returning();
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to save follow.",
          });
        }

        const duplicateKeys = membershipKeys.filter((key) => key !== targetKey);
        if (duplicateKeys.length > 0) {
          await tx.delete(schema.copyTradeFollows).where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, input.targetType),
              inArray(schema.copyTradeFollows.targetKey, duplicateKeys),
            ),
          );
        }

        const credentialsById = hasTypedDestinationColumns(row)
          ? await loadCredentialSummaries(tx, ctx.userId)
          : undefined;
        return toFollowItem(row, credential, duplicateKeys, credentialsById);
      });
    }),

  /** Unfollow a target (scoped to ctx.userId). Returns whether a row was removed. */
  unfollow: protectedProcedure
    .input(
      z.object({
        targetType: targetTypeSchema,
        targetKey: z.string().min(1).max(256),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const targetKey = await resolveFollowMutationKey(
        ctx.db,
        input.targetType,
        input.targetKey,
      );
      const memberships = await resolveFollowMemberships(ctx.db, [input]);
      const membershipKeys = [
        ...(memberships.get(followMembershipId(input.targetType, input.targetKey)) ?? [targetKey]),
      ];
      const hasTransaction = typeof (ctx.db as PoolDb & { transaction?: unknown }).transaction === "function";
      const removed = await withOptionalTransaction(ctx.db, async (tx) => {
        // Unfollow is a policy mutation too: it must wait behind a worker that
        // has already re-read consent and is holding the same user-first lock.
        if (hasTransaction) await lockCopyPerpPolicyUser(tx, ctx.userId);
        return tx
          .delete(schema.copyTradeFollows)
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, input.targetType),
              membershipKeys.length > 1
                ? inArray(schema.copyTradeFollows.targetKey, membershipKeys)
                : eq(schema.copyTradeFollows.targetKey, targetKey),
            ),
          )
          .returning({ id: schema.copyTradeFollows.id });
      });

      return { removed: removed.length > 0 };
    }),

  /**
   * Partially update an existing follow's sizing rule / auto_mirror flag
   * (scoped to ctx.userId). Identifies the row by (targetType, targetKey).
   */
  update: protectedProcedure
    .input(
      z
        .object({
          targetType: targetTypeSchema,
          targetKey: z.string().min(1).max(256),
          autoMirror: z.boolean().optional(),
          sizingMode: sizingModeSchema.optional(),
          sizingValue: z.number().positive().max(1_000_000).optional(),
          maxTradeSize: copyTradeCapSchema.optional().nullable(),
          maxCoinSize: copyTradeCapSchema.optional().nullable(),
          perpMaxLeverage: perpMaxLeverageSchema,
          credentialId: z.string().uuid().nullable().optional(),
          perpTakeProfitPct: perpTakeProfitPctSchema,
          perpStopLossPct: perpStopLossPctSchema,
          destinations: mirrorDestinationsSchema,
        })
        .superRefine((data, ctx) => {
          // Mode-aware bound, for the pair that is present in the request.
          // A mode arriving WITHOUT its value cannot be range-checked here at
          // all (zod sees no stored row), and it is not a benign partial patch
          // either: see requireSizingValueForModeChange, which rejects it once
          // the current rule has been read.
          const issue = validateSizingForMode(data.sizingMode, data.sizingValue);
          if (issue) {
            ctx.addIssue({ code: "custom", message: issue, path: ["sizingValue"] });
          }
          if (data.destinations !== undefined && hasLegacyDestinationInput(data)) {
            ctx.addIssue({
              code: "custom",
              message: "Use destinations instead of mixing legacy mirror fields in one request.",
              path: ["destinations"],
            });
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const hasTransaction = typeof (ctx.db as PoolDb & { transaction?: unknown }).transaction === "function";
      if (input.perpMaxLeverage !== undefined && !hasTransaction) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Copy-trade leverage changes require a transactional database connection.",
        });
      }
      const targetKey = await resolveFollowMutationKey(
        ctx.db,
        input.targetType,
        input.targetKey,
      );
      const memberships = await resolveFollowMemberships(ctx.db, [input]);
      const membershipKeys = [
        ...(memberships.get(followMembershipId(input.targetType, input.targetKey)) ?? [targetKey]),
      ];
      return withOptionalTransaction(ctx.db, async (tx) => {
        const globalPerpMaxLeverage = hasTransaction
          ? await lockCopyPerpPolicyUser(
              tx,
              ctx.userId,
              input.perpMaxLeverage !== undefined && input.perpMaxLeverage !== null,
            )
          : undefined;
        if (
          input.perpMaxLeverage !== undefined &&
          input.perpMaxLeverage !== null &&
          globalPerpMaxLeverage !== undefined &&
          input.perpMaxLeverage > globalPerpMaxLeverage
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The per-follow leverage cap cannot exceed your global copy-trading cap.",
          });
        }

        const existingRows = await tx
          .select()
          .from(schema.copyTradeFollows)
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, input.targetType),
              membershipKeys.length > 1
                ? inArray(schema.copyTradeFollows.targetKey, membershipKeys)
                : eq(schema.copyTradeFollows.targetKey, targetKey),
            ),
          );
        const current = existingRows.find((row) => row.targetKey === targetKey) ??
          existingRows.find((row) => membershipKeys.includes(row.targetKey));
        if (!current) return null;
        const storedTargetKey = current.targetKey;
        requireSizingValueForModeChange(current.sizingMode, input);

        let effectiveCredentialId =
          input.credentialId !== undefined ? input.credentialId : current.credentialId;
        const effectiveAutoMirror =
          input.credentialId === null ? false : input.autoMirror ?? current.autoMirror;
        let credential: CredentialSummary | undefined;
        if (input.destinations === undefined) {
          const resolved = await resolveLegacyCredential(
            tx,
            ctx.userId,
            effectiveCredentialId,
            current.credentialId,
            input.credentialId,
            effectiveAutoMirror,
            input.targetType,
            input.autoMirror,
          );
          effectiveCredentialId = resolved.credentialId;
          credential = resolved.credential;
          if (effectiveAutoMirror && !credential) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Select a ready Alpaca or Hyperliquid account before enabling Auto-mirror.",
            });
          }
        }
        const normalizedDestinations = await normalizeDestinationInputs(
          tx,
          ctx.userId,
          input.destinations,
          current as unknown as Record<string, unknown>,
        );
        const mutationInput = normalizedDestinations === undefined
          ? input
          : { ...input, destinations: normalizedDestinations };
        const destinationMutation = buildDestinationMutation(
          mutationInput as unknown as Record<string, unknown>,
          current as unknown as Record<string, unknown>,
          input.targetType,
          effectiveCredentialId,
          effectiveAutoMirror,
          credential,
        );
        const destinationValues = destinationMutation
          ? destinationMutation.preservedValues ?? destinationColumnValues(destinationMutation.states)
          : {};
        const compatibilityValues = destinationMutation?.nested
          ? legacyCompatibilityValues(destinationMutation.states)
          : {};

        const updateSet: Record<string, unknown> = {};
        if (input.autoMirror !== undefined || input.credentialId === null) {
          updateSet.autoMirror = effectiveAutoMirror;
        }
        if (input.credentialId !== undefined) updateSet.credentialId = input.credentialId;
        if (input.sizingMode !== undefined) updateSet.sizingMode = input.sizingMode;
        if (input.sizingValue !== undefined) updateSet.sizingValue = input.sizingValue.toFixed(2);
        if (input.maxTradeSize !== undefined) {
          updateSet.maxTradeSize = input.maxTradeSize !== null ? input.maxTradeSize.toFixed(2) : null;
        }
        if (input.maxCoinSize !== undefined) {
          updateSet.maxCoinSize = input.maxCoinSize !== null ? input.maxCoinSize.toFixed(2) : null;
        }
        if (input.perpMaxLeverage !== undefined) {
          updateSet.perpMaxLeverage = input.perpMaxLeverage;
        }
        // Absent leaves the stored exit alone; an explicit null removes it. See
        // perpProtectionPctSchema for why those must not be the same request.
        const patchTakeProfit = perpProtectionColumn(input.perpTakeProfitPct);
        const patchStopLoss = perpProtectionColumn(input.perpStopLossPct);
        if (patchTakeProfit !== undefined) updateSet.perpTakeProfitPct = patchTakeProfit;
        if (patchStopLoss !== undefined) updateSet.perpStopLossPct = patchStopLoss;
        Object.assign(updateSet, destinationValues, compatibilityValues);

        // Nothing to change — return the current row untouched.
        if (Object.keys(updateSet).length === 0) {
          const credentialsById = hasTypedDestinationColumns(current)
            ? await loadCredentialSummaries(tx, ctx.userId)
            : undefined;
          return toFollowItem(current, credential, [], credentialsById);
        }

        const [row] = await tx
          .update(schema.copyTradeFollows)
          .set(updateSet)
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, input.targetType),
              eq(schema.copyTradeFollows.targetKey, storedTargetKey),
            ),
          )
          .returning();

        if (!row) return null;
        const credentialsById = hasTypedDestinationColumns(row)
          ? await loadCredentialSummaries(tx, ctx.userId)
          : undefined;
        return toFollowItem(row, credential, [], credentialsById);
      });
    }),

  /**
   * Follow a Hyperliquid wallet address (idempotent upsert). The wallet is
   * tracked as targetType "hl_wallet" with the 0x address as targetKey.
   * Re-following the same address updates sizing/mirror settings in place.
   */
  followWallet: protectedProcedure
    .input(
      z
        .object({
          walletAddress: walletAddressSchema,
          sizingMode: sizingModeSchema.optional(),
          sizingValue: z.number().positive().max(1_000_000).optional(),
          maxTradeSize: copyTradeCapSchema.optional().nullable(),
          maxCoinSize: copyTradeCapSchema.optional().nullable(),
          autoMirror: z.boolean().optional(),
          credentialId: z.string().uuid().nullable().optional(),
          perpTakeProfitPct: perpTakeProfitPctSchema,
          perpStopLossPct: perpStopLossPctSchema,
          destinations: mirrorDestinationsSchema,
        })
        .superRefine((data, ctx) => {
          const issue = validateSizingForMode(data.sizingMode, data.sizingValue);
          if (issue) {
            ctx.addIssue({ code: "custom", message: issue, path: ["sizingValue"] });
          }
          if (data.destinations !== undefined && hasLegacyDestinationInput(data)) {
            ctx.addIssue({
              code: "custom",
              message: "Use destinations instead of mixing legacy mirror fields in one request.",
              path: ["destinations"],
            });
          }
          if (data.destinations?.stock?.enabled === true) {
            ctx.addIssue({
              code: "custom",
              message: "Hyperliquid wallet follows cannot enable a stock destination.",
              path: ["destinations", "stock"],
            });
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const targetType = "hl_wallet" as const;
      const targetKey = input.walletAddress;
      const hasTransaction =
        typeof (ctx.db as PoolDb & { transaction?: unknown }).transaction === "function";

      return withOptionalTransaction(ctx.db, async (tx) => {
        let followCount: number | null = null;

        if (hasTransaction) {
          const lockedUser = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.id, ctx.userId))
            .for("update");
          if (!lockedUser[0]) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "User account is unavailable.",
            });
          }
          const countRows = await tx
            .select({ count: count() })
            .from(schema.copyTradeFollows)
            .where(eq(schema.copyTradeFollows.followerUserId, ctx.userId));
          const rawCount = (countRows[0] as { count?: unknown } | undefined)?.count;
          followCount = Number(rawCount ?? 0);
          if (!Number.isSafeInteger(followCount) || followCount < 0) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Could not verify the follow limit.",
            });
          }
        }

        const existingRows = await tx
          .select()
          .from(schema.copyTradeFollows)
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              eq(schema.copyTradeFollows.targetType, targetType),
              eq(schema.copyTradeFollows.targetKey, targetKey),
            ),
          );
        const current = existingRows[0] ?? null;

        if (
          hasTransaction &&
          followCount !== null &&
          followCount >= MAX_COPY_TRADE_FOLLOWS_PER_USER &&
          !current
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `You can follow at most ${MAX_COPY_TRADE_FOLLOWS_PER_USER} targets.`,
          });
        }

        requireSizingValueForModeChange(current?.sizingMode, input);

        let effectiveCredentialId =
          input.credentialId !== undefined
            ? input.credentialId
            : current?.credentialId ?? null;
        const effectiveAutoMirror =
          input.credentialId === null
            ? false
            : input.autoMirror ?? current?.autoMirror ?? false;
        let credential: CredentialSummary | undefined;
        if (input.destinations === undefined) {
          const resolved = await resolveLegacyCredential(
            tx,
            ctx.userId,
            effectiveCredentialId,
            current?.credentialId,
            input.credentialId,
            effectiveAutoMirror,
            targetType,
            input.autoMirror,
          );
          effectiveCredentialId = resolved.credentialId;
          credential = resolved.credential;
          if (effectiveAutoMirror && !credential) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Select a ready Hyperliquid account before enabling Auto-mirror.",
            });
          }
        }
        const normalizedDestinations = await normalizeDestinationInputs(
          tx,
          ctx.userId,
          input.destinations,
          current as unknown as Record<string, unknown> | undefined,
        );
        const mutationInput = normalizedDestinations === undefined
          ? input
          : { ...input, destinations: normalizedDestinations };
        const destinationMutation = buildDestinationMutation(
          mutationInput as unknown as Record<string, unknown>,
          current as unknown as Record<string, unknown> | undefined,
          targetType,
          effectiveCredentialId,
          effectiveAutoMirror,
          credential,
        );
        const destinationValues = destinationMutation
          ? destinationMutation.preservedValues ?? destinationColumnValues(destinationMutation.states)
          : {};
        const compatibilityValues = destinationMutation?.nested
          ? legacyCompatibilityValues(destinationMutation.states)
          : {};

        const sizingValueStr =
          input.sizingValue !== undefined ? input.sizingValue.toFixed(2) : undefined;
        const perpTakeProfit = perpProtectionColumn(input.perpTakeProfitPct);
        const perpStopLoss = perpProtectionColumn(input.perpStopLossPct);

        // For inserts, include only what the caller provided; DB defaults cover the rest.
        // For the conflict update, only patch the columns that changed.
        const insertValues = {
          followerUserId: ctx.userId,
          targetType,
          targetKey,
          targetLabel: null as string | null,
          destinationPolicyInitialized: true,
          ...(input.sizingMode !== undefined ? { sizingMode: input.sizingMode } : {}),
          ...(sizingValueStr !== undefined ? { sizingValue: sizingValueStr } : {}),
          ...(input.maxTradeSize !== undefined
            ? { maxTradeSize: input.maxTradeSize !== null ? input.maxTradeSize.toFixed(2) : null }
            : {}),
          ...(input.maxCoinSize !== undefined
            ? { maxCoinSize: input.maxCoinSize !== null ? input.maxCoinSize.toFixed(2) : null }
            : {}),
          ...(input.autoMirror !== undefined || input.credentialId === null
            ? { autoMirror: effectiveAutoMirror }
            : {}),
          ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
          ...(perpTakeProfit !== undefined ? { perpTakeProfitPct: perpTakeProfit } : {}),
          ...(perpStopLoss !== undefined ? { perpStopLossPct: perpStopLoss } : {}),
          ...destinationValues,
          ...compatibilityValues,
        };

        const updateSet: Record<string, unknown> = {};
        if (input.sizingMode !== undefined) updateSet.sizingMode = input.sizingMode;
        if (sizingValueStr !== undefined) updateSet.sizingValue = sizingValueStr;
        if (input.maxTradeSize !== undefined) {
          updateSet.maxTradeSize = input.maxTradeSize !== null ? input.maxTradeSize.toFixed(2) : null;
        }
        if (input.maxCoinSize !== undefined) {
          updateSet.maxCoinSize = input.maxCoinSize !== null ? input.maxCoinSize.toFixed(2) : null;
        }
        if (input.autoMirror !== undefined || input.credentialId === null) {
          updateSet.autoMirror = effectiveAutoMirror;
        }
        if (input.credentialId !== undefined) updateSet.credentialId = input.credentialId;
        if (perpTakeProfit !== undefined) updateSet.perpTakeProfitPct = perpTakeProfit;
        if (perpStopLoss !== undefined) updateSet.perpStopLossPct = perpStopLoss;
        Object.assign(updateSet, destinationValues, compatibilityValues);
        // onConflictDoUpdate requires at least one column in set.
        if (Object.keys(updateSet).length === 0) updateSet.targetKey = targetKey;

        const [row] = await tx
          .insert(schema.copyTradeFollows)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [
              schema.copyTradeFollows.followerUserId,
              schema.copyTradeFollows.targetType,
              schema.copyTradeFollows.targetKey,
            ],
            set: updateSet,
          })
          .returning();

        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to save wallet follow.",
          });
        }

        const credentialsById = hasTypedDestinationColumns(row)
          ? await loadCredentialSummaries(tx, ctx.userId)
          : undefined;
        return toFollowItem(row, credential, [], credentialsById);
      });
    }),

  /** Unfollow a Hyperliquid wallet address (scoped to ctx.userId). */
  unfollowWallet: protectedProcedure
    .input(z.object({ walletAddress: walletAddressSchema }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.db
        .delete(schema.copyTradeFollows)
        .where(
          and(
            eq(schema.copyTradeFollows.followerUserId, ctx.userId),
            eq(schema.copyTradeFollows.targetType, "hl_wallet"),
            eq(schema.copyTradeFollows.targetKey, input.walletAddress),
          ),
        )
        .returning({ id: schema.copyTradeFollows.id });

      return { removed: removed.length > 0 };
    }),
});
