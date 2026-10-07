"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatExitPriceUsd, formatUsd } from "@/lib/format";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  X,
  DollarSign,
  Percent,
  AlertTriangle,
  Pencil,
  Check,
  Share2,
  Sparkles,
  Trash2,
  BarChart2,
  Zap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ClosePositionModal } from "@/components/trade/close-position-modal";
import { ClosePositionAlertDialog } from "@/components/trade/close-position-alert-dialog";
import { SharePnlModal } from "@/components/trade/share-pnl-modal";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { EmptyState } from "@/components/ui/empty-state";
import { STOP_LOSS_PRICE_INPUT_PROPS } from "@/components/trade/stop-loss-save";
import {
  dispatchStopLossEdit,
  dispatchStopLossSave,
  dispatchTakeProfitEdit,
  dispatchTakeProfitSave,
  type StopLossEditVariables,
} from "@/components/trade/stock-exit-save";
import {
  applyStopPriceOverrides,
  updateStopPriceInPositions,
} from "@/components/trade/position-stop-loss-overrides";
import { SubmitIntentStore } from "@/components/trade/order-idempotency";
import { ClosedOrdersList } from "@/components/trade/closed-orders-list";
import { useClosedOrders } from "@/components/trade/closed-orders-query";
import {
  PositionsPanelHeader,
  parsePositionsSort,
  type PositionsSortKey,
} from "@/components/trade/positions-panel-header";

interface Position {
  symbol: string;
  assetClass: string;
  exchange: string;
  qty: number;
  qtyAvailable: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number;
  lastDayPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  unrealizedIntradayPL: number;
  unrealizedIntradayPLPercent: number;
  changeToday: number;
  /**
   * Realized P&L banked on this position since it was opened ("RPNL"). Null
   * when the position predates the server's fill window, in which case the row
   * shows a dash rather than an understated number.
   */
  realizedPnl?: number | null;
  stopLossOrders: { id: string; stopPrice: number; qty: number; type: string }[];
  takeProfitOrders: { id: string; limitPrice: number; qty: number }[];
  trailingStopOrders: { id: string; trailPercent: number | null; trailPrice: number | null; stopPrice: number | null; qty: number }[];
  /** Populated when this position was opened via copy trading or a sidebar copy action. */
  copySourceLabel?: string | null;
}

const POSITIONS_SORT_KEY = "ready-set-trade.positions-sort-v1";

export function PositionsPanel({
  isSignedIn,
  selectedSymbol,
  onlySelectedSymbol = false,
  activeCredentialId,
  credentialsLoading = false,
  embedded = false,
  onAskAi,
  onSelectSymbol,
  onViewChart,
  onTrade,
  onBrowseSignals,
}: {
  isSignedIn: boolean;
  selectedSymbol?: string;
  /** Limit the open-position list to `selectedSymbol`. */
  onlySelectedSymbol?: boolean;
  activeCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
  /**
   * True while the user's saved credentials are still being fetched. Until that
   * resolves we don't yet know which account (if any) is active, so we show a
   * loading state instead of flashing the "Set your trading credentials" prompt.
   */
  credentialsLoading?: boolean;
  embedded?: boolean;
  /**
   * Opens AI chat and prefills a research prompt for the given symbol.
   * Optional so the panel still works in isolation.
   */
  onAskAi?: (symbol: string) => void;
  /**
   * Called when the user clicks a position row. Prefills the trade form's
   * symbol field with the position's symbol so the user can quickly act on it.
   */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * Called when the user clicks the chart button on a position row. Should
   * update the active symbol so the chart switches to that ticker.
   */
  onViewChart?: (symbol: string) => void;
  /**
   * Called when the user clicks the trade button on a position row. Should
   * navigate to the trade form with that symbol pre-selected.
   */
  onTrade?: (symbol: string) => void;
  /**
   * Route the user back to the signal feed. We are signal-first, so an empty
   * or unconfigured positions list offers "read signals" first and connecting
   * a broker second. Only the mobile shell passes this: on the terminal the
   * feed is already on screen in the left rail, and a button pointing at
   * something already visible is noise.
   */
  onBrowseSignals?: () => void;
}) {
  const positionsCollapse = useCollapsible("positions");
  const [showClosed, setShowClosed] = useState(false);
  const [sortBy, setSortByRaw] = useState<PositionsSortKey>("date");
  useEffect(() => {
    setSortByRaw(parsePositionsSort(window.localStorage.getItem(POSITIONS_SORT_KEY)));
  }, []);
  const setSortBy = (v: PositionsSortKey) => {
    setSortByRaw(v);
    window.localStorage.setItem(POSITIONS_SORT_KEY, v);
  };
  const [optimisticStopPrices, setOptimisticStopPrices] = useState<Record<string, number>>({});
  const trpcUtils = trpc.useUtils();
  const closeIntentRef = useRef(new SubmitIntentStore());

  // Fetch positions
  const positionsQuery = trpc.positions.list.useQuery({ credentialId: activeCredentialId }, {
    enabled: !!activeCredentialId,
    refetchInterval: 30000, // Refresh every 30s
  });

  // Closed orders (history): the same bounded, paged query the desktop
  // drawer's History tab reads, so the two surfaces cannot drift. It only
  // fires while the Closed view is active here.
  const closed = useClosedOrders({
    credentialId: activeCredentialId,
    active: showClosed,
  });

  // Close position mutation
  const closePositionMutation = trpc.positions.close.useMutation({
    onSuccess: (data, variables) => {
      if (data.success) {
        closeIntentRef.current.complete(variables.idempotencyKey);
        toast.success(data.message ?? "Closing order submitted");
      } else {
        toast.info(data.message);
      }
      positionsQuery.refetch();
      trpcUtils.positions.account.invalidate({
        credentialId: variables.credentialId,
      });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Update stop-loss mutation
  const updateStopLossMutation = trpc.positions.updateStopLoss.useMutation({
    onMutate: async ({ credentialId, stopOrderId, stopPrice }) => {
      const queryInput = { credentialId };

      setOptimisticStopPrices((current) => ({
        ...current,
        [stopOrderId]: stopPrice,
      }));

      await trpcUtils.positions.list.cancel(queryInput);
      const previousPositions = trpcUtils.positions.list.getData(queryInput);

      trpcUtils.positions.list.setData(queryInput, (current) =>
        updateStopPriceInPositions(current, stopOrderId, stopPrice)
      );

      return { previousPositions, queryInput, stopOrderId };
    },
    onSuccess: (data, variables) => {
      toast.success("Stop loss updated");

      // Alpaca's replaceOrder cancels the original order and issues a NEW one
      // with a different ID. Swap old → new in both the optimistic-price map
      // and the TRPC cache so the UI stays correct during the brief window
      // before the next refetch returns the new order from Alpaca.
      const queryInput = { credentialId: variables.credentialId };
      const newOrderId = data.orderId;
      const newStopPrice = data.stopPrice;

      setOptimisticStopPrices((current) => {
        const next = { ...current };
        delete next[variables.stopOrderId];
        // Track the new order ID so the cleanup effect doesn't prematurely
        // drop the override when the refetch arrives with the new order.
        next[newOrderId] = newStopPrice;
        return next;
      });

      trpcUtils.positions.list.setData(queryInput, (current) => {
        if (!current) return current;
        return current.map((pos) => ({
          ...pos,
          stopLossOrders: pos.stopLossOrders.map((order) =>
            order.id === variables.stopOrderId
              ? { ...order, id: newOrderId, stopPrice: newStopPrice }
              : order
          ),
        }));
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousPositions) {
        trpcUtils.positions.list.setData(context.queryInput, context.previousPositions);
      }
      if (context?.stopOrderId) {
        setOptimisticStopPrices((current) => {
          const next = { ...current };
          delete next[context.stopOrderId];
          return next;
        });
      }
      toast.error(error.message);
    },
    onSettled: (_data, _error, variables) => {
      // Delay the background refetch by 2 s. Alpaca's replaceOrder creates a
      // new order and there's a short propagation gap where the positions API
      // returns neither the old nor the new stop order. An immediate invalidate
      // hits that gap, which causes the cleanup useEffect to drop the optimistic
      // override (old ID gone from live data) and revert the displayed price.
      setTimeout(() => {
        trpcUtils.positions.list.invalidate({ credentialId: variables.credentialId });
      }, 2000);
    },
  });

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  };

  useEffect(() => {
    setOptimisticStopPrices((current) => {
      if (Object.keys(current).length === 0) return current;

      const next = { ...current };
      const liveStopOrderIds = new Set<string>();
      let changed = false;

      for (const position of positionsQuery.data ?? []) {
        for (const order of position.stopLossOrders ?? []) {
          liveStopOrderIds.add(order.id);
          const optimisticStopPrice = current[order.id];
          if (
            optimisticStopPrice !== undefined &&
            Math.abs(order.stopPrice - optimisticStopPrice) < 0.005
          ) {
            delete next[order.id];
            changed = true;
          }
        }
      }

      for (const orderId of Object.keys(current)) {
        if (!liveStopOrderIds.has(orderId)) {
          delete next[orderId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [positionsQuery.data]);

  const positions = applyStopPriceOverrides(
    positionsQuery.data || [],
    optimisticStopPrices,
  )
    .filter(
      (position) =>
        !onlySelectedSymbol ||
        !selectedSymbol ||
        position.symbol.toUpperCase() === selectedSymbol.toUpperCase(),
    )
    .sort((a, b) => {
      if (sortBy === "pnl") return b.unrealizedPL - a.unrealizedPL;
      if (sortBy === "value") return b.marketValue - a.marketValue;
      return 0; // "date": keep the API order (broker returns positions chronologically)
    });

  // While saved credentials are still loading we don't yet know whether an
  // account is active, so the panel should show a loading state rather than
  // flashing the "Set your trading credentials" empty state.
  const awaitingCredentials = credentialsLoading && !activeCredentialId;

  const totalPL = positions.reduce((sum, p) => sum + p.unrealizedPL, 0);
  const totalValue = positions.reduce((sum, p) => sum + p.marketValue, 0);

  return (
    <div
      className={cn(
        "min-w-0 max-w-full space-y-4",
        embedded && "xl:h-full xl:min-h-0 xl:overflow-hidden",
      )}
    >
      {/* Positions */}
      <Card
        className={cn(
          "premium-panel",
          embedded &&
            "xl:h-full xl:min-h-0 gap-0 rounded-none border-0 bg-background py-0 shadow-none",
        )}
      >
        <PositionsPanelHeader
          embedded={embedded}
          showClosed={showClosed}
          onShowClosedChange={setShowClosed}
          sortBy={sortBy}
          onSortByChange={setSortBy}
          description={
            showClosed ? (
              <>Recent filled / canceled orders</>
            ) : awaitingCredentials ? (
              <>Loading...</>
            ) : !isSignedIn ? (
              <>Sign in required</>
            ) : !activeCredentialId ? (
              <>No enabled account</>
            ) : (
              <>
                {positions.length} position{positions.length !== 1 ? "s" : ""} •{" "}
                <span className={`font-data tabular-nums ${totalPL >= 0 ? "text-green-500" : "text-destructive"}`}>
                  {formatCurrency(totalPL)} ({formatPercent((totalPL / (totalValue - totalPL)) * 100 || 0)})
                </span>
              </>
            )
          }
          collapseAction={
            !embedded ? (
              <CollapseButton
                collapsed={positionsCollapse.collapsed}
                onToggle={positionsCollapse.toggle}
                label="Positions"
              />
            ) : null
          }
        />
        {!positionsCollapse.collapsed && (
        <CardContent
          className={cn(
            embedded &&
              "min-w-0 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain p-0",
          )}
        >
          {showClosed ? (
            awaitingCredentials ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                Loading closed orders...
              </div>
            ) : !isSignedIn ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                Sign in to see closed orders.
              </div>
            ) : !activeCredentialId ? (
              <EmptyState
                icon={BarChart2}
                title="No stock account connected"
                body="Closed Alpaca stock and option orders show up here. Perp fills live on the perps venue."
                actions={[
                  {
                    label: "Connect Alpaca",
                    href: "/settings",
                    emphasis: "secondary" as const,
                  },
                ]}
              />
            ) : (
              <ClosedOrdersList
                isLoading={closed.isLoading}
                error={closed.error}
                orders={closed.orders}
                sortBy={sortBy}
                onViewChart={onViewChart}
                onTrade={onTrade}
                canLoadMore={closed.canLoadMore}
                isLoadingMore={closed.isLoadingMore}
                onLoadMore={closed.loadMore}
              />
            )
          ) : positionsQuery.isLoading || awaitingCredentials ? (
            <div className="text-sm text-muted-foreground">Loading positions...</div>
          ) : !isSignedIn ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Sign in to see open positions.
            </div>
          ) : !activeCredentialId ? (
            // Name the venue. This panel is Alpaca stocks and options only, so
            // "set your trading credentials" read as a blanket instruction to a
            // perps-only user whose account is already fully configured.
            <EmptyState
              icon={BarChart2}
              title="No stock account connected"
              body="This list shows Alpaca stock and option positions. Perp positions live on the perps venue."
              actions={[
                ...(onBrowseSignals
                  ? [{ label: "Browse signals", onClick: onBrowseSignals }]
                  : []),
                {
                  label: "Connect Alpaca",
                  href: "/settings",
                  emphasis: "secondary" as const,
                },
              ]}
            />
          ) : positionsQuery.error ? (
            <div className="py-8 text-center text-sm text-destructive flex flex-col items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {positionsQuery.error.message.includes("Authentication required")
                ? "Your session expired. Refresh the page to sign in again."
                : positionsQuery.error.message}
            </div>
          ) : positions.length === 0 ? (
            <EmptyState
              icon={BarChart2}
              title="No open positions"
              body="Positions show up here once an order fills. Most trades here start from a call in the signal feed."
              actions={
                onBrowseSignals
                  ? [{ label: "Browse signals", onClick: onBrowseSignals }]
                  : []
              }
            />
          ) : (
            <div
              className={cn(
                !embedded && "space-y-3",
                embedded && "@container/stockpos",
              )}
            >
              {embedded && (
                /* Keep the primary row readable at narrow phone widths. Full
                 * entry, value, SL and TP numbers live in a labeled 2-column
                 * summary directly below each row instead of being squeezed
                 * into fixed 48px cells. */
                <div className="sticky top-0 z-10 grid grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_44px_44px] @max-[359px]/stockpos:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_44px_44px] items-center border-b bg-background/95 px-3 py-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground xl:grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_24px_24px]">
                  <span>Symbol</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">uPnL</span>
                  <span />
                  <span />
                </div>
              )}
              {positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  compact={embedded}
                  credentialId={activeCredentialId}
                  onAskAi={onAskAi}
                  onSelectSymbol={onSelectSymbol}
                  onViewChart={onViewChart}
                  onTrade={onTrade}
                  onClose={(opts) => {
                    const close = {
                      symbol: position.symbol,
                      credentialId: activeCredentialId,
                      qty: opts.qty,
                      orderType: opts.orderType,
                      limitPrice: opts.limitPrice,
                    };
                    closePositionMutation.mutate({
                      ...close,
                      idempotencyKey: closeIntentRef.current.get(JSON.stringify(close)),
                    });
                  }}
                  onFullClose={() => {
                    const close = {
                      symbol: position.symbol,
                      credentialId: activeCredentialId,
                    };
                    closePositionMutation.mutate({
                      ...close,
                      idempotencyKey: closeIntentRef.current.get(JSON.stringify(close)),
                    });
                  }}
                  isClosing={closePositionMutation.isPending}
                  closeError={closePositionMutation.error?.message ?? null}
                  closeSucceeded={closePositionMutation.isSuccess}
                  closingSymbol={closePositionMutation.variables?.symbol ?? null}
                  resetClose={() => closePositionMutation.reset()}
                  onUpdateStopLoss={(variables) =>
                    updateStopLossMutation.mutate(variables)
                  }
                  isUpdatingStopLoss={updateStopLossMutation.isPending}
                  updateStopLossError={updateStopLossMutation.error?.message ?? null}
                  updatingStopOrderId={updateStopLossMutation.variables?.stopOrderId ?? null}
                  stopLossUpdateSucceeded={updateStopLossMutation.isSuccess}
                  resetStopLossUpdate={() => updateStopLossMutation.reset()}
                />
              ))}
            </div>
          )}
        </CardContent>
        )}
      </Card>
    </div>
  );
}

function PositionRow({
  position,
  compact = false,
  credentialId,
  onAskAi,
  onSelectSymbol,
  onViewChart,
  onTrade,
  onClose,
  onFullClose,
  isClosing,
  closeError,
  closeSucceeded,
  closingSymbol,
  resetClose,
  onUpdateStopLoss,
  isUpdatingStopLoss,
  updateStopLossError,
  updatingStopOrderId,
  stopLossUpdateSucceeded,
  resetStopLossUpdate,
}: {
  position: Position;
  compact?: boolean;
  credentialId?: string;
  onAskAi?: (symbol: string) => void;
  /** Prefills the trade form's symbol when the row is clicked. */
  onSelectSymbol?: (symbol: string) => void;
  /** Switches the center chart to this ticker. */
  onViewChart?: (symbol: string) => void;
  /** Opens the trade form with this ticker pre-selected. */
  onTrade?: (symbol: string) => void;
  onClose: (opts: { qty: number; orderType: "market" | "limit"; limitPrice?: number }) => void;
  onFullClose: () => void;
  isClosing: boolean;
  closeError: string | null;
  closeSucceeded: boolean;
  closingSymbol: string | null;
  resetClose: () => void;
  onUpdateStopLoss: (variables: StopLossEditVariables) => void;
  isUpdatingStopLoss: boolean;
  updateStopLossError: string | null;
  updatingStopOrderId: string | null;
  stopLossUpdateSucceeded: boolean;
  resetStopLossUpdate: () => void;
}) {
  const trpcUtils = trpc.useUtils();
  const exitIntentRef = useRef(new SubmitIntentStore());
  const [showDetails, setShowDetails] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  // Quick-close dialog: shown when the compact-row X button is tapped.
  // Uses a simple full-position market close (same UX as the perp close button).
  const [showQuickCloseDialog, setShowQuickCloseDialog] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const sharePnlMutation = trpc.pnlImage.generateOpenPosition.useMutation();

  // Stop-loss editing (existing)
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [draftStopPrice, setDraftStopPrice] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Take-profit editing (new)
  const [editingTpId, setEditingTpId] = useState<string | null>(null);
  const [draftTpPrice, setDraftTpPrice] = useState("");
  const [tpValidationError, setTpValidationError] = useState<string | null>(null);

  // Add stop-loss inline form
  const [showAddSL, setShowAddSL] = useState(false);
  const [newSLPrice, setNewSLPrice] = useState("");
  const [newSLQty, setNewSLQty] = useState("");
  const [newSLError, setNewSLError] = useState<string | null>(null);

  // Add take-profit inline form
  const [showAddTP, setShowAddTP] = useState(false);
  const [newTPPrice, setNewTPPrice] = useState("");
  const [newTPQty, setNewTPQty] = useState("");
  const [newTPError, setNewTPError] = useState<string | null>(null);

  // Cancel exit order - inline confirm state
  const [cancelingOrderId, setCancelingOrderId] = useState<string | null>(null);

  const cancelExitOrderMutation = trpc.positions.cancelExitOrder.useMutation({
    onMutate: async ({ credentialId: credId, orderId }) => {
      const queryInput = { credentialId: credId };
      await trpcUtils.positions.list.cancel(queryInput);
      const previousPositions = trpcUtils.positions.list.getData(queryInput);
      // Optimistically remove the order from whichever array it belongs to
      trpcUtils.positions.list.setData(queryInput, (current) => {
        if (!current) return current;
        return current.map((pos) => ({
          ...pos,
          stopLossOrders: pos.stopLossOrders.filter((o) => o.id !== orderId),
          takeProfitOrders: pos.takeProfitOrders.filter((o) => o.id !== orderId),
          trailingStopOrders: pos.trailingStopOrders.filter((o) => o.id !== orderId),
        }));
      });
      return { previousPositions, queryInput };
    },
    onSuccess: (data) => {
      toast.success(data.message);
      setCancelingOrderId(null);
    },
    onError: (error, _variables, context) => {
      if (context?.previousPositions) {
        trpcUtils.positions.list.setData(context.queryInput, context.previousPositions);
      }
      toast.error(error.message);
      setCancelingOrderId(null);
    },
    onSettled: (_data, _error, variables) => {
      trpcUtils.positions.list.invalidate({ credentialId: variables.credentialId });
    },
  });

  // Update take-profit mutation (lives here because it's per-row)
  const updateTakeProfitMutation = trpc.positions.updateTakeProfit.useMutation({
    onSuccess: () => {
      toast.success("Take profit updated");
      setEditingTpId(null);
      setDraftTpPrice("");
      setTpValidationError(null);
      trpcUtils.positions.list.invalidate({ credentialId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Add exit orders mutation (reuses createExitStrategy)
  const addExitOrdersMutation = trpc.positions.createExitStrategy.useMutation({
    onSuccess: (data, variables) => {
      if (data.success) {
        exitIntentRef.current.complete(variables.idempotencyKey);
        toast.success("Order added successfully");
      } else {
        toast.error(data.errors[0] ?? "Failed to add order");
        return;
      }
      setShowAddSL(false);
      setShowAddTP(false);
      setNewSLPrice("");
      setNewTPPrice("");
      setNewSLError(null);
      setNewTPError(null);
      trpcUtils.positions.list.invalidate({ credentialId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // This row's available qty for closing - fall back to qty if the broker
  // didn't report a separate available amount.
  const availableQty = position.qtyAvailable ?? position.qty;

  // Whether a close mutation in flight / just succeeded belongs to THIS row.
  const isThisClosing = isClosing && closingSymbol === position.symbol;
  const closeErrorForThisRow =
    closingSymbol === position.symbol ? closeError : null;

  const openCloseModal = () => {
    // Clear any sticky success/error from a prior close so reopening is clean.
    resetClose();
    setShowCloseModal(true);
  };

  const cancelCloseModal = () => {
    setShowCloseModal(false);
    resetClose();
  };

  // Close either close dialog once a close for this row succeeds.
  useEffect(() => {
    if (closeSucceeded && closingSymbol === position.symbol) {
      if (showCloseModal) setShowCloseModal(false);
      if (showQuickCloseDialog) setShowQuickCloseDialog(false);
    }
  }, [showCloseModal, showQuickCloseDialog, closeSucceeded, closingSymbol, position.symbol]);

  const startEditingStop = (sl: { id: string; stopPrice: number }) => {
    // Clear any sticky success/error from a prior save so re-editing the same
    // stop (or reopening after a failure) doesn't auto-close or show a stale error.
    resetStopLossUpdate();
    setEditingStopId(sl.id);
    setDraftStopPrice(String(sl.stopPrice));
    setValidationError(null);
  };

  const cancelEditingStop = () => {
    setEditingStopId(null);
    setDraftStopPrice("");
    setValidationError(null);
  };

  const saveStop = (stopOrderId: string) => {
    const result = dispatchStopLossEdit(
      {
        rawValue: draftStopPrice,
        side: position.side,
        currentPrice: position.currentPrice,
        credentialId,
        stopOrderId,
      },
      onUpdateStopLoss,
    );

    if (result.echoValue !== undefined) {
      setDraftStopPrice(result.echoValue);
    }

    if (!result.success) {
      setValidationError(result.error);
      return;
    }

    setValidationError(null);
  };

  // Close the inline editor once a save succeeds for the row being edited.
  useEffect(() => {
    if (
      editingStopId !== null &&
      stopLossUpdateSucceeded &&
      updatingStopOrderId === editingStopId
    ) {
      setEditingStopId(null);
      setDraftStopPrice("");
      setValidationError(null);
    }
  }, [editingStopId, stopLossUpdateSucceeded, updatingStopOrderId]);

  // ---- Take-profit editing handlers ----
  const startEditingTP = (tp: { id: string; limitPrice: number }) => {
    setEditingTpId(tp.id);
    setDraftTpPrice(String(tp.limitPrice));
    setTpValidationError(null);
  };

  const cancelEditingTP = () => {
    setEditingTpId(null);
    setDraftTpPrice("");
    setTpValidationError(null);
  };

  const saveEditTP = (tpOrderId: string) => {
    const result = dispatchTakeProfitEdit(
      {
        rawValue: draftTpPrice,
        side: position.side,
        currentPrice: position.currentPrice,
        credentialId,
        tpOrderId,
      },
      (variables) => updateTakeProfitMutation.mutate(variables),
    );
    if (!result.success) {
      setTpValidationError(result.error);
      return;
    }
    setTpValidationError(null);
  };

  // ---- Add stop-loss handlers ----
  const openAddSL = () => {
    setNewSLPrice("");
    setNewSLQty(String(Math.floor(position.qty)));
    setNewSLError(null);
    setShowAddSL(true);
  };

  const cancelAddSL = () => {
    setShowAddSL(false);
    setNewSLPrice("");
    setNewSLError(null);
  };

  const saveNewSL = () => {
    if (!credentialId) return;
    const result = dispatchStopLossSave(
      newSLPrice,
      {
        side: position.side,
        currentPrice: position.currentPrice,
      },
      (stopPrice) => {
        const qty = parseInt(newSLQty);
        if (isNaN(qty) || qty <= 0) {
          setNewSLError("Enter a valid quantity");
          return;
        }
        setNewSLError(null);
        const exitSide: "buy" | "sell" =
          position.side === "long" ? "sell" : "buy";
        const exitOrder = {
          symbol: position.symbol,
          credentialId,
          exitSide,
          takeProfits: [],
          stopLoss: { stopPrice, qty },
        };
        addExitOrdersMutation.mutate({
          ...exitOrder,
          idempotencyKey: exitIntentRef.current.get(JSON.stringify(exitOrder)),
        });
      },
    );

    if (result.echoValue !== undefined) {
      setNewSLPrice(result.echoValue);
    }

    if (!result.success) setNewSLError(result.error);
  };

  // ---- Add take-profit handlers ----
  const openAddTP = () => {
    setNewTPPrice("");
    setNewTPQty(String(Math.floor(position.qty)));
    setNewTPError(null);
    setShowAddTP(true);
  };

  const cancelAddTP = () => {
    setShowAddTP(false);
    setNewTPPrice("");
    setNewTPError(null);
  };

  const saveNewTP = () => {
    if (!credentialId) return;
    const result = dispatchTakeProfitSave(
      newTPPrice,
      {
        side: position.side,
        currentPrice: position.currentPrice,
      },
      (price) => {
        const qty = parseInt(newTPQty);
        if (isNaN(qty) || qty <= 0) {
          setNewTPError("Enter a valid quantity");
          return;
        }
        setNewTPError(null);
        const exitSide: "buy" | "sell" =
          position.side === "long" ? "sell" : "buy";
        const exitOrder = {
          symbol: position.symbol,
          credentialId,
          exitSide,
          takeProfits: [{ price, qty }],
        };
        addExitOrdersMutation.mutate({
          ...exitOrder,
          idempotencyKey: exitIntentRef.current.get(JSON.stringify(exitOrder)),
        });
      },
    );
    if (!result.success) setNewTPError(result.error);
  };

  const isProfitable = position.unrealizedPL >= 0;
  const realizedPnl = position.realizedPnl ?? null;
  const realizedClass = cn(
    realizedPnl != null && realizedPnl > 0 && "text-green-400",
    realizedPnl != null && realizedPnl < 0 && "text-red-400",
  );
  const realizedLabel = realizedPnl == null ? "–" : formatUsd(realizedPnl);
  const realizedTitle =
    realizedPnl == null
      ? "This position opened before the loaded fill history, so its realized P&L cannot be computed"
      : "Realized P&L banked on this position since it was opened";
  const isOption = position.assetClass === "us_option";
  const hasStopLoss = (position.stopLossOrders?.length ?? 0) > 0;
  const hasTakeProfit = (position.takeProfitOrders?.length ?? 0) > 0;
  const hasTrailingStop = (position.trailingStopOrders?.length ?? 0) > 0;

  const openStopEditor = () => {
    setShowDetails(true);
    const stop = position.stopLossOrders?.[0];
    if (stop) startEditingStop(stop);
    else openAddSL();
  };

  const openTakeProfitEditor = () => {
    setShowDetails(true);
    const takeProfit = position.takeProfitOrders?.[0];
    if (takeProfit) startEditingTP(takeProfit);
    else openAddTP();
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  const toggleDetails = () => {
    setShowDetails((current) => !current);
    onSelectSymbol?.(position.symbol);
  };

  return (
    <article
      className={cn(
        "min-w-0 max-w-full cursor-pointer border transition-colors hover:bg-accent/40",
        compact
          ? "rounded-lg border bg-card/60 px-3 py-2 xl:rounded-none xl:border-x-0 xl:border-t-0 xl:bg-transparent"
          : "premium-panel rounded-lg bg-card p-3",
      )}
      onClick={toggleDetails}
    >
      {compact && (
        /* The primary row stays compact while a labeled summary below it keeps
         * full entry, value, SL and TP prices visible on every phone width. */
        <>
          <div className="grid grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_44px_44px] @max-[359px]/stockpos:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_44px_44px] items-center text-sm xl:grid-cols-[minmax(80px,1fr)_44px_minmax(72px,auto)_24px_24px]">
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                onViewChart?.(position.symbol);
              }}
              aria-label={`View ${position.symbol} chart`}
              title="View chart"
            >
              <span className="truncate font-data font-semibold">{position.symbol}</span>
              <span
                className={cn(
                  "shrink-0 rounded px-1 py-0.5 text-3xs font-semibold uppercase",
                  position.side === "long"
                    ? "bg-gain-tint text-green-500"
                    : "bg-loss-tint text-red-500",
                )}
              >
                {position.side}
              </span>
            </button>
            <span className="text-right font-data tabular-nums text-xs">{position.qty}</span>
            <span
              className={cn(
                "text-right font-data tabular-nums text-xs",
                isProfitable ? "text-green-400" : "text-red-400",
              )}
            >
              {formatCurrency(position.unrealizedPL)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-11 w-11 shrink-0 p-0 xl:h-6 xl:w-6"
              aria-expanded={showDetails}
              aria-label={`${showDetails ? "Close" : "Open"} ${position.symbol} position details`}
              title={showDetails ? "Hide position details" : "Show position details"}
              onClick={(event) => {
                event.stopPropagation();
                toggleDetails();
              }}
            >
              {showDetails ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="h-11 w-11 shrink-0 p-0 xl:h-6 xl:w-6"
              title="Close position"
              aria-label={`Close ${position.symbol} position`}
              onClick={(event) => {
                event.stopPropagation();
                resetClose();
                setShowQuickCloseDialog(true);
              }}
              disabled={isThisClosing}
            >
              <X />
            </Button>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-data text-3xs leading-tight text-muted-foreground">
            <span className="flex min-w-0 justify-between gap-2">
              <span>Entry</span>
              <span className="truncate text-foreground">{formatCurrency(position.avgEntryPrice)}</span>
            </span>
            <span className="flex min-w-0 justify-between gap-2">
              <span>Value</span>
              <span className="truncate text-foreground">{formatCurrency(position.marketValue)}</span>
            </span>
            <span className="flex min-w-0 justify-between gap-2" title={realizedTitle}>
              <span>RPNL</span>
              <span className={cn("truncate text-foreground", realizedClass)}>
                {realizedLabel}
              </span>
            </span>
            <span className="flex min-w-0 justify-between gap-2">
              <span>Stop loss</span>
              <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
                <span className="truncate">
                {hasStopLoss ? formatExitPriceUsd(position.stopLossOrders[0]!.stopPrice) : "–"}
                </span>
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground xl:h-6 xl:w-6"
                  aria-label={`Edit stop loss for ${position.symbol}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openStopEditor();
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </span>
            </span>
            <span className="flex min-w-0 justify-between gap-2">
              <span>Take profit</span>
              <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
                <span className="truncate">
                {hasTakeProfit ? formatExitPriceUsd(position.takeProfitOrders[0]!.limitPrice) : "–"}
                </span>
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground xl:h-6 xl:w-6"
                  aria-label={`Edit take profit for ${position.symbol}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openTakeProfitEditor();
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </span>
            </span>
            {position.copySourceLabel && (
              <span className="col-span-2 truncate">
                Copied from <span className="text-primary/80">{position.copySourceLabel}</span>
              </span>
            )}
          </div>
        </>
      )}

      {!compact && (
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={cn(
              "shrink-0",
              compact ? "mt-0.5 rounded px-1.5 py-1" : "rounded-full p-2",
              isProfitable
                ? "bg-gain-tint text-green-500"
                : "bg-loss-tint text-red-500",
            )}
          >
            {isProfitable ? (
              <TrendingUp className="h-4 w-4" />
            ) : (
              <TrendingDown className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            {onViewChart ? (
              <button
                type="button"
                className="flex flex-wrap items-center gap-2 rounded-sm text-left font-medium outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring lg:flex-nowrap"
                onClick={(event) => {
                  event.stopPropagation();
                  onViewChart(position.symbol);
                }}
                aria-label={`View ${position.symbol} chart`}
                title="View chart"
              >
                {position.symbol}
                <Badge variant="outline" className="text-xs">
                  {position.side.toUpperCase()}
                </Badge>
                {isOption && (
                  <Badge variant="secondary" className="text-xs">
                    Option
                  </Badge>
                )}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 font-medium lg:flex-nowrap">
                {position.symbol}
                <Badge variant="outline" className="text-xs">
                  {position.side.toUpperCase()}
                </Badge>
                {isOption && (
                  <Badge variant="secondary" className="text-xs">
                    Option
                  </Badge>
                )}
              </div>
            )}
            <div className="text-xs text-muted-foreground truncate">
              {position.qty} {isOption ? "contracts" : "shares"} @ {formatCurrency(position.avgEntryPrice)}
              {position.copySourceLabel && (
                <span> · copied from <span className="text-primary/80">{position.copySourceLabel}</span></span>
              )}
            </div>
            {/* Exit-plan summary always visible on the collapsed card.
                - If exits exist: tappable badges jump straight to the exit orders section
                  and show the actual price so the user sees their levels at a glance.
                - If no exits: a subtle "+ Set exits" shortcut opens the section in one tap.
                Both cases mean the user never has to guess or tap twice. */}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {hasStopLoss && (
                <span
                  className="inline-flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 text-3xs font-medium text-destructive cursor-pointer hover:bg-destructive/20 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setShowDetails(true); }}
                >
                  ⛔ SL {formatCurrency(position.stopLossOrders[0]!.stopPrice)}
                  {(position.stopLossOrders?.length ?? 0) > 1 && ` +${position.stopLossOrders!.length - 1}`}
                  <button
                    type="button"
                    className="ml-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded p-0.5 hover:bg-destructive/15 xl:h-6 xl:w-6"
                    aria-label={`Edit stop loss for ${position.symbol}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openStopEditor();
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </span>
              )}
              {hasTakeProfit && (
                <span
                  className="inline-flex items-center gap-0.5 rounded bg-gain-tint px-1.5 py-0.5 text-3xs font-medium text-green-500 cursor-pointer hover:bg-green-500/20 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setShowDetails(true); }}
                >
                  🎯 TP {formatCurrency(position.takeProfitOrders[0]!.limitPrice)}
                  {(position.takeProfitOrders?.length ?? 0) > 1 && ` ×${position.takeProfitOrders!.length}`}
                  <button
                    type="button"
                    className="ml-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded p-0.5 hover:bg-green-500/15 xl:h-6 xl:w-6"
                    aria-label={`Edit take profit for ${position.symbol}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openTakeProfitEditor();
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </span>
              )}
              {hasTrailingStop && (
                <span
                  className="inline-flex items-center gap-0.5 rounded bg-yellow-500/10 px-1.5 py-0.5 text-3xs font-medium text-yellow-600 dark:text-yellow-500 cursor-pointer hover:bg-yellow-500/20 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setShowDetails(true); }}
                >
                  📉 Trail
                  {position.trailingStopOrders?.[0]?.trailPercent
                    ? ` ${position.trailingStopOrders[0].trailPercent}%`
                    : ""}
                </span>
              )}
              {!hasStopLoss && !hasTakeProfit && !hasTrailingStop && (
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 rounded border border-dashed border-muted-foreground/25 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground/50 hover:border-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  onClick={(e) => { e.stopPropagation(); setShowDetails(true); }}
                >
                  + Set exits
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="text-right">
            <div className="font-data tabular-nums font-medium whitespace-nowrap">{formatCurrency(position.marketValue)}</div>
            <div
              className={`font-data tabular-nums text-sm flex items-center justify-end gap-1 whitespace-nowrap ${
                isProfitable ? "text-green-500" : "text-destructive"
              }`}
            >
              {isProfitable ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {formatCurrency(position.unrealizedPL)} ({position.unrealizedPLPercent.toFixed(2)}%)
            </div>
            <div
              className="font-data tabular-nums text-3xs whitespace-nowrap text-muted-foreground"
              title={realizedTitle}
            >
              RPNL <span className={realizedClass}>{realizedLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-expanded={showDetails}
              aria-label={`${showDetails ? "Close" : "Open"} ${position.symbol} position details`}
              title={showDetails ? "Hide position details" : "Show position details"}
              onClick={(event) => {
                event.stopPropagation();
                toggleDetails();
              }}
            >
              {showDetails ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
            {onViewChart && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewChart(position.symbol);
                }}
                aria-label={`View ${position.symbol} chart`}
                title="View chart"
              >
                <BarChart2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {onTrade && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onTrade(position.symbol);
                }}
                aria-label={`Trade ${position.symbol}`}
                title="Trade"
              >
                <Zap className="h-3.5 w-3.5" />
              </Button>
            )}
            {onAskAi && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex h-7 w-7 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onAskAi(position.symbol);
                }}
                aria-label={`Ask AI about ${position.symbol}`}
                title="Ask AI"
              >
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex h-7 w-7 p-0"
              onClick={(e) => {
                e.stopPropagation();
                setShowShareModal(true);
              }}
              aria-label={`Share ${position.symbol} P&L`}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
      )}

      <SharePnlModal
        open={showShareModal}
        symbol={position.symbol}
        onClose={() => setShowShareModal(false)}
        generate={(hideAmount) =>
          sharePnlMutation.mutateAsync({
            symbol: position.symbol,
            credentialId,
            hideAmount,
          })
        }
      />

      {/* Quick full-close confirmation (compact-row X button). Rendered outside
          the showDetails block so it works without expanding the row first. */}
      <ClosePositionAlertDialog
        open={showQuickCloseDialog}
        displayName={position.symbol}
        isPending={isThisClosing}
        onCancel={() => {
          setShowQuickCloseDialog(false);
          if (!isThisClosing) resetClose();
        }}
        onConfirm={onFullClose}
      />

      {showDetails && (
        <>
          <Separator className="my-3" />
          <div className="grid grid-cols-2 gap-3 text-sm pb-2 lg:grid-cols-4 lg:gap-4">
            <div>
              <div className="text-muted-foreground flex items-center gap-1">
                <DollarSign className="h-3 w-3" />
                Entry Price
              </div>
              <div className="font-data tabular-nums">{formatCurrency(position.avgEntryPrice)}</div>
            </div>
            <div>
              <div className="text-muted-foreground flex items-center gap-1">
                <DollarSign className="h-3 w-3" />
                Current Price
              </div>
              <div className="font-data tabular-nums">{formatCurrency(position.currentPrice)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Cost Basis</div>
              <div className="font-data tabular-nums">{formatCurrency(position.costBasis)}</div>
            </div>
            <div>
              <div className="text-muted-foreground flex items-center gap-1">
                <Percent className="h-3 w-3" />
                Today
              </div>
              <div className={`font-data tabular-nums ${position.changeToday >= 0 ? "text-green-500" : "text-destructive"}`}>
                {position.changeToday >= 0 ? "+" : ""}{position.changeToday.toFixed(2)}%
              </div>
            </div>
          </div>
          
          {!showCloseModal && (
            <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
              {onAskAi && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAskAi(position.symbol);
                  }}
                  className="w-full sm:w-auto"
                  title={`Open AI Chat and analyze ${position.symbol}`}
                >
                  <Sparkles className="h-4 w-4 mr-1" />
                  Ask AI
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowShareModal(true);
                }}
                className="w-full sm:w-auto"
              >
                <Share2 className="h-4 w-4 mr-1" />
                Share P&L
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  openCloseModal();
                }}
                disabled={isThisClosing}
                className="w-full sm:w-auto"
              >
                <X className="h-4 w-4 mr-1" />
                Close Position
              </Button>
            </div>
          )}

          <ClosePositionModal
            open={showCloseModal}
            symbol={position.symbol}
            side={position.side}
            availableQty={availableQty}
            currentPrice={position.currentPrice}
            unitLabel={isOption ? "contracts" : "shares"}
            isClosing={isThisClosing}
            errorMessage={closeErrorForThisRow}
            formatCurrency={formatCurrency}
            onCancel={cancelCloseModal}
            onConfirm={({ qty, orderType, limitPrice }) =>
              onClose({ qty, orderType, limitPrice })
            }
            onFullClose={onFullClose}
          />

          {/* Exit Orders - always visible when position is expanded */}
          <Separator className="my-3" />
          <div onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pb-2">Exit Orders</p>
            <div className="space-y-2">

            {/* ---- Existing stop-loss orders (with edit) ---- */}
            {position.stopLossOrders?.map((sl) => {
              const isEditing = editingStopId === sl.id;
              const isSavingThis = isUpdatingStopLoss && updatingStopOrderId === sl.id;
              return (
                <div key={sl.id} className="text-sm bg-destructive/10 rounded px-2 py-1">
                  {isEditing ? (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
                        <span className="text-destructive font-medium whitespace-nowrap">⛔ Stop Loss</span>
                        <Input
                          {...STOP_LOSS_PRICE_INPUT_PROPS}
                          autoComplete="off"
                          value={draftStopPrice}
                          onChange={(e) => { setDraftStopPrice(e.target.value); setValidationError(null); }}
                          disabled={isSavingThis}
                          className="h-7 w-24 font-data tabular-nums"
                          aria-label="Stop loss price"
                        />
                        <span className="text-muted-foreground whitespace-nowrap">× {sl.qty}</span>
                        <div className="ml-auto flex items-center gap-1">
                          <Button variant="default" size="sm" className="h-7 px-2" onClick={() => saveStop(sl.id)} disabled={isSavingThis}>
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelEditingStop} disabled={isSavingThis}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {validationError && <div className="text-xs text-destructive">{validationError}</div>}
                      {updateStopLossError && updatingStopOrderId === sl.id && (
                        <div className="text-xs text-destructive">{updateStopLossError}</div>
                      )}
                    </div>
                  ) : cancelingOrderId === sl.id ? (
                    <div className="flex items-center justify-between">
                      <span className="text-destructive font-medium">⛔ Stop Loss</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Cancel order?</span>
                        <Button variant="destructive" size="sm" className="h-7 px-2" onClick={() => cancelExitOrderMutation.mutate({ credentialId, orderId: sl.id })} disabled={cancelExitOrderMutation.isPending}>
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setCancelingOrderId(null)} disabled={cancelExitOrderMutation.isPending}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-destructive font-medium">⛔ Stop Loss</span>
                      <div className="flex items-center gap-2">
                        <span>{formatCurrency(sl.stopPrice)} × {sl.qty}</span>
                        <Button variant="ghost" size="sm" className="h-11 w-11 p-0 lg:h-6 lg:w-6" onClick={() => startEditingStop(sl)} aria-label="Edit stop loss">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-11 w-11 p-0 lg:h-6 lg:w-6 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); setCancelingOrderId(sl.id); }} aria-label="Cancel stop loss order">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ---- Add stop-loss (shown when none exists) ---- */}
            {!hasStopLoss && !showAddSL && (
              <button
                type="button"
                className="w-full text-left text-xs text-muted-foreground hover:text-destructive py-1 px-2 rounded border border-dashed border-muted-foreground/30 hover:border-destructive/50 transition-colors"
                onClick={openAddSL}
              >
                + Add Stop Loss
              </button>
            )}
            {!hasStopLoss && showAddSL && (
              <div className="text-sm bg-destructive/10 rounded px-2 py-2 space-y-1">
                <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
                  <span className="text-destructive font-medium whitespace-nowrap">⛔ Stop Loss</span>
                  <Input
                    {...STOP_LOSS_PRICE_INPUT_PROPS}
                    placeholder="Price"
                    value={newSLPrice}
                    onChange={(e) => { setNewSLPrice(e.target.value); setNewSLError(null); }}
                    disabled={addExitOrdersMutation.isPending}
                    className="h-7 w-24 font-data tabular-nums"
                    aria-label="New stop loss price"
                  />
                  <span className="text-muted-foreground whitespace-nowrap shrink-0">×</span>
                  <Input
                    type="number"
                    min="1"
                    placeholder="Qty"
                    value={newSLQty}
                    onChange={(e) => { setNewSLQty(e.target.value); setNewSLError(null); }}
                    disabled={addExitOrdersMutation.isPending}
                    className="h-7 w-20"
                    aria-label="Stop loss quantity"
                  />
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="default" size="sm" className="h-7 px-2" onClick={saveNewSL} disabled={addExitOrdersMutation.isPending}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelAddSL} disabled={addExitOrdersMutation.isPending}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {newSLError && <div className="text-xs text-destructive">{newSLError}</div>}
              </div>
            )}

            {/* ---- Existing take-profit orders (with edit) ---- */}
            {position.takeProfitOrders?.map((tp, i) => {
              const isEditingTP = editingTpId === tp.id;
              const isSavingTP =
                updateTakeProfitMutation.isPending &&
                updateTakeProfitMutation.variables?.tpOrderId === tp.id;
              return (
                <div key={tp.id} className="text-sm bg-gain-tint rounded px-2 py-1">
                  {isEditingTP ? (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
                        <span className="text-green-500 font-medium whitespace-nowrap">
                          🎯 TP{position.takeProfitOrders!.length > 1 ? ` ${i + 1}` : ""}
                        </span>
                        <Input
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={draftTpPrice}
                          onChange={(e) => { setDraftTpPrice(e.target.value); setTpValidationError(null); }}
                          disabled={isSavingTP}
                          className="h-7 w-24 font-data tabular-nums"
                          aria-label="Take profit price"
                        />
                        <span className="text-muted-foreground whitespace-nowrap">× {tp.qty}</span>
                        <div className="ml-auto flex items-center gap-1">
                          <Button variant="default" size="sm" className="h-7 px-2" onClick={() => saveEditTP(tp.id)} disabled={isSavingTP}>
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelEditingTP} disabled={isSavingTP}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {tpValidationError && <div className="text-xs text-destructive">{tpValidationError}</div>}
                      {updateTakeProfitMutation.isError &&
                        updateTakeProfitMutation.variables?.tpOrderId === tp.id && (
                          <div className="text-xs text-destructive">
                            {updateTakeProfitMutation.error.message}
                          </div>
                        )}
                    </div>
                  ) : cancelingOrderId === tp.id ? (
                    <div className="flex items-center justify-between">
                      <span className="text-green-500 font-medium">
                        🎯 TP{position.takeProfitOrders!.length > 1 ? ` ${i + 1}` : ""}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Cancel order?</span>
                        <Button variant="destructive" size="sm" className="h-7 px-2" onClick={() => cancelExitOrderMutation.mutate({ credentialId, orderId: tp.id })} disabled={cancelExitOrderMutation.isPending}>
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setCancelingOrderId(null)} disabled={cancelExitOrderMutation.isPending}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-green-500 font-medium">
                        🎯 TP{position.takeProfitOrders!.length > 1 ? ` ${i + 1}` : ""}
                      </span>
                      <div className="flex items-center gap-2">
                        <span>{formatCurrency(tp.limitPrice)} × {tp.qty}</span>
                        <Button variant="ghost" size="sm" className="h-11 w-11 p-0 lg:h-6 lg:w-6" onClick={() => startEditingTP(tp)} aria-label="Edit take profit">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-11 w-11 p-0 lg:h-6 lg:w-6 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); setCancelingOrderId(tp.id); }} aria-label="Cancel take profit order">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ---- Add take-profit (shown when none exists) ---- */}
            {!hasTakeProfit && !showAddTP && (
              <button
                type="button"
                className="w-full text-left text-xs text-muted-foreground hover:text-green-500 py-1 px-2 rounded border border-dashed border-muted-foreground/30 hover:border-green-500/50 transition-colors"
                onClick={openAddTP}
              >
                + Add Take Profit
              </button>
            )}
            {!hasTakeProfit && showAddTP && (
              <div className="text-sm bg-gain-tint rounded px-2 py-2 space-y-1">
                <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
                  <span className="text-green-500 font-medium whitespace-nowrap">🎯 Take Profit</span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="Price"
                    value={newTPPrice}
                    onChange={(e) => { setNewTPPrice(e.target.value); setNewTPError(null); }}
                    disabled={addExitOrdersMutation.isPending}
                    className="h-7 w-24 font-data tabular-nums"
                    aria-label="New take profit price"
                  />
                  <span className="text-muted-foreground whitespace-nowrap shrink-0">×</span>
                  <Input
                    type="number"
                    min="1"
                    placeholder="Qty"
                    value={newTPQty}
                    onChange={(e) => { setNewTPQty(e.target.value); setNewTPError(null); }}
                    disabled={addExitOrdersMutation.isPending}
                    className="h-7 w-20"
                    aria-label="Take profit quantity"
                  />
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="default" size="sm" className="h-7 px-2" onClick={saveNewTP} disabled={addExitOrdersMutation.isPending}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelAddTP} disabled={addExitOrdersMutation.isPending}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {newTPError && <div className="text-xs text-destructive">{newTPError}</div>}
              </div>
            )}

            {/* ---- Trailing stops (with cancel) ---- */}
            {position.trailingStopOrders?.map((ts) => (
              <div key={ts.id} className="text-sm bg-yellow-500/10 rounded px-2 py-1">
                {cancelingOrderId === ts.id ? (
                  <div className="flex items-center justify-between">
                    <span className="text-yellow-600 dark:text-yellow-500 font-medium">📉 Trailing Stop</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Cancel order?</span>
                      <Button variant="destructive" size="sm" className="h-7 px-2" onClick={() => cancelExitOrderMutation.mutate({ credentialId, orderId: ts.id })} disabled={cancelExitOrderMutation.isPending}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setCancelingOrderId(null)} disabled={cancelExitOrderMutation.isPending}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-yellow-600 dark:text-yellow-500 font-medium">📉 Trailing Stop</span>
                    <div className="flex items-center gap-2">
                      <div className="text-right leading-tight">
                        <div>
                          {ts.trailPercent ? `${ts.trailPercent}%` : ts.trailPrice ? formatCurrency(ts.trailPrice) : ""}
                          {" × "}
                          {ts.qty}
                        </div>
                        {ts.stopPrice != null && (
                          <div className="text-xs text-muted-foreground">
                            stops at {formatCurrency(ts.stopPrice)}
                          </div>
                        )}
                      </div>
                      <Button variant="ghost" size="sm" className="h-11 w-11 p-0 lg:h-6 lg:w-6 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); setCancelingOrderId(ts.id); }} aria-label="Cancel trailing stop order">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Empty state */}
            {!hasStopLoss && !hasTakeProfit && !hasTrailingStop && !showAddSL && !showAddTP && (
              <div className="text-xs text-muted-foreground text-center py-0.5">
                No exit orders - use buttons above to add one
              </div>
            )}
            </div>
          </div>
        </>
      )}
    </article>
  );
}
