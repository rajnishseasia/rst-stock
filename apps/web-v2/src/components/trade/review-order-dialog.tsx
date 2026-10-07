"use client";

/**
 * The "Review order before submitting" confirmation dialog, extracted from
 * the trade-form god component (audit H7). Pure presentational component:
 * every number it shows is passed in, and confirming hands the reviewed
 * order back to the caller rather than submitting anything itself.
 */

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getActionSide, RISK_BUDGET_LABEL, type ReviewMetrics } from "./review-metrics";

export interface ReviewOrderDialogOrder {
  symbol: string;
  assetType: "EQUITY" | "OPTION";
  action:
    | "Buy"
    | "Sell"
    | "SellShort"
    | "BuyToCover"
    | "BuyToOpen"
    | "SellToClose"
    | "SellToOpen"
    | "BuyToClose";
  direction: "long" | "short";
  quantity: string;
  orderType: "Market" | "Limit" | "StopMarket" | "StopLimit" | "OCO";
  timeInForce: "day" | "gtc" | "ioc" | "fok";
  entryOrderType: "Market" | "Limit";
  entryPriceRef?: string;
  limitPrice?: string;
  priceTrigger?: string;
  stopMarketPrice?: string;
  optionsDateYear?: string;
  optionsDateMonth?: string;
  optionsDateDay?: string;
  optionsStrike?: string;
  optionType?: "call" | "put";
  takeProfits?: { quantity: string; price: string }[];
  trailingEnabled: boolean;
  trailingQty?: string;
  trailingPercent?: string;
  // Not read by this dialog, but required so the confirmed order handed back
  // through onConfirm still satisfies the full TradeFormData shape the
  // caller's submit path expects.
  skipPresetTp: boolean;
  forceThreeContracts: boolean;
}

/** Exported (not just for JSX use) so tests can identify these nodes in the
 *  element tree by reference and read their label/value props directly -
 *  the dialog's content sits behind a Radix Portal, which react-dom/server
 *  cannot render (see ui/alert-dialog.test.ts), so this is how the row
 *  bindings get verified without a browser DOM. */
export function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[65%] text-right font-data text-xs font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

export function ReviewOrderDialog({
  order,
  metrics,
  isSubmitting,
  submitToneClass,
  fallbackOptionType,
  accountType,
  accountLabel,
  onOpenChange,
  onConfirm,
}: {
  /** The order pending confirmation. Dialog is closed when null. */
  order: ReviewOrderDialogOrder | null;
  /** Dollar-impact figures for the reviewed order (see computeReviewMetrics). */
  metrics: ReviewMetrics | null;
  isSubmitting: boolean;
  submitToneClass: string;
  /** Option side to fall back to when the reviewed order predates the field. */
  fallbackOptionType: "call" | "put";
  /** Alpaca account selected when this order was reviewed. */
  accountType?: "PAPER" | "LIVE";
  accountLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (order: ReviewOrderDialogOrder) => void;
}) {
  return (
    <AlertDialog open={!!order} onOpenChange={onOpenChange}>
      <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-md">
        <AlertDialogHeader className="items-start text-left">
          <AlertDialogTitle className="text-base font-semibold">
            Review order before submitting
          </AlertDialogTitle>
        </AlertDialogHeader>

        {order && (
          <div className="space-y-3">
            <div className="rounded-lg border bg-card/70 px-3">
              <ReviewRow label="Symbol" value={order.symbol.toUpperCase()} />
              {accountType && (
                <ReviewRow
                  label="Account"
                  value={`Alpaca · ${accountType === "LIVE" ? "Live" : "Paper"}${accountLabel ? ` · ${accountLabel}` : ""}`}
                />
              )}
              <ReviewRow
                label="Asset"
                value={order.assetType === "OPTION" ? "Option" : "Equity"}
              />
              <ReviewRow label="Action" value={order.action} />
              <ReviewRow label="Direction" value={order.direction} />
              <ReviewRow label="Quantity" value={order.quantity} />
              <ReviewRow label="Order type" value={order.orderType} />
              <ReviewRow
                label="Time in force"
                value={order.timeInForce.toUpperCase()}
              />
              {/* Only show the entry/limit price when the entry is actually
                  a limit order - for market entries, entryPriceRef is a
                  calculator anchor, not the fill price. */}
              {order.entryOrderType === "Limit" &&
                (order.limitPrice || order.entryPriceRef) && (
                <ReviewRow
                  label="Entry / limit"
                  value={order.entryPriceRef || order.limitPrice || "-"}
                />
              )}
              {order.priceTrigger && (
                <ReviewRow label="Stop trigger" value={order.priceTrigger} />
              )}
              {order.orderType === "OCO" && order.stopMarketPrice && (
                <ReviewRow label="Stop loss" value={order.stopMarketPrice} />
              )}
              {order.assetType === "OPTION" && (
                <ReviewRow
                  label="Contract"
                  value={`${order.optionsDateYear}${order.optionsDateMonth}${order.optionsDateDay} ${order.optionsStrike} ${(order.optionType ?? fallbackOptionType).toUpperCase()}`}
                />
              )}
              {order.orderType === "OCO" &&
                order.takeProfits &&
                order.takeProfits.length > 0 && (
                  <ReviewRow
                    label="Take profit"
                    value={order.takeProfits
                      .map((tp) => `${tp.quantity} @ ${tp.price}`)
                      .join(", ")}
                  />
                )}
              {order.orderType === "OCO" &&
                order.trailingEnabled &&
                order.trailingQty && (
                  <ReviewRow
                    label="Trailing runner"
                    value={`${order.trailingQty} @ ${order.trailingPercent || "-"}%`}
                  />
                )}
            </div>

            {/* Bottom-line dollar impact. Stop-loss risk is only shown when
                  this reviewed order actually includes a usable stop. */}
            {metrics && (
              <div
                className={cn(
                  "grid gap-2",
                  metrics.riskIfStopped !== null ? "grid-cols-2" : "grid-cols-1",
                )}
              >
                <div className="rounded-lg border bg-card/70 px-3 py-2">
                  <div className="text-xs text-muted-foreground">
                    Est. position size
                  </div>
                  <div className="font-data text-base font-bold tabular-nums text-foreground">
                    {formatUsd(metrics.positionSize)}
                  </div>
                </div>
                {metrics.riskIfStopped !== null && (
                  <div
                    className={cn(
                      "rounded-lg border px-3 py-2",
                      metrics.riskExceedsBudget
                        ? "border-red-500/40 bg-red-500/10"
                        : "bg-card/70",
                    )}
                  >
                    <div className="text-xs text-muted-foreground">
                      {metrics.hasTrailingRunner
                        ? "Est. risk at entry"
                        : "Risk if stopped"}
                    </div>
                    <div
                      className={cn(
                        "font-data text-base font-bold tabular-nums",
                        metrics.riskExceedsBudget
                          ? "text-red-400"
                          : "text-foreground",
                      )}
                    >
                      {formatUsd(metrics.riskIfStopped)}
                      {metrics.riskPctOfPortfolio !== null && (
                        <span className="ml-1 text-xs font-semibold">
                          ({(metrics.riskPctOfPortfolio * 100).toFixed(1)}% of
                          acct)
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {metrics?.riskExceedsBudget && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                This position risks more than {RISK_BUDGET_LABEL} of your
                portfolio if stopped. Reduce the quantity or widen your stop
                before submitting.
              </div>
            )}

            {(order.assetType === "OPTION" ||
              order.direction === "short" ||
              getActionSide(order.action) === "sell") && (
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                This order has elevated risk characteristics. Confirm contract,
                side, quantity, and exit plan carefully.
              </div>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            type="button"
            className={cn("font-semibold", submitToneClass)}
            disabled={isSubmitting || !order}
            onClick={() => {
              if (order) {
                onConfirm(order);
              }
            }}
          >
            {isSubmitting ? "Submitting..." : "Confirm Submit"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
