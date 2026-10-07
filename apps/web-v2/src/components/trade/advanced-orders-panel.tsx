"use client";

import { useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useSession } from "@/lib/auth-client";
import {
  Shield,
  Target,
  TrendingUp,
  Plus, Trash2, Calculator,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useFieldArray } from "react-hook-form";
import { SubmitIntentStore } from "./order-idempotency";


// ============================================
// OCO ORDER FORM
// One-Cancels-Other for exits
// ============================================


const takeProfitSchema = z.object({
  price: z.string().min(1, "TP Price required"),
  quantity: z.string().min(1, "TP Qty required"),
});

const ocoOrderSchema = z.object({
  symbol: z.string().min(1, "Symbol required").transform(v => v.toUpperCase()),
  quantity: z.string().min(1, "Total quantity required"),
  entryPrice: z.string().optional(),
  stopLossPrice: z.string().min(1, "Stop loss required"),
  takeProfits: z.array(takeProfitSchema).min(1, "At least one TP required"),
  timeInForce: z.enum(["day", "gtc"]),
});

type OCOFormData = z.infer<typeof ocoOrderSchema>;

function OCOOrderForm() {
  const { data: session } = useSession();
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const submitIntentRef = useRef(new SubmitIntentStore());

  const { control, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<OCOFormData>({
    resolver: zodResolver(ocoOrderSchema),
    defaultValues: {
      symbol: "",
      quantity: "100",
      entryPrice: "",
      stopLossPrice: "",
      takeProfits: [{ price: "", quantity: "100" }],
      timeInForce: "gtc",
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "takeProfits",
  });

  const watchEntry = watch("entryPrice");
  const watchSL = watch("stopLossPrice");
  const watchTotalQty = watch("quantity");

  const submitMutation = trpc.orders.submitOCO.useMutation({
    onSuccess: (data, variables) => {
      setResult({ type: data.success ? "success" : "error", message: data.message });
      if (data.success) {
        submitIntentRef.current.complete(variables.idempotencyKey);
        toast.success(data.message);
      } else {
        toast.error(data.message);
      }
    },
    onError: (error) => {
      setResult({ type: "error", message: error.message });
      toast.error(error.message);
    },
  });

  const onSubmit = (data: OCOFormData) => {
    if (!session) {
      setResult({ type: "error", message: "Please log in to submit orders." });
      return;
    }
    setResult(null);
    const order = {
      symbol: data.symbol,
      quantity: parseInt(data.quantity),
      takeProfits: data.takeProfits.map(tp => ({
        price: parseFloat(tp.price),
        quantity: parseInt(tp.quantity),
      })),
      stopLossPrice: parseFloat(data.stopLossPrice),
      timeInForce: data.timeInForce,
    };
    submitMutation.mutate({
      ...order,
      idempotencyKey: submitIntentRef.current.get(JSON.stringify(order)),
    });
  };

  const calculateRPrice = (multiple: number) => {
    const entry = parseFloat(watchEntry || "0");
    const sl = parseFloat(watchSL || "0");
    if (!entry || !sl) return null;

    const r = entry - sl; // Assume long for now, or detect based on SL vs Entry
    const tpPrice = entry + (multiple * r);
    return tpPrice.toFixed(2);
  };

  const addRLevel = (multiple: number) => {
    const price = calculateRPrice(multiple);
    if (price) {
      // Split remaining quantity or just default to full if first
      const currentTPs = watch("takeProfits");
      const totalUsedQty = currentTPs.reduce((acc, tp) => acc + parseInt(tp.quantity || "0"), 0);
      const remaining = Math.max(0, parseInt(watchTotalQty || "0") - totalUsedQty);

      append({ price, quantity: remaining.toString() });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Target className="h-4 w-4" />
        <span>Exit strategy: Multi-TP OCO. Each TP gets its own OCO with same SL.</span>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:gap-4">
        <div className="space-y-2">
          <Label>Symbol</Label>
          <Controller
            name="symbol"
            control={control}
            render={({ field }) => (
              <Input {...field} placeholder="AAPL" className="h-11 lg:h-7" />
            )}
          />
          {errors.symbol && <p className="text-xs text-destructive">{errors.symbol.message}</p>}
        </div>

        <div className="space-y-2">
          <Label>Total Quantity</Label>
          <Controller
            name="quantity"
            control={control}
            render={({ field }) => (
              <Input {...field} type="number" min="1" placeholder="100" className="h-11 lg:h-7" />
            )}
          />
          {errors.quantity && <p className="text-xs text-destructive">{errors.quantity.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:gap-4">
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Calculator className="h-3 w-3" />
            Entry Price (for R calcs)
          </Label>
          <Controller
            name="entryPrice"
            control={control}
            render={({ field }) => (
              <Input {...field} type="number" step="0.01" placeholder="150.00" className="h-11 lg:h-7" />
            )}
          />
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-red-500">
            <Shield className="h-4 w-4" />
            Stop Loss Price
          </Label>
          <Controller
            name="stopLossPrice"
            control={control}
            render={({ field }) => (
              <Input {...field} type="number" step="0.01" placeholder="145.00" className="h-11 lg:h-7" />
            )}
          />
          {errors.stopLossPrice && <p className="text-xs text-destructive">{errors.stopLossPrice.message}</p>}
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Label className="text-green-500 flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Take Profit Levels
          </Label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => addRLevel(0.4)}
              disabled={!watchEntry || !watchSL}
              className="text-3xs h-8 sm:h-7"
            >
              +0.4R
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => addRLevel(0.7)}
              disabled={!watchEntry || !watchSL}
              className="text-3xs h-8 sm:h-7"
            >
              +0.7R
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => addRLevel(1)}
              disabled={!watchEntry || !watchSL}
              className="text-3xs h-8 sm:h-7"
            >
              +1R
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => addRLevel(2)}
              disabled={!watchEntry || !watchSL}
              className="text-3xs h-8 sm:h-7"
            >
              +2R
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => append({ price: "", quantity: "" })}
              className="h-8 w-8 p-0 sm:h-7 sm:w-7"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-6 space-y-1">
              <Label className="text-3xs text-muted-foreground">TP {index + 1} Price</Label>
              <Controller
                name={`takeProfits.${index}.price`}
                control={control}
                render={({ field }) => (
                  <Input {...field} type="number" step="0.01" className="h-11 text-base lg:h-8 lg:text-sm" />
                )}
              />
            </div>
            <div className="col-span-4 space-y-1">
              <Label className="text-3xs text-muted-foreground">Qty</Label>
              <Controller
                name={`takeProfits.${index}.quantity`}
                control={control}
                render={({ field }) => (
                  <Input {...field} type="number" className="h-11 text-base lg:h-8 lg:text-sm" />
                )}
              />
            </div>
            <div className="col-span-2 pb-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(index)}
                className="h-11 w-11 p-0 text-destructive hover:text-destructive/80 lg:h-8 lg:w-8"
                disabled={fields.length === 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {errors.takeProfits && <p className="text-xs text-destructive">{errors.takeProfits.message}</p>}
      </div>

      <div className="space-y-2 pt-2">
        <Label>Time in Force</Label>
        <Controller
          name="timeInForce"
          control={control}
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="gtc">Good Till Cancelled</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {result && (
        <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
          result.type === "success"
            ? "bg-gain-tint text-green-600 dark:text-green-400"
            : "bg-loss-tint text-red-600 dark:text-red-400"
        }`}>
          {result.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {result.message}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={isSubmitting || submitMutation.isPending || !session}>
        {submitMutation.isPending ? "Submitting..." : "Submit OCO Orders"}
      </Button>
    </form>
  );
}


// ============================================
// MAIN COMPONENT
// ============================================

export function AdvancedOrdersPanel() {
  const credentialsQuery = trpc.userSettings.hasApiCredentials.useQuery({ provider: "alpaca" });

  return (
    <Card className="premium-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" />
          OCO Orders
        </CardTitle>
        <CardDescription>
          {credentialsQuery.data?.hasCredentials
            ? "Submit One-Cancels-Other orders via Alpaca"
            : "Configure Alpaca in Settings to use OCO orders"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <OCOOrderForm />

          <Separator />

          <div className="space-y-3">
            <h4 className="font-medium text-sm">Order Type Explained</h4>
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="font-medium flex items-center gap-2">
                <Badge variant="outline">OCO</Badge>
                One-Cancels-Other
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                For existing positions: set Take Profit and Stop Loss where hitting one automatically cancels the other.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
