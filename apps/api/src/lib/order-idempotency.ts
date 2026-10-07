import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ALPACA_CLIENT_ORDER_ID_MAX_LENGTH,
  createBrokerClientOrderId,
} from "@trade-bot/alpaca";

export const clientOrderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ALPACA_CLIENT_ORDER_ID_MAX_LENGTH);

export function resolveClientOrderId(
  userId: string,
  logicalId: string | undefined,
  namespace: string,
): string {
  const resolvedLogicalId = logicalId?.trim() || `ord_${randomUUID()}`;
  return createBrokerClientOrderId(userId, resolvedLogicalId, namespace);
}
