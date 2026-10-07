"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useForm,
  Controller,
  useFieldArray,
  type FieldErrors,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { BinaryToggle } from "@/components/ui/binary-toggle";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useSession } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { validateStopLossDirection } from "./stop-loss-input";
import { TICKET_INPUT_TEXT_XS } from "./ticket-input-text";
import { equityCtaLabel } from "./equity-cta-label";
import { equityPositionSummary } from "./ticket-position-summary";
import { TicketContextRow } from "./ticket-context-row";
import { SubmitIntentStore, deriveOrderClientId } from "./order-idempotency";
import { TICKET_CTA_NEGATIVE, TICKET_CTA_POSITIVE } from "./ticket-cta";
import {
  isLimitSellOrder,
  resolveTradeFormTimeInForce,
} from "./trade-time-in-force";
import { cn } from "@/lib/utils";
import { useExitPlanPreferences } from "./use-exit-plan-prefs";
import { useTradeQuotes } from "./use-trade-quotes";
import {
  computeRPrice,
  defaultStopForDirection,
  entryBasisFromQuote,
  sizeByExitPlanRisk,
  sizeByRisk,
  resolveSizingPrice,
  shouldShowStopSizingFeedback,
  resolveStalePriceReset,
  splitQty,
  DEFAULT_TP_R,
  DEFAULT_TRAIL_PERCENT,
} from "./smart-exit";
import {
  Plus,
  Trash2,
  AlertCircle,
  Info,
  Key,
} from "lucide-react";
import { formatUsd } from "@/lib/format";
import {
  resolveSignalPrefillPlan,
  type SignalPrefillOrderType,
  type SignalPrefillEntryOrderType,
  type SignalPrefillDirection,
  type SignalPrefillTimeInForce,
} from "./signal-prefill";
import {
  computeCurrentRisk,
  computeEstimatedNotional,
  hasActiveTrailingRunner as computeHasActiveTrailingRunner,
  plainOrderTypeForEntry,
  resolveExitPlanRouting,
  resolveLimitAwareBasis,
  resolveQuickTradeIntent,
  resolveTpFraction,
  riskReadoutSuffix,
  shouldRunAutoSizer,
  stopLossSectionCaption,
} from "./trade-form-submit-plan";
import {
  getActionSide,
  computeReviewMetrics,
  shouldReviewOrder as computeShouldReviewOrder,
  RISK_BUDGET_PCT,
  RISK_BUDGET_LABEL,
} from "./review-metrics";
import { ReviewOrderDialog } from "./review-order-dialog";
import {
  buildStockTicketReset,
  resolveStockManualCopySourceId,
  type ManualCopyPrefillEvent,
  type StockManualCopyPrefill,
} from "./manual-copy-prefill";

// Order types matching the legacy system. Aliased to the shared prefill type so
// the ticket and the pure prefill mapping never drift apart.
type OrderType = SignalPrefillOrderType;
type EntryOrderType = Extract<OrderType, "Market" | "Limit">;
type AssetType = "EQUITY" | "OPTION";
type TradeAction =
  | "Buy"
  | "Sell"
  | "SellShort"
  | "BuyToCover"
  | "BuyToOpen"
  | "SellToClose"
  | "SellToOpen"
  | "BuyToClose";
type Direction = "long" | "short";
type EquitySide = "buy" | "sell";

interface TradeFormProps {
  initialSymbol?: string;
  initialSide?: "buy" | "sell";
  initialQty?: number;
  initialAssetType?: AssetType;
  initialOptionExpiration?: string;
  initialOptionStrike?: number;
  initialOptionType?: "CALL" | "PUT";
  initialTradeAction?: Extract<TradeAction, "BuyToOpen" | "SellToClose">;
  /** Suggested entry price (used as the OCO entryPriceRef anchor when a
   *  Signa signal is copied). Optional. */
  initialEntry?: number;
  /** Suggested stop loss. When paired with initialTakeProfit, the form
   *  auto-switches to OCO so a real broker stop attaches to the order. */
  initialStopLoss?: number;
  /** Suggested take-profit target. Paired with initialStopLoss this
   *  triggers OCO mode and appends a TP row. */
  initialTakeProfit?: number;
  /** Explicit order type for the ticket (e.g. from a chat order draft). When
   *  set it selects the matching ticket, so a plain Market or Limit draft is no
   *  longer forced into the default OCO ticket. Absent = prior behavior. */
  initialOrderType?: OrderType;
  /** Explicit limit price for a Limit/StopLimit ticket. Falls back to
   *  initialEntry when absent. */
  initialLimitPrice?: number;
  /** Entry-leg type for an OCO ticket (chat limit-bracket drafts keep their
   *  Limit entry instead of the form's Market default). */
  initialEntryOrderType?: SignalPrefillEntryOrderType;
  /** Explicit position intent from a chat draft. "short" switches the ticket
   *  to an opening short (SellShort + direction short). Absent = prior
   *  behavior, where initialSide "sell" maps to a plain Sell. */
  initialDirection?: SignalPrefillDirection;
  /** Explicit time in force from a chat draft. Sets the TIF field so a "DAY
   *  order" draft doesn't silently fall back to the GTC default. Absent =
   *  form default untouched. */
  initialTimeInForce?: SignalPrefillTimeInForce;
  signalId?: string;
  activeCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
  activeAccountLabel?: string;
  embedded?: boolean;
  isPrefilledOrder?: boolean;
  /** Canonical feed source for an eligible manual equity copy. */
  copySourceItemId?: string;
  /** Symbol captured when the source was selected. */
  copySourceSymbol?: string;
  /** Manual copy side, when the source came from the copy-trade feed. */
  copySourceSide?: "buy" | "sell";
  manualCopyPrefill?: ManualCopyPrefillEvent<StockManualCopyPrefill> | null;
  manualCopyResetNonce?: number;
  onManualCopyPrefillConsumed?: (nonce: number) => void;
  onManualCopyPrefillCompleted?: (nonce: number) => void;
  onManualCopyPrefillCancelled?: (nonce: number) => void;
  onSymbolCommit?: (symbol: string) => void;
}

/**
 * Small info "ⓘ" affixed next to a field label. Hover/focus reveals the
 * explanation in a tooltip so the form stays uncluttered (no helper text
 * stacked under every field).
 */
function FieldHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Popover instead of Tooltip: click/tap to open, click-outside or Escape
  // to close. Tooltip is hover-only and doesn't work on mobile touch screens.
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`${label} info`}
          aria-expanded={open}
          className="inline-flex size-11 shrink-0 touch-manipulation items-center justify-center text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-foreground sm:size-7"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="z-50 max-w-[calc(100vw-1.5rem)] rounded-lg bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-floating ring-1 ring-foreground/10 sm:max-w-xs"
        >
          {children}
          <PopoverPrimitive.Arrow className="fill-popover size-2.5 translate-y-[calc(-50%_-_1px)] rotate-45 rounded-[2px]" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const takeProfitSchema = z.object({
  price: z.string().min(1, "TP Price required"),
  quantity: z.string().min(1, "TP Qty required"),
});

export const tradeFormSchema = z
  .object({
    symbol: z
      .string()
      .min(1, "Symbol is required")
      .transform((val) => val.toUpperCase()),
    assetType: z.enum(["EQUITY", "OPTION"]),
    orderType: z.enum(["Market", "Limit", "StopMarket", "StopLimit", "OCO"]),
    entryOrderType: z.enum(["Market", "Limit"]),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]),
    action: z.enum([
      "Buy",
      "Sell",
      "SellShort",
      "BuyToCover",
      "BuyToOpen",
      "SellToClose",
      "SellToOpen",
      "BuyToClose",
    ]),
    direction: z.enum(["long", "short"]),
    maxRisk: z.string().optional(),
    quantity: z.string().min(1, "Quantity is required"),
    stopMarketPrice: z.string().optional(),
    priceTrigger: z.string().optional(),
    limitPrice: z.string().optional(),
    optionsDateYear: z.string().optional(),
    optionsDateMonth: z.string().optional(),
    optionsDateDay: z.string().optional(),
    optionsStrike: z.string().optional(),
    optionsLimitPrice: z.string().optional(),
    optionType: z.enum(["call", "put"]).optional(),

    // OCO / exit-plan specific
    entryPriceRef: z.string().optional(), // For R calcs
    takeProfits: z.array(takeProfitSchema).optional(),

    // Trailing runner - the portion of the position that rides a trailing stop
    // instead of a fixed take-profit. Attached after the entry fills.
    trailingEnabled: z.boolean(),
    trailingPercent: z.string().optional(),
    trailingQty: z.string().optional(),

    skipPresetTp: z.boolean(),
    forceThreeContracts: z.boolean(),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      // If order type is Limit or StopLimit, limitPrice is required
      if (data.orderType === "Limit" || data.orderType === "StopLimit") {
        return !!data.limitPrice && data.limitPrice.length > 0;
      }
      return true;
    },
    {
      message: "Limit price is required for Limit and StopLimit orders",
      path: ["limitPrice"],
    },
  )
  .refine(
    (data) => {
      // If order type is StopMarket or StopLimit, priceTrigger is required
      if (data.orderType === "StopMarket" || data.orderType === "StopLimit") {
        return !!data.priceTrigger && data.priceTrigger.length > 0;
      }
      return true;
    },
    {
      message: "Price trigger is required for StopMarket and StopLimit orders",
      path: ["priceTrigger"],
    },
  )
  .refine(
    (data) => {
      // An exit plan needs at least one protective leg: a fixed take-profit,
      // a trailing runner, OR a fixed stop-loss. Stop-only submits as an
      // Alpaca OTO with a stop-loss child (see submitWithExitPlan). Trailing-
      // only is also valid ("Skip preset TP" path).
      if (data.orderType === "OCO") {
        const hasTp = !!data.takeProfits && data.takeProfits.length > 0;
        const hasStop = !!data.stopMarketPrice;
        return hasTp || data.trailingEnabled || hasStop;
      }
      return true;
    },
    {
      message:
        "Add a stop loss, a take-profit level, or enable the trailing runner",
      path: ["takeProfits"],
    },
  )
  .refine(
    (data) => {
      // Mirror the server rule: a fixed stop price can't ride alongside a
      // trailing runner with no take-profit legs. Alpaca won't accept two
      // separate sell orders against the same shares, so this combo would
      // silently drop the fixed stop. Catch it inline before submit instead
      // of surfacing the confusing broker error post-submit.
      if (data.orderType !== "OCO") return true;
      const hasTp = !!data.takeProfits && data.takeProfits.length > 0;
      const trailingOnlyWithFixedStop =
        !!data.stopMarketPrice && data.trailingEnabled && !hasTp;
      return !trailingOnlyWithFixedStop;
    },
    {
      message:
        "Trailing already carries its own stop. Add a take-profit target, or turn off Trailing stop runner to use just the fixed stop.",
      path: ["stopMarketPrice"],
    },
  )
  .refine(
    (data) => {
      // OCO doesn't strictly require a fixed stop: a configured trailing
      // runner carries its own moving stop and is attached by Smart Exit after
      // fill. Only block when both fixed stop and trailing protection are
      // absent.
      if (data.orderType !== "OCO") return true;
      const hasStop = !!data.stopMarketPrice && data.stopMarketPrice.length > 0;
      const hasTrailing =
        !!data.trailingEnabled &&
        !!data.trailingPercent &&
        parseFloat(data.trailingPercent) > 0;
      return hasStop || hasTrailing;
    },
    {
      message:
        "Add a stop loss, or enable the trailing runner (which brings its own stop).",
      path: ["stopMarketPrice"],
    },
  )
  .refine(
    (data) => {
      if (data.orderType === "OCO" && data.entryOrderType === "Limit") {
        return !!(data.entryPriceRef || data.limitPrice);
      }
      return true;
    },
    {
      message: "Entry price is required for limit entries",
      path: ["entryPriceRef"],
    },
  )
  .refine(
    (data) => {
      // If asset type is OPTION, options fields are required
      if (data.assetType === "OPTION") {
        return (
          !!data.optionsDateYear &&
          !!data.optionsDateMonth &&
          !!data.optionsDateDay &&
          !!data.optionType &&
          !!data.optionsStrike &&
          data.optionsStrike.length > 0
        );
      }
      return true;
    },
    {
      message: "Options contract details are required",
      path: ["optionsStrike"],
    },
  )
  .refine(
    (data) => {
      if (
        data.orderType === "OCO" &&
        data.timeInForce !== "day" &&
        data.timeInForce !== "gtc"
      ) {
        return false;
      }
      return true;
    },
    {
      message: "OCO orders only support DAY and GTC Time in Force",
      path: ["timeInForce"],
    },
  );

type TradeFormData = z.infer<typeof tradeFormSchema>;

// RISK_BUDGET_PCT/RISK_BUDGET_LABEL and the review-dialog gating/math live in
// ./review-metrics (audit H7 extraction) so they can be unit tested without
// rendering this component. The dialog markup itself lives in
// ./review-order-dialog.

export function TradeForm({
  initialSymbol = "",
  initialSide,
  initialQty,
  initialAssetType,
  initialOptionExpiration,
  initialOptionStrike,
  initialOptionType,
  initialTradeAction,
  initialEntry,
  initialStopLoss,
  initialTakeProfit,
  initialOrderType,
  initialLimitPrice,
  initialEntryOrderType,
  initialDirection,
  initialTimeInForce,
  signalId,
  activeCredentialId,
  activeAccountType,
  activeAccountLabel,
  embedded = false,
  isPrefilledOrder = false,
  copySourceItemId,
  copySourceSymbol,
  copySourceSide,
  manualCopyPrefill,
  manualCopyResetNonce = 0,
  onManualCopyPrefillConsumed,
  onManualCopyPrefillCompleted,
  onManualCopyPrefillCancelled,
  onSymbolCommit,
}: TradeFormProps) {
  const { data: session } = useSession();

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    getValues,
    trigger,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TradeFormData>({
    resolver: zodResolver(tradeFormSchema),
    defaultValues: {
      symbol: initialSymbol,
      assetType: "EQUITY",
      // Equities default to the one-click exit plan (Buy + auto take-profit +
      // trailing stop). Plain order types remain available in the dropdown.
      orderType: "OCO",
      entryOrderType: "Market",
      timeInForce: "gtc",
      action: "Buy",
      direction: "long",
      maxRisk: "100",
      quantity: "1",
      stopMarketPrice: "",
      priceTrigger: "",
      limitPrice: "",
      optionsDateYear: "",
      optionsDateMonth: "",
      optionsDateDay: "",
      optionsStrike: "",
      optionsLimitPrice: "",
      optionType: "call",
      entryPriceRef: "",
      takeProfits: [],
      // Trailing defaults: on, with the 5% floor pre-filled so the field is
      // never empty on first render. localStorage hydration below reconciles
      // to the user's saved preference on mount.
      trailingEnabled: true,
      trailingPercent: String(DEFAULT_TRAIL_PERCENT),
      trailingQty: "",
      skipPresetTp: false,
      forceThreeContracts: false,
      notes: "",
    },
  });

  // Hoisted to sit next to useForm so every downstream effect (signal-prefill,
  // applySmartExit, addRLevel) can use the field-array's mutators. Historical
  // bug: any code path that wrote to takeProfits via setValue("takeProfits",
  // ...) mutated form data without notifying useFieldArray, so `tpFields`
  // (what the UI iterates over) went out of sync with the submitted form data
  // - the user saw an empty "Take-profit targets" panel while the review
  // dialog and the actual order carried an auto-attached TP row.
  const {
    fields: tpFields,
    append: appendTp,
    remove: removeTp,
    replace: replaceTps,
    update: updateTp,
  } = useFieldArray({
    control,
    name: "takeProfits",
  });

  // Watch for external symbol selections (e.g. clicking a signal from the feed)
  useEffect(() => {
    if (initialSymbol) {
      setValue("symbol", initialSymbol, { shouldValidate: true });
    }
  }, [initialSymbol, setValue]);

  // Prefill the quantity when a copied item supplies a pre-sized qty. Additive:
  // only acts when initialQty is a positive number.
  // Also resets the "user edited qty" flag so the risk-based auto-sizer below
  // is free to recalculate - a copy is not a deliberate manual entry.
  // Options: cap at 10 contracts regardless of auto-sized qty. Option contract
  // sizing must be a deliberate choice because 1 contract = 100 shares, and
  // an auto-sized equity qty copied straight over produces wildly large positions.
  useEffect(() => {
    if (!initialQty || initialQty <= 0) return;
    userEditedQtyRef.current = false;
    const qty = initialAssetType === "OPTION" ? Math.min(initialQty, 10) : initialQty;
    setValue("quantity", String(qty), { shouldValidate: true });
  }, [initialQty, initialAssetType, setValue]);

  useEffect(() => {
    if (initialAssetType === "EQUITY") {
      const currentValues = getValues();
      reset({
        ...currentValues,
        assetType: "EQUITY",
        action: initialSide === "sell" ? "Sell" : "Buy",
        optionsDateYear: "",
        optionsDateMonth: "",
        optionsDateDay: "",
        optionsStrike: "",
        optionsLimitPrice: "",
        optionType: "call",
      });
      return;
    }
    if (initialAssetType !== "OPTION") return;
    if (!initialOptionExpiration || !initialOptionStrike || !initialOptionType)
      return;
    const optionTradeAction = initialTradeAction;
    if (!optionTradeAction) return;

    const currentValues = getValues();
    reset({
      ...currentValues,
      assetType: "OPTION",
      orderType: "Market",
      entryOrderType: "Market",
      direction: "long",
      action: optionTradeAction,
      optionsDateYear: initialOptionExpiration.slice(0, 2),
      optionsDateMonth: initialOptionExpiration.slice(2, 4),
      optionsDateDay: initialOptionExpiration.slice(4, 6),
      optionType: initialOptionType === "PUT" ? "put" : "call",
      optionsStrike: String(initialOptionStrike),
    });
  }, [
    getValues,
    initialAssetType,
    initialOptionExpiration,
    initialOptionStrike,
    initialOptionType,
    initialSide,
    initialTradeAction,
    reset,
  ]);

  /**
   * Seed the ticket from a copied Signa signal or a chat order draft.
   *
   * The field-by-field decisions live in the pure `resolveSignalPrefillPlan`
   * mapping (unit-tested in `signal-prefill.test.ts`); this effect just applies
   * the resulting plan. In summary:
   * - When BOTH stop + target are present (and no explicit order type overrides
   *   it), switch the form to OCO so the broker actually places a protective
   *   stop + take-profit. This matches "Copy signal" and an OCO chat draft.
   * - An explicit `initialOrderType` (from a chat draft) selects the ticket, so
   *   a plain Market or Limit draft shows the matching ticket rather than the
   *   default OCO.
   * - The stop value populates `stopMarketPrice`; the entry anchors the OCO R:R
   *   calculator via `entryPriceRef` and seeds the Limit Price. A Limit/StopLimit
   *   draft's explicit `initialLimitPrice` overrides that, falling back to entry.
   * - An explicit `initialEntryOrderType` keeps a limit bracket's Limit entry on
   *   the OCO ticket (instead of the form's Market entry default), with the
   *   draft's limit price resting as the entry.
   * - An explicit `initialDirection` of "short" switches the ticket to
   *   SellShort + direction short, so a "short AAPL" draft opens a short
   *   rather than reading as closing a long.
   * - A stop WITHOUT a target upgrades a plain Market/Limit draft to the
   *   OCO/exit-plan ticket (see resolveSignalPrefillPlan), because only that
   *   path broker-attaches the stop; the plain ticket would submit a naked
   *   entry.
   * - An explicit `initialTimeInForce` sets the TIF field, so a "DAY order"
   *   draft doesn't silently fall back to the GTC default.
   * - The target replaces the take-profit rows with a single row at the target.
   *
   * All branches are additive - the user can still edit any field before
   * submitting. `replaceTps` (useFieldArray's replace) keeps `tpFields` in sync
   * with form data (see the hoisted useFieldArray block above).
   */
  useEffect(() => {
    const plan = resolveSignalPrefillPlan({
      entry: initialEntry,
      stopLoss: initialStopLoss,
      takeProfit: initialTakeProfit,
      orderType: initialOrderType,
      limitPrice: initialLimitPrice,
      entryOrderType: initialEntryOrderType,
      direction: initialDirection,
      timeInForce: initialTimeInForce,
    });
    if (plan.stopMarketPrice != null) {
      setValue("stopMarketPrice", plan.stopMarketPrice, {
        shouldValidate: false,
      });
    }
    if (plan.entryPriceRef != null) {
      setValue("entryPriceRef", plan.entryPriceRef, { shouldValidate: false });
    }
    if (plan.limitPrice != null) {
      setValue("limitPrice", plan.limitPrice, { shouldValidate: false });
    }
    if (plan.orderType != null) {
      setValue("orderType", plan.orderType, { shouldValidate: false });
    }
    if (plan.entryOrderType != null) {
      setValue("entryOrderType", plan.entryOrderType, {
        shouldValidate: false,
      });
    }
    if (plan.action != null) {
      setValue("action", plan.action, { shouldValidate: false });
    }
    if (plan.direction != null) {
      setValue("direction", plan.direction, { shouldValidate: false });
    }
    if (plan.timeInForce != null) {
      setValue("timeInForce", plan.timeInForce, { shouldValidate: false });
    }
    if (plan.takeProfits != null) {
      replaceTps(plan.takeProfits);
    }
  }, [
    initialEntry,
    initialStopLoss,
    initialTakeProfit,
    initialOrderType,
    initialLimitPrice,
    initialEntryOrderType,
    initialDirection,
    initialTimeInForce,
    setValue,
    replaceTps,
  ]);

  // Watch form values for derived state and queries
  const symbol = watch("symbol");
  const [marketDataSymbol, setMarketDataSymbol] = useState(() =>
    symbol.trim().toUpperCase(),
  );
  const normalizedSymbol = symbol.trim().toUpperCase();
  const quoteMatchesInput = marketDataSymbol === normalizedSymbol;
  const assetType = watch("assetType");
  const orderType = watch("orderType");
  const entryOrderType = watch("entryOrderType");
  const action = watch("action");
  const timeInForce = watch("timeInForce");

  const direction = watch("direction");
  const maxRisk = watch("maxRisk");
  const quantityWatched = watch("quantity");
  const stopMarketPrice = watch("stopMarketPrice");
  const limitPrice = watch("limitPrice");
  const optionsDateYear = watch("optionsDateYear");
  const optionsDateMonth = watch("optionsDateMonth");
  const optionsDateDay = watch("optionsDateDay");
  const optionsStrike = watch("optionsStrike");
  const optionTypeField = watch("optionType");
  // Explicit Call/Put selection, decoupled from long/short direction.
  // Falls back to direction so existing behaviour is preserved if unset.
  const optionTypeWatched: "call" | "put" =
    optionTypeField || (direction === "long" ? "call" : "put");
  const forceThreeContracts = watch("forceThreeContracts");
  const watchEntry = watch("entryPriceRef");
  const takeProfitsWatched = watch("takeProfits") || [];
  const trailingEnabled = watch("trailingEnabled");
  const trailingPercent = watch("trailingPercent");
  const trailingQty = watch("trailingQty");
  const skipPresetTp = watch("skipPresetTp");
  const notesWatched = watch("notes");

  useEffect(() => {
    const timeout = setTimeout(() => {
      const nextSymbol = symbol.trim().toUpperCase();
      setMarketDataSymbol(nextSymbol);
      if (nextSymbol) {
        onSymbolCommit?.(nextSymbol);
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [symbol, onSymbolCommit]);

  // Exit-plan preference persistence (trailing runner + take-profit) lives in
  // its own hook (audit H7: first extraction from this god component). The
  // refs are read by applySmartExit and the reset-on-submit path; the persist
  // helpers are called ONLY from explicit user actions.
  const {
    savedTrailingPreferenceRef,
    savedTpPreferenceRef,
    savedAttachPreferenceRef,
    persistTrailingPreference,
    persistTakeProfitPreference,
    persistAutoTpPreference,
    persistAttachPreference,
  } = useExitPlanPreferences(
    setValue as unknown as import("./use-exit-plan-prefs").ExitPlanPrefSetValue,
    initialOrderType == null && initialStopLoss == null && initialTakeProfit == null,
  );

  // Alias for the reset-on-submit reader above, kept as a local const so the
  // reset block reads naturally.
  const savedTrailingPreference = savedTrailingPreferenceRef.current;

  // Submission result state (not part of form state)
  const [submitResult, setSubmitResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [pendingReviewOrder, setPendingReviewOrder] =
    useState<TradeFormData | null>(null);
  const pendingManualCopyNonceRef = useRef<number | null>(null);
  const pendingManualCopySourceRef = useRef<StockManualCopyPrefill | null>(null);
  // Rail-variant note expander. Hidden by default behind a small "+ Add note"
  // link so the form stays compact; auto-opens once the user has actually
  // typed something so a non-empty note never gets visually orphaned.
  const [railShowNotes, setRailShowNotes] = useState(false);
  // Controls whether the take-profit sub-card is expanded. Starts open so
  // auto-filled TPs are immediately visible; collapses when the user clicks Remove.
  const [showTpSection, setShowTpSection] = useState(true);

  // Auto-dismiss the success banner so it doesn't linger forever. Errors stay
  // until the next submit so the user can read what went wrong.
  useEffect(() => {
    if (submitResult?.type !== "success") return;
    const timer = setTimeout(() => setSubmitResult(null), 5000);
    return () => clearTimeout(timer);
  }, [submitResult]);

  const trpcUtils = trpc.useUtils();
  const submitIntentRef = useRef(new SubmitIntentStore());
  const manualCopySubmissionNoncesRef = useRef(new Map<string, number>());
  const currentManualCopyNonceRef = useRef<number | null>(null);
  currentManualCopyNonceRef.current = manualCopyPrefill?.nonce ?? null;

  // After a successful submit, the open-orders panel reads from Alpaca
  // (orders.listAlpacaOrders). Invalidate it immediately and again after a
  // short delay so a freshly placed order appears once Alpaca has it, instead
  // of waiting for the panel's 15s refetch interval.
  const refreshOpenOrders = () => {
    trpcUtils.orders.listAlpacaOrders.invalidate();
    setTimeout(() => {
      trpcUtils.orders.listAlpacaOrders.invalidate();
    }, 3000);
  };

  const submitOrderMutation = trpc.orders.submit.useMutation({
    onMutate: async (newOrder) => {
      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await trpcUtils.orders.list.cancel();

      // Snapshot the previous value
      const previousOrders = trpcUtils.orders.list.getData({ limit: 50 });

      // Optimistically update to the new value
      if (previousOrders) {
        trpcUtils.orders.list.setData({ limit: 50 }, (old: any) => [
          {
            id: "optimistic-" + Math.random().toString(36).substring(7),
            symbol: newOrder.symbol,
            status: "PENDING",
            orderType: newOrder.orderType,
            quantity: newOrder.quantity,
            tradeAction: newOrder.tradeAction,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            assetType: newOrder.assetType,
            direction: newOrder.direction,
          },
          ...(old || []),
        ]);
      }

      return { previousOrders };
    },
    onSuccess: (data, variables) => {
      const manualCopyNonce = variables.idempotencyKey
        ? manualCopySubmissionNoncesRef.current.get(variables.idempotencyKey)
        : undefined;
      if (variables.idempotencyKey) {
        manualCopySubmissionNoncesRef.current.delete(variables.idempotencyKey);
      }
      setSubmitResult({
        type: data.success ? "success" : "error",
        message: data.message,
      });
      if (data.success) {
        submitIntentRef.current.complete(variables.idempotencyKey);
        toast.success(data.message);
        if (manualCopyNonce != null) {
          onManualCopyPrefillCompleted?.(manualCopyNonce);
        }
        // Invalidate active orders/positions cache to refresh UI instantly
        trpcUtils.orders.list.invalidate();
        trpcUtils.positions.list.invalidate();
        // Refresh the Alpaca-backed open-orders panel (now + after ~3s)
        refreshOpenOrders();

        if (currentManualCopyNonceRef.current !== (manualCopyNonce ?? null)) return;
        // Reset form on success
        reset({
          symbol: "",
          assetType: "EQUITY",
          orderType:
            savedAttachPreferenceRef.current === false ? "Market" : "OCO",
          entryOrderType: "Market",
          timeInForce: "gtc",
          action: "Buy",
          direction: "long",
          maxRisk: "100",
          quantity: "1",
          stopMarketPrice: "",
          priceTrigger: "",
          limitPrice: "",
          optionsDateYear: "",
          optionsDateMonth: "",
          optionsDateDay: "",
          optionsStrike: "",
          optionsLimitPrice: "",
          optionType: "call",
          entryPriceRef: "",
          takeProfits: [],
          // Post-submit reset honors the user's saved trailing + auto-TP
          // preferences so consecutive trades don't wipe out preferences they
          // just set. Falls back to the defaults when nothing is saved.
          trailingEnabled: savedTrailingPreference?.enabled ?? true,
          trailingPercent: savedTrailingPreference?.percent ?? String(DEFAULT_TRAIL_PERCENT),
          trailingQty: "",
          skipPresetTp: savedTpPreferenceRef.current
            ? !savedTpPreferenceRef.current.enabled
            : false,
          forceThreeContracts: false,
          notes: "",
        });
      } else {
        toast.error(data.message);
      }
    },
    onError: (error, newOrder, context) => {
      if (newOrder.idempotencyKey) {
        manualCopySubmissionNoncesRef.current.delete(newOrder.idempotencyKey);
      }
      // If mutation fails, use the context returned from onMutate to roll back
      if (context?.previousOrders) {
        trpcUtils.orders.list.setData({ limit: 50 }, context.previousOrders);
      }
      setSubmitResult({
        type: "error",
        message: error.message,
      });
      toast.error(error.message);
    },
    onSettled: () => {
      // Always refetch after error or success:
      trpcUtils.orders.list.invalidate();
    },
  });

  const submitBracketMutation = trpc.orders.submitBracket.useMutation({
    onSuccess: () => {
      trpcUtils.orders.list.invalidate();
      trpcUtils.positions.list.invalidate();
      // Refresh the Alpaca-backed open-orders panel (now + after ~3s)
      refreshOpenOrders();
    },
  });

  const submitWithExitPlanMutation = trpc.orders.submitWithExitPlan.useMutation(
    {
      onSuccess: () => {
        trpcUtils.orders.list.invalidate();
        trpcUtils.positions.list.invalidate();
        refreshOpenOrders();
      },
    },
  );

  const getDirectionForAction = (
    newAssetType: AssetType,
    newAction: TradeAction,
  ): Direction => {
    if (newAssetType === "OPTION") {
      return newAction === "SellToOpen" || newAction === "BuyToClose"
        ? "short"
        : "long";
    }

    return newAction === "SellShort" || newAction === "BuyToCover"
      ? "short"
      : "long";
  };

  const getEquitySideForAction = (newAction: TradeAction): EquitySide =>
    getActionSide(newAction);

  const getSubmitBlocker = (data: TradeFormData) => {
    if (!session?.user) return "Please sign in to place orders";
    if (!credentialsQuery.data?.hasCredentials) {
      return "Credentials missing. Please add your API keys in Settings.";
    }
    if (!activeCredentialId) {
      return "Select an enabled Paper or Live account before placing orders.";
    }
    if (
      data.assetType === "OPTION" &&
      (!data.optionsDateYear ||
        !data.optionsDateMonth ||
        !data.optionsDateDay ||
        !data.optionsStrike)
    ) {
      return "Select an expiration and strike for the option contract before submitting.";
    }
    return null;
  };

  const shouldReviewOrder = (data: TradeFormData) =>
    computeShouldReviewOrder(data, {
      embedded,
      activeAccountType,
      isPrefilledOrder,
    });

  const openOrderReview = (data: TradeFormData) => {
    const blocker = getSubmitBlocker(data);
    if (blocker) {
      pendingManualCopyNonceRef.current = null;
      pendingManualCopySourceRef.current = null;
      setSubmitResult({ type: "error", message: blocker });
      return;
    }

    const manualCopyNonce = manualCopyPrefill?.nonce ?? null;
    const manualCopySource = manualCopyPrefill?.value ?? null;
    if (shouldReviewOrder(data)) {
      pendingManualCopyNonceRef.current = manualCopyNonce;
      pendingManualCopySourceRef.current = manualCopySource;
      setPendingReviewOrder(data);
      return;
    }

    void executeSubmit(data, manualCopyNonce, manualCopySource);
  };

  const calculateRPrice = (multiple: number) => {
    // Use the same entry fallback chain as chipEntry in the chip render so
    // the pill always computes a price whenever the chip is enabled. Without
    // this, a Market OCO where entryPriceRef is "0" (not yet auto-filled)
    // would pass the string-truthy disabled check but return null here,
    // making the chip visually active yet silently doing nothing on click.
    //
    // Gate on entryOrderType: for Market entries, size off the live sizingPrice
    // rather than the limitPrice/entryPriceRef anchor. That anchor is seeded
    // once by applySmartExit and goes stale as the quote moves, so using it
    // for a Market entry prices the R chips against a snapshot rather than the
    // current market. Same guard as the auto-sizer's riskEntry.
    const entry = resolveLimitAwareBasis({
      entryOrderType,
      watchEntry,
      limitPrice,
      sizingPrice,
    });
    const sl = parseFloat(stopMarketPrice || "0");
    if (!entry || !sl) return null;
    const r = direction === "long" ? entry - sl : sl - entry;
    const tpPrice =
      direction === "long" ? entry + multiple * r : entry - multiple * r;
    return tpPrice.toFixed(2);
  };

  const addRLevel = (multiple: number) => {
    const price = calculateRPrice(multiple);
    if (price) {
      // Ensure the TP section is visible whenever a pill adds a target.
      // Defensive: if the user clicked "Remove" (which hides the section)
      // and then tapped a quick-add pill via an external path, the newly
      // appended row would be hidden without this call.
      setShowTpSection(true);
      const watchTotalQty = watch("quantity");
      const totalUsedQty = takeProfitsWatched.reduce(
        (acc, tp) => acc + parseInt(tp.quantity || "0"),
        0,
      );
      const remaining = Math.max(
        0,
        parseInt(watchTotalQty || "0") - totalUsedQty,
      );
      appendTp({ price, quantity: remaining > 0 ? remaining.toString() : "1" });
      // R-multiple pills are an explicit "I want TPs at this R" signal - flip
      // the auto-TP preference back on AND remember the chosen multiple so
      // the next ticket's auto plan seeds its take-profit at the same R.
      persistTakeProfitPreference({ enabled: true, r: multiple });
      setValue("skipPresetTp", false, { shouldValidate: false });
    }
  };

  // Market-data queries + derived values live in their own hook (audit H7:
  // second extraction from this god component; moved verbatim). The raw query
  // objects are still consumed below for isLoading/error/isFetching UI states.
  const {
    quoteQuery,
    optionQuoteQuery,
    accountQuery,
    contractsQuery,
    portfolioValue,
    stockQuote,
    optionQuote,
    optionContracts,
    heldEquityPosition,
    heldEquityPositionKnown,
    canSellLongEquity,
    equitySellAvailabilityKnown,
    selectedExpirationYYYYMMDD,
    expirations,
    strikes,
  } = useTradeQuotes({
    symbol,
    marketDataSymbol,
    normalizedSymbol,
    activeCredentialId,
    assetType,
    optionsDateYear,
    optionsDateMonth,
    optionsDateDay,
    optionsStrike,
    optionTypeWatched,
  });

  // Clear a chosen strike that is no longer valid for the current expiration +
  // call/put (e.g. after switching type via the direction fallback, changing
  // expiration, or changing symbol) so we never build a non-existent contract.
  useEffect(() => {
    if (assetType !== "OPTION") return;
    if (!optionContracts || !optionsStrike) return;
    if (!strikes.some((s) => s === parseFloat(optionsStrike))) {
      setValue("optionsStrike", "", { shouldValidate: false });
    }
  }, [assetType, optionContracts, strikes, optionsStrike, setValue]);

  const credentialsQuery = trpc.userSettings.hasApiCredentials.useQuery(
    { provider: "alpaca" },
    { enabled: !!session?.user },
  );

  // Update symbol when initialSymbol changes
  useEffect(() => {
    if (initialSymbol) {
      setValue("symbol", initialSymbol);
    }
  }, [initialSymbol, setValue]);

  // Removed auto-update stop to low of day, as it prevents users from leaving it blank for manual orders

  // Calculate quantity based on max risk and stop loss
  // Single price basis for risk math. Limit entries use the explicit
  // entry/limit anchor; market entries use the live quote so hidden seeded
  // entry values don't make a valid stop look invalid.
  const sizingPrice = useMemo(() => {
    if (assetType === "OPTION") return parseFloat(optionQuote?.last || "0");
    return resolveSizingPrice({
      entryAnchor: parseFloat(watchEntry || "0"),
      limitPrice: parseFloat(limitPrice || "0"),
      liveLast: parseFloat(stockQuote?.last || "0"),
      preferEntryAnchor: entryOrderType === "Limit",
    });
  }, [
    assetType,
    watchEntry,
    limitPrice,
    optionQuote?.last,
    stockQuote?.last,
    entryOrderType,
  ]);

  const showStopSizingFeedback = shouldShowStopSizingFeedback({
    orderType,
    embedded,
  });

  const calculatedQuantity = useMemo(() => {
    const risk = parseFloat(maxRisk || "0");
    const currentPrice = sizingPrice;
    const stop = parseFloat(stopMarketPrice || "0");

    if (isNaN(risk) || isNaN(currentPrice) || isNaN(stop) || stop <= 0) {
      return 0;
    }

    // Validation based on direction
    if (direction === "long" && currentPrice <= stop) return 0;
    if (direction === "short" && currentPrice >= stop) return 0; // stop should be higher than price for short

    const diff = Math.abs(currentPrice - stop);
    if (diff === 0) return 0;

    if (assetType === "OPTION") {
      // Options: Risk / (diff * 100)
      return Math.floor(risk / (diff * 100));
    } else {
      // Equity: Risk / diff
      return Math.round(risk / diff);
    }
  }, [maxRisk, stopMarketPrice, sizingPrice, assetType, direction]);

  // Live $ risk for the CURRENTLY entered quantity (presentation only - does not
  // touch quantity, schema, or submit). Mirrors the calculatedQuantity inputs so
  // the user sees the relationship update with whatever they have typed.
  const hasActiveTrailingRunner = computeHasActiveTrailingRunner({
    trailingEnabled,
    trailingQty,
    trailingPercent,
  });
  const currentRisk = useMemo(
    () => {
      if (!showStopSizingFeedback) return null;
      return computeCurrentRisk({
        trailingEnabled,
        trailingQty,
        trailingPercent,
        quantity: quantityWatched,
        takeProfits: takeProfitsWatched,
        sizingPrice,
        stopMarketPrice,
        direction,
        isOption: assetType === "OPTION",
      });
    },
    [
      showStopSizingFeedback,
      trailingEnabled,
      trailingQty,
      trailingPercent,
      quantityWatched,
      takeProfitsWatched,
      stopMarketPrice,
      sizingPrice,
      assetType,
      direction,
    ],
  );

  // Explain WHY risk-based sizing can't run instead of silently showing 0/blank.
  // Reuses the same gates as calculatedQuantity / currentRisk.
  const sizingHint = useMemo(() => {
    if (!showStopSizingFeedback) return null;

    const currentPrice = sizingPrice;
    const stop = parseFloat(stopMarketPrice || "0");

    if (isNaN(currentPrice) || currentPrice <= 0) {
      return "Waiting for a live price to size by risk…";
    }
    if (isNaN(stop) || stop <= 0) {
      return "Enter a stop loss to size by risk.";
    }
    if (direction === "long" && currentPrice <= stop) {
      return "For a long, set the stop BELOW the current price.";
    }
    if (direction === "short" && currentPrice >= stop) {
      return "For a short, set the stop ABOVE the current price.";
    }
    return null;
  }, [showStopSizingFeedback, stopMarketPrice, sizingPrice, direction]);

  // Dollar figures for the review modal: how much cash the position commits and
  // how much is lost if the stop is hit. Computed from the order being reviewed
  // so the numbers match exactly what's about to be sent. Risk is also expressed
  // as a % of the portfolio so an oversized position is obvious before submit.
  const reviewMetrics = useMemo(
    () =>
      computeReviewMetrics(
        pendingReviewOrder,
        pendingReviewOrder?.assetType === "OPTION"
          ? optionQuote?.last
          : stockQuote?.last,
        portfolioValue,
      ),
    [pendingReviewOrder, stockQuote?.last, optionQuote?.last, portfolioValue],
  );

  // Hard directional check on the exit-plan stop: a long's stop must sit BELOW
  // the live price and a short's ABOVE - otherwise it would trigger instantly.
  // Unlike sizingHint (a calculator hint), this gates submission, so it only
  // fires once a stop is actually entered for an OCO/exit-plan order.
  const stopDirectionError = useMemo(() => {
    if (orderType !== "OCO") return null;
    const stop = parseFloat(stopMarketPrice || "0");
    if (!Number.isFinite(stop) || stop <= 0) return null;
    const currentPrice =
      assetType === "OPTION"
        ? parseFloat(optionQuote?.last || "0")
        : parseFloat(stockQuote?.last || "0");
    return validateStopLossDirection(stop, direction, currentPrice);
  }, [
    orderType,
    stopMarketPrice,
    stockQuote?.last,
    optionQuote?.last,
    assetType,
    direction,
  ]);

  // Update quantity when relevant fields change
  // REMOVED: Auto-updating quantity fights with manual user input.
  // Instead, we show a suggestion/button to apply the calculation.
  // useEffect(() => {
  //   if (calculatedQuantity > 0 && !forceThreeContracts) {
  //     setValue("quantity", String(calculatedQuantity));
  //   }
  // }, [calculatedQuantity, forceThreeContracts, setValue]);

  // Force quantity to 3 when option is checked
  useEffect(() => {
    if (forceThreeContracts) {
      setValue("quantity", "3");
    }
  }, [forceThreeContracts, setValue]);

  // Tracks whether the user has manually edited Max $ Risk this session. While
  // it's untouched we keep it in sync with the risk-budget default below;
  // once they type a value we stop overriding it.
  const userEditedRiskRef = useRef(false);
  const appliedRiskDefaultRef = useRef(false);

  // Tracks whether the user has hand-typed a share quantity this session. While
  // untouched, the quantity is kept in sync with the risk budget as entry/stop
  // change (see the auto-resize effect below).
  const userEditedQtyRef = useRef(false);
  const lastAutoFilledSymbol = useRef<string | null>(null);

  // Manual copy is an event, not a set of additive initial values. Reset the
  // whole stock ticket in one operation so repeated copies, including copies
  // with the same symbol and quantity, replace user edits and old exit legs.
  const appliedManualCopyNonceRef = useRef(0);
  useEffect(() => {
    if (!manualCopyPrefill || manualCopyPrefill.consumed) return;
    if (appliedManualCopyNonceRef.current === manualCopyPrefill.nonce) return;

    appliedManualCopyNonceRef.current = manualCopyPrefill.nonce;
    if (manualCopyPrefill.value.qty === undefined) {
      // X-feed chips own provenance but keep the existing unsized ticket flow.
      setPendingReviewOrder(null);
      onManualCopyPrefillConsumed?.(manualCopyPrefill.nonce);
      return;
    }
    const currentValues = getValues();
    reset({
      ...currentValues,
      ...buildStockTicketReset({
        copy: manualCopyPrefill.value,
        currentMaxRisk: currentValues.maxRisk,
        trailingEnabled: savedTrailingPreferenceRef.current?.enabled ?? true,
        trailingPercent:
          savedTrailingPreferenceRef.current?.percent ?? String(DEFAULT_TRAIL_PERCENT),
        skipPresetTp: savedTpPreferenceRef.current
          ? !savedTpPreferenceRef.current.enabled
          : false,
      }),
    });
    userEditedQtyRef.current = true;
    replaceTps([]);
    setShowTpSection(true);
    setRailShowNotes(false);
    setPendingReviewOrder(null);
    // A same-symbol copy also needs fresh quote-derived protective levels.
    lastAutoFilledSymbol.current = null;
    onManualCopyPrefillConsumed?.(manualCopyPrefill.nonce);
  }, [
    getValues,
    manualCopyPrefill,
    onManualCopyPrefillConsumed,
    replaceTps,
    reset,
  ]);

  // Fallback restore: the last Max $ Risk the user traded with, used only when
  // we don't (yet) have a portfolio value to compute the risk-budget default from - e.g.
  // before the account loads, or when no account is connected. Runs once on
  // mount; the risk-budget default effect below supersedes it once the balance arrives.
  const LAST_RISK_KEY = "rst:lastMaxRisk";
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (userEditedRiskRef.current || appliedRiskDefaultRef.current) return;
    const saved = window.localStorage.getItem(LAST_RISK_KEY);
    if (saved && /^\d+(\.\d+)?$/.test(saved)) {
      setValue("maxRisk", saved, { shouldValidate: false });
    }
  }, [setValue]);

  // Default Max $ Risk to RISK_BUDGET_PCT of total portfolio value, so a
  // stop-out loses ≤ that share of the account by default. Applied once, when
  // the balance first becomes available and the user hasn't manually overridden
  // the field. Editable down afterwards; a manual edit (userEditedRiskRef)
  // permanently disables this.
  useEffect(() => {
    if (appliedRiskDefaultRef.current || userEditedRiskRef.current) return;
    if (portfolioValue === null || portfolioValue <= 0) return;
    const budgetRisk = Math.max(
      1,
      Math.round(RISK_BUDGET_PCT * portfolioValue),
    );
    setValue("maxRisk", String(budgetRisk), { shouldValidate: false });
    appliedRiskDefaultRef.current = true;
  }, [portfolioValue, setValue]);

  // Keep the share quantity sized to the risk budget when the inputs that
  // define risk change - Max $ Risk, the exit-plan entry, or the stop. Without
  // this, a copied/auto-filled quantity goes stale after the entry or stop is
  // edited and silently over-risks (e.g. 48 shares left over from a tighter
  // stop now risking far more than the risk budget). Runs for any non-option
  // equity order (OCO or plain Market/Limit — the plain-mode stop is a sizing
  // anchor only) as long as the user hasn't hand-typed a quantity. The OCO
  // take-profit / trailing legs are re-split to match the new size when they
  // exist; otherwise the leg writes are no-ops.
  useEffect(() => {
    if (
      !shouldRunAutoSizer({
        assetType,
        userEditedQty: userEditedQtyRef.current,
        forceThreeContracts,
      })
    )
      return;
    // Limit entries prefer the explicit entry/limit anchor (entryPriceRef,
    // then limitPrice), falling back to sizingPrice only if neither is set
    // yet. Market entries always size off sizingPrice (the live quote) - the
    // anchor fields are seeded by applySmartExit for OCO bookkeeping and can
    // go stale as the quote moves, so using them here would let the
    // submitted position exceed the configured risk budget. This mirrors
    // resolveSizingPrice's own entryOrderType gating.
    const riskEntry = resolveLimitAwareBasis({
      entryOrderType,
      watchEntry,
      limitPrice,
      sizingPrice,
    });
    const stop = parseFloat(stopMarketPrice || "0");
    const risk = parseFloat(maxRisk || "0");
    const trailingIsEnabled = trailingEnabled;
    const tpFraction = resolveTpFraction({
      tpActive: !skipPresetTp,
      trailingActive: trailingIsEnabled,
    });
    const trailPct = parseFloat(trailingPercent || "0");
    const qty =
      orderType === "OCO" && trailingIsEnabled && trailPct > 0
        ? sizeByExitPlanRisk({
            maxRisk: risk,
            entry: riskEntry,
            stop,
            direction,
            tpFraction,
            trailingPercent: trailPct,
          })
        : sizeByRisk({ maxRisk: risk, entry: riskEntry, stop, direction });
    if (qty <= 0) return;
    const currentQty = parseInt(quantityWatched || "0", 10);
    if (currentQty !== qty) {
      setValue("quantity", String(qty), { shouldValidate: true });
    }

    // Re-split the exit legs so the TP half + trailing runner still cover the
    // whole (re-sized) position. Mirror the auto-fill's fraction rules: no TP
    // slice when the user opted out, the full position when trailing is off.
    const { tpQty, trailQty } = splitQty(
      qty,
      tpFraction,
    );
    const tps = watch("takeProfits") || [];
    if (tps.length >= 1 && tpQty > 0) {
      setValue("takeProfits.0.quantity", String(tpQty), {
        shouldValidate: true,
      });
    }
    if (trailingIsEnabled && trailQty > 0) {
      setValue("trailingQty", String(trailQty), { shouldValidate: false });
    }
  }, [
    maxRisk,
    watchEntry,
    limitPrice,
    sizingPrice,
    stopMarketPrice,
    direction,
    entryOrderType,
    orderType,
    assetType,
    forceThreeContracts,
    quantityWatched,
    trailingEnabled,
    trailingPercent,
    skipPresetTp,
    setValue,
    watch,
  ]);

  // When the user manually edits the total share quantity, scale all OCO exit
  // legs (every TP row + the trailing runner) proportionally so the plan
  // continues to cover the full position after the resize.
  //
  // The auto-sizer above handles the risk-budget path (userEditedQtyRef=false).
  // This effect handles the manual path (userEditedQtyRef=true) and is
  // intentionally mutually exclusive with it.
  useEffect(() => {
    if (orderType !== "OCO" || assetType === "OPTION") return;
    if (!userEditedQtyRef.current) return;

    const newQty = parseInt(quantityWatched || "0", 10);
    if (newQty <= 0) return;

    const tps = watch("takeProfits") || [];
    const trailingIsEnabled = watch("trailingEnabled");
    const currentTrailingQty = parseInt(watch("trailingQty") || "0", 10);

    // Build weights from the current TP row quantities + trailing qty.
    const tpQtys = tps.map((tp) =>
      Math.max(0, parseInt(tp.quantity || "0", 10)),
    );
    const tpTotal = tpQtys.reduce((a, b) => a + b, 0);
    const trailTotal = trailingIsEnabled ? Math.max(0, currentTrailingQty) : 0;
    const oldTotal = tpTotal + trailTotal;
    if (oldTotal <= 0) return; // nothing to scale from

    // Scale each TP row proportionally; round to whole shares.
    let distributedToTps = 0;
    tps.forEach((_tp, index) => {
      const scaled = Math.round((tpQtys[index] / oldTotal) * newQty);
      const clamped = Math.max(1, scaled);
      distributedToTps += clamped;
      setValue(`takeProfits.${index}.quantity`, String(clamped), {
        shouldValidate: false,
      });
    });

    // Trailing runner gets whatever shares remain after the TP slice.
    if (trailingIsEnabled && trailTotal > 0) {
      const newTrailQty = Math.max(1, newQty - distributedToTps);
      setValue("trailingQty", String(newTrailQty), { shouldValidate: false });
    }
  }, [quantityWatched, orderType, assetType, setValue, watch]);

  /**
   * Auto-fill the one-click exit plan: stop = LOD (long) / HOD (short), a
   * risk-sized quantity, and a TP@0.7R (50%) + 5%-trailing-runner (50%) plan
   * by default, reshaped by the user's saved take-profit / trailing
   * preferences.
   *
   * Runs once per symbol when a live quote is first available, and only fills
   * fields the user hasn't already set, so it primes the form without fighting
   * manual edits. The user can re-trigger it explicitly via "Auto-fill plan".
   */
  // A stock copy's buying power belongs to one Alpaca credential. When the
  // account changes, clear the copied ticket as well as the parent event so a
  // mounted form cannot submit the old quantity against Paper/Live's peer.
  useEffect(() => {
    if (!manualCopyResetNonce) return;
    const currentValues = getValues();
    reset({
      ...currentValues,
      ...buildStockTicketReset({
        copy: {
          symbol: initialSymbol || currentValues.symbol,
          side: "buy",
          qty: 1,
          assetType: "EQUITY",
        },
        currentMaxRisk: currentValues.maxRisk,
        trailingEnabled: savedTrailingPreferenceRef.current?.enabled ?? true,
        trailingPercent:
          savedTrailingPreferenceRef.current?.percent ?? String(DEFAULT_TRAIL_PERCENT),
        skipPresetTp: savedTpPreferenceRef.current
          ? !savedTpPreferenceRef.current.enabled
          : false,
      }),
    });
    userEditedQtyRef.current = false;
    replaceTps([]);
    setShowTpSection(true);
    setRailShowNotes(false);
    setPendingReviewOrder(null);
    lastAutoFilledSymbol.current = null;
  }, [
    getValues,
    initialSymbol,
    manualCopyResetNonce,
    replaceTps,
    reset,
  ]);

  const applySmartExit = useCallback(
    (opts: { force?: boolean; forcePrices?: boolean } = {}) => {
      if (assetType === "OPTION" || orderType !== "OCO") return;

      const last = parseFloat(stockQuote?.last || "0");
      const bid = parseFloat(stockQuote?.bid || "0");
      const ask = parseFloat(stockQuote?.ask || "0");
      const low = parseFloat(stockQuote?.low || "0");
      const high = parseFloat(stockQuote?.high || "0");
      if (!last || last <= 0) return;

      // `forcePrices` reseeds the entry/limit/stop from the loaded symbol's
      // quote without disturbing a copied quantity or take-profits - used when
      // the symbol changes so prices never carry the prior symbol's values.
      // `force` (the "Auto-fill plan" button) additionally recomputes qty/TPs.
      const overwritePrices = opts.force || opts.forcePrices;

      // Entry: rest on the direction's side of the book - best bid for longs,
      // best ask for shorts - falling back to last. Keep a user-set entry unless
      // overwriting.
      const existingEntry = parseFloat(watch("entryPriceRef") || "0");
      const autoFillEntry =
        entryOrderType === "Limit"
          ? entryBasisFromQuote({ bid, ask, last, direction }) ?? last
          : last;
      const entry =
        overwritePrices || existingEntry <= 0 ? autoFillEntry : existingEntry;
      if (overwritePrices || existingEntry <= 0) {
        setValue("entryPriceRef", entry.toFixed(2), { shouldValidate: false });
        // Mirror onto the plain-limit field so a Limit entry rests on the same side.
        setValue("limitPrice", entry.toFixed(2), { shouldValidate: false });
      }

      // Stop: LOD for longs, HOD for shorts. Don't clobber a user-set stop
      // unless overwriting.
      const existingStop = parseFloat(watch("stopMarketPrice") || "0");
      const autoStop = defaultStopForDirection({ direction, low, high });
      const stop =
        overwritePrices || existingStop <= 0
          ? (autoStop ?? existingStop)
          : existingStop;
      if (stop && stop > 0 && (overwritePrices || existingStop <= 0)) {
        // Validate after all exit legs are seeded below. Validating here sees
        // the temporary fixed-stop + trailing + no-TP state and leaves a stale
        // error visible even after the take-profit row is added.
        setValue("stopMarketPrice", stop.toFixed(2), { shouldValidate: false });
      }
      if (!stop || stop <= 0) return;

      // Quantity: size by risk. Only auto-size if untouched (still "1") or forced.
      const risk = parseFloat(watch("maxRisk") || "0");
      const qty = sizeByRisk({ maxRisk: risk, entry, stop, direction });
      const existingQty = parseInt(watch("quantity") || "0");
      const effectiveQty =
        opts.force || (!manualCopyPrefill && existingQty <= 1)
          ? qty > 0
            ? qty
            : existingQty
          : existingQty;
      if (
        qty > 0 &&
        (opts.force || (!manualCopyPrefill && existingQty <= 1)) &&
        !forceThreeContracts
      ) {
        setValue("quantity", String(qty), { shouldValidate: true });
      }
      if (!effectiveQty || effectiveQty <= 0) return;

      // Exit legs: each fresh auto-fill seeds the saved plan shape, defaulting
      // to TP@DEFAULT_TP_R on half + trailing runner on the remainder. The
      // saved preferences (take-profit on/off + preferred R, trailing on/off
      // + percent) come from the user's last explicit edits, so removing the
      // TP or changing the trail % carries into the next ticket.
      const tpPrefEnabled = savedTpPreferenceRef.current?.enabled ?? true;
      const trailPrefEnabled =
        savedTrailingPreferenceRef.current?.enabled ?? true;
      if (overwritePrices) {
        setValue("skipPresetTp", !tpPrefEnabled, { shouldValidate: false });
      }
      const tpActive = overwritePrices ? tpPrefEnabled : !watch("skipPresetTp");
      const trailActive = overwritePrices
        ? trailPrefEnabled
        : !!watch("trailingEnabled");
      // TP share of the position: half when the trailing runner takes the
      // rest, everything when trailing is off, nothing when the user opted
      // out of preset take-profits.
      const tpFraction = resolveTpFraction({
        tpActive,
        trailingActive: trailActive,
      });
      const { tpQty, trailQty } = splitQty(effectiveQty, tpFraction);

      // Whether a fixed take-profit leg actually ended up on the ticket.
      // Needed below: a trailing runner plus a fixed stop with NO take-profit
      // is an invalid Alpaca combo, so the fixed stop must be dropped then.
      let hasTpLeg = false;

      const existingTps = watch("takeProfits") || [];
      if (overwritePrices || existingTps.length === 0) {
        // No TPs yet, or reseeding prices for a new symbol: the take-profit is
        // derived from entry/stop, so recompute it rather than leave the prior
        // symbol's absolute price. Seed a single TP at the preferred R for the
        // TP slice.
        //
        // IMPORTANT: use replaceTps (useFieldArray's replace) rather than
        // setValue("takeProfits", ...). setValue mutates the form's data but
        // does NOT sync useFieldArray's internal `tpFields` state - which is
        // what the UI iterates over. Using it caused a silent UI-vs-data
        // desync where the "Take-profit targets" section appeared empty but
        // the submitted order carried an auto-attached TP row.
        if (tpQty > 0) {
          const tpPrice = computeRPrice({
            entry,
            stop,
            direction,
            multiple: savedTpPreferenceRef.current?.r ?? DEFAULT_TP_R,
          });
          replaceTps(
            tpPrice
              ? [{ price: tpPrice.toFixed(2), quantity: String(tpQty) }]
              : [],
          );
          hasTpLeg = !!tpPrice;
        } else {
          replaceTps([]);
        }
        if (overwritePrices) {
          setShowTpSection(tpQty > 0 && hasTpLeg);
        }
      } else if (existingTps.length === 1 && tpQty > 0) {
        // A TP price is already set (e.g. a copied signal's target) but its
        // quantity is still the placeholder - size it to the TP half so the
        // position is fully covered between the TP and the trailing runner.
        // Same reason for update() over setValue: keeps useFieldArray in sync.
        const existingQtyForTp = parseInt(existingTps[0].quantity || "0") || 0;
        if (existingQtyForTp <= 1) {
          updateTp(0, {
            price: existingTps[0].price ?? "",
            quantity: String(tpQty),
          });
        }
        hasTpLeg = true;
      } else {
        hasTpLeg = existingTps.length > 0;
      }

      // Trailing runner: the user's saved percent, defaulting to the flat
      // DEFAULT_TRAIL_PERCENT (5%). Deliberately not derived from the stop
      // distance: the auto plan promises "half at the R target, half on a 5%
      // trail" unless the user tuned it themselves.
      const savedTrailNum = Number(savedTrailingPreferenceRef.current?.percent);
      const trail =
        Number.isFinite(savedTrailNum) && savedTrailNum > 0
          ? savedTrailNum
          : DEFAULT_TRAIL_PERCENT;
      const trailingOn = trailActive && trailQty > 0;
      setValue("trailingEnabled", trailingOn, { shouldValidate: false });
      if (trailingOn) {
        if (opts.force || !watch("trailingPercent")) {
          setValue("trailingPercent", String(trail), { shouldValidate: false });
        }
        setValue("trailingQty", String(trailQty), { shouldValidate: false });
      } else {
        setValue("trailingQty", "", { shouldValidate: false });
      }

      // Trailing-only plan (no TP leg): the trailing stop carries its own
      // protection and Alpaca rejects a fixed stop riding alongside it, so
      // drop the fixed stop AFTER it has served its purpose as the sizing
      // anchor above. Mirrors the manual "Remove take-profit" flow. Without
      // this, the seeded plan opened in an error state ("Trailing already
      // carries its own stop...") the moment the ticket rendered.
      if (trailingOn && !hasTpLeg) {
        setValue("stopMarketPrice", "", { shouldValidate: false });
      }

      // The auto-fill performs several dependent writes. Validate their final
      // combined state so transient intermediate combinations never surface as
      // user-facing errors on a valid default plan.
      void trigger(["stopMarketPrice", "takeProfits"]);
    },
    [
      assetType,
      orderType,
      stockQuote?.last,
      stockQuote?.bid,
      stockQuote?.ask,
      stockQuote?.low,
      stockQuote?.high,
      direction,
      entryOrderType,
      forceThreeContracts,
      manualCopyPrefill,
      setValue,
      trigger,
      watch,
      replaceTps,
      updateTp,
    ],
  );

  // A copied Signa signal supplies its own entry/stop/target via props; when it
  // does we must not overwrite those with the live quote.
  const hasSignalPrefill =
    initialEntry != null ||
    initialStopLoss != null ||
    initialTakeProfit != null;

  // Track the last committed (debounced, uppercased) symbol the ticket priced
  // against, so a symbol switch can clear price fields that are absolute to the
  // prior symbol. Seeded to the initial committed symbol so the first mount is
  // not treated as a change.
  const pricedSymbolRef = useRef(marketDataSymbol);

  // Reset stale price fields when the traded symbol changes.
  //
  // The stop / take-profit / entry / limit / stop-trigger fields hold prices
  // absolute to one symbol. Before this reset, switching the symbol (e.g. a
  // "Copy $HYPE" chip while a SPY ticket was set up) left SPY's stop 737.35 and
  // target 737.93 on the HYPE ticket, so the review dialog and the submitted
  // HYPE order carried SPY price levels (a real-money hazard). applySmartExit
  // reseeds these from the new symbol's quote, but only once a live quote is
  // available: a symbol with no equity quote (a crypto/perp ticker, an illiquid
  // name, after hours) never reseeds, so the prior symbol's prices survived
  // indefinitely. Clearing here is NOT gated on a quote, so the stale prices
  // always go.
  //
  // A fresh Copy-Signal / chat-draft prefill FOR the new symbol is preserved:
  // those props set stop/target/entry intentionally for the symbol being
  // loaded, and the prefill effect above applies them. The pure
  // shouldResetStalePriceFields helper returns false in that case (and on the
  // first mount and same-symbol re-renders) so intentional values and live user
  // input are never wiped.
  useEffect(() => {
    const previousSymbol = pricedSymbolRef.current;
    // Only a real symbol advances the "priced against" marker. A cleared symbol
    // field debounces to "" mid-edit; treating that as the priced symbol would
    // make the NEXT commit look like a first mount (previous="") and skip the
    // reset entirely, carrying the old symbol's stop/target onto the new ticket.
    if (marketDataSymbol) {
      pricedSymbolRef.current = marketDataSymbol;
    }
    const plan = resolveStalePriceReset({
      previousSymbol,
      nextSymbol: marketDataSymbol,
      // Field-granular: a partial prefill (e.g. a stop-only chat draft) pins
      // only what it carries, so every other stale field is still cleared.
      //
      // Contract: these props are assumed to describe the symbol being loaded.
      // The parent guarantees that by clearing its prefill state whenever the
      // committed symbol differs from the active one (see `onSymbolCommit` /
      // `handleTradeSymbolCommit` in app/page.tsx). A TradeForm mounted WITHOUT
      // `onSymbolCommit` would keep a symbol-A prefill pinning fields while the
      // user types symbol B, so keep that wiring when adding a mount.
      prefill: hasSignalPrefill
        ? {
            hasEntry: initialEntry != null,
            hasStop: initialStopLoss != null,
            hasTarget: initialTakeProfit != null,
          }
        : undefined,
    });
    if (!plan.shouldReset) return;
    // Clear the price fields absolute to the prior symbol, plus the exit legs
    // and derived risk-sizing share counts that were computed from them. The
    // auto-fill effect below reseeds fresh values (prices, risk-sized qty, and
    // legs) once the new symbol's quote loads; if it never loads the fields
    // stay empty rather than carrying the prior symbol's levels.
    if (plan.clearStop) setValue("stopMarketPrice", "", { shouldValidate: false });
    if (plan.clearEntry) {
      setValue("entryPriceRef", "", { shouldValidate: false });
      setValue("limitPrice", "", { shouldValidate: false });
    }
    if (plan.clearTrigger) setValue("priceTrigger", "", { shouldValidate: false });
    if (plan.clearTrailingQty) setValue("trailingQty", "", { shouldValidate: false });
    if (plan.clearTakeProfits) {
      replaceTps([]);
      setShowTpSection(true);
    }
    // Let applySmartExit fully reseed for the new symbol when its quote arrives,
    // instead of treating the symbol as already auto-filled.
    lastAutoFilledSymbol.current = null;
  }, [
    marketDataSymbol,
    hasSignalPrefill,
    initialEntry,
    initialStopLoss,
    initialTakeProfit,
    setValue,
    replaceTps,
  ]);

  // One-shot auto-fill per symbol once its quote is ready. Reseed the
  // entry/limit/stop from the new symbol's quote (best bid / LOD-HOD) so they
  // never carry the prior symbol's prices - unless a copied signal pinned them.
  useEffect(() => {
    if (assetType === "OPTION" || orderType !== "OCO") return;
    if (!normalizedSymbol || !stockQuote?.last) return;
    if (lastAutoFilledSymbol.current === normalizedSymbol) return;
    lastAutoFilledSymbol.current = normalizedSymbol;
    applySmartExit({ forcePrices: !hasSignalPrefill });
  }, [
    assetType,
    orderType,
    normalizedSymbol,
    stockQuote?.last,
    hasSignalPrefill,
    applySmartExit,
  ]);

  // Keep the form aligned with the server's Alpaca TIF rules: limit sells rest
  // as GTC; option market/stop orders are DAY-only (Alpaca allows GTC on option
  // limit orders only).
  useEffect(() => {
    const nextTimeInForce = resolveTradeFormTimeInForce({
      assetType,
      orderType,
      action,
      timeInForce,
    });

    if (timeInForce !== nextTimeInForce) {
      setValue("timeInForce", nextTimeInForce, { shouldValidate: true });
    }

    if (assetType === "OPTION" && orderType === "OCO") {
      setValue("orderType", "Market", { shouldValidate: true });
    }
  }, [assetType, orderType, action, timeInForce, setValue]);

  // Apply a chosen expiration (YYYY-MM-DD) onto the existing year/month/day
  // fields so the submit/quote payload construction stays unchanged.
  const handleExpirationChange = (yyyymmdd: string) => {
    const [yyyy, mm, dd] = yyyymmdd.split("-");
    if (!yyyy || !mm || !dd) return;
    setValue("optionsDateYear", yyyy.slice(2), { shouldValidate: true });
    setValue("optionsDateMonth", mm, { shouldValidate: true });
    setValue("optionsDateDay", dd, { shouldValidate: true });
    // Clear the strike when the expiration changes since available strikes differ.
    setValue("optionsStrike", "", { shouldValidate: false });
  };

  const updateQuickIntent = (
    newAssetType: AssetType,
    newValue: Direction | EquitySide,
  ) => {
    const intent = resolveQuickTradeIntent({
      assetType: newAssetType,
      side: newValue,
      canSellLongEquity,
    });
    if (!intent) return;
    setValue("direction", intent.direction, { shouldValidate: true });
    setValue("action", intent.action, { shouldValidate: true });
  };

  const handleActionChange = (newAction: TradeAction) => {
    if (assetType === "EQUITY" && newAction === "Sell" && !canSellLongEquity)
      return;
    setValue("action", newAction, { shouldValidate: true });
    setValue("direction", getDirectionForAction(assetType, newAction), {
      shouldValidate: true,
    });
  };

  /**
   * Switching to Options always lands the user on "Buy to Open" (and
   * direction = long) regardless of the previous equity action. The
   * previous behaviour mapped existing direction onto the option action,
   * which felt surprising - most option flows start with BTO.
   */
  const handleAssetTypeChange = (newAssetType: AssetType) => {
    setValue("assetType", newAssetType, { shouldValidate: true });
    if (newAssetType === "OPTION") {
      setValue("direction", "long", { shouldValidate: true });
      setValue("action", "BuyToOpen", { shouldValidate: true });
    } else {
      const nextEquitySide = getEquitySideForAction(action);
      updateQuickIntent(
        newAssetType,
        nextEquitySide === "sell" && !canSellLongEquity
          ? "buy"
          : nextEquitySide,
      );
    }
  };

  const handleEntryOrderTypeChange = (next: EntryOrderType) => {
    setValue("entryOrderType", next, { shouldValidate: true });
    if (orderType === "Market" || orderType === "Limit") {
      setValue("orderType", next, { shouldValidate: true });
    }
  };

  const handleOrderTypeChange = (next: OrderType) => {
    setValue("orderType", next, { shouldValidate: true });
    if (next === "Market" || next === "Limit") {
      setValue("entryOrderType", next, { shouldValidate: true });
    }
  };

  useEffect(() => {
    if (
      assetType === "EQUITY" &&
      action === "Sell" &&
      equitySellAvailabilityKnown &&
      !canSellLongEquity
    ) {
      setValue("action", "Buy", { shouldValidate: true });
      setValue("direction", "long", { shouldValidate: true });
    }
  }, [
    action,
    assetType,
    canSellLongEquity,
    equitySellAvailabilityKnown,
    setValue,
  ]);

  const executeSubmit = async (
    data: TradeFormData,
    manualCopyNonce: number | null = manualCopyPrefill?.nonce ?? null,
    manualCopySourceForSubmit: StockManualCopyPrefill | null =
      manualCopyPrefill?.value ?? null,
  ) => {
    setSubmitResult(null);
    setPendingReviewOrder(null);

    const blocker = getSubmitBlocker(data);
    if (blocker) {
      setSubmitResult({ type: "error", message: blocker });
      return;
    }

    // Resolve call/put the same way the rest of the component does so the
    // submitted contract matches the displayed quote/strikes.
    const resolvedOptionType: "call" | "put" =
      data.optionType ?? (data.direction === "long" ? "call" : "put");

    // Built once (no stale-date fallback) and reused by both submit paths.
    const optionExpiration =
      data.assetType === "OPTION"
        ? `${data.optionsDateYear!.padStart(2, "0")}${data.optionsDateMonth!.padStart(2, "0")}${data.optionsDateDay!.padStart(2, "0")}`
        : undefined;
    const optionTypeOut: "CALL" | "PUT" | undefined =
      data.assetType === "OPTION"
        ? resolvedOptionType === "call"
          ? "CALL"
          : "PUT"
        : undefined;

    const currentPrice =
      data.assetType === "OPTION"
        ? parseFloat(optionQuote?.last || "0")
        : parseFloat(stockQuote?.last || "0");

    const manualCopySource = manualCopySourceForSubmit;
    const orderCopySourceItemId = resolveStockManualCopySourceId({
      copySourceItemId:
        manualCopySource?.copySourceItemId ?? copySourceItemId,
      sourceSymbol: manualCopySource?.symbol ?? copySourceSymbol,
      sourceSide: manualCopySource?.side ?? copySourceSide,
      orderSymbol: data.symbol,
      assetType: data.assetType,
      action: data.action,
      direction: data.direction,
    });

    // Persist the Max $ Risk so the next order reuses it (the spec's "reuse the
    // last $100 you set"). Presentation-only; never blocks submit.
    if (
      typeof window !== "undefined" &&
      data.maxRisk &&
      /^\d+(\.\d+)?$/.test(data.maxRisk)
    ) {
      try {
        window.localStorage.setItem(LAST_RISK_KEY, data.maxRisk);
      } catch {
        /* localStorage may be unavailable (private mode) - ignore */
      }
    }

    // Resolve the trailing runner once for the exit-plan path below.
    const totalQty = parseInt(data.quantity) || 0;
    // submitWithExitPlan carries three flavours now:
    //   - trailing (± TP): the classic "Smart Exit" path, worker attaches
    //     legs after fill.
    //   - fixed TP only (no trailing): also worker-attached, but with just
    //     take-profit legs — see the OCO+TP branch below.
    //   - stop-only: no TP, no trailing, just a broker stop. Submitted as an
    //     Alpaca OTO with a stop_loss child, no worker involvement.
    // The submitWithExitPlan mutation understands all three; we only need to
    // gate it here so we don't fall through to the plain-order path.
    const { useExitPlan, trailingStop, hasFixedTps } = resolveExitPlanRouting(
      data,
    );

    // Guard against placing a naked entry: if the exit plan is on but nothing
    // protective is configured (no stop, no TP, no trailing), stop and tell
    // the user to finish the plan or turn off the exit plan.
    if (
      data.orderType === "OCO" &&
      data.assetType === "EQUITY" &&
      !useExitPlan &&
      !hasFixedTps
    ) {
      setSubmitResult({
        type: "error",
        message:
          'Finish the exit plan first - set a stop, a take-profit, or a trailing runner (tap "Auto-fill plan"), or turn "Attach exit plan" off for a plain order.',
      });
      return;
    }

    const clientOrderId = submitIntentRef.current.get(JSON.stringify({
      data,
      activeCredentialId,
      signalId,
      copySourceItemId: orderCopySourceItemId,
    }));

    try {
      if (useExitPlan) {
        // Smart Exit: one entry order for the full position, carrying a
        // take-profit + trailing-stop plan the worker attaches on fill.
        const fixedTps = (data.takeProfits || [])
          .map((tp) => ({
            price: parseFloat(tp.price),
            qty: parseInt(tp.quantity) || 0,
          }))
          .filter((tp) => tp.price > 0 && tp.qty > 0)
          .map((tp) => ({
            price: tp.price,
            qtyFraction: Math.min(1, tp.qty / totalQty),
          }));

        const usesLimitEntry = data.entryOrderType === "Limit";
        const result = await submitWithExitPlanMutation.mutateAsync({
          symbol: data.symbol,
          side: getActionSide(data.action),
          direction: data.direction,
          quantity: totalQty,
          orderType: usesLimitEntry ? "limit" : "market",
          limitPrice: usesLimitEntry
            ? data.entryPriceRef
              ? parseFloat(data.entryPriceRef)
              : data.limitPrice
                ? parseFloat(data.limitPrice)
                : undefined
            : undefined,
          timeInForce: data.timeInForce as "day" | "gtc",
          maxRisk: data.maxRisk ? parseFloat(data.maxRisk) : undefined,
          stopMarketPrice: data.stopMarketPrice
            ? parseFloat(data.stopMarketPrice)
            : undefined,
          takeProfits: fixedTps,
          // Only send a trailing runner when it's actually configured.
          // Stop-only submissions leave this undefined so the server routes
          // through the OTO stop_loss path (no post-fill worker attach).
          trailingStop,
          notes: data.notes || undefined,
          signalId: signalId || undefined,
          credentialId: activeCredentialId,
          idempotencyKey: clientOrderId,
          ...(orderCopySourceItemId
            ? { copySourceItemId: orderCopySourceItemId }
            : {}),
        });
        if (!result.success) {
          throw new Error(result.message);
        }
        submitIntentRef.current.complete(clientOrderId);
        if (manualCopyNonce != null) {
          onManualCopyPrefillCompleted?.(manualCopyNonce);
        }
        const hasTrailing = trailingStop != null;
        const planMsg = hasTrailing
          ? `Order submitted for ${data.symbol}. Exit plan (${
              fixedTps.length ? "0.4R take-profit + " : ""
            }trailing stop) attaches once it fills.`
          : fixedTps.length
            ? `Order submitted for ${data.symbol}. Take-profit + broker stop attach once it fills.`
            : `Order submitted for ${data.symbol}. Broker stop attached (fires when entry fills).`;
        setSubmitResult({ type: "success", message: planMsg });
        toast.success(planMsg);
      } else if (
        data.orderType === "OCO" &&
        data.takeProfits &&
        data.takeProfits.length > 0
      ) {
        // Loop and submit brackets (fixed TP + fixed stop, no trailing runner)
        let successCount = 0;
        for (const [index, tp] of data.takeProfits.entries()) {
          const result = await submitBracketMutation.mutateAsync({
            symbol: data.symbol,
            assetType: data.assetType,
            side: getActionSide(data.action),
            quantity: parseInt(tp.quantity),
            orderType: data.entryOrderType === "Limit" ? "limit" : "market",
            limitPrice:
              data.entryOrderType === "Limit"
                ? data.entryPriceRef
                  ? parseFloat(data.entryPriceRef)
                  : data.limitPrice
                    ? parseFloat(data.limitPrice)
                    : undefined
                : undefined,
            takeProfitPrice: parseFloat(tp.price),
            stopLossPrice: parseFloat(data.stopMarketPrice!),
            timeInForce: data.timeInForce as "day" | "gtc",
            optionExpiration,
            optionStrike:
              data.assetType === "OPTION"
                ? parseFloat(data.optionsStrike!)
                : undefined,
            optionType: optionTypeOut,
            credentialId: activeCredentialId,
            idempotencyKey: deriveOrderClientId(clientOrderId, `br${index}`),
            ...(orderCopySourceItemId
              ? { copySourceItemId: orderCopySourceItemId }
              : {}),
          });
          if (!result.success) {
            throw new Error(result.message);
          }
          successCount++;
        }
        submitIntentRef.current.complete(clientOrderId);
        if (manualCopyNonce != null) {
          onManualCopyPrefillCompleted?.(manualCopyNonce);
        }
        const bracketMessage = `Successfully submitted ${successCount} bracket order(s) for OCO.`;
        setSubmitResult({ type: "success", message: bracketMessage });
        toast.success(bracketMessage);
      } else {
        if (manualCopyNonce != null) {
          manualCopySubmissionNoncesRef.current.set(clientOrderId, manualCopyNonce);
        }
        submitOrderMutation.mutate({
          symbol: data.symbol.toUpperCase(),
          assetType: data.assetType,
          orderType: data.orderType === "OCO" ? "Market" : data.orderType, // Fallback if OCO chosen without TPs
          timeInForce: data.timeInForce,
          tradeAction: data.action,
          direction: data.direction,
          quantity: data.forceThreeContracts ? 3 : parseInt(data.quantity) || 1,
          maxRisk: data.maxRisk ? parseFloat(data.maxRisk) : undefined,
          limitPrice: data.limitPrice ? parseFloat(data.limitPrice) : undefined,
          stopPrice:
            data.orderType === "StopMarket" || data.orderType === "StopLimit"
              ? parseFloat(data.priceTrigger || "0") || undefined
              : undefined,
          stopMarketPrice: data.stopMarketPrice
            ? parseFloat(data.stopMarketPrice)
            : undefined,
          priceTrigger: currentPrice || undefined,
          optionExpiration,
          optionStrike:
            data.assetType === "OPTION"
              ? parseFloat(data.optionsStrike!) || undefined
              : undefined,
          optionType: optionTypeOut,
          skipPresetTp: data.skipPresetTp,
          forceThreeContracts: data.forceThreeContracts,
          notes: data.notes || undefined,
          signalId: signalId || undefined,
          credentialId: activeCredentialId,
          idempotencyKey: clientOrderId,
          ...(orderCopySourceItemId
            ? { copySourceItemId: orderCopySourceItemId }
            : {}),
        });
      }
    } catch (err: any) {
      setSubmitResult({ type: "error", message: err.message });
      toast.error(err.message);
    }
  };

  const onSubmit = (data: TradeFormData) => {
    setSubmitResult(null);
    // Block a wrong-side exit-plan stop before opening review or placing the
    // order (e.g. a long's stop set above the current price). The inline
    // warning under the Stop Loss field already explains the fix.
    if (stopDirectionError) {
      setSubmitResult({ type: "error", message: stopDirectionError });
      return;
    }
    openOrderReview(data);
  };

  const onInvalid = (validationErrors: FieldErrors<TradeFormData>) => {
    const hasExitPlanError = Boolean(
      validationErrors.maxRisk ||
        validationErrors.stopMarketPrice ||
        validationErrors.takeProfits,
    );

    if (hasExitPlanError) {
      setSubmitResult({
        type: "error",
        message: "Review the highlighted stop, target, or risk fields.",
      });
      return;
    }

    setSubmitResult({
      type: "error",
      message: "Review the highlighted order fields before continuing.",
    });
  };

  const isSubmittingForm =
    isSubmitting ||
    submitOrderMutation.isPending ||
    submitBracketMutation.isPending ||
    submitWithExitPlanMutation.isPending;

  const isOptions = assetType === "OPTION";
  const actionSide = getActionSide(action);
  const isShortIntent = direction === "short";
  const isSellAction = actionSide === "sell";
  const submitToneClass = isSellAction
    ? TICKET_CTA_NEGATIVE
    : TICKET_CTA_POSITIVE;
  const limitSellRequiresGtc = isLimitSellOrder({
    assetType,
    orderType,
    action,
  });
  // Alpaca accepts GTC only on option LIMIT orders. Market/stop options are
  // DAY-only and expire at market close, so GTC must be disabled for them.
  const optionsDayOnly = isOptions && orderType !== "Limit";
  const currentQuote = isOptions ? optionQuote : stockQuote;
  const isLoadingQuote =
    !!normalizedSymbol &&
    (!quoteMatchesInput ||
      (isOptions ? optionQuoteQuery.isLoading : quoteQuery.isLoading));
  const quoteError = isOptions ? optionQuoteQuery.error : quoteQuery.error;
  const hasQuoteError = quoteMatchesInput && !!quoteError;
  const equityIntent: Extract<TradeAction, "Buy" | "Sell"> =
    action === "Sell" ? "Sell" : "Buy";
  const optionIntent: "long" | "short" =
    direction === "short" ? "short" : "long";
  const handleOptionIntentChange = (nextIntent: "long" | "short") => {
    handleActionChange(nextIntent === "short" ? "SellToOpen" : "BuyToOpen");
  };
  const estimatedNotional = computeEstimatedNotional({
    quantity: quantityWatched,
    isOptions,
    entryOrderType,
    orderType,
    watchEntry,
    limitPrice,
    currentQuoteLast: currentQuote?.last,
  });
  // When the order is in OCO mode the submit attaches a broker stop loss
  // (and, when the trailing runner is enabled, a trailing stop on a slice of
  // the position). The button label calls that out so the user isn't
  // surprised when a trailing-stop order shows up post-fill - particularly on
  // mobile, where the exit plan isn't visible from the collapsed position card.
  const hasAutoExit = orderType === "OCO";
  const autoExitSuffix = hasAutoExit ? " + auto-exit" : "";
  const primaryActionLabel =
    actionSide === "sell"
      ? isOptions
        ? "Review short option"
        : `Review sell${autoExitSuffix}`
      : isOptions
        ? "Review long option"
        : `Review buy${autoExitSuffix}`;
  // Plan A3: the same blockers `getSubmitBlocker` enforces, said BEFORE the tap.
  // A confirmed missing broker is a navigation action, not an attempted order;
  // every other state remains a real submit and keeps the existing validation,
  // review, and server-side safety gates.
  const ctaLabel = equityCtaLabel({
    isSignedIn: !!session?.user,
    credentialsKnown: !credentialsQuery.isLoading && !!credentialsQuery.data,
    hasCredentials: !!credentialsQuery.data?.hasCredentials,
    hasActiveAccount: !!activeCredentialId,
    isSubmitting: isSubmittingForm,
    actionLabel: primaryActionLabel,
  });
  const brokerConnectionRequired =
    !!session?.user &&
    !credentialsQuery.isLoading &&
    credentialsQuery.data?.hasCredentials === false;
  // Plan A2: two numbers the ticket already had in scope and threw away.
  // nonMarginableBuyingPower, NOT buyingPower: the latter is margin-inflated
  // (positions.ts documents it as misleading to surface), and page.tsx already
  // follows that rule in the terminal header.
  const buyingPowerLabel = formatUsd(
    accountQuery.data?.nonMarginableBuyingPower ?? null,
  );
  const positionLabel = equityPositionSummary(heldEquityPosition, {
    settled: heldEquityPositionKnown,
  });
  const railQuantityPresets = isOptions ? ["1", "2", "5", "10"] : ["1", "5", "10", "25"];
  // Qty that risks exactly maxRisk dollars if stopped — used by the "Risk 1%" button.
  // Requires the stop field to have a real value so the button always agrees with
  // the form (using the LOD fallback caused the button to size against a different
  // stop than the form had, producing misleading risk numbers).
  const riskSizedQty = (() => {
    const riskEntry = resolveLimitAwareBasis({
      entryOrderType,
      watchEntry,
      limitPrice,
      sizingPrice,
    });
    const stop = parseFloat(stopMarketPrice || "0");
    const risk = parseFloat(maxRisk || "0");
    if (!riskEntry || !stop || !risk) return null;
    const trailingIsEnabled = watch("trailingEnabled");
    const trailPct = parseFloat(watch("trailingPercent") || "0");
    if (orderType === "OCO" && trailingIsEnabled && trailPct > 0) {
      return sizeByExitPlanRisk({
        maxRisk: risk,
        entry: riskEntry,
        stop,
        direction,
        tpFraction: resolveTpFraction({
          tpActive: !watch("skipPresetTp"),
          trailingActive: true,
        }),
        trailingPercent: trailPct,
      });
    }
    return sizeByRisk({ maxRisk: risk, entry: riskEntry, stop, direction });
  })();
  const showEntryPriceField =
    (orderType === "OCO" && entryOrderType === "Limit") ||
    orderType === "Limit" ||
    orderType === "StopLimit";
  const entryPriceFieldName = orderType === "OCO" ? "entryPriceRef" : "limitPrice";
  const entryPriceError =
    orderType === "OCO" ? errors.entryPriceRef : errors.limitPrice;
  // Greeks/IV are optional additive keys on the option-quote payload. Read them
  // through a loose view so the readout compiles regardless of whether the
  // backend exposes them yet, and renders only when present.
  const optionGreeks = (optionQuote ?? null) as
    | (Record<string, unknown> & {
        delta?: number | null;
        gamma?: number | null;
        theta?: number | null;
        vega?: number | null;
        rho?: number | null;
        impliedVolatility?: number | null;
      })
    | null;

  const formContent = (
    <>
      {/* Missing credentials. The submit button now carries the same state
          ("Connect Broker to Trade", see equityCtaLabel), so this shrinks from
          a 48-line instruction card to one line naming where to go. */}
      {!credentialsQuery.isLoading &&
        credentialsQuery.data &&
        !credentialsQuery.data.hasCredentials &&
        session?.user && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <Key className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              No broker connected.{" "}
              <a
                href="/settings"
                className="font-medium underline underline-offset-2 hover:text-red-400"
              >
                Add your Alpaca API keys
              </a>
            </span>
          </div>
        )}

        <form
          onSubmit={handleSubmit(onSubmit, onInvalid)}
          className={cn(
            "terminal-trade-ticket relative flex min-h-0 flex-1 flex-col overflow-hidden",
            isSellAction
              ? "border-red-500/20 bg-red-500/[0.025]"
              : "border-green-500/20 bg-green-500/[0.025]",
          )}
        >
          <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3 xl:no-scrollbar touch-pan-y overscroll-contain [-webkit-overflow-scrolling:touch]">
            <div className="mb-3 rounded-md bg-muted/35 p-1">
              {isOptions ? (
                <BinaryToggle<"long" | "short">
                  ariaLabel="Option intent"
                  value={optionIntent}
                  onChange={handleOptionIntentChange}
                  options={[
                    { value: "long", label: "Long", tone: "positive" },
                    { value: "short", label: "Short", tone: "negative" },
                  ]}
                />
              ) : (
                <BinaryToggle<Extract<TradeAction, "Buy" | "Sell">>
                  ariaLabel="Equity side"
                  value={equityIntent}
                  onChange={handleActionChange}
                  options={[
                    { value: "Buy", label: "Buy", tone: "positive" },
                    {
                      value: "Sell",
                      label: "Sell",
                      tone: "negative",
                      disabled: !canSellLongEquity,
                      title: canSellLongEquity
                        ? undefined
                        : "Requires an available long equity position",
                    },
                  ]}
                />
              )}
            </div>

            {/* Plan A2. The position cell is EQUITY-only on purpose: an option
                ticket's underlying share position is not the contract position,
                and labelling it "Position" there would be a lie. */}
            {activeCredentialId && (
              <TicketContextRow
                className="mb-3"
                cells={
                  isOptions
                    ? [
                        {
                          label: "Buying power",
                          value: buyingPowerLabel,
                          title:
                            "Non-marginable buying power: the cash Alpaca will actually use for this order.",
                        },
                      ]
                    : [
                        {
                          label: "Buying power",
                          value: buyingPowerLabel,
                          title:
                            "Non-marginable buying power: the cash Alpaca will actually use for this order.",
                        },
                        {
                          label: normalizedSymbol
                            ? `${normalizedSymbol} position`
                            : "Position",
                          value: positionLabel,
                          title: "Shares currently held on this account.",
                        },
                      ]
                }
              />
            )}

            <section className="mb-3 border-b border-border/60 px-3 pb-3">
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-3xs uppercase tracking-wide text-muted-foreground">
                    Asset
                  </Label>
                  <Controller
                    name="assetType"
                    control={control}
                    render={({ field }) => (
                      <BinaryToggle
                        ariaLabel="Asset type"
                        value={field.value || "EQUITY"}
                        onChange={(val) => handleAssetTypeChange(val)}
                        options={[
                          // Neutral on purpose: green/red fills are reserved for
                          // choices that carry direction (Buy/Sell, Long/Short,
                          // Call/Put). An asset or entry type is not a direction,
                          // and a green Stock chip dilutes what green means one
                          // block above it.
                          { value: "EQUITY", label: "Stock", tone: "neutral" },
                          { value: "OPTION", label: "Option", tone: "neutral" },
                        ]}
                      />
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-3xs uppercase tracking-wide text-muted-foreground">
                    Entry
                  </Label>
                  <BinaryToggle<EntryOrderType>
                    ariaLabel="Entry price type"
                    value={entryOrderType || "Market"}
                    onChange={handleEntryOrderTypeChange}
                    options={[
                      { value: "Market", label: "Mkt", tone: "neutral" },
                      { value: "Limit", label: "Limit", tone: "neutral" },
                    ]}
                  />
                </div>
              </div>

              {showEntryPriceField && (
                <div className="mb-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label
                      htmlFor={entryPriceFieldName}
                      className="text-3xs uppercase tracking-wide text-muted-foreground"
                    >
                      Entry price
                    </Label>
                    {currentQuote?.last && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-5 font-data"
                        onClick={() =>
                          setValue(entryPriceFieldName, currentQuote.last.toString(), {
                            shouldValidate: true,
                          })
                        }
                      >
                        Use last ${currentQuote.last}
                      </Button>
                    )}
                  </div>
                  <Controller
                    name={entryPriceFieldName}
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        id={entryPriceFieldName}
                        type="number"
                        step="0.01"
                        aria-invalid={entryPriceError ? "true" : "false"}
                        className={`h-10 font-data ${TICKET_INPUT_TEXT_XS}`}
                      />
                    )}
                  />
                  {entryPriceError && (
                    <p className="text-xs text-destructive">
                      {entryPriceError.message}
                    </p>
                  )}
                </div>
              )}

              {(orderType === "StopMarket" || orderType === "StopLimit") && (
                <div className="mb-3 space-y-1.5">
                  <Label
                    htmlFor="priceTrigger"
                    className="text-3xs uppercase tracking-wide text-muted-foreground"
                  >
                    Stop trigger
                  </Label>
                  <Controller
                    name="priceTrigger"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        id="priceTrigger"
                        type="number"
                        step="0.01"
                        aria-invalid={errors.priceTrigger ? "true" : "false"}
                        className={`h-10 font-data ${TICKET_INPUT_TEXT_XS}`}
                      />
                    )}
                  />
                  {errors.priceTrigger && (
                    <p className="text-xs text-destructive">
                      {errors.priceTrigger.message}
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-3xs uppercase tracking-wide text-muted-foreground">
                  TIF
                </Label>
                <Controller
                  name="timeInForce"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value || "gtc"} onValueChange={field.onChange}>
                      <SelectTrigger className="h-9 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gtc" disabled={optionsDayOnly}>
                          GTC
                        </SelectItem>
                        <SelectItem value="day" disabled={limitSellRequiresGtc}>
                          Day
                        </SelectItem>
                        <SelectItem
                          value="ioc"
                          disabled={isOptions || limitSellRequiresGtc}
                        >
                          IOC
                        </SelectItem>
                        <SelectItem
                          value="fok"
                          disabled={isOptions || limitSellRequiresGtc}
                        >
                          FOK
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {isOptions && (
                  <p className="text-3xs leading-tight text-muted-foreground">
                    {optionsDayOnly
                      ? "Options: market orders are Day only and expire at market close. Use a limit order for GTC."
                      : "Options support GTC only on limit orders. Limit sells rest as GTC until filled or cancelled."}
                  </p>
                )}
              </div>
            </section>

            <section className="mb-3 border-b border-border/60 px-3 pb-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Amount
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {isOptions ? "Contracts" : "Shares"} for {symbol || "ticker"}
                  </span>
                </div>
                {estimatedNotional != null && (
                  <Badge variant="outline" className="shrink-0 font-data">
                    ≈ {formatUsd(estimatedNotional)}
                  </Badge>
                )}
              </div>
              <Controller
                name="quantity"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    onChange={(e) => {
                      userEditedQtyRef.current = true;
                      field.onChange(e);
                    }}
                    id="quantity"
                    type="number"
                    min="1"
                    disabled={forceThreeContracts}
                    aria-invalid={errors.quantity ? "true" : "false"}
                    className="h-14 rounded-lg border-border/80 bg-background/70 px-3 font-data text-3xl font-semibold tabular-nums"
                  />
                )}
              />
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {railQuantityPresets.map((qty) => (
                  <Button
                    key={qty}
                    type="button"
                    variant={quantityWatched === qty ? "default" : "outline"}
                    size="sm"
                    className="h-8 font-data"
                    onClick={() => {
                      userEditedQtyRef.current = true;
                      setValue("quantity", qty, { shouldValidate: true });
                    }}
                  >
                    {qty}
                  </Button>
                ))}
                {/* Risk-sized preset depends on the attached plan's stop, so
                    never show it for a plain order. */}
                {riskSizedQty != null &&
                  riskSizedQty > 0 &&
                  !isOptions &&
                  orderType === "OCO" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    title={`Buy ${riskSizedQty} shares — risk $${maxRisk} (${RISK_BUDGET_LABEL} of portfolio) if stopped`}
                    className="h-8 font-data col-span-4 border-dashed border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
                    onClick={() => {
                      userEditedQtyRef.current = false;
                      setValue("quantity", String(riskSizedQty), { shouldValidate: true });
                    }}
                  >
                    Risk {RISK_BUDGET_LABEL} → {riskSizedQty} shares
                  </Button>
                )}
              </div>
              {errors.quantity && (
                <p className="mt-2 text-xs text-destructive">
                  {errors.quantity.message}
                </p>
              )}
              {currentRisk != null ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Risk ≈{" "}
                  <span className="font-data font-semibold text-foreground">
                    {formatUsd(currentRisk)}
                  </span>{" "}
                  {riskReadoutSuffix(hasActiveTrailingRunner)}
                  .
                </p>
              ) : sizingHint ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {sizingHint}
                </p>
              ) : null}
            </section>

            {isOptions && (
              <section className="mb-3 rounded-md border border-border/60 bg-card/25 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-3xs uppercase tracking-wide text-muted-foreground">
                    Option contract
                  </Label>
                  {contractsQuery.isFetching && (
                    <span className="text-3xs text-muted-foreground">
                      Loading…
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <Controller
                    name="optionType"
                    control={control}
                    render={({ field }) => (
                      <BinaryToggle
                        ariaLabel="Call or Put"
                        value={field.value || optionTypeWatched}
                        onChange={(val) => {
                          field.onChange(val);
                          setValue("optionsStrike", "", {
                            shouldValidate: false,
                          });
                        }}
                        options={[
                          { value: "call", label: "Call", tone: "positive" },
                          { value: "put", label: "Put", tone: "negative" },
                        ]}
                      />
                    )}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={
                        expirations.includes(selectedExpirationYYYYMMDD)
                          ? selectedExpirationYYYYMMDD
                          : ""
                      }
                      onValueChange={handleExpirationChange}
                      disabled={
                        contractsQuery.isLoading || expirations.length === 0
                      }
                    >
                      <SelectTrigger className="h-9 w-full">
                        <SelectValue placeholder="Expiration" />
                      </SelectTrigger>
                      <SelectContent>
                        {expirations.map((exp) => (
                          <SelectItem key={exp} value={exp}>
                            {exp}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Controller
                      name="optionsStrike"
                      control={control}
                      render={({ field }) => (
                        <Select
                          value={field.value || ""}
                          onValueChange={(val) =>
                            setValue("optionsStrike", val, {
                              shouldValidate: true,
                            })
                          }
                          disabled={
                            !selectedExpirationYYYYMMDD || strikes.length === 0
                          }
                        >
                          <SelectTrigger
                            className="h-9 w-full"
                            aria-invalid={errors.optionsStrike ? "true" : "false"}
                          >
                            <SelectValue placeholder="Strike" />
                          </SelectTrigger>
                          <SelectContent>
                            {strikes.map((strike) => (
                              <SelectItem key={strike} value={String(strike)}>
                                {strike}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  {errors.optionsStrike && (
                    <p className="text-xs text-destructive">
                      {errors.optionsStrike.message}
                    </p>
                  )}
                  {/* Live option price data: last trade, bid/ask spread, volume, OI.
                      Only shown once the user has selected both expiration and strike. */}
                  {optionQuote && (
                    <div className="mt-2 space-y-0.5 rounded bg-muted/40 px-2 py-1.5 font-data text-3xs text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span>Last</span>
                        <span className="font-semibold text-foreground">${optionQuote.last}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Bid / Ask</span>
                        <span className="text-foreground">${optionQuote.bid} / ${optionQuote.ask}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Vol / OI</span>
                        <span className="text-foreground">
                          {Number(optionQuote.volume).toLocaleString()} / {optionQuote.openInterest.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                  {optionQuoteQuery.isFetching && !optionQuote && (
                    <p className="mt-1 text-3xs text-muted-foreground">Loading quote…</p>
                  )}
                </div>
              </section>
            )}

            <section
              className={cn(
                "mb-3 border-border/60 bg-card/25",
                orderType === "OCO"
                  ? "rounded-md border p-3"
                  : "border-y px-0 py-2.5",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Stop loss &amp; targets
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {stopLossSectionCaption(orderType, isOptions)}
                  </div>
                </div>
                {/* Header-level Attach-exit-plan toggle. OFF flips the order
                    type back to Market so the user can place a naked buy
                    without hunting through the order-type dropdown; ON restores
                    OCO with the current stop/TP/trailing sub-body. Hidden for
                    options (Alpaca rejects OCO/trailing on options anyway, so
                    the auto-exit plan is equity-only). */}
                {!isOptions && (
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-semibold">
                    <span className="text-muted-foreground">Attach exit plan</span>
                    <input
                      type="checkbox"
                      checked={orderType === "OCO"}
                      onChange={(e) => {
                        // Preserve the user's Entry choice on toggle-off.
                        // Hard-coding Market here silently downgrades Limit
                        // tickets while the Entry control still reads Limit.
                        setValue(
                          "orderType",
                          e.target.checked
                            ? "OCO"
                            : plainOrderTypeForEntry(entryOrderType),
                          { shouldValidate: true },
                        );
                        persistAttachPreference(e.target.checked);
                      }}
                      aria-label="Attach exit plan (broker-managed stop)"
                      className="h-4 w-4 shrink-0 rounded border-border"
                    />
                  </label>
                )}
              </div>

              <div className="terminal-pane-enter">

              {/* Max risk only applies to an attached exit plan. */}
              {orderType === "OCO" && (
                <div className="mt-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label
                    htmlFor="maxRisk"
                    className="text-3xs uppercase tracking-wide text-muted-foreground"
                  >
                    Max risk ($)
                  </Label>
                  <FieldHint label="Max $ Risk">
                    {`The dollars you'll lose if price hits your stop. Defaults to ${RISK_BUDGET_LABEL} of your portfolio.`}
                  </FieldHint>
                </div>
                <Controller
                  name="maxRisk"
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      onChange={(e) => {
                        userEditedRiskRef.current = true;
                        // Changing Max Risk is a deliberate signal to
                        // resize shares. Re-enable the auto-sizer so it
                        // can compute the new risk-adjusted qty.
                        userEditedQtyRef.current = false;
                        field.onChange(e);
                      }}
                      id="maxRisk"
                      type="number"
                      min="1"
                      aria-invalid={errors.maxRisk ? "true" : "false"}
                      className={`h-9 font-data ${TICKET_INPUT_TEXT_XS}`}
                    />
                  )}
                />
                </div>
              )}

              {/* Stop-loss, TP, and trailing controls belong to an attached
                  exit plan. Plain orders do not show a non-broker stop that
                  could be mistaken for real protection. */}
              {orderType === "OCO" && !isOptions && (
                <div className="mt-3 space-y-2.5 rounded-md border border-border/70 bg-background/40 p-2.5">
                    <div className="space-y-1.5">
                      {/* Header row holds the label plus a single slot on
                          the right that flips between "quick-fill from
                          LOD/HOD" and "currently filled from LOD/HOD".
                          We compare the input value to today's bar so the
                          breadcrumb stays truthful no matter how the value
                          got there (no extra was-prefilled state needed). */}
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="stopMarketPrice" className="text-xs">
                          Stop loss
                        </Label>
                        {(() => {
                          const bar =
                            direction === "long" ? stockQuote?.low : stockQuote?.high;
                          if (!bar) return null;
                          const label = direction === "long" ? "LOD" : "HOD";
                          const stopNum = Number(stopMarketPrice);
                          const matchesBar =
                            !!stopMarketPrice &&
                            Number.isFinite(stopNum) &&
                            stopNum === Number(bar);
                          if (matchesBar) {
                            return (
                              <span className="text-3xs font-medium text-muted-foreground">
                                Filled from {label} (${bar})
                              </span>
                            );
                          }
                          return (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="h-5 font-data"
                              onClick={() => {
                                // Filling the stop from LOD/HOD is a new risk
                                // anchor, so let the auto-sizer recompute the
                                // share count even if a preset was tapped.
                                userEditedQtyRef.current = false;
                                setValue("stopMarketPrice", String(bar), {
                                  shouldValidate: true,
                                });
                              }}
                            >
                              {label} ${bar}
                            </Button>
                          );
                        })()}
                      </div>
                      <Controller
                        name="stopMarketPrice"
                        control={control}
                        render={({ field }) => (
                          <Input
                            {...field}
                            onChange={(e) => {
                              // Stop moves imply a new share size at the same
                              // risk budget. Re-enable the auto-sizer (mirrors
                              // the Max-Risk input's onChange) so the qty tracks
                              // the new stop instead of freezing at whatever the
                              // user last typed.
                              userEditedQtyRef.current = false;
                              field.onChange(e);
                            }}
                            id="stopMarketPrice"
                            type="number"
                            step="0.01"
                            aria-invalid={errors.stopMarketPrice ? "true" : "false"}
                            className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                          />
                        )}
                      />
                      {/* % distance from entry — instant feedback without math */}
                      {(() => {
                        const entry =
                          parseFloat(watchEntry || limitPrice || "0") ||
                          sizingPrice;
                        const stop = parseFloat(stopMarketPrice || "0");
                        if (!entry || !stop) return null;
                        const pct = ((stop - entry) / entry) * 100;
                        return (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-data font-semibold text-destructive/80">
                              {pct.toFixed(1)}%
                            </span>{" "}
                            from entry
                          </p>
                        );
                      })()}
                      {errors.stopMarketPrice && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-destructive">
                            {errors.stopMarketPrice.message}
                          </p>
                          {/* Fully stripped plan (no stop, no TPs, trailing
                              off): the user is asking for a plain order, so
                              offer the "Attach exit plan" toggle-off right
                              here instead of leaving them stuck in an error
                              state with no visible way out. */}
                          {orderType === "OCO" &&
                            !trailingEnabled &&
                            !stopMarketPrice &&
                            tpFields.length === 0 && (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                className="h-6 text-2xs"
                                onClick={() => {
                                  // Mirrors the header "Attach exit plan"
                                  // checkbox turning off: keep the user's
                                  // Entry choice (Market vs Limit).
                                  setValue(
                                    "orderType",
                                    plainOrderTypeForEntry(entryOrderType),
                                    { shouldValidate: true },
                                  );
                                }}
                              >
                                Continue without exit plan
                              </Button>
                            )}
                          {orderType === "OCO" &&
                            trailingEnabled &&
                            !!stopMarketPrice &&
                            tpFields.length === 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  className="h-6 text-2xs"
                                  onClick={() => {
                                    setValue("trailingEnabled", false, {
                                      shouldValidate: true,
                                    });
                                    // Explicit user opt-out: remember it for
                                    // the next ticket's auto plan.
                                    persistTrailingPreference({
                                      enabled: false,
                                    });
                                  }}
                                >
                                  Turn off trailing
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  className="h-6 text-2xs"
                                  onClick={() => {
                                    setValue("stopMarketPrice", "", {
                                      shouldValidate: true,
                                    });
                                    userEditedQtyRef.current = false;
                                  }}
                                >
                                  Remove fixed stop
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  className="h-6 text-2xs"
                                  onClick={() => {
                                    setShowTpSection(true);
                                    if (tpFields.length === 0) {
                                      appendTp({ price: "", quantity: "1" });
                                      persistAutoTpPreference(true);
                                    }
                                  }}
                                >
                                  Add take-profit
                                </Button>
                              </div>
                            )}
                        </div>
                      )}
                      {stopDirectionError && (
                        <p
                          role="alert"
                          className="flex items-center gap-1.5 text-xs text-destructive"
                        >
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          {stopDirectionError}
                        </p>
                      )}
                    </div>

                    {/* TP + trailing sub-cards are only meaningful when
                        "Attach exit plan" is on (orderType === "OCO"). In
                        plain-order mode the stop above is a sizing anchor
                        only, and the auto-exit legs don't apply. */}
                    {orderType === "OCO" && <>
                    {/* Sub-card: take-profit targets. Collapsed when the user
                        clicks Remove; re-opened via the link below. */}
                    {!showTpSection && (
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => setShowTpSection(true)}
                          className="text-2xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground self-start"
                        >
                          + Add take-profit targets
                        </button>
                        {errors.takeProfits && (
                          <p className="text-xs text-destructive">
                            {(errors.takeProfits as { message?: string })?.message ??
                              "Add a stop loss, a take-profit level, or enable the trailing runner."}
                          </p>
                        )}
                      </div>
                    )}
                    <div className={showTpSection ? "space-y-2 border-t border-border/60 pt-2.5" : "hidden"}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground">
                            Take profit
                          </Label>
                          <span className="text-3xs uppercase tracking-wide text-muted-foreground">
                            Optional
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            replaceTps([]);
                            persistAutoTpPreference(false);
                            setShowTpSection(false);
                            // Only clear the fixed stop when trailing is already
                            // enabled. Alpaca rejects: fixed stop + trailing + no
                            // TP. When trailing is off, the stop-loss is a valid
                            // standalone exit (OTO) and must be preserved.
                            const trailingOn = watch("trailingEnabled");
                            if (trailingOn) {
                              setValue("stopMarketPrice", "", {
                                shouldValidate: true,
                              });
                              userEditedQtyRef.current = false;
                              const currentQty = watch("quantity");
                              if (currentQty) {
                                setValue("trailingQty", currentQty, { shouldValidate: false });
                              }
                            }
                          }}
                          className="p-1.5 -m-1.5 text-2xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                        >
                          Remove
                        </button>
                      </div>

                      {/* R-multiple quick-add. Disabled with a tooltip when
                          we can't compute the level (no entry or no stop) so
                          users aren't left guessing why the pills don't work.
                          A pill lights up when an existing target sits at its
                          R-multiple, so the auto plan's seeded level (0.7R by
                          default) is visibly "selected" on open. */}
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="mr-0.5 text-3xs text-muted-foreground">
                          Quick add
                        </span>
                          {(() => {
                            // Same Limit/Market gate as calculateRPrice and the
                            // auto-sizer: Market chips must reflect the live
                            // sizingPrice, not the stale entryPriceRef anchor.
                            const chipEntry =
                              entryOrderType === "Limit"
                                ? parseFloat(watchEntry || limitPrice || "0") ||
                                  sizingPrice
                                : sizingPrice;
                            const chipStop = parseFloat(
                              stopMarketPrice || "0",
                            );
                            const riskPerShare =
                              chipEntry > 0 && chipStop > 0
                                ? Math.abs(chipEntry - chipStop)
                                : 0;
                            const activeR = (r: number) =>
                              riskPerShare > 0 &&
                              takeProfitsWatched.some((tp) => {
                                const price = parseFloat(tp.price || "0");
                                if (!price) return false;
                                const mult =
                                  direction === "short"
                                    ? (chipEntry - price) / riskPerShare
                                    : (price - chipEntry) / riskPerShare;
                                // Tolerance absorbs the 2-decimal rounding of
                                // the seeded target price.
                                return Math.abs(mult - r) < 0.05;
                              });
                            return [0.4, 0.7, 1, 2].map((r) => {
                              // Use parsed values so "0" / "0.00" also
                              // disables the chip. String-falsy alone misses
                              // those cases and lets calculateRPrice return
                              // null silently, making the chip look active but
                              // do nothing on click.
                              const disabled =
                                chipEntry <= 0 || chipStop <= 0;
                              const selected = !disabled && activeR(r);
                              return (
                                <Button
                                  key={r}
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  onClick={() => addRLevel(r)}
                                  disabled={disabled}
                                  aria-pressed={selected}
                                  className={
                                    selected
                                      ? "border-primary/60 bg-primary/15 font-semibold text-primary hover:bg-primary/20 hover:text-primary"
                                      : undefined
                                  }
                                  title={
                                    disabled
                                      ? "Set an entry price and stop loss to use R-multiple shortcuts."
                                      : undefined
                                  }
                                >
                                  +{r}R
                                </Button>
                              );
                            });
                          })()}
                      </div>

                      {tpFields.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_1.75rem] items-center gap-1.5 px-0.5 text-3xs text-muted-foreground">
                            <span>TP price</span>
                            <span>Shares</span>
                            <span aria-hidden="true" />
                          </div>
                          {tpFields.map((field, index) => {
                            // Compute R-multiple and % distance for the hint line.
                            const tpPrice = parseFloat(
                              watch(`takeProfits.${index}.price`) || "0",
                            );
                            const tpEntry =
                              parseFloat(watchEntry || limitPrice || "0") ||
                              sizingPrice;
                            const tpStop = parseFloat(stopMarketPrice || "0");
                            const tpHint = (() => {
                              if (!tpPrice || !tpEntry) return null;
                              const pct = ((tpPrice - tpEntry) / tpEntry) * 100;
                              const riskPerShare =
                                tpStop && tpEntry !== tpStop
                                  ? Math.abs(tpEntry - tpStop)
                                  : null;
                              // For shorts, profit is price going DOWN: (entry - tp) / risk
                              const rMult =
                                riskPerShare && riskPerShare > 0
                                  ? direction === "short"
                                    ? (tpEntry - tpPrice) / riskPerShare
                                    : (tpPrice - tpEntry) / riskPerShare
                                  : null;
                              const sign = pct >= 0 ? "+" : "";
                              return rMult != null
                                ? `+${rMult.toFixed(2)}R · ${sign}${pct.toFixed(1)}% from entry`
                                : `${sign}${pct.toFixed(1)}% from entry`;
                            })();
                            return (
                              <div key={field.id} className="space-y-0.5">
                                <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_1.75rem] items-center gap-1.5">
                                  <Controller
                                    name={`takeProfits.${index}.price`}
                                    control={control}
                                    render={({ field }) => (
                                      <Input
                                        {...field}
                                        type="number"
                                        step="0.01"
                                        placeholder={`TP ${index + 1} price`}
                                        aria-label={`Take-profit ${index + 1} price`}
                                        className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                                      />
                                    )}
                                  />
                                  <Controller
                                    name={`takeProfits.${index}.quantity`}
                                    control={control}
                                    render={({ field }) => (
                                      <Input
                                        {...field}
                                        type="number"
                                        placeholder="Qty"
                                        aria-label={`Take-profit ${index + 1} shares`}
                                        className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                                      />
                                    )}
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => {
                                      removeTp(index);
                                      if (tpFields.length <= 1) {
                                        persistAutoTpPreference(false);
                                        // Only clear the fixed stop when trailing
                                        // is on (Alpaca rejects trailing + fixed
                                        // stop + no TP). With trailing off, the
                                        // stop-loss is a valid standalone exit and
                                        // must be preserved.
                                        if (watch("trailingEnabled")) {
                                          setValue("stopMarketPrice", "", {
                                            shouldValidate: true,
                                          });
                                          userEditedQtyRef.current = false;
                                        }
                                      }
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label={`Remove take-profit ${index + 1}`}
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>
                                {tpHint && (
                                  <p className="text-2xs text-muted-foreground pl-0.5">
                                    <span className="font-data font-semibold text-green-500">
                                      {tpHint}
                                    </span>
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          appendTp({ price: "", quantity: "1" });
                          // Adding a TP back after previously opting out flips the
                          // pref back on so subsequent trades resume auto-attach.
                          persistAutoTpPreference(true);
                        }}
                        className="h-7 w-full border-dashed text-2xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add custom target
                      </Button>

                      {errors.takeProfits && (
                        <p className="text-xs text-destructive">
                          {(errors.takeProfits as { message?: string })?.message ??
                            "Add a stop loss, a take-profit level, or enable the trailing runner."}
                        </p>
                      )}
                    </div>

                    {/* Sub-card: trailing runner. The header doubles as the
                        toggle (label + switch). When off the body collapses
                        so the card stays compact; when on the percent / qty
                        inputs slide in underneath. */}
                    <div className="border-t border-border/60 pt-2.5">
                      <Controller
                        name="trailingEnabled"
                        control={control}
                        render={({ field }) => (
                          <label className="flex cursor-pointer items-center justify-between gap-2">
                            <span className="flex items-center gap-1 text-left">
                              <span className="text-xs font-semibold text-muted-foreground">
                                Trailing stop runner
                              </span>
                              <FieldHint label="Trailing stop runner">
                                Lets a portion of the position keep running
                                with a trailing stop after fixed targets fill.
                              </FieldHint>
                            </span>
                            <input
                              type="checkbox"
                              checked={field.value}
                              onChange={(e) => {
                                field.onChange(e.target.checked);
                                // Explicit user toggle: remember it so the
                                // next ticket's auto plan seeds the same
                                // trailing on/off state.
                                persistTrailingPreference({
                                  enabled: e.target.checked,
                                });
                                // If the user disables trailing with no TPs and
                                // the TP section is collapsed, reopen it so they
                                // see the validation error and can add a target.
                                if (
                                  !e.target.checked &&
                                  !showTpSection &&
                                  takeProfitsWatched.length === 0
                                ) {
                                  setShowTpSection(true);
                                }
                              }}
                              aria-label="Enable trailing stop runner"
                              className="h-4 w-4 shrink-0 rounded border-border"
                            />
                          </label>
                        )}
                      />
                      {trailingEnabled && (
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
                          <div className="space-y-1">
                            <Label
                              htmlFor="trailingPercent"
                              className="text-3xs uppercase tracking-wide text-muted-foreground"
                            >
                              Trail %
                            </Label>
                            <Controller
                              name="trailingPercent"
                              control={control}
                              render={({ field }) => (
                                <Input
                                  {...field}
                                  onChange={(e) => {
                                    field.onChange(e);
                                    // Persist only fully valid percents so a
                                    // half-typed value can't erase the saved
                                    // preference.
                                    const pct = Number(e.target.value);
                                    if (Number.isFinite(pct) && pct > 0) {
                                      persistTrailingPreference({
                                        percent: e.target.value,
                                      });
                                    }
                                  }}
                                  id="trailingPercent"
                                  type="number"
                                  step="0.1"
                                  placeholder="e.g. 5"
                                  className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                                />
                              )}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label
                              htmlFor="trailingQty"
                              className="text-3xs uppercase tracking-wide text-muted-foreground"
                            >
                              Runner shares
                            </Label>
                            <Controller
                              name="trailingQty"
                              control={control}
                              render={({ field }) => (
                                <Input
                                  {...field}
                                  id="trailingQty"
                                  type="number"
                                  placeholder="Qty"
                                  className={`h-8 bg-background px-2 font-data tabular-nums ${TICKET_INPUT_TEXT_XS}`}
                                />
                              )}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    </>}
                  </div>
              )}
                </div>
            </section>

            {/* Slim "Add note" affordance - the previous "Advanced order
                settings" drawer duplicated the Buy/Sell and Market/Limit
                toggles already shown at the top of the form, so it's been
                removed. The one piece of unique value (the trade-notes
                textarea) lives here as a one-line expandable link. */}
            {(() => {
              const notesValue = (notesWatched ?? "").trim();
              const expanded = railShowNotes || notesValue.length > 0;
              if (!expanded) {
                return (
                  <button
                    type="button"
                    onClick={() => setRailShowNotes(true)}
                    className="flex w-full items-center gap-1.5 rounded-xl border border-dashed bg-card/40 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add note
                  </button>
                );
              }
              return (
                <div className="premium-panel rounded-xl border bg-card/50 px-3 py-2">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <Label htmlFor="notes" className="text-xs font-semibold">
                      Note
                    </Label>
                    <button
                      type="button"
                      onClick={() => {
                        setRailShowNotes(false);
                        setValue("notes", "", { shouldValidate: false });
                      }}
                      className="text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline p-2 -m-2"
                    >
                      Remove
                    </button>
                  </div>
                  <Controller
                    name="notes"
                    control={control}
                    render={({ field }) => (
                      <Textarea
                        {...field}
                        id="notes"
                        placeholder="Why this trade? (optional)"
                        rows={2}
                        className={TICKET_INPUT_TEXT_XS}
                      />
                    )}
                  />
                </div>
              );
            })()}
          </div>

          <div className="terminal-trade-footer relative shrink-0 border-t bg-background/95 p-3">
            {submitResult?.type === "error" && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">
                <AlertCircle className="h-4 w-4" />
                {submitResult.message}
              </div>
            )}
            <div className="mb-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <span className="font-data">
                {orderType === "OCO" ? "Auto-exit" : orderType} ·{" "}
                {timeInForce.toUpperCase()}
              </span>
            </div>
            {brokerConnectionRequired ? (
              <Button
                asChild
                size="lg"
                className={cn(
                  "terminal-trade-submit h-11 w-full rounded-lg text-sm font-bold",
                  submitToneClass,
                )}
              >
                <a href="/settings">{ctaLabel}</a>
              </Button>
            ) : (
              <Button
                type="submit"
                size="lg"
                className={cn(
                  "terminal-trade-submit h-11 w-full rounded-lg text-sm font-bold",
                  submitToneClass,
                )}
                disabled={isSubmittingForm}
              >
                {ctaLabel}
              </Button>
            )}
          </div>
        </form>

      <ReviewOrderDialog
        order={pendingReviewOrder}
        metrics={reviewMetrics}
        isSubmitting={isSubmittingForm}
        submitToneClass={submitToneClass}
        fallbackOptionType={optionTypeWatched}
        accountType={activeAccountType}
        accountLabel={activeAccountLabel}
        onOpenChange={(open) => {
          if (!open) {
            const pendingManualCopyNonce = pendingManualCopyNonceRef.current;
            if (pendingReviewOrder && !isSubmittingForm) {
              if (pendingManualCopyNonce != null) {
                onManualCopyPrefillCancelled?.(pendingManualCopyNonce);
              }
            }
            pendingManualCopyNonceRef.current = null;
            pendingManualCopySourceRef.current = null;
            setPendingReviewOrder(null);
          }
        }}
        onConfirm={(order) => {
          const manualCopyNonce = pendingManualCopyNonceRef.current;
          const manualCopySource = pendingManualCopySourceRef.current;
          pendingManualCopyNonceRef.current = null;
          pendingManualCopySourceRef.current = null;
          void executeSubmit(order, manualCopyNonce, manualCopySource);
        }}
      />
    </>
  );

  // Single layout for every surface (desktop rail + mobile sheet): the form
  // owns its own height, internal scroll, and sticky submit footer, so the
  // wrapper provides a definite flex column so the optional broker banner and
  // the form share the available height, while the host container handles its
  // own scrolling.
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 max-w-full flex-col touch-pan-y overflow-hidden border-t px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] overscroll-contain xl:no-scrollbar",
        isShortIntent
          ? "border-red-500/25 bg-[linear-gradient(180deg,rgba(239,68,68,0.09),transparent_30%)]"
          : "border-green-500/25 bg-[linear-gradient(180deg,rgba(34,197,94,0.08),transparent_30%)]",
      )}
    >
      {formContent}
    </div>
  );
}
