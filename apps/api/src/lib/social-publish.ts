/**
 * Social feed publication (audit M12).
 *
 * The social-feed publication block used to be
 * copy-pasted into every order-submitting procedure with small drifts in
 * logging and null handling. One helper, fire-and-forget by contract: it
 * NEVER throws, so social publishing can never break an order flow.
 */

import { schema } from "@trade-bot/db";
import type { PoolDb } from "@trade-bot/db";
import { createProductionLogger } from "@trade-bot/logger";
import { isPaperAccount } from "./alpaca.js";

const logger = createProductionLogger();

export interface SocialTradePayload {
  symbol: string;
  side: string;
  qty: number;
  orderType: string;
  assetType: string;
  limitPrice?: number | string | null;
  brokerOrderId?: string | null;
  orderId?: string | null;
  /** Log label, e.g. "Bracket trade". Defaults to "Trade". */
  label?: string;
}

/**
 * Insert a social_trades row for every live Alpaca trade. Paper/SIM accounts
 * are intentionally private and never enter the feed or leaderboard. Errors
 * are swallowed and logged at warn: broker state is already committed by the
 * time this runs, and a feed hiccup must not fail the order response.
 */
export async function publishSocialTrade(
  db: PoolDb,
  userId: string,
  payload: SocialTradePayload,
  accountType: string | null | undefined,
): Promise<void> {
  if (isPaperAccount(accountType)) return;

  try {
    await db.insert(schema.socialTrades).values({
      userId,
      symbol: payload.symbol,
      side: payload.side,
      qty: payload.qty,
      orderType: payload.orderType,
      assetType: payload.assetType,
      limitPrice: payload.limitPrice != null ? String(payload.limitPrice) : null,
      brokerOrderId: payload.brokerOrderId ?? null,
      orderId: payload.orderId ?? null,
    });
    logger.info("api", `[Social] ${payload.label ?? "Trade"} published to social feed`, {
      symbol: payload.symbol,
    });
  } catch (socialErr) {
    // Never let social publishing break order flow.
    logger.warn("api", "[Social] Failed to publish trade", { error: socialErr });
  }
}
