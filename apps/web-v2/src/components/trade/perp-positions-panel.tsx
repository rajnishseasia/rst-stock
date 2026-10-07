"use client";

/**
 * PerpPositionsPanel — the perps positions table (center-bottom of the perps
 * terminal).
 *
 * Rows show coin / side / size / entryPx / markPx / liquidationPx /
 * unrealizedPnl / realized PnL banked on the position so far ("RPNL", replayed
 * from the fills because the clearinghouse reports unrealized only) /
 * leverage+mode / marginUsed / funding, with a reduce-only
 * market Close (full size) that submits the opposite side via
 * `trpc.orders.submitPerp` with `reduceOnly: true`. Source is
 * `trpc.positions.listPerps` on a 30s poll. Reuses the P&L color tokens and
 * `formatUsd` idiom from the equity positions panel.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  LoaderCircle,
  Pencil,
  Share2,
  Shield,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ClosePositionAlertDialog } from "@/components/trade/close-position-alert-dialog";
import { SharePnlModal } from "@/components/trade/share-pnl-modal";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  PositionsPanelHeader,
  parsePositionsSort,
  type PositionsSortKey,
} from "@/components/trade/positions-panel-header";
import { PerpClosedPanel } from "@/components/perps/perp-closed-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import { formatUsd } from "@/lib/format";
import { isValidPerpsMasterAddress } from "@/lib/perps-wallet-selection";
import {
  formatPerpPx as formatPx,
  formatPerpExitPx,
  formatPerpNotionalUsd,
  formatPerpRoePct,
  formatPerpUsd,
} from "@/components/perps/perp-format";
import { generatePerpCloid } from "./perp-form-math";
import {
  derivePerpTriggerPrice,
  isPerpTriggerDirectionValid,
  triggerPriceToInput,
  type PerpTpSlInputMode,
  type PerpTriggerKind,
} from "./perp-tpsl-input";
import {
  PERP_CLOSE_BACKGROUND_POLL_MS,
  perpClosePollInterval,
  perpCloseSlowNoticeDelay,
  resolvePerpClose,
  type PerpCloseIntent,
} from "./perp-close-reconciliation";
import {
  buildFullPositionPerpTpSlRequest,
  createPerpTpSlIntentStore,
  dispatchPerpTpSlActionIfFresh,
  isPerpTpSlActionable,
  PERP_TPSL_OPEN_ORDERS_STALE_TIME_MS,
} from "./perp-tpsl-intent";

/**
 * Formats a Hyperliquid liquidation price. Returns "N/A" when `px` is null,
 * which happens for cross-margin positions where HL does not provide a liq
 * price (the effective threshold is below zero for well-collateralized
 * accounts).
 */
function formatLiqPx(px: string | null | undefined): string {
  return px != null ? formatPx(px) : "N/A";
}

/** Separate from the equity key so each venue remembers its own sort. */
const PERP_POSITIONS_SORT_KEY = "ready-set-trade.perp-positions-sort-v1";

interface PositionTriggerOrder {
  oid: number;
  triggerPx: string | null;
}

function PositionTriggerControls({
  coin,
  kind,
  orders,
  editable,
  onEdit,
  className,
}: {
  coin: string;
  kind: "sl" | "tp";
  orders: PositionTriggerOrder[];
  editable: boolean;
  onEdit: (order?: PositionTriggerOrder) => void;
  className?: string;
}) {
  const displayCoin = perpDisplayCoin(coin);
  const readableKind = kind === "sl" ? "stop loss" : "take profit";

  if (orders.length === 0) {
    return (
      <span className={cn("inline-flex items-center justify-end gap-1", className)}>
        <span>–</span>
        {editable && (
          <button
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground xl:h-6 xl:w-6"
            aria-label={`Set ${readableKind} for ${displayCoin}`}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5", className)}>
      {orders.map((order, index) => (
        <span key={order.oid} className="inline-flex items-center gap-0.5 whitespace-nowrap">
          <span>{formatPerpExitPx(order.triggerPx)}</span>
          {editable && (
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground xl:h-6 xl:w-6"
              aria-label={
                orders.length === 1
                  ? `Edit ${readableKind} for ${displayCoin}`
                  : `Edit ${readableKind} ${index + 1} for ${displayCoin}`
              }
              onClick={(event) => {
                event.stopPropagation();
                onEdit(order);
              }}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

export interface PerpPositionsPanelProps {
  /** HL wallet address for the active user, or null until perps are enabled. */
  walletAddress: string | null;
  /** Whether perps have been enabled (gates the query). */
  enabled: boolean;
  /** The enablement query has not settled yet, so `enabled=false` is unknown. */
  loading?: boolean;
  /** Select this position's canonical coin in the perpetual chart. */
  onViewChart?: (coin: string) => void;
  /** Canonical Hyperliquid coin selected on the surrounding chart. */
  selectedCoin?: string;
  /** Limit the open-position list to `selectedCoin`. */
  onlySelectedCoin?: boolean;
}

export function PerpPositionsPanel({
  walletAddress,
  enabled,
  loading = false,
  onViewChart,
  selectedCoin,
  onlySelectedCoin = false,
}: PerpPositionsPanelProps) {
  const trpcUtils = trpc.useUtils();
  const hasValidPerpsMasterAddress = isValidPerpsMasterAddress(walletAddress);
  // Open | Closed and the sort order are the SAME controls the equity panel
  // draws (PositionsPanelHeader owns both), so the two venues behave
  // identically. Closed perps are completed round-trips folded out of the
  // fills feed; they used to be reachable only from a separate drawer sub-tab
  // that the stocks venue had no counterpart for.
  const [showClosed, setShowClosed] = useState(false);
  const [sortBy, setSortByRaw] = useState<PositionsSortKey>("date");
  useEffect(() => {
    setSortByRaw(parsePositionsSort(window.localStorage.getItem(PERP_POSITIONS_SORT_KEY)));
  }, []);
  const setSortBy = (value: PositionsSortKey) => {
    setSortByRaw(value);
    window.localStorage.setItem(PERP_POSITIONS_SORT_KEY, value);
  };
  const [closeTargetCoin, setCloseTargetCoin] = useState<string | null>(null);
  // Which position (by coin) has its shareable P&L card open. The card itself is
  // rendered server-side from the live HL position, so the row passes the coin
  // and nothing else.
  const [shareCoin, setShareCoin] = useState<string | null>(null);
  const sharePnlMutation = trpc.pnlImage.generateOpenPerp.useMutation();
  const [pendingClose, setPendingClose] = useState<PerpCloseIntent | null>(null);
  const [showSlowCloseNotice, setShowSlowCloseNotice] = useState(false);

  const perpsQuery = trpc.positions.listPerps.useQuery(undefined, {
    enabled,
    refetchInterval: pendingClose
      ? perpClosePollInterval(pendingClose.startedAt)
      : PERP_CLOSE_BACKGROUND_POLL_MS,
    staleTime: 15_000,
    retry: (failureCount) => failureCount < 2,
  });

  // Open (resting) trigger orders, so we can surface each position's attached
  // TP/SL legs. `listPerps` returns POSITIONS only, never these ORDERS.
  const openOrdersQuery = trpc.positions.listPerpOpenOrders.useQuery(undefined, {
    enabled: enabled && hasValidPerpsMasterAddress,
    refetchInterval: 30_000,
    staleTime: PERP_TPSL_OPEN_ORDERS_STALE_TIME_MS,
    retry: false,
  });
  const isTpslSnapshotActionable = () =>
    isPerpTpSlActionable(walletAddress, openOrdersQuery, Date.now());
  const dispatchTpslActionIfFresh = (dispatch: () => void) =>
    dispatchPerpTpSlActionIfFresh(
      walletAddress,
      openOrdersQuery,
      dispatch,
      Date.now(),
    );
  const canManageTpsl = isTpslSnapshotActionable();

  const closeOrderQuery = trpc.orders.getByClientOrderId.useQuery(
    { clientOrderId: pendingClose?.cloid ?? "" },
    {
      enabled: pendingClose?.phase === "confirming",
      refetchInterval: pendingClose
        ? perpClosePollInterval(pendingClose.startedAt)
        : false,
      retry: false,
    },
  );

  // Cancel a single resting trigger order by coin + oid.
  const cancelOrderMutation = trpc.orders.cancelPerp.useMutation({
    onSuccess: () => {
      toast.success("Order cancelled");
      // The leg being edited no longer exists, so the editor has nothing to act on.
      closeTpslEditor();
      void trpcUtils.positions.listPerpOpenOrders.invalidate();
      void trpcUtils.positions.listPerps.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // One idempotency cloid per close "intent" (keyed by the close signature), so
  // retrying or reconciling a close reuses the same cloid and can't
  // double-submit. The entry is cleared only after a venue-authoritative
  // terminal outcome (position gone/shrunk, or order definitively failed).
  const closeCloids = useRef<Map<string, string>>(new Map());
  const closeCloidFor = (signature: string): string => {
    const existing = closeCloids.current.get(signature);
    if (existing) return existing;
    const cloid = generatePerpCloid();
    closeCloids.current.set(signature, cloid);
    return cloid;
  };

  const closeMutation = trpc.orders.submitPerp.useMutation({
    onSuccess: (data, variables) => {
      if (data && data.success === false) {
        const acceptedStatus =
          data.status === "SUBMITTED" ||
          data.status === "PARTIAL" ||
          data.status === "FILLED";
        if (data.syncing || acceptedStatus) {
          setPendingClose((current) =>
            current && current.cloid === variables.cloid
              ? { ...current, phase: "confirming" }
              : current,
          );
          setCloseTargetCoin(null);
          toast.info(
            acceptedStatus
              ? "Close accepted; confirming the position update"
              : data.message ?? "Confirming the close with Hyperliquid",
          );
          void trpcUtils.positions.listPerps.invalidate();
          return;
        }
        for (const [key, value] of closeCloids.current) {
          if (value === variables.cloid) closeCloids.current.delete(key);
        }
        setPendingClose(null);
        toast.error(data.message ?? "Close was rejected — please retry.");
        return;
      }
      setPendingClose((current) =>
        current && current.cloid === variables.cloid
          ? { ...current, phase: "confirming" }
          : current,
      );
      toast.info("Close order submitted; confirming the position update");
      setCloseTargetCoin(null);
      void trpcUtils.positions.listPerps.invalidate();
    },
    onError: (error, variables) => {
      const hasServerResponse = Boolean(
        (error as { data?: { code?: string } }).data?.code,
      );
      if (hasServerResponse) {
        for (const [key, value] of closeCloids.current) {
          if (value === variables.cloid) closeCloids.current.delete(key);
        }
        setPendingClose(null);
        toast.error(error.message);
        return;
      }

      setPendingClose((current) =>
        current && current.cloid === variables.cloid
          ? { ...current, phase: "confirming" }
          : current,
      );
      setCloseTargetCoin(null);
      toast.info(
        "The response was interrupted. Confirming the existing close request; do not submit another.",
      );
      void trpcUtils.positions.listPerps.invalidate();
    },
  });

  useEffect(() => {
    if (!pendingClose || pendingClose.phase !== "submitting") {
      setShowSlowCloseNotice(false);
      return;
    }

    const remaining = perpCloseSlowNoticeDelay(pendingClose.startedAt);
    const timeout = window.setTimeout(() => setShowSlowCloseNotice(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [pendingClose]);

  // TP/SL editor: which position row (by coin) has its TP/SL panel open, and the
  // per-coin draft stop-loss / take-profit prices.
  const [tpslOpenCoin, setTpslOpenCoin] = useState<string | null>(null);
  const [tpslMode, setTpslMode] =
    useState<PerpTpSlInputMode>("roePercent");
  const [slDraft, setSlDraft] = useState("");
  const [tpDraft, setTpDraft] = useState("");
  const [editingTrigger, setEditingTrigger] = useState<{
    coin: string;
    orderId: number;
    kind: "sl" | "tp";
  } | null>(null);
  // Keep an intent's seed until its outcome is definitive; the backend folds
  // each leg's own price into the client-order id.
  const tpslIntents = useRef(createPerpTpSlIntentStore(generatePerpCloid));

  const tpslMutation = trpc.orders.setPerpTpSl.useMutation({
    onSuccess: (data, variables) => {
      if (data && data.success === false) {
        // The broker call may have succeeded even when the local status write
        // did not. This is a sync warning, not a venue rejection. Refresh the
        // authoritative live-order view and prevent an accidental duplicate.
        toast.warning(
          data.message ??
            "TP/SL order outcome is syncing. Check live orders before retrying.",
        );
        tpslIntents.current.resolve(
          variables?.cloid,
          data.status === "RECONCILIATION_NEEDED"
            ? "reconciliation-needed"
            : "definitive-failure",
        );
        setTpslOpenCoin(null);
        setSlDraft("");
        setTpDraft("");
        setEditingTrigger(null);
        void trpcUtils.positions.listPerpOpenOrders.invalidate();
        void trpcUtils.positions.listPerps.invalidate();
        return;
      }
      tpslIntents.current.resolve(variables?.cloid, "definitive-success");
      toast.success("TP/SL orders set");
      setTpslOpenCoin(null);
      setSlDraft("");
      setTpDraft("");
      setEditingTrigger(null);
      void trpcUtils.positions.listPerpOpenOrders.invalidate();
      void trpcUtils.positions.listPerps.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const modifyTpslMutation = trpc.orders.modifyPerpTpSl.useMutation({
    onSuccess: () => {
      toast.success("TP/SL order updated");
      setTpslOpenCoin(null);
      setSlDraft("");
      setTpDraft("");
      setEditingTrigger(null);
      void trpcUtils.positions.listPerpOpenOrders.invalidate();
      void trpcUtils.positions.listPerps.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Unsorted, in venue order. Everything that reconciles a close or replays
  // fills keys off the coin, so it reads this list; only the RENDER order is
  // affected by the sort control below.
  const positions = useMemo(
    () => perpsQuery.data?.positions ?? [],
    [perpsQuery.data],
  );
  // Filtering is presentation-only. Close reconciliation, protection edits,
  // and fill replay must always read the complete authoritative venue list.
  const visiblePositions = useMemo(
    () =>
      positions.filter(
        (position) =>
          !onlySelectedCoin || !selectedCoin || position.coin === selectedCoin,
      ),
    [positions, onlySelectedCoin, selectedCoin],
  );

  // Same three orders the equity panel offers. "value" is the position's
  // notional (size x mark), the perps analogue of an equity market value;
  // "date" keeps the venue's own order, as the equity panel keeps the
  // broker's.
  const sortedPositions = useMemo(() => {
    const notional = (position: (typeof visiblePositions)[number]) =>
      Math.abs(Number(position.size) * Number(position.markPx ?? position.entryPx));
    return [...visiblePositions].sort((a, b) => {
      if (sortBy === "pnl") return Number(b.unrealizedPnl) - Number(a.unrealizedPnl);
      if (sortBy === "value") return notional(b) - notional(a);
      return 0;
    });
  }, [visiblePositions, sortBy]);

  // Header summary: the count plus total unrealized P&L, stated as a return on
  // the margin actually committed (the equity panel divides by cost basis).
  const totalUnrealized = visiblePositions.reduce(
    (sum, position) => sum + Number(position.unrealizedPnl),
    0,
  );
  const totalMargin = visiblePositions.reduce(
    (sum, position) => sum + Number(position.marginUsed),
    0,
  );
  const closeTarget = positions.find((position) => position.coin === closeTargetCoin) ?? null;

  useEffect(() => {
    if (!pendingClose || pendingClose.phase !== "confirming" || !perpsQuery.isSuccess) {
      return;
    }

    const currentPosition = positions.find(
      (position) => position.coin === pendingClose.coin,
    );
    const resolution = resolvePerpClose({
      initialSize: pendingClose.initialSize,
      currentSize: currentPosition?.size ?? null,
      orderStatus: closeOrderQuery.data?.status,
    });
    if (resolution === "pending") return;

    for (const [key, value] of closeCloids.current) {
      if (value === pendingClose.cloid) closeCloids.current.delete(key);
    }
    setPendingClose(null);
    setCloseTargetCoin(null);

    if (resolution === "closed") {
      toast.success(`${perpDisplayCoin(pendingClose.coin)} position closed`);
    } else if (resolution === "partial") {
      toast.warning(
        `Close partially filled; ${currentPosition?.size ?? "some"} ${perpDisplayCoin(pendingClose.coin)} remains`,
      );
    } else {
      toast.error("The close was not completed. You can submit a new close request.");
    }
  }, [closeOrderQuery.data?.status, pendingClose, perpsQuery.isSuccess, positions]);

  // Group the resting TRIGGER orders (TP/SL) by canonical coin (HL coins are
  // case-sensitive: kPEPE, xyz:GOOGL; never uppercase them) so each
  // position row can render its own attached legs. We include ONLY protective
  // (position-closing) triggers: a trigger is also used for stop/take-profit
  // ENTRY orders (Reduce-only unchecked), and surfacing one of those under a
  // position would mislabel a pending entry as an attached TP/SL and let the
  // inline cancel kill the user's ENTRY order. Require the venue's position-TP/SL
  // flag or reduce-only so only protective legs appear here.
  const triggerOrdersByCoin = useMemo(() => {
    const map = new Map<string, NonNullable<typeof openOrdersQuery.data>["orders"]>();
    for (const order of openOrdersQuery.data?.orders ?? []) {
      if (!order.isTrigger) continue;
      if (!order.isPositionTpsl && !order.reduceOnly) continue;
      const key = order.coin;
      const bucket = map.get(key);
      if (bucket) bucket.push(order);
      else map.set(key, [order]);
    }
    return map;
  }, [openOrdersQuery.data]);

  const handleCancelOrder = (coin: string, oid: number) => {
    // The coin keeps HL's canonical case-sensitive spelling (kPEPE):
    // uppercasing it would cancel against an unknown coin.
    dispatchTpslActionIfFresh(() =>
      cancelOrderMutation.mutate({ coin, orderId: oid }),
    );
  };

  const closingCoin = pendingClose?.coin ?? null;
  const closePhase = pendingClose?.phase ?? null;

  const closeTpslEditor = () => {
    setTpslOpenCoin(null);
    setSlDraft("");
    setTpDraft("");
    setEditingTrigger(null);
  };

  const openTriggerEditor = (
    coin: string,
    kind: "sl" | "tp",
    order?: { oid: number; triggerPx: string | null },
  ) => {
    dispatchTpslActionIfFresh(() => {
      setTpslOpenCoin(coin);
      setTpslMode("price");
      setSlDraft(kind === "sl" ? order?.triggerPx ?? "" : "");
      setTpDraft(kind === "tp" ? order?.triggerPx ?? "" : "");
      setEditingTrigger(
        order ? { coin, orderId: order.oid, kind } : null,
      );
    });
  };

  const changeTpslMode = (mode: string) => {
    if (!mode) return;
    setTpslMode(mode as PerpTpSlInputMode);
    setSlDraft("");
    setTpDraft("");
  };

  const triggerFromDraft = (
    draft: string,
    kind: PerpTriggerKind,
    position: (typeof positions)[number],
  ): number | null =>
    derivePerpTriggerPrice({
      mode: tpslMode,
      kind,
      side: position.side,
      value: Number(draft),
      entryPrice: Number(position.entryPx),
      size: Number(position.size),
      marginUsed: Number(position.marginUsed),
    });

  const handleSetTpSl = (position: (typeof positions)[number]) => {
    if (!isTpslSnapshotActionable()) return;
    const hasStopLoss = slDraft.trim() !== "";
    const hasTakeProfit = tpDraft.trim() !== "";
    const stopLossPrice = hasStopLoss
      ? triggerFromDraft(slDraft, "stopLoss", position)
      : null;
    const takeProfitPrice = hasTakeProfit
      ? triggerFromDraft(tpDraft, "takeProfit", position)
      : null;
    if (hasStopLoss && stopLossPrice == null) {
      toast.error("Enter a valid stop-loss value that keeps the trigger above zero");
      return;
    }
    if (hasTakeProfit && takeProfitPrice == null) {
      toast.error("Enter a valid take-profit value that keeps the trigger above zero");
      return;
    }
    const marketPrice = Number(position.markPx);
    if (
      (stopLossPrice != null || takeProfitPrice != null) &&
      (!Number.isFinite(marketPrice) || marketPrice <= 0)
    ) {
      toast.error("Current market price is unavailable. Refresh positions and try again.");
      return;
    }
    if (
      stopLossPrice != null &&
      !isPerpTriggerDirectionValid(
        "stopLoss",
        position.side,
        stopLossPrice,
        marketPrice,
      )
    ) {
      toast.error(
        `A ${position.side} stop must be beyond the current market price`,
      );
      return;
    }
    if (
      takeProfitPrice != null &&
      !isPerpTriggerDirectionValid(
        "takeProfit",
        position.side,
        takeProfitPrice,
        marketPrice,
      )
    ) {
      toast.error(
        `A ${position.side} take-profit must be beyond the current market price`,
      );
      return;
    }
    const stopLossPx =
      stopLossPrice != null ? triggerPriceToInput(stopLossPrice) : undefined;
    const takeProfitPx =
      takeProfitPrice != null ? triggerPriceToInput(takeProfitPrice) : undefined;
    if (!stopLossPx && !takeProfitPx) {
      toast.error("Enter a stop-loss and/or take-profit value");
      return;
    }
    if (editingTrigger?.coin === position.coin) {
      const triggerPx = editingTrigger.kind === "sl" ? stopLossPx : takeProfitPx;
      if (!triggerPx) {
        toast.error("Enter a trigger price");
        return;
      }
      dispatchTpslActionIfFresh(() =>
        modifyTpslMutation.mutate({
          coin: position.coin,
          orderId: editingTrigger.orderId,
          kind: editingTrigger.kind,
          triggerPx,
        }),
      );
      return;
    }
    // Seed is keyed on the POSITION only (not the prices): the backend folds each
    // leg's own trigger price into its cloid, so editing one leg's price and
    // retrying leaves the other leg's cloid stable → HL dedupes the unchanged leg
    // instead of duplicating it.
    const signature = `${position.coin}:${position.side}:${position.size}`;
    dispatchTpslActionIfFresh(() =>
      tpslMutation.mutate(
        buildFullPositionPerpTpSlRequest({
          coin: position.coin,
          positionSide: position.side,
          size: position.size,
          isMarket: true,
          cloid: tpslIntents.current.getOrCreate(signature),
          ...(stopLossPx ? { stopLossPx } : {}),
          ...(takeProfitPx ? { takeProfitPx } : {}),
        }),
      ),
    );
  };

  const handleClose = (position: (typeof positions)[number]) => {
    // Reduce-only market close of the full size: submit the OPPOSITE side.
    // markPrice is sent only when known. The server still sources a fresh mid
    // for its authoritative minimum-notional guard, under a bounded close-only
    // preflight deadline.
    const signature = `${position.coin}:${position.side}:${position.size}`;
    const cloid = closeCloidFor(signature);
    setPendingClose({
      coin: position.coin,
      initialSize: position.size,
      cloid,
      startedAt: Date.now(),
      phase: "submitting",
    });
    closeMutation.mutate({
      coin: position.coin,
      isLong: position.side === "short", // long position -> short to close
      marginMode: position.marginMode,
      orderType: "Market",
      sizeCoin: position.size,
      leverage: position.leverage,
      reduceOnly: true,
      postOnly: false,
      cloid,
      ...(position.markPx ? { markPrice: position.markPx } : {}),
    });
  };

  // The header renders in EVERY state (loading, not-set-up, empty, populated),
  // exactly as the equity panel's does, so the Open | Closed and sort controls
  // never disappear out from under the user.
  const header = (
    <PositionsPanelHeader
      embedded
      showClosed={showClosed}
      onShowClosedChange={setShowClosed}
      sortBy={sortBy}
      onSortByChange={setSortBy}
      description={
        showClosed ? (
          <>Recent closed round-trips</>
        ) : loading ? (
          <>Loading...</>
        ) : !enabled ? (
          <>Perps not set up</>
        ) : (
          <>
            {visiblePositions.length} position{visiblePositions.length !== 1 ? "s" : ""} •{" "}
            <span
              className={`font-data tabular-nums ${totalUnrealized >= 0 ? "text-green-500" : "text-destructive"}`}
            >
              {formatPerpUsd(totalUnrealized)} (
              {formatPerpRoePct(null, totalUnrealized, totalMargin)}
              )
            </span>
          </>
        )
      }
    />
  );

  const body = () => {
    // The Closed view states its own not-set-up copy, so it is checked before
    // the open list's: "...to view positions" under a header reading
    // "Closed (history)" named the wrong thing.
    if (showClosed) {
      if (loading) {
        return (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Loading closed positions...
          </div>
        );
      }
      return (
        <PerpClosedPanel bare enabled={enabled} sortBy={sortBy} onViewChart={onViewChart} />
      );
    }

    if (loading) {
      return (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          Loading positions...
        </div>
      );
    }

    if (!enabled) {
      return (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          Set up perpetual futures in the Trade panel to view positions.
        </div>
      );
    }

    return (
      <>
        {perpsQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Loading positions...
          </div>
        ) : perpsQuery.error ? (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-4 text-sm border-b border-destructive/20 bg-destructive/5 text-destructive">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {perpsQuery.error.message.includes("Session") || perpsQuery.error.message.includes("session")
                  ? "Session verification failed. Please check your login or retry."
                  : perpsQuery.error.message}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs border-destructive/30 hover:bg-destructive/10"
              onClick={() => void perpsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : visiblePositions.length === 0 ? (
          // Signal-first: name the route in, which is a perp call from the
          // feed, not a deposit. No button here on purpose. Every surface that
          // renders this panel today is the desktop terminal, where the signal
          // feed is already on screen in the left rail.
          <EmptyState
            icon={Shield}
            title="No open perp positions"
            body="Copy a perp call from the signal feed and the position shows up here."
          />
        ) : (
          <table className="w-full table-fixed border-collapse text-xs @[640px]/perppos:table-auto @[760px]/perppos:text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 text-3xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr className="border-b">
                <th className="w-[64%] px-2 py-1.5 text-left font-medium @[520px]/perppos:w-[34%] @[760px]/perppos:w-auto">Coin</th>
                <th className="hidden w-[12%] px-1 py-1.5 text-right font-medium @[520px]/perppos:table-cell @[760px]/perppos:w-auto @[760px]/perppos:px-2">Size</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[1040px]/perppos:table-cell">Entry</th>
                <th className="hidden w-[15%] px-1 py-1.5 text-right font-medium @[520px]/perppos:table-cell @[760px]/perppos:w-auto @[760px]/perppos:px-2">Mark</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[760px]/perppos:table-cell">Liq.</th>
                <th className="hidden w-[15%] px-1 py-1.5 text-right font-medium @[520px]/perppos:table-cell @[760px]/perppos:w-auto @[760px]/perppos:px-2">uPnL</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[880px]/perppos:table-cell" title="Realized P&L banked on this position so far">RPNL</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[880px]/perppos:table-cell">Margin</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[1040px]/perppos:table-cell">Funding</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[760px]/perppos:table-cell">SL</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[760px]/perppos:table-cell">TP</th>
                <th className="w-[36%] px-2 py-1.5 text-right font-medium @[520px]/perppos:w-[24%] @[760px]/perppos:w-auto">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedPositions.map((position) => {
                const pnl = Number(position.unrealizedPnl);
                const pnlPercent = formatPerpRoePct(
                  position.returnOnEquity,
                  position.unrealizedPnl,
                  position.marginUsed,
                );
                const pnlTone =
                  !Number.isFinite(pnl) || pnl === 0
                    ? "neutral"
                    : pnl > 0
                      ? "positive"
                      : "negative";
                const funding = Number(position.funding);
                const realized = position.realizedPnl ?? null;
                const realizedLabel = realized == null ? "–" : formatUsd(realized);
                const realizedClass = cn(
                  realized != null && realized > 0 && "text-green-400",
                  realized != null && realized < 0 && "text-red-400",
                );
                const realizedTitle = realized == null
                  ? "The stored fills do not cover this whole position, so its realized P&L cannot be computed"
                  : "Realized P&L banked on this position since it was opened";
                const isClosing = closingCoin === position.coin;
                const tpslOpen =
                  tpslOpenCoin === position.coin && canManageTpsl;
                const isSettingTpsl =
                  (tpslMutation.isPending &&
                    tpslMutation.variables?.coin === position.coin) ||
                  (modifyTpslMutation.isPending &&
                    modifyTpslMutation.variables?.coin === position.coin);
                const triggerOrders =
                  triggerOrdersByCoin.get(position.coin) ?? [];
                const stopLossOrders = triggerOrders.filter((order) => order.tpsl === "sl");
                const takeProfitOrders = triggerOrders.filter((order) => order.tpsl === "tp");
                const stopLossPreview = slDraft.trim()
                  ? triggerFromDraft(slDraft, "stopLoss", position)
                  : null;
                const takeProfitPreview = tpDraft.trim()
                  ? triggerFromDraft(tpDraft, "takeProfit", position)
                  : null;
                const marketPrice = Number(position.markPx);
                // Size is shown in dollars, not coin units: "0.0231 BTC" says
                // nothing about how much money is in the trade, and the unit
                // price spans five orders of magnitude across HL's coins. The
                // coin quantity stays available as the cell's tooltip (and is
                // still what the close dialog quotes, since that is the order).
                const sizeUsd = formatPerpNotionalUsd(
                  position.size,
                  position.markPx ?? position.entryPx,
                );
                const sizeCoinLabel = `${position.size} ${perpDisplayCoin(position.coin)}`;
                return (
                  <Fragment key={position.coin}>
                  <tr
                    className="min-h-11 border-b transition-colors hover:bg-accent/40 focus-within:bg-accent/30 xl:min-h-0"
                  >
                    <td className="min-w-0 px-2 py-2 text-left">
                      <button
                        type="button"
                        className="flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm text-left outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-inherit xl:min-h-0"
                        onClick={(event) => {
                          event.stopPropagation();
                          onViewChart?.(position.coin);
                        }}
                        disabled={!onViewChart}
                        aria-label={`View ${perpDisplayCoin(position.coin)} perpetual chart`}
                        title="View chart"
                      >
                        <span className="font-data text-sm font-semibold">
                          {perpDisplayCoin(position.coin)}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-3xs font-semibold uppercase",
                            position.side === "long"
                              ? "bg-gain-tint text-green-500"
                              : "bg-loss-tint text-red-500",
                          )}
                        >
                          {position.side}
                        </span>
                        <span className="text-3xs text-muted-foreground">
                          {position.leverage}x {position.marginMode}
                        </span>
                      </button>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-data text-3xs leading-tight text-muted-foreground @[520px]/perppos:hidden">
                        <span className="flex justify-between gap-1">
                          <span>Size</span>
                          <span className="text-foreground" title={sizeCoinLabel}>{sizeUsd}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Entry</span><span className="text-foreground">{formatPx(position.entryPx)}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Mark</span><span className="text-xs text-foreground">{formatPx(position.markPx)}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Liq.</span><span className="text-foreground">{formatLiqPx(position.liquidationPx)}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>uPnL</span>
                          <span
                            className={cn(
                              pnlTone === "positive" && "text-green-400",
                              pnlTone === "negative" && "text-red-400",
                              pnlTone === "neutral" && "text-foreground",
                            )}
                          >
                            <span className="whitespace-nowrap text-xs">
                              {formatUsd(pnl)} ({pnlPercent})
                            </span>
                          </span>
                        </span>
                        <span className="flex justify-between gap-1" title={realizedTitle}>
                          <span>RPNL</span>
                          <span className={cn("text-foreground", realizedClass)}>{realizedLabel}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Margin</span><span className="text-foreground">{formatUsd(position.marginUsed)}</span>
                        </span>
                        <span className="col-span-2 flex justify-between gap-1">
                          <span>Funding</span><span className="text-foreground">{formatPerpUsd(position.funding)}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Stop loss</span>
                          <PositionTriggerControls
                            coin={position.coin}
                            kind="sl"
                            orders={stopLossOrders}
                            editable={canManageTpsl}
                            onEdit={(order) =>
                              openTriggerEditor(position.coin, "sl", order)
                            }
                            className="text-foreground"
                          />
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Take profit</span>
                          <PositionTriggerControls
                            coin={position.coin}
                            kind="tp"
                            orders={takeProfitOrders}
                            editable={canManageTpsl}
                            onEdit={(order) =>
                              openTriggerEditor(position.coin, "tp", order)
                            }
                            className="text-foreground"
                          />
                        </span>
                      </div>
                      <div className="mt-1 hidden space-y-0.5 font-data text-3xs leading-tight text-muted-foreground @[520px]/perppos:block @[760px]/perppos:hidden">
                        <div>
                          Entry {formatPx(position.entryPx)} · Liq. {formatLiqPx(position.liquidationPx)} · RPNL <span className={realizedClass}>{realizedLabel}</span> · Margin {formatUsd(position.marginUsed)} · Funding {formatPerpUsd(position.funding)}
                        </div>
                        <div className="flex flex-wrap gap-x-3">
                          <span>
                            SL{" "}
                            <PositionTriggerControls
                              coin={position.coin}
                              kind="sl"
                              orders={stopLossOrders}
                              editable={canManageTpsl}
                              onEdit={(order) =>
                                openTriggerEditor(position.coin, "sl", order)
                              }
                              className="align-middle text-foreground"
                            />
                          </span>
                          <span>
                            TP{" "}
                            <PositionTriggerControls
                              coin={position.coin}
                              kind="tp"
                              orders={takeProfitOrders}
                              editable={canManageTpsl}
                              onEdit={(order) =>
                                openTriggerEditor(position.coin, "tp", order)
                              }
                              className="align-middle text-foreground"
                            />
                          </span>
                        </div>
                      </div>
                      <div className="mt-1 hidden truncate font-data text-3xs leading-tight text-muted-foreground @[760px]/perppos:block @[880px]/perppos:hidden">
                        RPNL <span className={realizedClass}>{realizedLabel}</span> · Margin {formatUsd(position.marginUsed)} · Funding {formatPerpUsd(position.funding)}
                      </div>
                      <div className="mt-1 hidden truncate font-data text-3xs leading-tight text-muted-foreground @[880px]/perppos:block @[1040px]/perppos:hidden">
                        Funding {formatPerpUsd(position.funding)}
                      </div>
                    </td>
                    <td
                      className="hidden px-1 py-2 text-right font-data tabular-nums @[520px]/perppos:table-cell @[760px]/perppos:px-2"
                      title={sizeCoinLabel}
                    >
                      {sizeUsd}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums @[1040px]/perppos:table-cell">
                      {formatPx(position.entryPx)}
                    </td>
                    <td className="hidden px-1 py-2 text-right font-data tabular-nums @[520px]/perppos:table-cell @[760px]/perppos:px-2">
                      {formatPx(position.markPx)}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums text-muted-foreground @[760px]/perppos:table-cell">
                      {formatLiqPx(position.liquidationPx)}
                    </td>
                    <td
                      className={cn(
                        "hidden px-1 py-2 text-right font-data tabular-nums @[520px]/perppos:table-cell @[760px]/perppos:px-2",
                        pnlTone === "positive" && "text-green-400",
                        pnlTone === "negative" && "text-red-400",
                      )}
                    >
                      <span className="flex flex-col items-end leading-tight @[760px]/perppos:hidden">
                        <span>{formatUsd(pnl)}</span>
                        <span className="text-3xs">({pnlPercent})</span>
                      </span>
                      <span className="hidden whitespace-nowrap @[760px]/perppos:inline">
                        {formatUsd(pnl)} ({pnlPercent})
                      </span>
                    </td>
                    <td
                      className={cn(
                        "hidden px-2 py-2 text-right font-data tabular-nums @[880px]/perppos:table-cell",
                        realizedClass,
                      )}
                      title={realizedTitle}
                    >
                      {realizedLabel}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums @[880px]/perppos:table-cell">
                      {formatUsd(position.marginUsed)}
                    </td>
                    <td
                      className={cn(
                        "hidden px-2 py-2 text-right font-data tabular-nums @[1040px]/perppos:table-cell",
                        Number.isFinite(funding) && funding > 0 && "text-red-400",
                        Number.isFinite(funding) && funding < 0 && "text-green-400",
                      )}
                    >
                      {formatPerpUsd(position.funding)}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums text-muted-foreground @[760px]/perppos:table-cell">
                      <PositionTriggerControls
                        coin={position.coin}
                        kind="sl"
                        orders={stopLossOrders}
                        editable={canManageTpsl}
                        onEdit={(order) =>
                          openTriggerEditor(position.coin, "sl", order)
                        }
                        className="flex-col items-end"
                      />
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums text-muted-foreground @[760px]/perppos:table-cell">
                      <PositionTriggerControls
                        coin={position.coin}
                        kind="tp"
                        orders={takeProfitOrders}
                        editable={canManageTpsl}
                        onEdit={(order) =>
                          openTriggerEditor(position.coin, "tp", order)
                        }
                        className="flex-col items-end"
                      />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-11 w-11 shrink-0 p-0 xl:h-7 xl:w-7"
                          onClick={(event) => {
                            event.stopPropagation();
                            setShareCoin(position.coin);
                          }}
                          aria-label={`Share ${perpDisplayCoin(position.coin)} P&L`}
                          title="Share P&L"
                        >
                          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-11 w-11 gap-1 p-0 xl:h-7 xl:w-7 @[680px]/perppos:w-auto @[680px]/perppos:px-2"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCloseTargetCoin(position.coin);
                          }}
                          disabled={pendingClose !== null || closeMutation.isPending}
                          aria-label={
                            isClosing
                              ? `Closing ${perpDisplayCoin(position.coin)} position`
                              : `Close ${perpDisplayCoin(position.coin)} position`
                          }
                          title={
                            isClosing
                              ? `Closing ${perpDisplayCoin(position.coin)} position`
                              : `Close ${perpDisplayCoin(position.coin)} position`
                          }
                        >
                          {isClosing ? (
                            <LoaderCircle
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          <span className="sr-only @[680px]/perppos:not-sr-only">
                            {isClosing
                              ? closePhase === "confirming"
                                ? "Confirming..."
                                : "Closing..."
                              : "Close"}
                          </span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {tpslOpen && (
                    <tr className="border-b bg-muted/20">
                      <td colSpan={12} className="px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-3xs uppercase tracking-wide text-muted-foreground">
                              {editingTrigger?.coin === position.coin
                                ? `Edit ${editingTrigger.kind === "sl" ? "stop loss" : "take profit"}`
                                : "Protect position"}
                            </div>
                            <div className="mt-0.5 font-data text-xs text-foreground">
                              {position.side} {position.size} {perpDisplayCoin(position.coin)} @ {formatPx(position.entryPx)}
                            </div>
                          </div>
                          <ToggleGroup
                            type="single"
                            value={tpslMode}
                            onValueChange={changeTpslMode}
                            aria-label="TP/SL input mode"
                            className="rounded-md border bg-background/60 p-0.5"
                          >
                            <ToggleGroupItem
                              value="roePercent"
                              className="h-11 px-2 text-3xs xl:h-7"
                            >
                              ROE %
                            </ToggleGroupItem>
                            <ToggleGroupItem value="pnlUsd" className="h-11 px-2 text-3xs xl:h-7">
                              $ P&amp;L
                            </ToggleGroupItem>
                            <ToggleGroupItem value="price" className="h-11 px-2 text-3xs xl:h-7">
                              Price
                            </ToggleGroupItem>
                          </ToggleGroup>
                          <div className="flex items-center gap-1">
                            {editingTrigger?.coin === position.coin && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-11 px-2 text-3xs text-muted-foreground hover:text-destructive xl:h-7"
                                onClick={() =>
                                  handleCancelOrder(position.coin, editingTrigger.orderId)
                                }
                                disabled={
                                  cancelOrderMutation.isPending &&
                                  cancelOrderMutation.variables?.orderId ===
                                    editingTrigger.orderId
                                }
                              >
                                {cancelOrderMutation.isPending &&
                                cancelOrderMutation.variables?.orderId ===
                                  editingTrigger.orderId
                                  ? "Cancelling..."
                                  : `Cancel ${editingTrigger.kind === "sl" ? "SL" : "TP"}`}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-11 w-11 p-0 xl:h-7 xl:w-7"
                              onClick={closeTpslEditor}
                              aria-label={`Close TP/SL editor for ${perpDisplayCoin(position.coin)}`}
                              title="Close"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-start gap-3">
                          <div className="space-y-1">
                            <label
                              htmlFor={`sl-${position.coin}`}
                              className="block text-3xs uppercase tracking-wide text-muted-foreground"
                            >
                              {tpslMode === "roePercent"
                                ? "Max loss ROE %"
                                : tpslMode === "pnlUsd"
                                  ? "Max loss $"
                                  : "Stop price"}
                            </label>
                            <Input
                              id={`sl-${position.coin}`}
                              inputMode="decimal"
                              type="number"
                              min="0"
                              step="any"
                              placeholder={
                                tpslMode === "roePercent"
                                  ? "2"
                                  : tpslMode === "pnlUsd"
                                    ? "50"
                                    : "0.00"
                              }
                              aria-label={`Stop-loss ${tpslMode} for ${perpDisplayCoin(position.coin)}`}
                              value={slDraft}
                              onChange={(e) => setSlDraft(e.target.value)}
                              className="h-11 w-28 font-data tabular-nums xl:h-8"
                            />
                            {slDraft.trim() && (
                              <p
                                className={cn(
                                  "text-3xs",
                                  stopLossPreview != null &&
                                    isPerpTriggerDirectionValid(
                                      "stopLoss",
                                      position.side,
                                      stopLossPreview,
                                      marketPrice,
                                    )
                                    ? "text-red-400"
                                    : "text-destructive",
                                )}
                              >
                                {stopLossPreview != null
                                  ? `Trigger ${formatPx(stopLossPreview)}`
                                  : "Invalid value"}
                              </p>
                            )}
                          </div>
                          <div className="space-y-1">
                            <label
                              htmlFor={`tp-${position.coin}`}
                              className="block text-3xs uppercase tracking-wide text-muted-foreground"
                            >
                              {tpslMode === "roePercent"
                                ? "Profit target ROE %"
                                : tpslMode === "pnlUsd"
                                  ? "Profit target $"
                                  : "Target price"}
                            </label>
                            <Input
                              id={`tp-${position.coin}`}
                              inputMode="decimal"
                              type="number"
                              min="0"
                              step="any"
                              placeholder={
                                tpslMode === "roePercent"
                                  ? "4"
                                  : tpslMode === "pnlUsd"
                                    ? "100"
                                    : "0.00"
                              }
                              aria-label={`Take-profit ${tpslMode} for ${perpDisplayCoin(position.coin)}`}
                              value={tpDraft}
                              onChange={(e) => setTpDraft(e.target.value)}
                              className="h-11 w-28 font-data tabular-nums xl:h-8"
                            />
                            {tpDraft.trim() && (
                              <p
                                className={cn(
                                  "text-3xs",
                                  takeProfitPreview != null &&
                                    isPerpTriggerDirectionValid(
                                      "takeProfit",
                                      position.side,
                                      takeProfitPreview,
                                      marketPrice,
                                    )
                                    ? "text-green-400"
                                    : "text-destructive",
                                )}
                              >
                                {takeProfitPreview != null
                                  ? `Trigger ${formatPx(takeProfitPreview)}`
                                  : "Invalid value"}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            className="h-11 xl:h-8"
                            onClick={() => handleSetTpSl(position)}
                            disabled={tpslMutation.isPending || modifyTpslMutation.isPending}
                          >
                            {isSettingTpsl
                              ? editingTrigger?.coin === position.coin
                                ? "Updating..."
                                : "Setting..."
                              : editingTrigger?.coin === position.coin
                                ? "Update"
                                : "Set TP/SL"}
                          </Button>
                        </div>
                        <p className="mt-2 text-3xs text-muted-foreground">
                          {tpslMode === "roePercent"
                            ? "ROE targets use current position margin, so leverage is reflected in the calculated trigger. Fees, funding, and slippage can change realized P&L."
                            : tpslMode === "pnlUsd"
                              ? "Dollar values are total position loss or profit, calculated from entry and size."
                              : "Enter exact trigger prices."}{" "}
                          Leave either field blank to set only one protective leg.
                        </p>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </>
    );
  };

  return (
    <div className="min-w-0 max-w-full space-y-4 xl:h-full xl:min-h-0 xl:overflow-hidden">
      <Card className="premium-panel xl:h-full xl:min-h-0 gap-0 rounded-none border-0 bg-background py-0 shadow-none">
        {header}
        <CardContent className="@container/perppos min-w-0 overflow-x-hidden p-0 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
          {body()}
        </CardContent>
      </Card>
      <ClosePositionAlertDialog
        open={closeTarget !== null}
        displayName={closeTarget ? perpDisplayCoin(closeTarget.coin) : ""}
        description={
          closeTarget
            ? `This submits a reduce-only market order for the full ${closeTarget.size} ${perpDisplayCoin(closeTarget.coin)} position. The final fill price may differ from the current mark.`
            : undefined
        }
        isPending={closeMutation.isPending}
        pendingDescription={
          showSlowCloseNotice
            ? "This is taking longer than usual. You can hide this dialog; the close will remain locked while we confirm it with Hyperliquid."
            : "Submitting the reduce-only close to Hyperliquid..."
        }
        allowPendingDismiss={showSlowCloseNotice}
        pendingDismissLabel="Hide"
        pendingActionLabel={showSlowCloseNotice ? "Still closing..." : "Closing..."}
        onCancel={() => {
          if (!closeMutation.isPending || showSlowCloseNotice) {
            setCloseTargetCoin(null);
          }
        }}
        onConfirm={() => {
          if (closeTarget) handleClose(closeTarget);
        }}
      />
      <SharePnlModal
        open={shareCoin !== null}
        symbol={shareCoin ? perpDisplayCoin(shareCoin) : ""}
        onClose={() => setShareCoin(null)}
        generate={(hideAmount) =>
          sharePnlMutation.mutateAsync({
            coin: shareCoin ?? "",
            hideAmount,
          })
        }
      />
    </div>
  );
}
