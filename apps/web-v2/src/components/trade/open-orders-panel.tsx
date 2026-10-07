"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import { toast } from "sonner";
import {
  getLinkedExitLabel,
  getVisibleOpenOrderCount,
  isNoiseOrderStatus,
  isStopLossOrderType,
} from "./open-orders-display";
import {
  RefreshCw,
  X,
  Pencil,
  Check,
  XCircle,
  AlertTriangle,
  AlertCircle,
  ListOrdered,
  Trash2,
  Clock,
  ArrowUpDown,
} from "lucide-react";

interface AlpacaOrder {
  id: string;
  clientOrderId: string;
  copySourceLabel?: string | null;
  symbol: string;
  assetClass: string;
  side: string;
  type: string;
  orderClass: string;
  qty: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  trailPrice: number | null;
  trailPercent: number | null;
  status: string;
  timeInForce: string;
  createdAt: string;
  updatedAt: string;
  filledAt: string | null;
  legs?: {
    id: string;
    symbol: string;
    side: string;
    type: string;
    qty: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
    status: string;
  }[];
}

export function OpenOrdersPanel({
  activeCredentialId,
  credentialsLoading = false,
  embedded = false,
}: {
  activeCredentialId?: string;
  /**
   * Retained for caller compatibility. The panel no longer surfaces the
   * account mode (Paper/Live) in its copy; it names the broker (Alpaca).
   */
  activeAccountType?: "PAPER" | "LIVE";
  /**
   * True while the user's saved credentials are still being fetched. Until that
   * resolves we don't yet know which account (if any) is active, so we show a
   * loading state instead of flashing the "Set your trading credentials" prompt.
   */
  credentialsLoading?: boolean;
  embedded?: boolean;
}) {
  const { collapsed, toggle } = useCollapsible("open-orders");
  const isCollapsed = embedded ? false : collapsed;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{
    qty?: string;
    limitPrice?: string;
    stopPrice?: string;
    timeInForce?: string;
  }>({});
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const { data: session } = useSession();
  const isSignedIn = !!session?.user;

  // Fetch open orders from Alpaca
  const ordersQuery = trpc.orders.listAlpacaOrders.useQuery(
    { status: "open", limit: 100, credentialId: activeCredentialId },
    {
      enabled: !!activeCredentialId,
      refetchInterval: 15000,
      staleTime: 5000,
    }
  );

  // Cancel single order
  const cancelMutation = trpc.orders.cancelAlpacaOrder.useMutation({
    onSuccess: () => {
      toast.success("Order cancelled");
      ordersQuery.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Cancel all orders
  const cancelAllMutation = trpc.orders.cancelAllOrders.useMutation({
    onSuccess: () => {
      toast.success("All orders cancelled");
      ordersQuery.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Modify order
  const modifyMutation = trpc.orders.modifyAlpacaOrder.useMutation({
    onSuccess: () => {
      toast.success("Order modified");
      setEditingOrderId(null);
      setEditValues({});
      ordersQuery.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleRefresh = async () => {
    if (!activeCredentialId) return;
    setIsRefreshing(true);
    await ordersQuery.refetch();
    setIsRefreshing(false);
  };

  const startEditing = (order: AlpacaOrder) => {
    setEditingOrderId(order.id);
    setEditValues({
      qty: order.qty?.toString() || "",
      limitPrice: order.limitPrice?.toString() || "",
      stopPrice: order.stopPrice?.toString() || "",
      timeInForce: order.type === "limit" && order.side === "sell" ? "gtc" : order.timeInForce || "gtc",
    });
  };

  const submitModify = (order: AlpacaOrder) => {
    if (!session) {
      setStatusMessage({ type: "error", message: "Please log in to modify orders." });
      return;
    }
    const updates: any = { brokerOrderId: order.id, credentialId: activeCredentialId };
    if (editValues.qty) updates.qty = parseInt(editValues.qty);
    if (editValues.limitPrice) updates.limitPrice = parseFloat(editValues.limitPrice);
    if (editValues.stopPrice) updates.stopPrice = parseFloat(editValues.stopPrice);
    if (editValues.timeInForce || (order.type === "limit" && order.side === "sell")) {
      updates.timeInForce = order.type === "limit" && order.side === "sell" ? "gtc" : editValues.timeInForce;
    }
    modifyMutation.mutate(updates);
  };

  const handleCancelAll = () => {
    if (!session) {
      setStatusMessage({ type: "error", message: "Please log in to cancel orders." });
      return;
    }
    cancelAllMutation.mutate({ credentialId: activeCredentialId });
  };

  const handleCancel = (brokerOrderId: string) => {
    if (!session) {
      setStatusMessage({ type: "error", message: "Please log in to cancel orders." });
      return;
    }
    cancelMutation.mutate({ brokerOrderId, credentialId: activeCredentialId });
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const getOrderTypeLabel = (type: string) => {
    switch (type) {
      case "market": return "Market";
      case "limit": return "Limit";
      case "stop": return "Stop";
      case "stop_limit": return "Stop Limit";
      case "trailing_stop": return "Trail Stop";
      default: return type;
    }
  };

  const getSideColor = (side: string) => {
    return side === "buy" ? "text-green-500" : "text-red-500";
  };

  const getStatusBadgeVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case "new":
      case "accepted":
      case "pending_new":
        return "default";
      case "partially_filled":
        return "secondary";
      case "filled":
        return "outline";
      default:
        return "destructive";
    }
  };

  const orders = (ordersQuery.data || []) as AlpacaOrder[];
  const visibleOpenOrderCount = getVisibleOpenOrderCount(orders);

  // While saved credentials are still loading we don't yet know whether an
  // account is active, so the panel should show a loading state rather than
  // flashing the "Set your trading credentials" empty state.
  const awaitingCredentials = credentialsLoading && !activeCredentialId;

  return (
    <Card
      className={cn(
        embedded && "h-full min-h-0 gap-0 overflow-hidden rounded-none bg-transparent py-0 ring-0",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {!embedded && (
              <CardTitle className="flex items-center gap-2 text-lg">
                <ListOrdered className="h-5 w-5 text-primary" />
                Open Orders
              </CardTitle>
            )}
            <CardDescription>
              {activeCredentialId
                ? `${visibleOpenOrderCount} open order${visibleOpenOrderCount !== 1 ? "s" : ""} on Alpaca`
                : awaitingCredentials ? "Loading..." : isSignedIn ? "No enabled account" : "Sign in required"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {orders.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={cancelAllMutation.isPending || !activeCredentialId}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Cancel All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel ALL open orders?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will cancel all {orders.length} open order
                      {orders.length !== 1 ? "s" : ""} on Alpaca. This action cannot
                      be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep orders</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={handleCancelAll}
                    >
                      Cancel all orders
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing || !activeCredentialId}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {!embedded && (
              <CollapseButton collapsed={collapsed} onToggle={toggle} label="Open Orders" />
            )}
          </div>
        </div>
      </CardHeader>
      {!isCollapsed && (
      <CardContent className={cn(embedded && "flex min-h-0 flex-1 flex-col")}>
        {ordersQuery.isLoading || awaitingCredentials ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Loading open orders...
          </div>
        ) : !isSignedIn ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Sign in to see open orders.
          </div>
        ) : !activeCredentialId ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Set your trading credentials in Settings to see open orders.
          </div>
        ) : ordersQuery.error ? (
          <div className="text-sm text-destructive flex items-center gap-2 py-4">
            <AlertTriangle className="h-4 w-4" />
            {ordersQuery.error.message}
          </div>
        ) : orders.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No open orders
          </div>
        ) : (
          <div
            className={cn(
              "overflow-y-auto pr-2 space-y-2 custom-scrollbar",
              embedded ? "max-h-none flex-1" : "max-h-[600px]",
            )}
          >
            {orders.map((order) => (
              <div
                key={order.id}
                className="premium-panel p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors"
              >
                {/* Order Header */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0 lg:flex-nowrap">
                    <span className={`font-semibold ${getSideColor(order.side)}`}>
                      {order.side.toUpperCase()}
                    </span>
                    <span className="font-medium min-w-0 truncate">{order.symbol}</span>
                    <Badge variant="outline" className="text-xs">
                      {getOrderTypeLabel(order.type)}
                    </Badge>
                    {isStopLossOrderType(order.type) && (
                      <Badge variant="destructive" className="text-xs">
                        Stop Loss
                      </Badge>
                    )}
                    {/*
                      Every open order sits at a submission status right after
                      being placed ("new" in hours, "accepted"/"pending_new"
                      outside them), so badging it added noise to every row.
                      Hide those; other statuses (filled, canceled, partially
                      filled, etc.) still surface because they carry signal.
                    */}
                    {!isNoiseOrderStatus(order.status) && (
                      <Badge variant={getStatusBadgeVariant(order.status)} className="text-xs">
                        {order.status}
                      </Badge>
                    )}
                    {order.orderClass && order.orderClass !== "simple" && (
                      <Badge variant="secondary" className="text-xs">
                        {order.orderClass}
                      </Badge>
                    )}
                    {order.copySourceLabel && (
                      <Badge
                        variant="outline"
                        className="text-xs border-primary/40 text-primary/80 whitespace-nowrap"
                        title={`Auto-mirrored from ${order.copySourceLabel}`}
                      >
                        Copied · {order.copySourceLabel}
                      </Badge>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Only show modify for limit/stop orders */}
                    {(order.type === "limit" || order.type === "stop" || order.type === "stop_limit" || order.type === "trailing_stop") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 lg:h-7 lg:w-7"
                        onClick={() =>
                          editingOrderId === order.id
                            ? (setEditingOrderId(null), setEditValues({}))
                            : startEditing(order)
                        }
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 text-destructive hover:text-destructive lg:h-7 lg:w-7"
                          disabled={cancelMutation.isPending}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {order.side.toUpperCase()} {order.symbol} (
                            {getOrderTypeLabel(order.type)}) will be cancelled. This action cannot
                            be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep order</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => handleCancel(order.id)}
                          >
                            Cancel order
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>

                {/* Order Details */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Qty: <strong className="font-data tabular-nums text-foreground">{order.qty}</strong>
                    {order.filledQty > 0 && (
                      <span className="text-green-500"> ({order.filledQty} filled)</span>
                    )}
                  </span>
                  {order.limitPrice !== null && (
                    <span>
                      Limit: <strong className="font-data tabular-nums text-foreground">{formatUsd(order.limitPrice)}</strong>
                    </span>
                  )}
                  {order.stopPrice !== null && (
                    <span>
                      Stop: <strong className="font-data tabular-nums text-foreground">{formatUsd(order.stopPrice)}</strong>
                    </span>
                  )}
                  {order.trailPercent !== null && (
                    <span>
                      Trail: <strong className="font-data tabular-nums text-foreground">{order.trailPercent}%</strong>
                    </span>
                  )}
                  {order.trailPrice !== null && (
                    <span>
                      Trail $: <strong className="font-data tabular-nums text-foreground">{formatUsd(order.trailPrice)}</strong>
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {order.timeInForce.toUpperCase()} • {formatTime(order.createdAt)}
                  </span>
                </div>

                {/* Legs (bracket/OCO children) */}
                {order.legs && order.legs.length > 0 && (
                  <div className="mt-2 rounded-md border border-muted bg-muted/20 p-2 space-y-1.5">
                    <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      Linked broker exits
                    </div>
                    {order.legs.map((leg) => (
                      <div key={leg.id} className="flex flex-wrap items-center gap-2 text-xs lg:flex-nowrap">
                        <Badge
                          variant={leg.stopPrice !== null ? "destructive" : "secondary"}
                          className="text-xs py-0"
                        >
                          {getLinkedExitLabel(leg)}
                        </Badge>
                        <span className={getSideColor(leg.side)}>
                          {leg.side.toUpperCase()} {leg.symbol}
                        </span>
                        <span className="text-muted-foreground">
                          Qty: <span className="font-data tabular-nums text-foreground">{leg.qty}</span>
                        </span>
                        {leg.limitPrice !== null && (
                          <span className="text-muted-foreground">
                            Limit: <span className="font-data tabular-nums text-foreground">{formatUsd(leg.limitPrice)}</span>
                          </span>
                        )}
                        {leg.stopPrice !== null && (
                          <span className="text-muted-foreground">
                            Stop: <span className="font-data tabular-nums text-foreground">{formatUsd(leg.stopPrice)}</span>
                          </span>
                        )}
                        {!isNoiseOrderStatus(leg.status) && (
                          <Badge
                            variant={getStatusBadgeVariant(leg.status)}
                            className="text-xs py-0"
                          >
                            {leg.status}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Inline Edit Form */}
                {editingOrderId === order.id && (
                  <>
                    <Separator className="my-2" />
                    <div className="space-y-2">
                      <div className="text-xs font-medium flex items-center gap-1 text-primary">
                        <ArrowUpDown className="h-3 w-3" />
                        Modify Order
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Qty</Label>
                          <Input
                            type="number"
                            min="1"
                            value={editValues.qty || ""}
                            onChange={(e) =>
                              setEditValues({ ...editValues, qty: e.target.value })
                            }
                            className="h-8 text-sm"
                          />
                        </div>
                        {(order.type === "limit" || order.type === "stop_limit") && (
                          <div className="space-y-1">
                            <Label className="text-xs">Limit Price</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editValues.limitPrice || ""}
                              onChange={(e) =>
                                setEditValues({ ...editValues, limitPrice: e.target.value })
                              }
                              className="h-8 text-sm"
                            />
                          </div>
                        )}
                        {(order.type === "stop" || order.type === "stop_limit") && (
                          <div className="space-y-1">
                            <Label className="text-xs">Stop Price</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editValues.stopPrice || ""}
                              onChange={(e) =>
                                setEditValues({ ...editValues, stopPrice: e.target.value })
                              }
                              className="h-8 text-sm"
                            />
                          </div>
                        )}
                        <div className="space-y-1">
                          <Label className="text-xs">TIF</Label>
                          <Select
                            value={order.type === "limit" && order.side === "sell" ? "gtc" : editValues.timeInForce}
                            onValueChange={(v) =>
                              setEditValues({
                                ...editValues,
                                timeInForce: order.type === "limit" && order.side === "sell" ? "gtc" : v,
                              })
                            }
                          >
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="day" disabled={order.type === "limit" && order.side === "sell"}>DAY</SelectItem>
                              <SelectItem value="gtc">GTC</SelectItem>
                              <SelectItem value="ioc" disabled={order.type === "limit" && order.side === "sell"}>IOC</SelectItem>
                              <SelectItem value="fok" disabled={order.type === "limit" && order.side === "sell"}>FOK</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => submitModify(order)}
                          disabled={modifyMutation.isPending}
                          className="gap-1"
                        >
                          <Check className="h-3.5 w-3.5" />
                          {modifyMutation.isPending ? "Saving..." : "Save Changes"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingOrderId(null);
                            setEditValues({});
                          }}
                          className="gap-1"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      {statusMessage && (
        <div className={`mx-4 mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${statusMessage.type === "error" ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-transparent bg-gain-tint text-green-500"}`}>
          <AlertCircle className="h-4 w-4 shrink-0" />
          {statusMessage.message}
        </div>
      )}
      </CardContent>
      )}
    </Card>
  );
}
