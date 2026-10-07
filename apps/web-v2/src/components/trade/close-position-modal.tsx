"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, AlertTriangle } from "lucide-react";

interface ClosePositionModalProps {
  open: boolean;
  symbol: string;
  /** Position side - used to label the resulting closing side for the user. */
  side: "long" | "short";
  /** Available quantity that can be closed (max + default). */
  availableQty: number;
  /** Current market price, used to seed the limit-price field. */
  currentPrice: number;
  unitLabel: string;
  isClosing: boolean;
  errorMessage: string | null;
  formatCurrency: (value: number) => string;
  onCancel: () => void;
  onConfirm: (args: {
    qty: number;
    orderType: "market" | "limit";
    limitPrice?: number;
  }) => void;
  /**
   * Close the ENTIRE position at market via the legacy full-close path (no qty).
   * Used for fractional positions, which can't be closed by a whole-unit qty.
   */
  onFullClose: () => void;
}

/**
 * Compact inline confirm panel for closing (part of) a position. Lets the user
 * pick a quantity and Market vs Limit (with a required limit price). It does NOT
 * place the order itself - it validates and hands a clean payload to onConfirm.
 * Fractional positions (e.g. 0.5 shares) can't be expressed as a whole-unit
 * close, so a "close entire position at market" path (onFullClose) is offered.
 */
export function ClosePositionModal({
  open,
  symbol,
  side,
  availableQty,
  currentPrice,
  unitLabel,
  isClosing,
  errorMessage,
  formatCurrency,
  onCancel,
  onConfirm,
  onFullClose,
}: ClosePositionModalProps) {
  // Available qty is integer for equities/options; floor defensively so the
  // max/default can never exceed what Alpaca will allow to close.
  const maxQty = Math.max(0, Math.floor(availableQty));
  // Fractional positions can't be closed by a whole-unit qty - offer a full
  // market close (the legacy path handles fractional amounts).
  const isFractional = availableQty > 0 && !Number.isInteger(availableQty);
  const [qtyInput, setQtyInput] = useState(String(maxQty));
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPriceInput, setLimitPriceInput] = useState(
    currentPrice > 0 ? String(currentPrice) : ""
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reset the form each time the modal opens so a reopened modal is always
  // clean (no stale qty/type/price/validation from a prior interaction).
  useEffect(() => {
    if (open) {
      setQtyInput(String(maxQty));
      setOrderType("market");
      setLimitPriceInput(currentPrice > 0 ? String(currentPrice) : "");
      setValidationError(null);
    }
  }, [open, maxQty, currentPrice]);

  if (!open) return null;

  const closeSide = side === "long" ? "Sell" : "Buy";

  const handleConfirm = () => {
    const qty = Number(qtyInput);
    if (!qtyInput.trim() || !Number.isInteger(qty) || qty < 1) {
      setValidationError("Enter a whole quantity of at least 1");
      return;
    }
    if (qty > maxQty) {
      setValidationError(`Max available is ${maxQty}`);
      return;
    }

    let limitPrice: number | undefined;
    if (orderType === "limit") {
      limitPrice = Number(limitPriceInput);
      if (!limitPriceInput.trim() || Number.isNaN(limitPrice) || limitPrice <= 0) {
        setValidationError("Enter a positive limit price");
        return;
      }
    }

    setValidationError(null);
    onConfirm({ qty, orderType, limitPrice });
  };

  const header = (
    <div className="flex items-center justify-between">
      <div className="text-sm font-medium">
        Close {symbol}
        <span className="text-muted-foreground font-normal">
          {" "}({closeSide} to close)
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={onCancel}
        disabled={isClosing}
        aria-label="Cancel close"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const errorBlocks = (
    <>
      {validationError && (
        <div className="text-xs text-destructive">{validationError}</div>
      )}
      {errorMessage && (
        <div className="text-xs text-destructive flex items-start gap-1">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </>
  );

  // Fractional position with no whole unit to close (e.g. 0.5 shares): the
  // quantity form is unusable, so offer only a full market close.
  if (maxQty < 1) {
    return (
      <div
        className="mt-2 max-h-[80vh] overflow-y-auto rounded-lg border bg-muted/40 p-3 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        <div className="text-xs text-muted-foreground">
          This is a fractional position ({availableQty} {unitLabel}). Fractional
          amounts can only be closed in full, at market.
        </div>
        {errorBlocks}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isClosing} className="h-11 w-full sm:h-8 sm:w-auto">
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onFullClose}
            disabled={isClosing}
            className="h-11 w-full sm:h-8 sm:w-auto"
          >
            {isClosing ? "Closing..." : "Close entire position (market)"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-2 max-h-[80vh] overflow-y-auto rounded-lg border bg-muted/40 p-3 space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      {header}

      {/* Quantity */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor={`close-qty-${symbol}`}>
          Quantity ({unitLabel}) · max {maxQty}
        </label>
        <Input
          id={`close-qty-${symbol}`}
          type="number"
          step="1"
          min={1}
          max={maxQty}
          value={qtyInput}
          onChange={(e) => setQtyInput(e.target.value)}
          disabled={isClosing}
          className="h-11 font-data tabular-nums sm:h-8"
          aria-label="Close quantity"
        />
      </div>

      {/* Order type segmented control */}
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Order Type</span>
        <div className="grid grid-cols-2 gap-1">
          <Button
            type="button"
            variant={orderType === "market" ? "default" : "outline"}
            size="sm"
            className="h-11 sm:h-8"
            onClick={() => setOrderType("market")}
            disabled={isClosing}
          >
            Market
          </Button>
          <Button
            type="button"
            variant={orderType === "limit" ? "default" : "outline"}
            size="sm"
            className="h-11 sm:h-8"
            onClick={() => setOrderType("limit")}
            disabled={isClosing}
          >
            Limit
          </Button>
        </div>
      </div>

      {/* Limit price (only for limit orders) */}
      {orderType === "limit" && (
        <div className="space-y-1">
          <label
            className="text-xs text-muted-foreground"
            htmlFor={`close-limit-${symbol}`}
          >
            Limit Price
          </label>
          <Input
            id={`close-limit-${symbol}`}
            type="number"
            step="0.01"
            min="0"
            value={limitPriceInput}
            onChange={(e) => setLimitPriceInput(e.target.value)}
            disabled={isClosing}
            className="h-11 font-data tabular-nums sm:h-8"
            aria-label="Limit price"
          />
          <div className="text-xs text-muted-foreground">
            Current price {formatCurrency(currentPrice)}
          </div>
        </div>
      )}

      {isFractional && (
        <div className="text-xs text-muted-foreground">
          Heads up: this position includes a fractional amount. Close whole {unitLabel} above,
          or close it all at market.
        </div>
      )}

      {errorBlocks}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isClosing} className="h-11 w-full sm:h-8 sm:w-auto">
          Cancel
        </Button>
        {isFractional && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onFullClose}
            disabled={isClosing}
            className="h-11 w-full sm:h-8 sm:w-auto"
          >
            Close all (market)
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={handleConfirm}
          disabled={isClosing || maxQty < 1}
          className="h-11 w-full sm:h-8 sm:w-auto"
        >
          {isClosing ? "Closing..." : "Confirm Close"}
        </Button>
      </div>
    </div>
  );
}
