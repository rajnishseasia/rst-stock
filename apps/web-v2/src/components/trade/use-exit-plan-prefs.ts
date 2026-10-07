/**
 * Exit-plan preference persistence hook (audit H7: first extraction from the
 * trade-form god component; behavior moved verbatim).
 *
 * When the user tweaks the trail % or toggles the runner off, we remember
 * both and re-apply them to the next trade - so a trader who prefers a wider
 * trail (or wants trailing off) doesn't have to reconfigure it every single
 * order. The same applies to the fixed take-profit leg: removing it, or
 * picking a different R-multiple, is saved and seeds the next ticket's auto
 * plan. Per-browser (client-only).
 *
 * IMPORTANT: these preferences are only written from explicit user actions
 * (toggles, typed values, chip taps, remove buttons) - never from the
 * programmatic auto-fill, which would otherwise overwrite a real preference
 * with derived plan state (e.g. "trailing off because only 1 share fit").
 *
 * Hydration is SSR-safe: form default values seed the first render, and the
 * mount effect reconciles the saved preferences into react-hook-form state.
 */

import { useCallback, useEffect, useRef } from "react";
import { DEFAULT_TP_R, DEFAULT_TRAIL_PERCENT } from "./smart-exit";

export const TRAIL_PREF_KEY = "trade-form:trailing";
export interface TrailingPreference {
  enabled: boolean;
  percent: string;
}

export const TP_PREF_KEY = "trade-form:takeProfit";
export const ATTACH_PREF_KEY = "trade-form:attachExitPlan";
export interface TakeProfitPreference {
  enabled: boolean;
  r: number;
}

/**
 * Narrow setValue contract so this hook doesn't depend on the trade form's
 * full react-hook-form schema type.
 */
export type ExitPlanPrefSetValue = (
  name: "trailingEnabled" | "trailingPercent" | "skipPresetTp" | "orderType",
  value: boolean | string,
  options?: { shouldValidate: boolean },
) => void;

export function useExitPlanPreferences(
  setValue: ExitPlanPrefSetValue,
  hydrateAttachPreference = true,
) {
  const savedTrailingPreferenceRef = useRef<TrailingPreference | null>(null);
  const savedTpPreferenceRef = useRef<TakeProfitPreference | null>(null);
  const savedAttachPreferenceRef = useRef<boolean | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TRAIL_PREF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TrailingPreference>;
        const enabled =
          typeof parsed.enabled === "boolean" ? parsed.enabled : true;
        const percentNum = Number(parsed.percent);
        const percent =
          Number.isFinite(percentNum) && percentNum > 0
            ? String(percentNum)
            : String(DEFAULT_TRAIL_PERCENT);
        savedTrailingPreferenceRef.current = { enabled, percent };
        setValue("trailingEnabled", enabled, { shouldValidate: false });
        setValue("trailingPercent", percent, { shouldValidate: false });
      }
    } catch {
      // ignore malformed stored value; fall through to form defaults
    }
    try {
      const raw = window.localStorage.getItem(ATTACH_PREF_KEY);
      if (raw === "true" || raw === "false") {
        const enabled = raw === "true";
        savedAttachPreferenceRef.current = enabled;
        if (hydrateAttachPreference) {
          setValue("orderType", enabled ? "OCO" : "Market", {
            shouldValidate: false,
          });
        }
      }
    } catch {
      // ignore unavailable storage; fall through to the default exit plan
    }
    try {
      const raw = window.localStorage.getItem(TP_PREF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TakeProfitPreference>;
        const enabled =
          typeof parsed.enabled === "boolean" ? parsed.enabled : true;
        const rNum = Number(parsed.r);
        savedTpPreferenceRef.current = {
          enabled,
          r: Number.isFinite(rNum) && rNum > 0 ? rNum : DEFAULT_TP_R,
        };
        if (!enabled) {
          setValue("skipPresetTp", true, { shouldValidate: false });
        }
      }
    } catch {
      // ignore malformed stored value; fall through to form defaults
    }
    // Run once on mount - user edits persist via the helpers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Remember whether new equity tickets should attach an exit plan. */
  const persistAttachPreference = useCallback((enabled: boolean) => {
    savedAttachPreferenceRef.current = enabled;
    try {
      window.localStorage.setItem(ATTACH_PREF_KEY, String(enabled));
    } catch {
      // localStorage can throw (private mode, quota) - silent by design.
    }
  }, []);

  /**
   * Persist the trailing-runner preference. Partial updates merge over the
   * previously saved value; a non-numeric percent (e.g. a half-typed "")
   * keeps the last good one so it can't erase the preference.
   */
  const persistTrailingPreference = useCallback(
    (pref: Partial<TrailingPreference>) => {
      const prev = savedTrailingPreferenceRef.current;
      const percentNum = Number(pref.percent ?? prev?.percent);
      const next: TrailingPreference = {
        enabled: pref.enabled ?? prev?.enabled ?? true,
        percent:
          Number.isFinite(percentNum) && percentNum > 0
            ? String(percentNum)
            : (prev?.percent ?? String(DEFAULT_TRAIL_PERCENT)),
      };
      savedTrailingPreferenceRef.current = next;
      try {
        window.localStorage.setItem(TRAIL_PREF_KEY, JSON.stringify(next));
      } catch {
        // localStorage can throw (private mode, quota) - silent by design.
      }
    },
    [],
  );

  /** Persist the take-profit preference (attach on/off + preferred R). */
  const persistTakeProfitPreference = useCallback(
    (pref: Partial<TakeProfitPreference>) => {
      const prev = savedTpPreferenceRef.current;
      const rNum = Number(pref.r ?? prev?.r);
      const next: TakeProfitPreference = {
        enabled: pref.enabled ?? prev?.enabled ?? true,
        r: Number.isFinite(rNum) && rNum > 0 ? rNum : DEFAULT_TP_R,
      };
      savedTpPreferenceRef.current = next;
      try {
        window.localStorage.setItem(TP_PREF_KEY, JSON.stringify(next));
      } catch {
        // localStorage can throw (private mode, quota) - silent by design.
      }
    },
    [],
  );

  /**
   * Toggle the auto-TP branch for the current ticket AND remember the choice
   * for future trades. Removing the take-profit (or adding one back) is an
   * explicit user action, so the next ticket seeds the same shape.
   */
  const persistAutoTpPreference = useCallback(
    (enabled: boolean) => {
      setValue("skipPresetTp", !enabled, { shouldValidate: false });
      persistTakeProfitPreference({ enabled });
    },
    [setValue, persistTakeProfitPreference],
  );

  return {
    savedTrailingPreferenceRef,
    savedTpPreferenceRef,
    savedAttachPreferenceRef,
    persistTrailingPreference,
    persistTakeProfitPreference,
    persistAutoTpPreference,
    persistAttachPreference,
  };
}
