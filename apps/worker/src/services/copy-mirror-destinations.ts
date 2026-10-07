import type { SizingMode } from "../../../api/src/lib/copy-mirror";

export type MirrorDestination = "stock" | "perp";

export interface MirrorDestinationState {
  enabled: boolean;
  credentialId: string | null;
  sizingMode: SizingMode;
  sizingValue: number;
}

export type MirrorCredentialProvider = "alpaca" | "hyperliquid";

export interface ReadMirrorDestinationOptions {
  /** Provider proof used only for a pre-migration-shaped legacy row. */
  legacyProvider?: MirrorCredentialProvider | null;
}

type DestinationRow = Record<string, unknown>;

const SIZING_BOUNDS: Record<SizingMode, { min: number; max: number }> = {
  pct: { min: 0.01, max: 100 },
  pct_equity: { min: 0.01, max: 100 },
  usd: { min: 0.01, max: 1_000_000 },
  ratio: { min: 0.01, max: 10 },
};

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function readMode(value: unknown): SizingMode | null {
  return value === "pct" || value === "usd" || value === "pct_equity" || value === "ratio"
    ? value
    : null;
}

function hasOwn(row: DestinationRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function readCredentialId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function disabledDestination(credentialId: string | null = null): MirrorDestinationState {
  return {
    enabled: false,
    credentialId,
    sizingMode: "pct",
    sizingValue: 5,
  };
}

function validSizing(mode: SizingMode | null, value: number | null): boolean {
  if (mode === null || value === null) return false;
  const bounds = SIZING_BOUNDS[mode];
  return value >= bounds.min && value <= bounds.max;
}

function readDestinationPair(
  row: DestinationRow,
  prefix: "stock" | "perp",
  allowEnabled: boolean,
): MirrorDestinationState {
  const credentialId = readCredentialId(row[`${prefix}CredentialId`]);
  const sizingMode = readMode(row[`${prefix}SizingMode`]);
  const sizingValue = readNumber(row[`${prefix}SizingValue`]);

  // Never turn a malformed persisted pair into a usable default. A disabled
  // result may retain the account id so a reduce-only close can still identify
  // its durable destination, but it can never be used to stage an open.
  if (sizingMode === null || sizingValue === null || !validSizing(sizingMode, sizingValue)) {
    return disabledDestination(credentialId);
  }
  if (!allowEnabled || row[`${prefix}AutoMirror`] !== true || credentialId === null) {
    return {
      enabled: false,
      credentialId,
      sizingMode,
      sizingValue,
    };
  }
  return {
    enabled: true,
    credentialId,
    sizingMode,
    sizingValue,
  };
}

/** Map source asset identity to the only destination that can execute it. */
export function mirrorDestinationForAsset(
  assetType: string | null | undefined,
): MirrorDestination | null {
  if (assetType === "PERP") return "perp";
  if (assetType === "EQUITY" || assetType === "OPTION") return "stock";
  return null;
}

/**
 * Read one destination from a follow row.
 *
 * A row with typed destination columns is authoritative. The only compatibility
 * escape hatch is a provider-verified row with no typed policy columns, which
 * can exist only in a pre-migration adapter or during a deliberately bounded
 * rollout. An initialized row never infers consent from legacy columns.
 */
export function readMirrorDestination(
  input: unknown,
  destination: MirrorDestination,
  options: ReadMirrorDestinationOptions = {},
): MirrorDestinationState {
  const row = input && typeof input === "object" ? input as DestinationRow : {};
  const prefix = destination === "stock" ? "stock" : "perp";
  const hasTypedColumns = [
    "stockAutoMirror",
    "stockCredentialId",
    "stockSizingMode",
    "stockSizingValue",
    "perpAutoMirror",
    "perpCredentialId",
    "perpSizingMode",
    "perpSizingValue",
  ].some((key) => hasOwn(row, key));
  const destinationProvider: MirrorCredentialProvider = destination === "stock"
    ? "alpaca"
    : "hyperliquid";
  const hasPolicyMarker = hasOwn(row, "destinationPolicyInitialized");

  if (hasTypedColumns || hasPolicyMarker) {
    return readDestinationPair(
      row,
      prefix,
      !hasPolicyMarker || row.destinationPolicyInitialized === true,
    );
  }

  // This branch is intentionally bounded to rows that predate the typed
  // columns. Once migration 0040 has run, every database row has those columns
  // and no legacy row can silently re-arm a venue.
  if (options.legacyProvider !== destinationProvider) return disabledDestination();
  const credentialId = readCredentialId(row.credentialId);
  const sizingMode = readMode(row.sizingMode);
  const sizingValue = readNumber(row.sizingValue);
  if (sizingMode === null || sizingValue === null || !validSizing(sizingMode, sizingValue)) {
    return disabledDestination(credentialId);
  }
  return {
    enabled: row.autoMirror === true && credentialId !== null,
    credentialId,
    sizingMode,
    sizingValue,
  };
}
