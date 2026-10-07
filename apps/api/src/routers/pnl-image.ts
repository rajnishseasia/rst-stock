/**
 * PNL Image Router
 *
 * tRPC mutations that proxy shareable PNL card generation to the worker's
 * private HTTP server (native canvas rendering can't run on Vercel).
 *
 * Open positions are valued server-side from the live venue position (Alpaca
 * for equities/options, Hyperliquid for perps) so a stale/malicious client can
 * never put fabricated open-position numbers on a card. Closed orders use the
 * client's row values (like the Olympus closed flow) but are strictly validated
 * and re-derived here.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDecryptedCredentials } from "../lib/credentials.js";
import { createAlpacaClientFromCredentials } from "../lib/alpaca.js";
import { callWorker } from "../lib/call-worker.js";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import { resolveHlWalletAddress } from "../lib/hl-wallet.js";
import { networkFromEnv } from "@trade-bot/hyperliquid";

const credentialSelectorSchema = {
  credentialId: z.string().uuid().optional(),
  accountId: z.string().optional(),
};

// Reject NaN/Infinity and absurd magnitudes for client-provided numbers.
const cardNumber = z.number().gt(-1e12).lt(1e12);

interface PnlImageResponse {
  base64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

interface PnlCardPayload {
  symbol: string;
  side: "long" | "short";
  qty?: number;
  unitLabel?: string;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  pnlPercent: number;
  totalValueUsd: number;
  result: "open" | "closed";
  hideAmount?: boolean;
  leverageLabel?: string;
}

/**
 * Display name for an HL coin: HIP-3 assets are namespaced as "dex:COIN" and
 * only the bare coin belongs on a shareable card. Mirrors `perpDisplayCoin` on
 * the web side.
 */
function perpDisplayCoin(coin: string): string {
  const separator = coin.indexOf(":");
  if (separator === -1) return coin;
  const bare = coin.slice(separator + 1).trim();
  return bare === "" ? coin : bare;
}

/**
 * HL quotes every position field as a decimal string and uses null for "not
 * reported" (a cross-margin position has no liquidation price, and a fresh
 * position may have no ROE yet). `Number(null)` is 0, which is finite, so a
 * plain Number() coercion would silently render a missing price as $0.
 */
function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

const OPEN_PERP_FILL_SCAN = 200;

/**
 * Replays the venue's recent fills for one coin and returns realized P&L only
 * when the reconstructed open size agrees with the live position. A missing
 * opening fill makes the result unknown instead of understating the share card.
 */
function realizedPnlForOpenPerp(
  fills: Awaited<ReturnType<ReturnType<typeof createHyperliquidInfoClient>["listFills"]>>,
  position: { coin: string; side: "long" | "short"; size: string },
): number | null {
  const ordered = fills
    .filter((fill) => fill.coin === position.coin)
    .sort((a, b) => a.time - b.time || a.oid - b.oid);
  let signedSize = 0;
  let realizedPnl = 0;
  let runKnown = false;

  for (const fill of ordered) {
    const size = toFiniteNumber(fill.sz);
    if (size == null || size <= 0) continue;
    const closing = /close|liquidat|>/i.test(fill.dir);
    const delta = fill.side === "buy" ? size : -size;

    if (signedSize === 0) {
      if (closing) continue;
      signedSize = delta;
      realizedPnl = 0;
      runKnown = true;
      continue;
    }

    const before = signedSize;
    const after = before + delta;
    if (closing && runKnown) {
      realizedPnl += toFiniteNumber(fill.closedPnl) ?? 0;
    }

    const flat = Math.abs(after) < 1e-12;
    const flipped = !flat && Math.sign(after) !== Math.sign(before);
    if (flat) {
      signedSize = 0;
      realizedPnl = 0;
      runKnown = false;
    } else if (flipped) {
      signedSize = after;
      realizedPnl = 0;
      runKnown = true;
    } else {
      signedSize = after;
    }
  }

  const liveSize = toFiniteNumber(position.size);
  if (!runKnown || liveSize == null || liveSize <= 0) return null;
  const liveSignedSize = position.side === "long" ? liveSize : -liveSize;
  const tolerance = Math.max(1e-8, Math.abs(liveSignedSize) * 1e-8);
  return Math.abs(signedSize - liveSignedSize) <= tolerance ? realizedPnl : null;
}

function unitLabelFor(assetClass: string | undefined, qty: number): string {
  const unit = assetClass === "us_option" ? "contract" : "share";
  return qty === 1 ? unit : `${unit}s`;
}

export const pnlImageRouter = router({
  /**
   * Generate a card for an open position. Values come from the live Alpaca
   * position, never from the client.
   */
  generateOpenPosition: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50),
        ...credentialSelectorSchema,
        hideAmount: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Alpaca credentials missing. Please configure in Settings.",
        });
      }

      const client = createAlpacaClientFromCredentials(credentials);

      let position;
      try {
        position = await client.getPosition(input.symbol);
      } catch (error) {
        if (error instanceof Error && error.message.includes("404")) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No open position for ${input.symbol}`,
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to fetch position",
        });
      }

      const qty = Math.abs(parseFloat(position.qty));
      const payload: PnlCardPayload = {
        symbol: position.symbol,
        side: position.side === "short" ? "short" : "long",
        qty: Number.isFinite(qty) && qty > 0 ? qty : undefined,
        unitLabel: unitLabelFor(position.asset_class, qty),
        entryPrice: parseFloat(position.avg_entry_price),
        exitPrice: parseFloat(position.current_price),
        pnlUsd: parseFloat(position.unrealized_pl),
        pnlPercent: parseFloat(position.unrealized_plpc) * 100,
        totalValueUsd: Math.abs(parseFloat(position.market_value)),
        result: "open",
        hideAmount: input.hideAmount,
      };

      return callWorker<PnlImageResponse>("/pnl-image/generate", payload);
    }),

  /**
   * Generate a card for an open Hyperliquid perp position. Like the equity
   * open-position card, every number is read from the venue here so a stale or
   * malicious client can never put fabricated figures on a card: the client
   * sends only which coin to share.
   */
  generateOpenPerp: protectedProcedure
    .input(
      z.object({
        coin: z.string().min(1).max(50),
        hideAmount: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const walletAddress = await resolveHlWalletAddress(ctx.db, ctx.userId);
      if (!walletAddress) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Perps are not enabled for this account.",
        });
      }

      const info = createHyperliquidInfoClient({ network: networkFromEnv() });
      let positions;
      try {
        positions = await info.listPositions(walletAddress);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error ? error.message : "Failed to fetch perp positions",
        });
      }

      const position = positions.find((row) => row.coin === input.coin);
      if (!position) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No open perp position for ${perpDisplayCoin(input.coin)}`,
        });
      }

      const size = toFiniteNumber(position.size);
      const entryPrice = toFiniteNumber(position.entryPx);
      const markPrice = toFiniteNumber(position.markPx);
      const pnlUsd = toFiniteNumber(position.unrealizedPnl);
      if (
        entryPrice == null ||
        entryPrice <= 0 ||
        markPrice == null ||
        markPrice <= 0 ||
        pnlUsd == null
      ) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Hyperliquid returned an incomplete position",
        });
      }
      const absSize = size == null ? null : Math.abs(size);
      const fills = await info.listFills(walletAddress, OPEN_PERP_FILL_SCAN);
      const realizedPnl = realizedPnlForOpenPerp(fills, position);
      const totalPnlUsd = pnlUsd + (realizedPnl ?? 0);

      // The headline percent is return on EQUITY (P&L against the margin
      // actually at risk), which is what the positions table shows and the only
      // percentage that means anything on a leveraged position. HL reports it
      // as a decimal. Preserve that venue value for the unrealized component,
      // then add realized return over the same margin for a total-position card.
      const roe = toFiniteNumber(position.returnOnEquity);
      const marginUsed = toFiniteNumber(position.marginUsed);
      const unrealizedReturn =
        roe ?? (marginUsed != null && marginUsed > 0 ? pnlUsd / marginUsed : 0);
      const realizedReturn =
        realizedPnl != null && marginUsed != null && marginUsed > 0
          ? realizedPnl / marginUsed
          : 0;
      const pnlPercent = (unrealizedReturn + realizedReturn) * 100;

      const payload: PnlCardPayload = {
        symbol: perpDisplayCoin(position.coin),
        side: position.side === "short" ? "short" : "long",
        qty: absSize != null && absSize > 0 ? absSize : undefined,
        unitLabel: perpDisplayCoin(position.coin),
        entryPrice,
        exitPrice: markPrice,
        pnlUsd: totalPnlUsd,
        pnlPercent,
        totalValueUsd: absSize != null ? absSize * markPrice : 0,
        result: "open",
        leverageLabel: `${position.leverage}x ${position.marginMode}`,
        hideAmount: input.hideAmount,
      };

      return callWorker<PnlImageResponse>("/pnl-image/generate", payload);
    }),

  /**
   * Generate a card for a closed order (history row). The client supplies the
   * row's fill values; entry price and percent are re-derived server-side
   * from qty/fill/P&L so the displayed numbers are internally consistent.
   */
  generateClosedOrder: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50),
        /** Side of the CLOSING order — sell closes a long, buy closes a short. */
        side: z.enum(["buy", "sell"]),
        qty: cardNumber.positive(),
        fillPrice: cardNumber.positive(),
        realizedPnl: cardNumber,
        assetClass: z.string().max(40).optional(),
        hideAmount: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const multiplier = input.assetClass === "us_option" ? 100 : 1;
      const positionSide = input.side === "sell" ? "long" : "short";

      // Reconstruct the entry price from the fill and realized P&L:
      // long: pnl = (exit - entry) * qty * mult; short: pnl = (entry - exit) * ...
      const perUnitPnl = input.realizedPnl / (input.qty * multiplier);
      const entryPrice =
        positionSide === "long"
          ? input.fillPrice - perUnitPnl
          : input.fillPrice + perUnitPnl;

      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Provided values do not describe a valid closed trade",
        });
      }

      const costBasis = entryPrice * input.qty * multiplier;
      const pnlPercent = costBasis > 0 ? (input.realizedPnl / costBasis) * 100 : 0;

      const payload: PnlCardPayload = {
        symbol: input.symbol,
        side: positionSide,
        qty: input.qty,
        unitLabel: unitLabelFor(input.assetClass, input.qty),
        entryPrice,
        exitPrice: input.fillPrice,
        pnlUsd: input.realizedPnl,
        pnlPercent,
        totalValueUsd: costBasis,
        result: "closed",
        hideAmount: input.hideAmount,
      };

      return callWorker<PnlImageResponse>("/pnl-image/generate", payload);
    }),
});
