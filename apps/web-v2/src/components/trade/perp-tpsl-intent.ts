import { isValidPerpsMasterAddress } from "@/lib/perps-wallet-selection";

type OpenOrdersQueryState = {
  isFetching?: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
  dataUpdatedAt?: number;
  isSuccess?: boolean;
  error?: unknown;
  data?: { orders?: unknown } | null;
};

export const PERP_TPSL_OPEN_ORDERS_STALE_TIME_MS = 15_000;

export function isPerpTpSlActionable(
  walletAddress: string | null | undefined,
  openOrdersQuery: OpenOrdersQueryState,
  now = Date.now(),
): boolean {
  const dataUpdatedAt = openOrdersQuery.dataUpdatedAt;
  return (
    isValidPerpsMasterAddress(walletAddress) &&
    openOrdersQuery.isSuccess === true &&
    openOrdersQuery.error == null &&
    Array.isArray(openOrdersQuery.data?.orders) &&
    openOrdersQuery.isFetching === false &&
    openOrdersQuery.fetchStatus === "idle" &&
    typeof dataUpdatedAt === "number" &&
    Number.isFinite(dataUpdatedAt) &&
    Number.isFinite(now) &&
    dataUpdatedAt <= now &&
    now - dataUpdatedAt < PERP_TPSL_OPEN_ORDERS_STALE_TIME_MS
  );
}

export function dispatchPerpTpSlActionIfFresh(
  walletAddress: string | null | undefined,
  openOrdersQuery: OpenOrdersQueryState,
  dispatch: () => void,
  now = Date.now(),
): boolean {
  if (!isPerpTpSlActionable(walletAddress, openOrdersQuery, now)) return false;
  dispatch();
  return true;
}

type PerpTpSlRequestFields = {
  coin: string;
  positionSide: "long" | "short";
  size: string;
  cloid: string;
  isMarket: boolean;
  stopLossPx?: string;
  takeProfitPx?: string;
};

export function buildFullPositionPerpTpSlRequest<T extends PerpTpSlRequestFields>(
  request: T,
): T & { sizeMode: "full-position" } {
  return { ...request, sizeMode: "full-position" };
}

export type PerpTpSlIntentResolution =
  | "definitive-success"
  | "definitive-failure"
  | "reconciliation-needed"
  | "query-timeout"
  | "query-error"
  | "empty-open-orders";

export function createPerpTpSlIntentStore(generateCloid: () => string) {
  const cloidsBySignature = new Map<string, string>();

  return {
    getOrCreate(signature: string): string {
      const existing = cloidsBySignature.get(signature);
      if (existing) return existing;
      const cloid = generateCloid();
      cloidsBySignature.set(signature, cloid);
      return cloid;
    },

    resolve(
      clientOrderId: string | null | undefined,
      resolution: PerpTpSlIntentResolution,
    ): void {
      if (
        !clientOrderId ||
        (resolution !== "definitive-success" &&
          resolution !== "definitive-failure")
      ) {
        return;
      }

      for (const [signature, cloid] of cloidsBySignature) {
        if (cloid === clientOrderId) cloidsBySignature.delete(signature);
      }
    },
  };
}
