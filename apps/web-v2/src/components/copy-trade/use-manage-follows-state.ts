"use client";

import { useState } from "react";
import {
  DESTINATION_PRESENTATION,
  type MirrorDestination,
  type MirrorDestinationConfig,
} from "./account-targeting";
import type { SizingMode } from "./mirror-sizing";

export interface DestinationProtectionDraft {
  stopLoss: string;
  takeProfit: string;
}

export interface DestinationFollowDraft {
  mode: SizingMode | null;
  value: string;
  protection: DestinationProtectionDraft;
}

export interface DestinationFollowSeed {
  id?: string;
  autoMirror?: boolean;
  credentialId?: string | null;
  credentialAccountLabel?: string | null;
  credentialProvider?: "alpaca" | "hyperliquid" | null;
  sizingMode: SizingMode;
  sizingValue: number;
  perpStopLossPct: number | null;
  perpTakeProfitPct: number | null;
}

export type DestinationDraftChange = Omit<Partial<DestinationFollowDraft>, "protection"> & {
  protection?: Partial<DestinationProtectionDraft>;
};

export type DestinationDrafts = Partial<
  Record<MirrorDestination, DestinationFollowDraft>
>;

export interface FollowDestinationSource extends DestinationFollowSeed {
  destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
}

/**
 * Prefer the independent API state. The legacy branch maps only the provider
 * the API explicitly reported, so a legacy autoMirror flag never arms both
 * venues or silently invents a new destination.
 */
export function resolveFollowDestination(
  follow: FollowDestinationSource,
  destination: MirrorDestination,
): MirrorDestinationConfig {
  const stored = follow.destinations?.[destination];
  if (stored && isMirrorDestinationConfig(stored)) return stored;

  // Once the response has entered the independent shape, an omitted or
  // malformed venue is off. Do not let a legacy top-level flag arm the other
  // destination during a partial rollout or a stale response.
  if (follow.destinations !== undefined) {
    return {
      enabled: false,
      credentialId: null,
      sizingMode: follow.sizingMode,
      sizingValue: follow.sizingValue,
    };
  }

  const provider = DESTINATION_PRESENTATION[destination].provider;
  const legacyMatches = follow.credentialProvider === provider;
  return {
    enabled: legacyMatches ? Boolean(follow.autoMirror) : false,
    credentialId: legacyMatches ? follow.credentialId ?? null : null,
    credentialAccountLabel: legacyMatches ? follow.credentialAccountLabel ?? null : null,
    sizingMode: follow.sizingMode,
    sizingValue: follow.sizingValue,
  };
}

/** Resolve the seed shown before a user edits a destination. */
export function destinationDraftFromSeed(
  seed: DestinationFollowSeed,
  destination: MirrorDestination,
): DestinationFollowDraft {
  return {
    mode: null,
    value: String(seed.sizingValue),
    protection:
      destination === "perp"
        ? {
            stopLoss: seed.perpStopLossPct === null ? "" : String(seed.perpStopLossPct),
            takeProfit:
              seed.perpTakeProfitPct === null ? "" : String(seed.perpTakeProfitPct),
          }
        : { stopLoss: "", takeProfit: "" },
  };
}

function destinationDraftFromFollow(
  follow: FollowDestinationSource,
  destination: MirrorDestination,
): DestinationFollowDraft {
  const config = resolveFollowDestination(follow, destination);
  return destinationDraftFromSeed(
    {
      ...follow,
      sizingMode: config.sizingMode,
      sizingValue: config.sizingValue,
    },
    destination,
  );
}

function draftKey(followId: string, destination: MirrorDestination): string {
  return `${followId}:${destination}`;
}

/**
 * Local, per-follow/per-venue drafts for the independent mirror editor.
 * Nothing is sent until a complete sizing rule is stated, which keeps a mode
 * click from silently reinterpreting the saved number.
 */
export function useManageFollowsState() {
  const [drafts, setDrafts] = useState<
    Record<string, DestinationFollowDraft>
  >({});

  const getDraft = (
    follow: FollowDestinationSource & { id: string },
    destination: MirrorDestination,
  ): DestinationFollowDraft => {
    return drafts[draftKey(follow.id, destination)] ?? destinationDraftFromFollow(follow, destination);
  };

  const updateDraft = (
    followId: string,
    destination: MirrorDestination,
    change: DestinationDraftChange,
    seed: FollowDestinationSource,
  ): void => {
    const key = draftKey(followId, destination);
    setDrafts((current) => {
      const previous = current[key] ?? destinationDraftFromFollow(seed, destination);
      return {
        ...current,
        [key]: {
          ...previous,
          ...change,
          protection: {
            ...previous.protection,
            ...change.protection,
          },
        },
      };
    });
  };

  const clearDraft = (followId: string, destination: MirrorDestination): void => {
    const key = draftKey(followId, destination);
    setDrafts((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return { drafts, getDraft, updateDraft, clearDraft };
}

/** A small structural guard for callers that receive partial API rollout data. */
export function isMirrorDestinationConfig(value: unknown): value is MirrorDestinationConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.enabled === "boolean" &&
    (config.credentialId === null || typeof config.credentialId === "string") &&
    (config.credentialAccountLabel === undefined ||
      config.credentialAccountLabel === null ||
      typeof config.credentialAccountLabel === "string") &&
    (config.sizingMode === "pct" ||
      config.sizingMode === "pct_equity" ||
      config.sizingMode === "usd" ||
      config.sizingMode === "ratio") &&
    typeof config.sizingValue === "number" &&
    Number.isFinite(config.sizingValue)
  );
}
