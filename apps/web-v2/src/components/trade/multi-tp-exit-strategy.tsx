"use client";

import { useRef, useState } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useSession } from "@/lib/auth-client";
import { AdvancedChart } from "@/components/charts/advanced-chart";
import { SubmitIntentStore } from "./order-idempotency";
import {
  Target,
  TrendingUp,
  Shield,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Info,
  Zap,
} from "lucide-react";

/**
 * Multi-TP with Trailing Stop Exit Strategy
 *
 * This component allows users to set up an exit strategy for existing positions:
 * - Multiple Take Profit levels (e.g., TP1 at $155 for 30 shares, TP2 at $160 for 30 shares)
 * - Trailing stop for remaining shares
 * - Optional hard stop loss
 *
 * Since Alpaca doesn't support this natively in one order, we submit multiple orders.
 */

const exitStrategySchema = z.object({
  symbol: z.string().min(1, "Symbol required").transform(v => v.toUpperCase()),
  takeProfits: z.array(z.object({
    price: z.string().min(1, "Price required"),
    qty: z.string().min(1, "Quantity required"),
  })).min(1, "At least one take profit required"),
  trailingStop: z.object({
    enabled: z.boolean(),
    qty: z.string().optional(),
    trailPercent: z.string().optional(),
    trailPrice: z.string().optional(),
  }),
  stopLoss: z.object({
    enabled: z.boolean(),
    stopPrice: z.string().optional(),
    qty: z.string().optional(),
  }),
});

type ExitStrategyFormData = z.infer<typeof exitStrategySchema>;

export function MultiTPExitStrategyPanel({
  activeCredentialId,
  activeAccountType,
}: {
  activeCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
}) {
  const submitIntentRef = useRef(new SubmitIntentStore());
  const { data: session } = useSession();
  const [result, setResult] = useState<{ type: "success" | "error"; message: string; details?: string[] } | null>(null);
  const activeAccountName = activeAccountType === "LIVE" ? "Live" : "Paper";

  const { control, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<ExitStrategyFormData>({
    resolver: zodResolver(exitStrategySchema),
    defaultValues: {
      symbol: "",
      takeProfits: [
        { price: "", qty: "" },
        { price: "", qty: "" },
      ],
      trailingStop: {
        enabled: true,
        qty: "",
        trailPercent: "2",
        trailPrice: "",
      },
      stopLoss: {
        enabled: false,
        stopPrice: "",
        qty: "",
      },
    },
  });

  const { fields: tpFields, append: appendTP, remove: removeTP } = useFieldArray({
    control,
    name: "takeProfits",
  });

  const trailingStopEnabled = watch("trailingStop.enabled");
  const stopLossEnabled = watch("stopLoss.enabled");
  const symbolValue = watch("symbol");

  // Extract the underlying ticker from options OCC symbols
  // e.g. TSLA260417C00255000 → TSLA, AAPL → AAPL
  const chartSymbol = symbolValue?.replace(/\d{6}[CP]\d{8}$/, "") || symbolValue;

  // Fetch open positions for the symbol dropdown
  const positionsQuery = trpc.positions.list.useQuery({ credentialId: activeCredentialId }, {
    enabled: !!activeCredentialId,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const openPositions = positionsQuery.data || [];

  // When a position is selected from the dropdown, auto-populate qty fields
  const handlePositionSelect = (symbol: string) => {
    setValue("symbol", symbol);

    const position = openPositions.find((p) => p.symbol === symbol);
    if (!position) return;

    const totalQty = Math.floor(Math.abs(position.qty));
    if (totalQty <= 0) return;

    // Smart distribution: split qty across TP fields + trailing stop
    const tpCount = tpFields.length;
    const hasTrailing = trailingStopEnabled;

    if (hasTrailing && tpCount > 0) {
      // Give trailing stop ~40% of shares, divide rest among TPs
      const trailingQty = Math.max(1, Math.round(totalQty * 0.4));
      const tpQty = totalQty - trailingQty;
      const perTp = Math.max(1, Math.floor(tpQty / tpCount));

      tpFields.forEach((_, index) => {
        const qty = index === tpCount - 1 ? tpQty - perTp * (tpCount - 1) : perTp;
        setValue(`takeProfits.${index}.qty`, String(Math.max(1, qty)));
      });
      setValue("trailingStop.qty", String(trailingQty));
    } else if (tpCount > 0) {
      // No trailing stop - split evenly among TPs
      const perTp = Math.max(1, Math.floor(totalQty / tpCount));
      tpFields.forEach((_, index) => {
        const qty = index === tpCount - 1 ? totalQty - perTp * (tpCount - 1) : perTp;
        setValue(`takeProfits.${index}.qty`, String(Math.max(1, qty)));
      });
    }
  };

  // Fetch live quote using the underlying ticker (works for both equities and options)
  const quoteQuery = trpc.quotes.getStockQuote.useQuery(
    { symbol: chartSymbol, credentialId: activeCredentialId },
    {
      enabled: !!(activeCredentialId && symbolValue && symbolValue.length >= 1),
      refetchInterval: 30000,
      staleTime: 10000,
      retry: 2,
    }
  );

  // Compute mid price from bid/ask
  const bidPrice = parseFloat(quoteQuery.data?.bid || "0");
  const askPrice = parseFloat(quoteQuery.data?.ask || "0");
  const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : parseFloat(quoteQuery.data?.last || "0");

  // Auto-fill TP1 at +2% and SL at -2% of mid price
  const handleAutoFill = () => {
    if (!midPrice || midPrice <= 0) return;

    const tp1Price = (midPrice * 1.02).toFixed(2);
    const slPrice = (midPrice * 0.98).toFixed(2);

    // Set TP1 price
    setValue("takeProfits.0.price", tp1Price);

    // Enable and set stop loss
    setValue("stopLoss.enabled", true);
    setValue("stopLoss.stopPrice", slPrice);

    // If position is selected, auto-set SL qty to full position size (safety net)
    const pos = openPositions.find((p) => p.symbol === symbolValue);
    if (pos) {
      setValue("stopLoss.qty", String(Math.floor(Math.abs(pos.qty))));
    }
  };

  const createExitStrategyMutation = trpc.positions.createExitStrategy.useMutation({
    onSuccess: (data, variables) => {
      if (data.success) {
        submitIntentRef.current.complete(variables.idempotencyKey);
        setResult({
          type: "success",
          message: data.message,
          details: [
            `${data.takeProfitOrderIds.length} take profit order(s) created`,
            data.trailingStopOrderId ? "Trailing stop order created" : "",
            data.stopLossOrderId ? "Stop loss order created" : "",
          ].filter(Boolean),
        });
        toast.success(data.message);
      } else {
        setResult({
          type: "error",
          message: data.message,
          details: data.errors,
        });
        toast.error(data.message);
      }
    },
    onError: (error) => {
      setResult({ type: "error", message: error.message });
      toast.error(error.message);
    },
  });

  const onSubmit = (data: ExitStrategyFormData) => {
    setResult(null);

    if (!activeCredentialId) {
      setResult({ type: "error", message: "Select an enabled Paper or Live account before creating exits." });
      return;
    }

    const takeProfits = data.takeProfits
      .filter(tp => tp.price && tp.qty)
      .map(tp => ({
        price: parseFloat(tp.price),
        qty: parseInt(tp.qty),
      }));

    if (takeProfits.length === 0) {
      setResult({ type: "error", message: "At least one valid take profit is required" });
      return;
    }

    const trailingStop = data.trailingStop.enabled && data.trailingStop.qty
      ? {
          qty: parseInt(data.trailingStop.qty),
          trailPercent: data.trailingStop.trailPercent ? parseFloat(data.trailingStop.trailPercent) : undefined,
          trailPrice: data.trailingStop.trailPrice ? parseFloat(data.trailingStop.trailPrice) : undefined,
        }
      : undefined;

    const stopLoss = data.stopLoss.enabled && data.stopLoss.stopPrice && data.stopLoss.qty
      ? {
          stopPrice: parseFloat(data.stopLoss.stopPrice),
          qty: parseInt(data.stopLoss.qty),
        }
      : undefined;

    const exitStrategy = {
      symbol: data.symbol,
      credentialId: activeCredentialId,
      takeProfits,
      trailingStop,
      stopLoss,
    };
    createExitStrategyMutation.mutate({
      ...exitStrategy,
      idempotencyKey: submitIntentRef.current.get(JSON.stringify(exitStrategy)),
    });
  };

  // Calculate total shares
  const takeProfits = watch("takeProfits");
  const trailingStopQty = watch("trailingStop.qty");
  const stopLossQty = watch("stopLoss.qty");

  const tpShares = takeProfits.reduce((sum, tp) => sum + (parseInt(tp.qty) || 0), 0);
  const tsShares = trailingStopEnabled ? (parseInt(trailingStopQty || "0") || 0) : 0;
  const slShares = stopLossEnabled ? (parseInt(stopLossQty || "0") || 0) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Multi-TP Exit Strategy
        </CardTitle>
        <CardDescription>
          {activeCredentialId
            ? `Set up 2+ take profit levels with trailing stop for existing ${activeAccountName} positions`
            : "Set up 2+ take profit levels with trailing stop for existing positions"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Info Banner */}
          <div className="p-3 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400 text-sm flex items-start gap-2">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <strong>How it works:</strong> This creates multiple sell orders for an existing position.
              Each take profit is a limit sell order. The trailing stop follows price up and sells if it drops.
            </div>
          </div>

          {/* Symbol Dropdown - Open Positions */}
          <div className="space-y-2">
            <Label>Symbol (select from open positions)</Label>
            <div className="flex flex-wrap gap-2 items-center lg:flex-nowrap">
              {openPositions.length > 0 ? (
                <Select
                  value={symbolValue || undefined}
                  onValueChange={handlePositionSelect}
                >
                  <SelectTrigger className="w-full lg:w-fit lg:max-w-xs">
                    <SelectValue placeholder="Select a position…" />
                  </SelectTrigger>
                  <SelectContent>
                    {openPositions.map((pos) => {
                      const isProfitable = pos.unrealizedPL >= 0;
                      return (
                        <SelectItem key={pos.symbol} value={pos.symbol}>
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate font-medium">{pos.symbol}</span>
                            <span className="min-w-0 truncate text-muted-foreground text-xs">
                              {Math.abs(pos.qty)} {pos.assetClass === "us_option" ? "contracts" : "shares"}
                            </span>
                            <span className={`text-xs font-medium ${isProfitable ? "text-green-500" : "text-red-500"}`}>
                              {isProfitable ? "+" : ""}{pos.unrealizedPLPercent.toFixed(1)}%
                            </span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <Controller
                  name="symbol"
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      placeholder={positionsQuery.isLoading ? "Loading positions…" : "No open positions - type symbol"}
                      className="w-full lg:max-w-xs"
                      onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                    />
                  )}
                />
              )}
              {quoteQuery.isLoading && symbolValue && (
                <Badge variant="secondary" className="h-8">Loading...</Badge>
              )}
              {quoteQuery.data && !quoteQuery.isLoading && (
                <Badge variant="default" className="h-8">
                  ${quoteQuery.data.last}
                  {quoteQuery.data.changePercent && ` (${quoteQuery.data.changePercent}%)`}
                </Badge>
              )}
            </div>
            {/* Show selected position details */}
            {symbolValue && openPositions.find((p) => p.symbol === symbolValue) && (
              <div className="text-xs text-muted-foreground pl-1">
                {(() => {
                  const pos = openPositions.find((p) => p.symbol === symbolValue)!;
                  return (
                    <>
                      {pos.side.toUpperCase()} • {Math.abs(pos.qty)} shares @ ${pos.avgEntryPrice.toFixed(2)} •{" "}
                      <span className={pos.unrealizedPL >= 0 ? "text-green-500" : "text-red-500"}>
                        P&L: ${pos.unrealizedPL.toFixed(2)} ({pos.unrealizedPLPercent.toFixed(2)}%)
                      </span>
                    </>
                  );
                })()}
              </div>
            )}
            {errors.symbol && <p className="text-xs text-destructive">{errors.symbol.message}</p>}
          </div>

          {/* Chart preview - TV Advanced Charts via our datafeed. Annotations
              hidden because this is a configurator surface, not the live
              positions view. */}
          {chartSymbol && chartSymbol.length >= 1 && (
            <div className="rounded-lg overflow-hidden border">
              <AdvancedChart
                symbol={chartSymbol}
                height={250}
                hideAnnotations
              />
            </div>
          )}

          {/* Live Quote Info Bar + Auto-fill Button */}
          {quoteQuery.data && !quoteQuery.isLoading && midPrice > 0 && (
            <div className="p-3 rounded-lg bg-muted/50 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-muted-foreground">Bid:</span>
                  <span className="ml-1 font-medium">${quoteQuery.data.bid}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Ask:</span>
                  <span className="ml-1 font-medium">${quoteQuery.data.ask}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Mid:</span>
                  <span className="ml-1 font-semibold text-primary">${midPrice.toFixed(2)}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAutoFill}
                className="w-full gap-1.5"
              >
                <Zap className="h-3.5 w-3.5" />
                Auto-fill ±2%
              </Button>
            </div>
          )}

          <Separator />

          {/* Take Profit Levels */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 text-base">
                <Target className="h-4 w-4 text-green-500" />
                Take Profit Levels
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => appendTP({ price: "", qty: "" })}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add TP
              </Button>
            </div>

            <div className="space-y-3">
              {tpFields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-3">
                  <Badge variant="secondary" className="w-12 justify-center">
                    TP{index + 1}
                  </Badge>
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <Controller
                      name={`takeProfits.${index}.price`}
                      control={control}
                      render={({ field }) => (
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          placeholder="Price"
                          className="h-11 text-base lg:h-7 lg:text-sm"
                        />
                      )}
                    />
                    <Controller
                      name={`takeProfits.${index}.qty`}
                      control={control}
                      render={({ field }) => (
                        <Input
                          {...field}
                          type="number"
                          min="1"
                          placeholder="Shares"
                          className="h-11 text-base lg:h-7 lg:text-sm"
                        />
                      )}
                    />
                  </div>
                  {tpFields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeTP(index)}
                      className="size-11 shrink-0 lg:size-7"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Trailing Stop */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Controller
                name="trailingStop.enabled"
                control={control}
                render={({ field }) => (
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="rounded"
                  />
                )}
              />
              <Label className="flex items-center gap-2 cursor-pointer">
                <TrendingUp className="h-4 w-4 text-blue-500" />
                Trailing Stop (for remaining shares)
              </Label>
            </div>

            {trailingStopEnabled && (
              <div className="grid grid-cols-1 gap-3 pl-6 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">Shares</Label>
                  <Controller
                    name="trailingStop.qty"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        min="1"
                        placeholder="40"
                        className="h-11 text-base lg:h-7 lg:text-sm"
                      />
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Trail %</Label>
                  <Controller
                    name="trailingStop.trailPercent"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.1"
                        placeholder="2.0"
                        className="h-11 text-base lg:h-7 lg:text-sm"
                      />
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">OR Trail $</Label>
                  <Controller
                    name="trailingStop.trailPrice"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.01"
                        placeholder="5.00"
                        className="h-11 text-base lg:h-7 lg:text-sm"
                      />
                    )}
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Hard Stop Loss (optional) */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Controller
                name="stopLoss.enabled"
                control={control}
                render={({ field }) => (
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="rounded"
                  />
                )}
              />
              <Label className="flex items-center gap-2 cursor-pointer">
                <Shield className="h-4 w-4 text-red-500" />
                Hard Stop Loss (emergency exit)
              </Label>
            </div>

            {stopLossEnabled && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <div className="space-y-1">
                  <Label className="text-xs">Stop Price</Label>
                  <Controller
                    name="stopLoss.stopPrice"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.01"
                        placeholder="140.00"
                        className="h-11 text-base lg:h-7 lg:text-sm"
                      />
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Shares</Label>
                  <Controller
                    name="stopLoss.qty"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        min="1"
                        placeholder="100"
                        className="h-11 text-base lg:h-7 lg:text-sm"
                      />
                    )}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="p-4 rounded-lg bg-muted/50">
            <h4 className="font-medium text-sm mb-2">Order Summary</h4>
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3 sm:gap-4">
              <div>
                <span className="text-muted-foreground">TP Orders:</span>
                <span className="ml-2 font-medium">{tpShares} shares</span>
              </div>
              <div>
                <span className="text-muted-foreground">Trailing:</span>
                <span className="ml-2 font-medium">{tsShares} shares</span>
              </div>
              <div>
                <span className="text-muted-foreground">Stop Loss:</span>
                <span className="ml-2 font-medium">{slShares} shares</span>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Note: TP and trailing stop orders will be active simultaneously.
              Make sure total doesn&apos;t exceed your position size.
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className={`p-3 rounded-lg text-sm ${
              result.type === "success"
                ? "bg-gain-tint text-green-600 dark:text-green-400"
                : "bg-loss-tint text-red-600 dark:text-red-400"
            }`}>
              <div className="flex items-center gap-2">
                {result.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                {result.message}
              </div>
              {result.details && result.details.length > 0 && (
                <ul className="mt-2 ml-6 list-disc text-xs">
                  {result.details.map((detail, i) => (
                    <li key={i}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Submit */}
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting || createExitStrategyMutation.isPending || !session || !activeCredentialId}
          >
            {createExitStrategyMutation.isPending ? "Creating Exit Strategy..." : "Create Exit Strategy"}
          </Button>
        </form>

        <Separator className="my-6" />

        {/* Example */}
        <div className="space-y-3">
          <h4 className="font-medium text-sm flex items-center gap-2">
            <Info className="h-4 w-4" />
            Example: 100 shares of AAPL @ $150
          </h4>
          <div className="grid gap-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="w-12 justify-center">TP1</Badge>
              <span>Sell 30 shares at $155 (+3.3%)</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="w-12 justify-center">TP2</Badge>
              <span>Sell 30 shares at $160 (+6.7%)</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className="w-12 justify-center bg-blue-500">Trail</Badge>
              <span>Remaining 40 shares with 2% trailing stop</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
