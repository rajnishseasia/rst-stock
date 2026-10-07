"use client";

/**
 * PerpTradeForm — the perps execution rail (right column of the perps terminal).
 *
 * A dedicated form (NOT a branch of the 3304-line equity trade-form): direction
 * long/short + margin mode cross/isolated via the shared `BinaryToggle`; order
 * type Market|Limit; leverage via the `Slider` + preset chips clamped to the
 * asset's `maxLeverage`; dual size (coin <-> USD notional) synced through the mark
 * price and rounded to `szDecimals`; reduce-only; post-only (Limit only); limit
 * price (Limit only). Submits `trpc.orders.submitPerp` with a client-generated
 * cloid for idempotency, and gates risky orders (leverage >= 10x or notional over
 * a cap) behind an AlertDialog review — the same review idiom the equity form uses.
 *
 * Pure math (rounding / sync / clamp / review gate) lives in `perp-form-math.ts`
 * and is unit-tested against the real module.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ChevronDown, Shield, Target } from "lucide-react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { BinaryToggle } from "@/components/ui/binary-toggle";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { TICKET_CTA_NEGATIVE, TICKET_CTA_POSITIVE } from "./ticket-cta";
import { useSession } from "@/lib/auth-client";
import { useVenue } from "@/lib/venue-context";
import { PerpsOnboardingCard } from "@/components/perps/perps-onboarding-card";
import {
  clampLeverageForCap,
  coinSizeToUsd,
  generatePerpCloid,
  isTriggerUiOrderType,
  marginRequiredUsd,
  resolvePerpOrderType,
  roundSizeToDecimals,
  uiOrderTypeUsesLimitPrice,
  usdInputToCoinSize,
  DEFAULT_PERP_LEVERAGE,
  FALLBACK_MAX_LEVERAGE,
  leveragePresets,
  type PerpUiOrderType,
} from "./perp-form-math";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import {
  PERP_SIZE_PRESET_PERCENTS,
  perpPresetCoinSize,
  perpPresetLabel,
  resolvePerpSizeBasis,
} from "./perp-size-presets";
import { PerpSizeHeroInput } from "./perp-size-hero-input";
import {
  TICKET_INPUT_TEXT_SM,
  TICKET_INPUT_TEXT_XS,
} from "./ticket-input-text";
import { formatUsd } from "@/lib/format";
// PRICES on a perp must use the adaptive helper, not the fixed 2-decimal one:
// Hyperliquid lists sub-cent coins (kPEPE, kBONK, kSHIB), and formatUsd renders
// 0.002711 as "$0.00". USD AMOUNTS (notional, margin) stay on formatUsd.
import { formatPerpUsd } from "@/components/perps/perp-format";
import { perpPositionSummary } from "./ticket-position-summary";
import { TicketContextRow } from "./ticket-context-row";
import {
  derivePerpTriggerPrice,
  derivePerpTriggerValue,
  isPerpTriggerDirectionValid,
  normalizePerpDecimalInput,
  triggerPriceToInput,
} from "./perp-tpsl-input";
import {
  SubmissionAttemptGuard,
  visiblePerpSubmitError,
} from "./perp-submission-state";
import {
  buildPerpTicketReset,
  resolveManualCopyLeverage,
  resolvePerpManualCopySourceId,
} from "./manual-copy-prefill";

export interface PerpTradeFormProps {
  /** Active perp coin (e.g. "BTC"). */
  coin: string;
  /** Whether perps have been enabled + funded (gates the form). */
  enabled: boolean;
  /**
   * Prefill direction when copying a perp signal (true = long, false = short).
   * Applied on each `prefillNonce` bump; the user can still change it after.
   */
  initialIsLong?: boolean;
  /**
   * Prefill leverage when copying a perp signal. Applied on each `prefillNonce`
   * bump and re-clamped to the asset's real max leverage once metadata loads.
   */
  initialLeverage?: number;
  /**
   * Prefill a resting limit price, as HL's raw decimal string. Set by a click
   * on a level in the desktop order book; applied on each `prefillNonce` bump,
   * which also flips the order type to Limit so the field the price lands in is
   * actually visible. The user can still change or clear it afterward.
   *
   * The string is passed through verbatim rather than re-formatted: HL prices
   * carry more precision than the display helpers keep, and the value here is
   * what gets submitted.
   */
  initialLimitPrice?: string;
  /**
   * Bumped by the parent on every perp-signal Copy so a repeated copy of the
   * same call re-applies the prefill (a plain value change would not re-fire).
   * Zero / undefined means "no prefill" and the form keeps its own defaults.
   */
  prefillNonce?: number;
  /**
   * The coin the prefill was copied FOR. The prefill is skipped when it does not
   * match the coin currently loaded, so a stale side/leverage cannot land on a
   * different market. Omit to apply regardless of coin.
   */
  prefillCoin?: string;
  /** Parent-owned event consumption prevents a mobile remount from replaying it. */
  prefillConsumed?: boolean;
  onPrefillConsumed?: (nonce: number) => void;
  onManualCopyPrefillCompleted?: (nonce: number) => void;
  onManualCopyPrefillCancelled?: (nonce: number) => void;
  /** Canonical source-prefixed feed id for this manual perp copy. */
  copySourceItemId?: string;
  /** Immutable source market/direction used to clear provenance on edits. */
  copySourceCoin?: string;
  copySourceSide?: "long" | "short";
  /**
   * Suppress the ticket's own coin + mark-price header because the host already
   * states the market. Set by the mobile trade sheet (plan A1), whose header
   * carries the display coin, a PERP tag and the live mark; without this the two
   * stack and the symbol and price render twice. The ticket now spells the
   * market the same way everywhere (namespace stripped), so hiding this header
   * no longer changes which spelling the user sees.
   */
  hideMarketHeader?: boolean;
}

/**
 * Local Zod schema for the perp form's string-first fields. Validation of the
 * numeric ranges (positive size, limit required for Limit) mirrors the server's
 * `perpOrderSubmitSchema`; the server is still the source of truth on submit.
 */
const perpTradeFormSchema = z
  .object({
    isLong: z.boolean(),
    marginMode: z.enum(["cross", "isolated"]),
    /** User-facing selection; resolved to a concrete server type on submit. */
    orderType: z.enum([
      "Market",
      "Limit",
      "StopMarket",
      "StopLimit",
      "TakeProfit",
    ]) satisfies z.ZodType<PerpUiOrderType>,
    /** Coin size as the user typed it (validated as a positive decimal). */
    sizeCoin: z
      .string()
      .refine((v) => v.trim() !== "" && Number(v) > 0, "Enter a size greater than 0"),
    limitPrice: z.string().optional(),
    /** Trigger price for stop / take-profit orders. */
    triggerPx: z.string().optional(),
    reduceOnly: z.boolean(),
    postOnly: z.boolean(),
    leverage: z.number().int().positive(),
  })
  // Plain Limit and Stop Limit REQUIRE a resting limit price. (Take Profit's
  // limit price is optional — its presence chooses the TP-Limit variant.)
  .refine(
    (v) =>
      (v.orderType !== "Limit" && v.orderType !== "StopLimit") ||
      (!!v.limitPrice && Number(v.limitPrice) > 0),
    { message: "Enter a limit price", path: ["limitPrice"] },
  )
  // Every trigger (stop / take-profit) order REQUIRES a trigger price.
  .refine(
    (v) =>
      !isTriggerUiOrderType(v.orderType) ||
      (!!v.triggerPx && Number(v.triggerPx) > 0),
    { message: "Enter a trigger price", path: ["triggerPx"] },
  );

type PerpTradeFormData = z.infer<typeof perpTradeFormSchema>;

/** The five user-facing order-type choices, in selector order. */
const ORDER_TYPE_OPTIONS: readonly { value: PerpUiOrderType; label: string }[] = [
  { value: "Market", label: "Market" },
  { value: "Limit", label: "Limit" },
  { value: "StopMarket", label: "Stop Market" },
  { value: "StopLimit", label: "Stop Limit" },
  { value: "TakeProfit", label: "Take Profit" },
];

const PRIMARY_ORDER_TYPE_OPTIONS = ORDER_TYPE_OPTIONS.filter(
  ({ value }) => value === "Market" || value === "Limit",
);

const ADVANCED_ORDER_TYPE_OPTIONS = ORDER_TYPE_OPTIONS.filter(({ value }) =>
  isTriggerUiOrderType(value),
);

/**
 * Which of the three collapsed order settings is expanded (plan A4), or null.
 * These are PERPS-ONLY concepts. Nothing here may be lifted into the equity
 * ticket: an Alpaca stock order has no leverage and no margin mode.
 */
type PerpSettingPill = "margin" | "type" | "leverage" | null;

/**
 * One pill in the collapsed settings row: a label naming the setting and the
 * value currently chosen, so the row states the whole order configuration
 * without expanding anything.
 */
function SettingPill({
  label,
  value,
  expanded,
  controls,
  onClick,
}: {
  label: string;
  value: string;
  expanded: boolean;
  controls: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`${label}: ${value}`}
      className={cn(
        // 44px on touch, back to the terminal's compact pill from `sm` up.
        "flex h-11 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs font-semibold transition-colors duration-150 sm:h-8",
        expanded
          ? "border-border bg-muted text-foreground"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <span className="truncate tabular-nums">{value}</span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform duration-150",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

/** A single labeled row in the review dialog. */
function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-data font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Friendly label for the review modal, reflecting the RESOLVED server type. */
function reviewOrderTypeLabel(data: PerpTradeFormData): string {
  const hasLimit = !!data.limitPrice && data.limitPrice.trim() !== "";
  const resolved = resolvePerpOrderType(data.orderType, hasLimit);
  const labels: Record<string, string> = {
    Market: "Market",
    Limit: "Limit",
    StopMarket: "Stop Market",
    StopLimit: "Stop Limit",
    TakeProfitMarket: "Take Profit (Market)",
    TakeProfitLimit: "Take Profit (Limit)",
  };
  return labels[resolved] ?? resolved;
}

export function PerpTradeForm({
  coin,
  enabled,
  initialIsLong,
  initialLeverage,
  initialLimitPrice,
  prefillNonce = 0,
  prefillCoin,
  prefillConsumed = false,
  onPrefillConsumed,
  onManualCopyPrefillCompleted,
  onManualCopyPrefillCancelled,
  copySourceItemId,
  copySourceCoin,
  copySourceSide,
  hideMarketHeader = false,
}: PerpTradeFormProps) {
  const trpcUtils = trpc.useUtils();
  const { accountContext } = useVenue();
  // Platform session gates the onboarding card's status query when the rail
  // shows the not-yet-enabled setup flow instead of the form.
  const { data: session } = useSession();
  const hasSession = !!session?.user;

  // One per-coin snapshot provides both live prices and DEX-aware metadata.
  // This is load-bearing for HIP-3 (`xyz:JPY`): the default `meta/allMids`
  // endpoints only cover the validator-operated DEX unless a dex is supplied.
  const snapshotQuery = trpc.hyperliquid.assetSnapshot.useQuery(
    { coin },
    {
      enabled,
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  );
  // Plan A2: what the account holds in THIS coin. Same query key (and same 30s
  // cadence) the perp positions panel already uses, so mounting both shares one
  // cache entry rather than doubling the poll.
  const perpPositionsQuery = trpc.positions.listPerps.useQuery(undefined, {
    enabled: enabled && hasSession,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  // HL spells coins case-sensitively (kPEPE), so match case-insensitively but
  // never rewrite the coin itself.
  const openPosition = useMemo(
    () =>
      perpPositionsQuery.data?.positions.find(
        (position) => position.coin.toUpperCase() === coin.toUpperCase(),
      ) ?? null,
    [coin, perpPositionsQuery.data],
  );

  /**
   * How the market is SPELLED on screen. Hyperliquid namespaces its
   * stock-backed perps, so MU is canonically "xyz:MU", and that prefix is a
   * venue implementation detail most people do not recognise.
   *
   * This ticket previously kept the canonical spelling in its header, size
   * suffix, submit button and review dialog, on the reasoning that the point of
   * decision should name the exact market. In practice that just showed people
   * a prefix they could not read. DISPLAY ONLY: `coin` stays canonical
   * everywhere it matters (queries, the order payload, prefill matching, the
   * HIP-3 branch), because it is the coin Hyperliquid actually trades.
   */
  const displayCoin = perpDisplayCoin(coin);

  const szDecimals = snapshotQuery.data?.szDecimals ?? 4;
  // The REAL per-asset cap once metadata has loaded, or `undefined` while it is
  // still in flight. We deliberately do NOT default this to 1: a placeholder cap
  // of 1 is what pinned the leverage slider to 1x on a cold mount.
  const loadedMaxLeverage =
    snapshotQuery.data && Number.isFinite(snapshotQuery.data.maxLeverage)
      ? snapshotQuery.data.maxLeverage
      : undefined;
  // Cap to drive the slider/chip range. Falls back to a usable ceiling while the
  // real cap loads, so the control is never stuck at a 1x range.
  const sliderMaxLeverage = loadedMaxLeverage ?? FALLBACK_MAX_LEVERAGE;

  const markPrice = useMemo(() => {
    const parsed = Number(
      snapshotQuery.data?.markPx ?? snapshotQuery.data?.midPx,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [snapshotQuery.data]);
  const isolatedOnly = snapshotQuery.data?.isolatedOnly ?? false;

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<PerpTradeFormData>({
    resolver: zodResolver(perpTradeFormSchema),
    defaultValues: {
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "",
      limitPrice: "",
      triggerPx: "",
      reduceOnly: false,
      postOnly: false,
      leverage: DEFAULT_PERP_LEVERAGE,
    },
  });

  const isLong = watch("isLong");
  const marginMode = watch("marginMode");
  const orderType = watch("orderType");
  const sizeCoin = watch("sizeCoin");
  const leverage = watch("leverage");
  const reduceOnly = watch("reduceOnly");
  const postOnly = watch("postOnly");
  const watchedLimitPrice = watch("limitPrice");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedOrderTypesId = useId();
  // Plan A4: margin mode, order type and leverage collapse into one pill row.
  // Each pill opens the SAME control that used to sit in its own labelled block;
  // only one is expanded at a time so the ticket stops being three screens tall.
  const [openSetting, setOpenSetting] = useState<PerpSettingPill>(null);
  const settingsPanelId = useId();
  const toggleSetting = (pill: Exclude<PerpSettingPill, null>) =>
    setOpenSetting((current) => (current === pill ? null : pill));

  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [tpPriceInput, setTpPriceInput] = useState("");
  const [tpValueInput, setTpValueInput] = useState("");
  const [tpMode, setTpMode] = useState<"percent" | "pnlUsd">("percent");
  const [slPriceInput, setSlPriceInput] = useState("");
  const [slValueInput, setSlValueInput] = useState("");
  const [slMode, setSlMode] = useState<"percent" | "pnlUsd">("percent");
  const [activePresetPercent, setActivePresetPercent] = useState<number | null>(null);
  const tpLastEditedRef = useRef<"price" | "value">("price");
  const slLastEditedRef = useRef<"price" | "value">("price");
  // tpModeOpen / slModeOpen removed: mode selectors now use Radix DropdownMenu
  // which manages its own open state via Portal, fixing click interception by
  // the TradingView iframe when the form is positioned over the chart.

  // UI affordance flags derived from the current selection.
  const isTrigger = isTriggerUiOrderType(orderType);
  const selectedOrderTypeLabel =
    ORDER_TYPE_OPTIONS.find(({ value }) => value === orderType)?.label ??
    orderType;
  // Which inputs to show. Take Profit shows an OPTIONAL limit-price input (its
  // presence upgrades TP-Market → TP-Limit); Limit / Stop Limit REQUIRE it.
  const showLimitPrice =
    orderType === "Limit" ||
    orderType === "StopLimit" ||
    orderType === "TakeProfit";
  const limitPriceRequired =
    orderType === "Limit" || orderType === "StopLimit";
  // Post-only only applies to a plain resting Limit order.
  const showPostOnly = orderType === "Limit";

  // USD notional field is a sibling of the coin field; the two stay in sync via
  // the mark price. We track which side the user last edited so a mid refresh
  // doesn't clobber the field they're typing in.
  const [usdInput, setUsdInput] = useState("");
  const lastEditedRef = useRef<"coin" | "usd">("coin");
  const previousCoinRef = useRef(coin);

  // A mounted desktop rail can switch directly between perp markets. Do not
  // carry the previous market's quantity into the newly selected contract.
  useEffect(() => {
    if (previousCoinRef.current === coin) return;
    previousCoinRef.current = coin;
    lastEditedRef.current = "coin";
    setUsdInput("");
    setValue("sizeCoin", "", { shouldValidate: false });
  }, [coin, setValue]);

  useEffect(() => {
    if (isolatedOnly) {
      setValue("marginMode", "isolated", { shouldValidate: true });
    }
  }, [isolatedOnly, setValue]);

  // Clamp leverage DOWN only once a REAL cap has loaded (or when switching to an
  // asset with a lower cap). While the cap is still loading we skip entirely, so
  // the default leverage is never pinned to 1x on a cold mount.
  useEffect(() => {
    if (loadedMaxLeverage === undefined) return;
    setValue("leverage", clampLeverageForCap(leverage, loadedMaxLeverage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedMaxLeverage]);

  // Prefill direction + leverage when a perp signal is copied. Keyed on the
  // nonce so a repeat copy re-applies even when the values are unchanged. The
  // leverage is clamped defensively here; the clamp-on-cap effect above re-clamps
  // it once the asset's real maxLeverage loads (so a 20x prefill on a 3x-cap coin
  // never persists a value HL would reject). The user can still change either
  // control afterward.
  //
  // The nonce is CONSUMED ONCE. This form unmounts and remounts on right-pane
  // tab switches, mobile sheet open/close and venue flips; without the guard the
  // mount effect re-applies the last copied side/leverage every time, silently
  // stamping "20x short" onto a different coin the user had since set up.
  // `prefillCoin` scopes it further: a prefill is only applied to the coin it was
  // copied for.
  const appliedPrefillNonceRef = useRef(0);
  useEffect(() => {
    // A copy made before this user's perp wallet exists lands here while
    // `enabled` is false and the rail renders PerpsOnboardingCard instead of
    // this form. Without this guard the nonce was consumed right here anyway
    // (an effect runs regardless of what the component RETURNS), so once
    // onboarding completed the effect never re-ran (`enabled` wasn't even in
    // the dependency list) and the user got a default ticket instead of the
    // one they copied. Bail before touching the ref so the SAME nonce is still
    // "unapplied" once `enabled` flips true.
    if (!enabled) return;
    if (!prefillNonce) return;
    if (prefillConsumed) return;
    if (appliedPrefillNonceRef.current === prefillNonce) return;
    if (prefillCoin && prefillCoin !== coin) return;
    appliedPrefillNonceRef.current = prefillNonce;
    reviewedIdentityRef.current = null;
    setPendingReview(null);
    if (onPrefillConsumed) {
      // Manual copy is a complete ticket replacement. Clear every order-specific
      // field so a second copy cannot inherit size, exits, or a pending review.
      reset(
        buildPerpTicketReset({
          isLong: typeof initialIsLong === "boolean" ? initialIsLong : true,
          marginMode: isolatedOnly ? "isolated" : marginMode,
          leverage: resolveManualCopyLeverage(initialLeverage),
          maxLeverage: loadedMaxLeverage,
        }),
      );
      setUsdInput("");
      lastEditedRef.current = "coin";
      setTpSlEnabled(false);
      setTpPriceInput("");
      setTpValueInput("");
      setTpMode("percent");
      setSlPriceInput("");
      setSlValueInput("");
      setSlMode("percent");
      setAdvancedOpen(false);
      setOpenSetting(null);
      onPrefillConsumed(prefillNonce);
    } else {
      // Signal/mobile-side prefills are intentionally partial: keep the user's
      // existing ticket and only apply the values represented by that action.
      if (typeof initialIsLong === "boolean") {
        setValue("isLong", initialIsLong);
      }
      if (typeof initialLeverage === "number" && Number.isFinite(initialLeverage)) {
        setValue("leverage", clampLeverageForCap(initialLeverage, loadedMaxLeverage));
      }
      // A clicked order-book level is a resting price, so it only means anything
      // on a limit order: flip the type as well as filling the field, otherwise
      // the price lands in a control the Market ticket does not even render.
      // A blank / non-positive value is ignored rather than stamping an invalid
      // Limit ticket the user then has to undo.
      if (initialLimitPrice && Number(initialLimitPrice) > 0) {
        setValue("limitPrice", initialLimitPrice, { shouldValidate: true });
        setValue("orderType", "Limit", { shouldValidate: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    prefillNonce,
    prefillCoin,
    prefillConsumed,
    coin,
    enabled,
    isolatedOnly,
    loadedMaxLeverage,
    marginMode,
    onPrefillConsumed,
    reset,
  ]);

  // Keep the USD field in sync when the coin size (or mark) changes and the coin
  // field is the one being edited.
  useEffect(() => {
    if (lastEditedRef.current !== "coin") return;
    const coinNum = Number(sizeCoin);
    if (!Number.isFinite(coinNum) || coinNum <= 0 || markPrice <= 0) {
      setUsdInput("");
      return;
    }
    setUsdInput(coinSizeToUsd(coinNum, markPrice).toFixed(2));
  }, [sizeCoin, markPrice]);

  // If USD was edited before the asynchronous HIP-3 snapshot arrived, convert
  // it once mark price and asset precision become available. This also keeps
  // the coin size correct if a later snapshot reports different precision.
  useEffect(() => {
    if (lastEditedRef.current !== "usd") return;
    setValue(
      "sizeCoin",
      usdInputToCoinSize(usdInput, markPrice, szDecimals),
      { shouldValidate: true },
    );
  }, [usdInput, markPrice, szDecimals, setValue]);

  const handleUsdChange = (raw: string) => {
    setActivePresetPercent(null);
    lastEditedRef.current = "usd";
    setUsdInput(raw);
    setValue("sizeCoin", usdInputToCoinSize(raw, markPrice, szDecimals), {
      shouldValidate: true,
    });
  };

  const handleCoinChange = (raw: string) => {
    setActivePresetPercent(null);
    lastEditedRef.current = "coin";
    setValue("sizeCoin", raw, { shouldValidate: true });
  };

  // Round the coin field to szDecimals on blur so the submitted value already
  // matches HL's size rules (the server rounds again authoritatively).
  const handleCoinBlur = () => {
    const coinNum = Number(sizeCoin);
    if (Number.isFinite(coinNum) && coinNum > 0) {
      setValue("sizeCoin", roundSizeToDecimals(coinNum, szDecimals), {
        shouldValidate: true,
      });
    }
  };

  // For % and $ conversions, use the limit price as the entry basis when the
  // user has entered one (Limit order), so targets are relative to the resting
  // price, not the current mark. Falls back to mark for Market orders.
  const tpSlEntryPrice = useMemo(() => {
    const lp = watchedLimitPrice ? Number(watchedLimitPrice) : NaN;
    return Number.isFinite(lp) && lp > 0 ? lp : markPrice;
  }, [watchedLimitPrice, markPrice]);

  function handleTpPriceChange(raw: string) {
    tpLastEditedRef.current = "price";
    setTpPriceInput(raw);
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0 || tpSlEntryPrice <= 0) {
      setTpValueInput("");
      return;
    }
    if (tpMode === "percent") {
      const pct = ((price - tpSlEntryPrice) / tpSlEntryPrice) * 100;
      setTpValueInput(Math.abs(pct) > 0 ? Math.abs(pct).toFixed(2) : "");
    } else {
      const coinNum = Number(sizeCoin);
      const pnl = Math.abs(price - tpSlEntryPrice) * (Number.isFinite(coinNum) ? coinNum : 0);
      setTpValueInput(pnl > 0 ? pnl.toFixed(2) : "");
    }
  }

  function handleTpValueChange(raw: string) {
    tpLastEditedRef.current = "value";
    setTpValueInput(raw);
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0 || tpSlEntryPrice <= 0) {
      setTpPriceInput("");
      return;
    }
    const side = isLong ? "long" : "short";
    const computed = derivePerpTriggerPrice({ mode: tpMode, kind: "takeProfit", side, value: val, entryPrice: tpSlEntryPrice, size: Number(sizeCoin) });
    setTpPriceInput(computed ? triggerPriceToInput(computed) : "");
  }

  function handleSlPriceChange(raw: string) {
    slLastEditedRef.current = "price";
    setSlPriceInput(raw);
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0 || tpSlEntryPrice <= 0) {
      setSlValueInput("");
      return;
    }
    if (slMode === "percent") {
      const pct = ((tpSlEntryPrice - price) / tpSlEntryPrice) * 100;
      setSlValueInput(Math.abs(pct) > 0 ? Math.abs(pct).toFixed(2) : "");
    } else {
      const coinNum = Number(sizeCoin);
      const pnl = Math.abs(tpSlEntryPrice - price) * (Number.isFinite(coinNum) ? coinNum : 0);
      setSlValueInput(pnl > 0 ? pnl.toFixed(2) : "");
    }
  }

  function handleSlValueChange(raw: string) {
    slLastEditedRef.current = "value";
    setSlValueInput(raw);
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0 || tpSlEntryPrice <= 0) {
      setSlPriceInput("");
      return;
    }
    const side = isLong ? "long" : "short";
    const computed = derivePerpTriggerPrice({ mode: slMode, kind: "stopLoss", side, value: val, entryPrice: tpSlEntryPrice, size: Number(sizeCoin) });
    setSlPriceInput(computed ? triggerPriceToInput(computed) : "");
  }

  // Keep each TP/SL pair synchronized when position size, entry basis,
  // direction, or display unit changes. The last field the user edited remains
  // authoritative: a typed price updates its dollar risk as size changes, while
  // a typed dollar budget updates the trigger price.
  useEffect(() => {
    const size = Number(sizeCoin);
    const side = isLong ? "long" : "short";
    const syncPair = (
      kind: "takeProfit" | "stopLoss",
      mode: "percent" | "pnlUsd",
      priceInput: string,
      valueInput: string,
      lastEdited: "price" | "value",
      setPrice: (value: string) => void,
      setValueInput: (value: string) => void,
    ) => {
      if (lastEdited === "price") {
        const value = derivePerpTriggerValue({
          mode,
          triggerPrice: Number(priceInput),
          entryPrice: tpSlEntryPrice,
          size,
        });
        setValueInput(value === null ? "" : value.toFixed(2));
        return;
      }
      const price = derivePerpTriggerPrice({
        mode,
        kind,
        side,
        value: Number(valueInput),
        entryPrice: tpSlEntryPrice,
        size,
      });
      setPrice(price === null ? "" : triggerPriceToInput(price));
    };

    syncPair("takeProfit", tpMode, tpPriceInput, tpValueInput, tpLastEditedRef.current, setTpPriceInput, setTpValueInput);
    syncPair("stopLoss", slMode, slPriceInput, slValueInput, slLastEditedRef.current, setSlPriceInput, setSlValueInput);
    // Inputs are intentionally omitted: this effect responds to changes in the
    // conversion context, while input handlers synchronize ordinary keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeCoin, tpSlEntryPrice, isLong, tpMode, slMode]);

  const notionalUsd = useMemo(
    () => coinSizeToUsd(Number(sizeCoin), markPrice),
    [sizeCoin, markPrice],
  );
  const marginUsd = useMemo(
    () => marginRequiredUsd(notionalUsd, leverage),
    [notionalUsd, leverage],
  );

  // The TP/SL the review dialog shows. Derived exactly as executeSubmit derives
  // the prices it sends, so the confirmation cannot disagree with the payload.
  const reviewTakeProfitPx = useMemo(() => {
    if (!tpSlEnabled || tpPriceInput.trim() === "") return null;
    const px = Number(tpPriceInput);
    return Number.isFinite(px) ? px : null;
  }, [tpSlEnabled, tpPriceInput]);
  const reviewStopLossPx = useMemo(() => {
    if (!tpSlEnabled || slPriceInput.trim() === "") return null;
    const px = Number(slPriceInput);
    return Number.isFinite(px) ? px : null;
  }, [tpSlEnabled, slPriceInput]);

  // What the size quick-fill chips scale. Reduce Only makes them a share of the
  // open position; otherwise a share of free CROSS collateral times leverage.
  //
  // The cross summary rides along on the positions read (same clearinghouse
  // round trip, no extra request). It is deliberately not the Balance cell
  // below, which is total collateral including margin already committed, and
  // not `withdrawable`, whose transfer floor understates what can be opened.
  // See the header of perp-size-presets.ts for both, with the docs' formulas.
  const sizeBasis = useMemo(
    () =>
      resolvePerpSizeBasis({
        reduceOnly,
        position: openPosition,
        positionsSettled: perpPositionsQuery.isSuccess,
        crossMargin: perpPositionsQuery.isSuccess
          ? perpPositionsQuery.data?.crossMargin ?? null
          : null,
        markPrice,
        // The clamped value, not the raw watched one: the chips must size
        // against the leverage the order will actually carry.
        leverage: clampLeverageForCap(leverage, loadedMaxLeverage),
      }),
    [
      reduceOnly,
      openPosition,
      perpPositionsQuery.isSuccess,
      perpPositionsQuery.data,
      markPrice,
      leverage,
      loadedMaxLeverage,
    ],
  );

  // Chips write the preset size and lock lastEditedRef to "usd" when opening,
  // so the USD hero input matches Buying Power exactly and stays stable across live mark price ticks.
  const applySizePreset = (percent: (typeof PERP_SIZE_PRESET_PERCENTS)[number]) => {
    setActivePresetPercent(percent);
    if (sizeBasis.kind === "open" && sizeBasis.maxNotionalUsd > 0) {
      const targetUsd = (sizeBasis.maxNotionalUsd * percent) / 100;
      const targetUsdStr = targetUsd.toFixed(2);
      lastEditedRef.current = "usd";
      setUsdInput(targetUsdStr);
      setValue(
        "sizeCoin",
        usdInputToCoinSize(targetUsdStr, markPrice, szDecimals),
        { shouldValidate: true },
      );
    } else if (sizeBasis.kind === "reduce") {
      const next = perpPresetCoinSize(sizeBasis, percent, szDecimals);
      if (next === "") return;
      lastEditedRef.current = "coin";
      setValue("sizeCoin", next, { shouldValidate: true });
    }
  };

  const [pendingReview, setPendingReview] = useState<PerpTradeFormData | null>(
    null,
  );
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(
    null,
  );
  const submitInFlightRef = useRef(false);
  const submissionAttemptsRef = useRef(new SubmissionAttemptGuard());

  // Idempotency cloid, generated ONCE per order "intent" and REUSED across
  // retries so a resubmit after an ambiguous failure hits server-side dedupe
  // (never double-places). We regenerate only when the order payload changes
  // (a genuinely different order) and clear it on a successful submit.
  const cloidRef = useRef<string | null>(null);
  const cloidSigRef = useRef<string | null>(null);
  const stableCloid = (signature: string): string => {
    if (cloidRef.current === null || cloidSigRef.current !== signature) {
      cloidRef.current = generatePerpCloid();
      cloidSigRef.current = signature;
    }
    return cloidRef.current;
  };

  // A review owns its identity until success, cancellation, or replacement.
  // Each async attempt retains this object even if another review opens.
  const reviewedIdentityRef = useRef<{
    nonce: number | null;
    coin: string;
    sourceId?: string;
    sourceCoin?: string;
    sourceSide?: "long" | "short";
  } | null>(null);
  const submittingReviewRef = useRef<typeof reviewedIdentityRef.current>(null);
  const submitMutation = trpc.orders.submitPerp.useMutation({
    onSuccess: (result) => {
      if (result && result.success === false) return;
      void trpcUtils.positions.listPerps.invalidate();
      toast.success(result?.message ?? "Perp order submitted");
      if (result && "tpSlWarning" in result && typeof result.tpSlWarning === "string") {
        toast.warning(result.tpSlWarning);
      }
      if (reviewedIdentityRef.current !== submittingReviewRef.current) return;
      setSubmitErrorMessage(null);
      setPendingReview(null);
      cloidRef.current = null;
      cloidSigRef.current = null;
      reset((prev) => ({ ...prev, sizeCoin: "", limitPrice: "", triggerPx: "" }));
      setTpPriceInput("");
      setTpValueInput("");
      setSlPriceInput("");
      setSlValueInput("");
      setTpSlEnabled(false);
      setUsdInput("");
    },
  });

  const isSubmitBusy = submitMutation.isPending;

  const executeSubmit = async (data: PerpTradeFormData) => {
    const reviewedIdentity = reviewedIdentityRef.current;
    if (!reviewedIdentity) return;
    const orderCoin = reviewedIdentity.coin;
    setSubmitErrorMessage(null);
    const roundedSize = roundSizeToDecimals(Number(data.sizeCoin), szDecimals);
    if (Number(roundedSize) <= 0) {
      toast.error("Size rounds to zero at this asset's precision");
      return;
    }
    const leverage = clampLeverageForCap(data.leverage, loadedMaxLeverage);
    const dataHasLimitPrice = !!data.limitPrice && data.limitPrice.trim() !== "";
    // Resolve the friendly UI selection to the concrete server order type
    // (Take Profit → TP-Limit when a limit price is present, else TP-Market).
    const resolvedType = resolvePerpOrderType(data.orderType, dataHasLimitPrice);
    // Include the limit price only when the resolved type actually uses one.
    const limitPrice =
      uiOrderTypeUsesLimitPrice(data.orderType, dataHasLimitPrice) &&
      data.limitPrice
        ? normalizePerpDecimalInput(data.limitPrice)
        : undefined;
    // Trigger price accompanies every stop / take-profit order.
    const triggerPx =
      isTriggerUiOrderType(data.orderType) && data.triggerPx
        ? normalizePerpDecimalInput(data.triggerPx)
        : undefined;
    // Post-only is only meaningful on a plain resting Limit order.
    const postOnly = resolvedType === "Limit" ? data.postOnly : false;
    const positionSide = data.isLong ? "long" : "short";
    const requestedTakeProfit =
      tpSlEnabled && tpPriceInput.trim() !== "" ? Number(tpPriceInput) : null;
    const requestedStopLoss =
      tpSlEnabled && slPriceInput.trim() !== "" ? Number(slPriceInput) : null;

    if (tpSlEnabled && requestedTakeProfit === null && requestedStopLoss === null) {
      toast.error("Enter a take-profit or stop-loss price before submitting.");
      return;
    }
    if (tpSlEnabled && (resolvedType !== "Market" || data.reduceOnly)) {
      toast.error("Inline TP/SL is available only for new Market positions.");
      return;
    }
    if (
      requestedTakeProfit !== null &&
      (!Number.isFinite(requestedTakeProfit) ||
        !isPerpTriggerDirectionValid(
          "takeProfit",
          positionSide,
          requestedTakeProfit,
          markPrice,
        ))
    ) {
      toast.error(
        `Take-profit must be ${data.isLong ? "above" : "below"} the current market price.`,
      );
      return;
    }
    if (
      requestedStopLoss !== null &&
      (!Number.isFinite(requestedStopLoss) ||
        !isPerpTriggerDirectionValid(
          "stopLoss",
          positionSide,
          requestedStopLoss,
          markPrice,
        ))
    ) {
      toast.error(
        `Stop-loss must be ${data.isLong ? "below" : "above"} the current market price.`,
      );
      return;
    }
    // Payload identity — a change here means a new order → new cloid.
    // The coin keeps HL's canonical case-sensitive spelling (kPEPE):
    // uppercasing it would submit an unknown coin to Hyperliquid.
    const signature = JSON.stringify({
      coin,
      isLong: data.isLong,
      marginMode: data.marginMode,
      orderType: resolvedType,
      sizeCoin: roundedSize,
      leverage,
      reduceOnly: data.reduceOnly,
      postOnly,
      limitPrice: limitPrice ?? null,
      triggerPx: triggerPx ?? null,
      takeProfitPx: requestedTakeProfit,
      stopLossPx: requestedStopLoss,
    });
    const orderCopySourceItemId = resolvePerpManualCopySourceId({
      copySourceItemId: reviewedIdentity.sourceId,
      sourceCoin: reviewedIdentity.sourceCoin,
      sourceSide: reviewedIdentity.sourceSide,
      orderCoin,
      isLong: data.isLong,
      reduceOnly: data.reduceOnly,
    });
    const orderSignature = JSON.stringify({
      signature,
      copySourceItemId: orderCopySourceItemId,
    });
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    submittingReviewRef.current = reviewedIdentity;
    const attemptId = submissionAttemptsRef.current.begin();

    try {
      if (!submissionAttemptsRef.current.isCurrent(attemptId)) return;

      try {
        const result = await submitMutation.mutateAsync({
          coin: orderCoin,
          isLong: data.isLong,
          marginMode: data.marginMode,
          orderType: resolvedType,
          sizeCoin: roundedSize,
          leverage,
          reduceOnly: data.reduceOnly,
          postOnly,
          cloid: stableCloid(orderSignature),
          ...(limitPrice ? { limitPrice } : {}),
          ...(triggerPx ? { triggerPx } : {}),
          ...(markPrice > 0 ? { markPrice: String(markPrice) } : {}),
          ...(requestedTakeProfit !== null
            ? { takeProfitPx: normalizePerpDecimalInput(tpPriceInput) }
            : {}),
          ...(requestedStopLoss !== null
            ? { stopLossPx: normalizePerpDecimalInput(slPriceInput) }
            : {}),
          ...(orderCopySourceItemId
            ? { copySourceItemId: orderCopySourceItemId }
            : {}),
        });
        if (result && result.success === false) {
          if (reviewedIdentityRef.current !== reviewedIdentity) return;
          // A definitive rejection releases the rejected cloid, but not review identity.
          cloidRef.current = null;
          cloidSigRef.current = null;
          const message = result.message ?? "Order was rejected - please resubmit.";
          setSubmitErrorMessage(message);
          toast.error(message);
          return;
        }
        if (reviewedIdentity.nonce != null) {
          onManualCopyPrefillCompleted?.(reviewedIdentity.nonce);
        }
        if (reviewedIdentityRef.current !== reviewedIdentity) return;
        reviewedIdentityRef.current = null;
      } catch (error) {
        if (reviewedIdentityRef.current !== reviewedIdentity) return;
        const message = error instanceof Error ? error.message : "Could not submit this order.";
        setSubmitErrorMessage(message);
        toast.error(message);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not prepare this XYZ order.";
      setSubmitErrorMessage(message);
      toast.error(message);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const onValid = (data: PerpTradeFormData) => {
    // Block until the asset's real max-leverage is known. Until metadata loads,
    // the slider/clamp fall back to FALLBACK_MAX_LEVERAGE (20x), so a low-cap coin
    // could be reviewed AND persisted at up to 20x while the server silently
    // clamps the on-chain order to the true venue cap (e.g. 3x). Gate both the
    // review modal and the direct submit on the real cap so the reviewed/recorded
    // leverage always matches what actually opens.
    if (loadedMaxLeverage === undefined) {
      toast.error("Loading market data for this coin. Try again in a moment.");
      return;
    }
    // Always show the order review dialog before submitting a perp order,
    // matching the confirmation step shown for equity orders on live accounts.
    submitMutation.reset();
    setSubmitErrorMessage(null);
    reviewedIdentityRef.current = {
      nonce: onManualCopyPrefillCompleted && prefillNonce > 0 ? prefillNonce : null,
      coin,
      sourceId: copySourceItemId,
      sourceCoin: copySourceCoin,
      sourceSide: copySourceSide,
    };
    setPendingReview(data);
  };

  if (!enabled) {
    // Not yet fully set up (perps disabled, or enabled but the agent is not
    // live): render the SHARED onboarding/deposit card right here in the rail
    // instead of a "go to Settings" dead-end. Same component as the Settings
    // card (one flow, two mounts); it walks connect -> enable -> fund/deposit
    // -> activate and keeps the deposit address + balances + refresh visible.
    return (
      <div className="terminal-perp-ticket flex h-full min-h-0 flex-col bg-background">
        {!hideMarketHeader && (
          <div className="shrink-0 border-b px-3 py-2">
            <div className="text-3xs uppercase tracking-wide text-muted-foreground">
              Trade
            </div>
            <div className="font-data text-base font-semibold">{displayCoin}-PERP</div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <PerpsOnboardingCard enabledSession={hasSession} variant="rail" />
        </div>
      </div>
    );
  }

  const effectiveLeverage = clampLeverageForCap(leverage, loadedMaxLeverage);
  // hlBalanceUsd only exists on the perps branch of the discriminated context.
  const perpBalanceLabel = formatUsd(
    accountContext.venue === "perps" ? accountContext.hlBalanceUsd : null,
  );
  // `isSuccess`, not `isFetched`: with retry off a FAILED request is fetched
  // too, and a failure is not knowledge that the user holds nothing.
  const perpPositionLabel = perpPositionSummary(openPosition, {
    settled: perpPositionsQuery.isSuccess,
  });

  return (
    <div className="terminal-perp-ticket flex h-full min-h-0 flex-col bg-background">
      {!hideMarketHeader && (
        <div className="shrink-0 border-b border-border/70 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-data text-base font-semibold">
                {displayCoin}
              </span>
              <span className="text-3xs font-medium text-muted-foreground">
                PERP
              </span>
            </div>
            <div className="text-right">
              <div className="text-3xs font-medium text-muted-foreground">Mark</div>
              <div className="font-data text-sm font-semibold tabular-nums">
                {markPrice > 0 ? formatPerpUsd(markPrice) : "-"}
              </div>
            </div>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit(onValid)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4">
          {/* Direction */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Direction
            </Label>
            <Controller
              control={control}
              name="isLong"
              render={({ field }) => (
                <BinaryToggle
                  ariaLabel="Direction"
                  value={field.value ? "long" : "short"}
                  onChange={(next) => field.onChange(next === "long")}
                  options={[
                    { value: "long", label: "Long", tone: "positive" },
                    { value: "short", label: "Short", tone: "negative" },
                  ]}
                />
              )}
            />
          </div>

          {/* Plan A2. "Balance", not "Available": accountBalanceUsd is total
              USDC collateral (packages/hyperliquid/src/client.ts), not
              withdrawable or free margin, and calling it Available would
              overstate what can back a new order. The position cell is what
              Reduce Only acts on. */}
          <TicketContextRow
            cells={[
              {
                label: "Balance",
                value: perpBalanceLabel,
                title:
                  "Total USDC collateral on Hyperliquid. Not the same as free margin.",
              },
              {
                label: "Buying Power",
                value:
                  sizeBasis.kind === "open"
                    ? formatUsd(sizeBasis.maxNotionalUsd)
                    : "-",
                title:
                  "Max buying power for opening positions (Free Collateral x Leverage).",
              },
              {
                label: "Position",
                value: perpPositionLabel,
                title: `Open ${displayCoin} position on this account.`,
              },
            ]}
          />

          {/* Size: one USD-first hero input; the caption underneath swaps the
              hero unit. Both units stay directly editable and both keep
              flowing through the same sync handlers the old two-input grid
              used. The Controller stays mounted across unit flips: only the
              layout inside it changes, never the form state. */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Size</Label>
            <Controller
              control={control}
              name="sizeCoin"
              render={({ field }) => (
                <PerpSizeHeroInput
                  displayCoin={displayCoin}
                  usdValue={usdInput}
                  coinValue={field.value}
                  notionalUsd={notionalUsd}
                  invalid={!!errors.sizeCoin}
                  onUsdChange={handleUsdChange}
                  onCoinChange={handleCoinChange}
                  onCoinBlur={handleCoinBlur}
                />
              )}
            />
            {/* Quick-fill: a share of the position when reducing, of buying
                power otherwise. The caption states WHICH, because the same
                chip means two different things and getting that wrong on a
                leveraged ticket is expensive. When any input is unknown the
                chips disable and say what is missing rather than sizing off a
                guess. */}
            <div className="flex items-center gap-1.5">
              <div className="flex flex-1 gap-1">
                {PERP_SIZE_PRESET_PERCENTS.map((percent) => {
                  const filled = perpPresetCoinSize(sizeBasis, percent, szDecimals);
                  const disabled = filled === "";
                  const isSelected = activePresetPercent === percent && !disabled;
                  return (
                    <button
                      key={percent}
                      type="button"
                      disabled={disabled}
                      onClick={() => applySizePreset(percent)}
                      title={
                        sizeBasis.kind === "unavailable"
                          ? sizeBasis.reason
                          : `${perpPresetLabel(percent)} ${sizeBasis.caption}`
                      }
                      className={cn(
                        "h-7 flex-1 rounded-md text-2xs font-semibold tabular-nums transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#CAB06B]",
                        isSelected
                          ? "border-2 border-[#CAB06B] bg-[#CAB06B]/15 font-bold text-foreground shadow-[0_0_8px_rgba(202,176,107,0.25)]"
                          : "border border-border/70 bg-background text-muted-foreground hover:border-border hover:text-foreground",
                        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border/70 disabled:hover:text-muted-foreground",
                      )}
                    >
                      {perpPresetLabel(percent)}
                    </button>
                  );
                })}
              </div>
              <span className="shrink-0 text-3xs text-muted-foreground">
                {sizeBasis.kind === "unavailable"
                  ? sizeBasis.reason
                  : sizeBasis.caption}
              </span>
            </div>
            {errors.sizeCoin && (
              <p className="text-xs text-destructive">{errors.sizeCoin.message}</p>
            )}
          </div>

          {/* Plan A4: margin mode / order type / leverage as one pill row. The
              pills state the current configuration; tapping one expands the
              SAME control that used to own a labelled block of its own.

              Every Controller below stays mounted whether or not its panel is
              open - the conditional lives INSIDE the render prop. Unmounting a
              Controller is a form-state change, and this is a layout change. */}
          <div className="space-y-2">
            <div
              role="group"
              aria-label="Order settings"
              className="flex items-stretch gap-1.5"
            >
              <SettingPill
                label="Margin mode"
                value={marginMode === "isolated" ? "Isolated" : "Cross"}
                expanded={openSetting === "margin"}
                controls={settingsPanelId}
                onClick={() => toggleSetting("margin")}
              />
              <SettingPill
                label="Order type"
                value={selectedOrderTypeLabel}
                expanded={openSetting === "type"}
                controls={settingsPanelId}
                onClick={() => toggleSetting("type")}
              />
              <SettingPill
                label="Leverage"
                value={`${effectiveLeverage}x`}
                expanded={openSetting === "leverage"}
                controls={settingsPanelId}
                onClick={() => toggleSetting("leverage")}
              />
            </div>

            <div id={settingsPanelId}>
              {/* Margin mode */}
              <Controller
                control={control}
                name="marginMode"
                render={({ field }) =>
                  openSetting === "margin" ? (
                    <div className="space-y-2 border-l-2 border-border/80 pl-2 animate-in duration-150 fade-in slide-in-from-top-1">
                      <BinaryToggle
                        ariaLabel="Margin mode"
                        value={field.value}
                        onChange={(next) => {
                          field.onChange(next);
                          // Collapse back to the pill row: the choice is made,
                          // and the pill now states it.
                          setOpenSetting(null);
                        }}
                        options={[
                          {
                            value: "cross",
                            label: "Cross",
                            disabled: isolatedOnly,
                            title: isolatedOnly
                              ? "This market supports isolated margin only"
                              : undefined,
                          },
                          { value: "isolated", label: "Isolated" },
                        ]}
                      />
                      {isolatedOnly && (
                        <p className="text-2xs text-muted-foreground">
                          This HIP-3 market supports isolated margin only.
                        </p>
                      )}
                    </div>
                  ) : (
                    <></>
                  )
                }
              />

              {/* Market and Limit stay immediate; trigger orders live in Advanced. */}
              <Controller
                control={control}
                name="orderType"
                render={({ field }) =>
                  openSetting !== "type" ? (
                    <></>
                  ) : (
                  <div className="space-y-2 border-l-2 border-border/80 pl-2 animate-in duration-150 fade-in slide-in-from-top-1">
                    <div
                      role="group"
                      aria-label="Order type controls"
                      className="grid grid-cols-3 gap-0.5 rounded-md border bg-muted/50 p-0.5"
                    >
                      <div
                        role="radiogroup"
                        aria-label="Order type"
                        className="col-span-2 grid grid-cols-2 gap-0.5"
                      >
                        {PRIMARY_ORDER_TYPE_OPTIONS.map((opt) => {
                          const active = field.value === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-label={opt.label}
                              onClick={() => {
                                field.onChange(opt.value);
                                setAdvancedOpen(false);
                                setOpenSetting(null);
                              }}
                              className={cn(
                                "h-9 rounded-sm px-2 text-center text-xs font-semibold transition-colors duration-150",
                                active
                                  ? "bg-background text-foreground"
                                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                              )}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        aria-expanded={advancedOpen}
                        aria-controls={advancedOrderTypesId}
                        aria-pressed={isTrigger}
                        aria-label={
                          isTrigger
                            ? `Advanced order types, ${selectedOrderTypeLabel} selected`
                            : "Advanced order types"
                        }
                        title={
                          isTrigger
                            ? `Advanced: ${selectedOrderTypeLabel}`
                            : "Advanced order types"
                        }
                        onClick={() => setAdvancedOpen((open) => !open)}
                        className={cn(
                          "flex h-9 min-w-0 items-center justify-center gap-1 rounded-sm px-1.5 text-2xs font-semibold transition-colors duration-150",
                          isTrigger
                            ? "bg-background text-foreground"
                            : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0 truncate">
                          {isTrigger ? selectedOrderTypeLabel : "Advanced"}
                        </span>
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            "size-3 shrink-0 transition-transform duration-150",
                            advancedOpen && "rotate-180",
                          )}
                        />
                      </button>
                    </div>

                    {advancedOpen && (
                      <div
                        id={advancedOrderTypesId}
                        role="radiogroup"
                        aria-label="Advanced order type"
                        className="grid animate-in grid-cols-3 gap-1 border-l-2 border-border/80 pl-2 duration-150 fade-in slide-in-from-top-1"
                      >
                        {ADVANCED_ORDER_TYPE_OPTIONS.map((opt) => {
                          const active = field.value === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-label={opt.label}
                              onClick={() => {
                                field.onChange(opt.value);
                                setAdvancedOpen(false);
                                setOpenSetting(null);
                              }}
                              className={cn(
                                "h-9 rounded-sm border px-1 text-2xs font-medium leading-tight transition-colors duration-150",
                                active
                                  ? "border-border bg-muted text-foreground"
                                  : "border-transparent text-muted-foreground hover:border-border/70 hover:text-foreground",
                              )}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              />

              {/* Margin & leverage */}
              <Controller
                control={control}
                name="leverage"
                render={({ field }) =>
                  openSetting !== "leverage" ? (
                    <></>
                  ) : (
                    <div className="space-y-3 border-l-2 border-border/80 pl-2 animate-in duration-150 fade-in slide-in-from-top-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium text-muted-foreground">
                          Margin &amp; leverage
                        </Label>
                        <span className="font-data text-sm font-semibold tabular-nums">
                          {effectiveLeverage}x
                        </span>
                      </div>

                      <Slider
                        aria-label="Leverage"
                        min={1}
                        max={Math.max(1, sliderMaxLeverage)}
                        step={1}
                        value={[effectiveLeverage]}
                        onValueChange={(vals) =>
                          field.onChange(
                            clampLeverageForCap(vals[0] ?? 1, sliderMaxLeverage),
                          )
                        }
                      />

                      <div className="flex flex-wrap gap-1.5">
                        {leveragePresets(sliderMaxLeverage).map((preset) => {
                          const active = effectiveLeverage === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setValue("leverage", preset)}
                              className={cn(
                                "h-9 min-w-10 rounded-sm border px-2 text-xs font-semibold tabular-nums transition-colors duration-150 sm:h-7",
                                active
                                  ? "border-border bg-muted text-foreground"
                                  : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
                              )}
                            >
                              {preset}x
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() =>
                            setValue("leverage", Math.max(1, sliderMaxLeverage))
                          }
                          className={cn(
                            "h-9 min-w-10 rounded-sm border px-2 text-xs font-semibold transition-colors duration-150 sm:h-7",
                            effectiveLeverage === Math.max(1, sliderMaxLeverage)
                              ? "border-border bg-muted text-foreground"
                              : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
                          )}
                        >
                          Max
                        </button>
                      </div>
                    </div>
                  )
                }
              />
            </div>
          </div>

          {/* Trigger and limit prices follow the selected execution type. */}
          {(isTrigger || showLimitPrice) && (
            <div
              className={cn(
                "grid gap-2",
                isTrigger && showLimitPrice ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              {isTrigger && (
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Trigger price
                  </Label>
                  <Controller
                    control={control}
                    name="triggerPx"
                    render={({ field }) => (
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label="Trigger price"
                        aria-invalid={!!errors.triggerPx}
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className={`h-9 bg-background px-3 font-data tabular-nums ${TICKET_INPUT_TEXT_SM}`}
                      />
                    )}
                  />
                  {errors.triggerPx && (
                    <p className="text-xs text-destructive">
                      {errors.triggerPx.message}
                    </p>
                  )}
                </div>
              )}

              {showLimitPrice && (
                <div className="min-w-0 space-y-1.5">
                  <div className="flex min-w-0 items-center justify-between gap-1">
                    <Label className="truncate text-xs font-medium text-muted-foreground">
                      Limit price
                    </Label>
                    {!limitPriceRequired && (
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        Optional
                      </span>
                    )}
                  </div>
                  <Controller
                    control={control}
                    name="limitPrice"
                    render={({ field }) => (
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label="Limit price"
                        aria-invalid={!!errors.limitPrice}
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className={`h-9 bg-background px-3 font-data tabular-nums ${TICKET_INPUT_TEXT_SM}`}
                      />
                    )}
                  />
                  {errors.limitPrice && (
                    <p className="text-xs text-destructive">
                      {errors.limitPrice.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {orderType === "TakeProfit" && (
            <p className="-mt-2 text-3xs leading-relaxed text-muted-foreground">
              No limit price executes the take-profit at market.
            </p>
          )}

          {/* Secondary execution flags */}
          <div className="space-y-2 border-t border-border/70 pt-3">
            <div className="text-3xs font-medium text-muted-foreground">
              Execution
            </div>
            <div className="flex min-h-7 flex-wrap items-center gap-x-5 gap-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <input
                  type="checkbox"
                  checked={reduceOnly}
                  onChange={(e) => setValue("reduceOnly", e.target.checked)}
                  className="size-3.5 cursor-pointer rounded-sm border-border accent-primary"
                />
                Reduce only
              </label>
              {showPostOnly && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={postOnly}
                    onChange={(e) => setValue("postOnly", e.target.checked)}
                    className="size-3.5 cursor-pointer rounded-sm border-border accent-primary"
                  />
                  Post only
                </label>
              )}
            </div>
          </div>

          {/* TP / SL inline section */}
          <div className="space-y-2 border-t border-border/70 pt-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
              <input
                type="checkbox"
                checked={tpSlEnabled}
                onChange={(e) => setTpSlEnabled(e.target.checked)}
                className="size-3.5 cursor-pointer rounded-sm border-border accent-primary"
              />
              Take Profit / Stop Loss
            </label>

            {tpSlEnabled && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                {/* TP row */}
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="min-w-0 space-y-1">
                    <span className="flex items-center gap-1 text-3xs font-medium text-green-500">
                      <Target className="size-2.5" aria-hidden />
                      TP Price
                    </span>
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label="Take profit price"
                      value={tpPriceInput}
                      onChange={(e) => handleTpPriceChange(e.target.value)}
                      className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <span className="text-3xs font-medium text-muted-foreground">
                      Gain
                    </span>
                    <div className="flex h-8 gap-0.5">
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label="Take profit gain"
                        value={tpValueInput}
                        onChange={(e) => handleTpValueChange(e.target.value)}
                        className={`h-8 min-w-0 flex-1 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                      />
                      <button
                        type="button"
                        aria-label={
                          tpMode === "percent"
                            ? "Switch to dollar mode"
                            : "Switch to percent mode"
                        }
                        onClick={() => {
                          tpLastEditedRef.current = "price";
                          setTpMode(
                            tpMode === "percent" ? "pnlUsd" : "percent",
                          );
                        }}
                        className="flex h-8 w-10 items-center justify-center rounded-sm border border-border/70 bg-background text-3xs font-semibold text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                      >
                        {tpMode === "percent" ? "%" : "$"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* SL row */}
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="min-w-0 space-y-1">
                    <span className="flex items-center gap-1 text-3xs font-medium text-red-500">
                      <Shield className="size-2.5" aria-hidden />
                      SL Price
                    </span>
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label="Stop loss price"
                      value={slPriceInput}
                      onChange={(e) => handleSlPriceChange(e.target.value)}
                      className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <span className="text-3xs font-medium text-muted-foreground">
                      Loss
                    </span>
                    <div className="flex h-8 gap-0.5">
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label="Stop loss amount"
                        value={slValueInput}
                        onChange={(e) => handleSlValueChange(e.target.value)}
                        className={`h-8 min-w-0 flex-1 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                      />
                      <button
                        type="button"
                        aria-label={
                          slMode === "percent"
                            ? "Switch to dollar mode"
                            : "Switch to percent mode"
                        }
                        onClick={() => {
                          slLastEditedRef.current = "price";
                          setSlMode(
                            slMode === "percent" ? "pnlUsd" : "percent",
                          );
                        }}
                        className="flex h-8 w-10 items-center justify-center rounded-sm border border-border/70 bg-background text-3xs font-semibold text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                      >
                        {slMode === "percent" ? "%" : "$"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Compact order summary and action remain visible while the form scrolls. */}
        <div className="terminal-trade-footer sticky bottom-0 z-10 shrink-0 border-t border-border/70 bg-background/95 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2.5">
          <div className="mb-2.5 grid grid-cols-2 divide-x divide-border/70">
            <div className="min-w-0 pr-3">
              <div className="text-3xs font-medium text-muted-foreground">
                Notional
              </div>
              <div className="truncate font-data text-xs font-semibold tabular-nums transition-colors duration-150">
                {notionalUsd > 0 ? formatUsd(notionalUsd) : "-"}
              </div>
            </div>
            <div className="min-w-0 pl-3">
              <div className="text-3xs font-medium text-muted-foreground">
                Est. margin
              </div>
              <div className="truncate font-data text-xs font-semibold tabular-nums transition-colors duration-150">
                {marginUsd > 0 ? formatUsd(marginUsd) : "-"}
              </div>
            </div>
          </div>
          {visiblePerpSubmitError(submitErrorMessage, !!pendingReview) && (
            <div
              role="alert"
              className="mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {visiblePerpSubmitError(submitErrorMessage, !!pendingReview)}
            </div>
          )}
          <Button
            type="submit"
            className={cn(
              "terminal-trade-submit h-11 w-full rounded-lg text-sm font-bold",
              isLong ? TICKET_CTA_POSITIVE : TICKET_CTA_NEGATIVE,
            )}
            disabled={isSubmitBusy}
          >
            {submitMutation.isPending
              ? "Submitting..."
              : `${isLong ? "Long" : "Short"} ${displayCoin}`}
          </Button>
        </div>
      </form>

      {/* Review gate for high-leverage / large-notional orders */}
      <AlertDialog
        open={!!pendingReview}
        onOpenChange={(open) => {
          if (!open && !submitMutation.isPending) {
            const reviewedIdentity = reviewedIdentityRef.current;
            if (reviewedIdentity?.nonce != null) {
              onManualCopyPrefillCancelled?.(reviewedIdentity.nonce);
            }
            reviewedIdentityRef.current = null;
            submissionAttemptsRef.current.cancel();
            setPendingReview(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review order before submitting</AlertDialogTitle>
            <AlertDialogDescription>
              Verify the market, size, leverage, and estimated margin before
              sending this order to Hyperliquid.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingReview && (
            <div className="space-y-2">
              <ReviewRow
                label="Direction"
                value={pendingReview.isLong ? "Long" : "Short"}
              />
              <ReviewRow label="Coin" value={`${displayCoin}-PERP`} />
              <ReviewRow
                label="Order type"
                value={reviewOrderTypeLabel(pendingReview)}
              />
              <ReviewRow
                label="Size"
                value={`${pendingReview.sizeCoin} ${displayCoin}`}
              />
              <ReviewRow
                label="Leverage"
                value={`${clampLeverageForCap(pendingReview.leverage, loadedMaxLeverage)}x ${pendingReview.marginMode}`}
              />
              <ReviewRow
                label="Reduce only"
                value={pendingReview.reduceOnly ? "Yes" : "No"}
              />
              <ReviewRow
                label="Post only"
                value={pendingReview.postOnly ? "Yes" : "No"}
              />
              <ReviewRow
                label="Notional"
                value={notionalUsd > 0 ? formatUsd(notionalUsd) : "-"}
              />
              <ReviewRow
                label="Est. margin"
                value={marginUsd > 0 ? formatUsd(marginUsd) : "-"}
              />
              {isTriggerUiOrderType(pendingReview.orderType) &&
                pendingReview.triggerPx && (
                  <ReviewRow
                    label="Trigger price"
                    value={formatPerpUsd(Number(pendingReview.triggerPx))}
                  />
                )}
              {pendingReview.limitPrice &&
                uiOrderTypeUsesLimitPrice(
                  pendingReview.orderType,
                  !!pendingReview.limitPrice &&
                    pendingReview.limitPrice.trim() !== "",
                ) && (
                  <ReviewRow
                    label="Limit price"
                    value={formatPerpUsd(Number(pendingReview.limitPrice))}
                  />
                )}
              {/* Inline TP/SL lives in form state rather than on the reviewed
                  order, but it is submitted with this order, so it has to be
                  visible here for the same reason the stocks review shows it. */}
              {reviewTakeProfitPx !== null && (
                <ReviewRow
                  label="Take profit"
                  value={formatPerpUsd(reviewTakeProfitPx)}
                />
              )}
              {reviewStopLossPx !== null && (
                <ReviewRow
                  label="Stop loss"
                  value={formatPerpUsd(reviewStopLossPx)}
                />
              )}
            </div>
          )}
          {submitErrorMessage && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {submitErrorMessage}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              onClick={() => pendingReview && void executeSubmit(pendingReview)}
              disabled={isSubmitBusy}
              variant={pendingReview?.isLong ? "default" : "destructive"}
            >
              {submitMutation.isPending ? "Submitting..." : "Confirm Submit"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
