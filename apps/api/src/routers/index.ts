/**
 * Main tRPC Router
 *
 * Combine all sub-routers here.
 */

import { router } from "../trpc.js";
import { signalsRouter } from "./signals.js";
import { ordersRouter } from "./orders.js";
import { userSettingsRouter } from "./user-settings.js";
import { quotesRouter } from "./quotes.js";
import { positionsRouter } from "./positions.js";
import { socialRouter } from "./social.js";
import { llmCredentialsRouter } from "./llm-credentials.js";
import { watchlistRouter } from "./watchlist.js";
import { chartsRouter } from "./charts.js";
import { pnlImageRouter } from "./pnl-image.js";
import { copyTradeRouter } from "./copy-trade.js";
import { copyTradeFollowsRouter } from "./copy-trade-follows.js";
import { leaderboardRouter } from "./leaderboard.js";
import { signaRouter } from "./signa.js";
import { chatConversationsRouter } from "./chat-conversations.js";
import { symbolsRouter } from "./symbols.js";
import { marketsRouter } from "./markets.js";
import { hyperliquidRouter } from "./hyperliquid.js";
import { marketPulseRouter } from "./market-pulse.js";

export const appRouter = router({
  signals: signalsRouter,
  orders: ordersRouter,
  userSettings: userSettingsRouter,
  quotes: quotesRouter,
  positions: positionsRouter,
  social: socialRouter,
  llmCredentials: llmCredentialsRouter,
  watchlist: watchlistRouter,
  charts: chartsRouter,
  pnlImage: pnlImageRouter,
  copyTrade: copyTradeRouter,
  copyTradeFollows: copyTradeFollowsRouter,
  leaderboard: leaderboardRouter,
  signa: signaRouter,
  chatConversations: chatConversationsRouter,
  symbols: symbolsRouter,
  markets: marketsRouter,
  hyperliquid: hyperliquidRouter,
  marketPulse: marketPulseRouter,
});

// Export type for client usage
export type AppRouter = typeof appRouter;
