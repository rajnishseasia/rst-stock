/**
 * Worker Entry Point
 *
 * Initialize and start background job processors.
 */

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "production",
  tracesSampleRate: 0, // Worker: no performance tracing needed, only errors
  enabled: !!process.env.SENTRY_DSN,
});

import {
  createProductionLogger,
  SKIP_ERROR_REPORT,
  setAlertCooldownStore,
  setErrorReporter,
} from "@trade-bot/logger";
import {
  assertWorkerCanonicalIngestionCompatibility,
  assertWorkerCopyMirrorCompatibility,
  assertWorkerCopyMirrorDestinationsCompatibility,
  assertWorkerCopyTradeCapsCompatibility,
  assertWorkerCopyTradeLeverageCompatibility,
  assertWorkerWalletCopyCursorCompatibility,
  assertWorkerSchemaCompatibility,
  createWorkerPoolDb,
} from "@trade-bot/db";
import { getRedisClient } from "@trade-bot/redis";
import { RedisAlertCooldownStore } from "./lib/alert-cooldown-store";
import { sendFatalStartupAlert } from "./lib/fatal-alert";
import { describeError } from "./lib/log-safe-error";

const logger = createProductionLogger();

/**
 * Send every `logger.error` in this process to Sentry.
 *
 * Before this, Sentry saw exactly one kind of event from the worker: a startup
 * failure caught by `main().catch()` below. The 78 `logger.error` call sites in
 * the pollers and sync services wrote to stdout and nothing else, so a service
 * failing every cycle in production was visible only in Railway logs, or as a
 * bare count in a once-a-day Discord line. Installing the reporter here rather
 * than at each call site means new call sites are covered by default.
 *
 * Registered at call time by the logger package, so services that build their
 * logger at module scope are covered too, regardless of import order.
 */
setErrorReporter(({ error, service, message, context }) => {
  Sentry.captureException(error, {
    tags: { service },
    extra: { logMessage: message, ...context },
  });
});

/**
 * Report a crash the runtime is about to be killed by, then exit.
 *
 * Both handlers exit(1) deliberately. Node already terminates on an unhandled
 * rejection and on an uncaught exception, and the process state after either is
 * undefined; swallowing them here would trade a loud crash-and-restart for a
 * worker that silently stops doing its job. Preserving the exit also preserves
 * Railway's "Deployment Crashed" webhook, which is the out-of-band half of the
 * alerting.
 *
 * The original error is captured directly so Sentry gets its real stack. The
 * log line is marked to skip the reporter, otherwise the same crash files
 * twice: once from here and once through `logger.error`.
 */
async function reportFatalAndExit(kind: string, err: unknown): Promise<never> {
  const { errorName, errorMessage } = describeError(err);
  logger.error("worker", `Fatal: ${kind}`, {
    errorName,
    error: errorMessage,
    [SKIP_ERROR_REPORT]: true,
  });
  Sentry.captureException(err, { tags: { fatal: kind } });
  await Sentry.flush(2000);
  process.exit(1);
}

process.on("uncaughtException", (err) => {
  void reportFatalAndExit("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  void reportFatalAndExit("unhandledRejection", reason);
});

function getBunVersion(): string | undefined {
  if (typeof Bun === "undefined") return undefined;
  return Bun.version;
}

async function main() {
  logger.info("worker", "Starting worker...");
  logger.info("worker", "Runtime info", {
    bunVersion: getBunVersion(),
    nodeVersion: process.version,
    railwayGitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA,
    railwayServiceName: process.env.RAILWAY_SERVICE_NAME,
    npmLifecycleEvent: process.env.npm_lifecycle_event,
  });

  // Initialize database connection
  const databaseUrl = process.env.DATABASE_URL_DIRECT;
  if (!databaseUrl) {
    logger.warn(
      "worker",
      "DATABASE_URL_DIRECT not set. Worker cannot start. Set environment variables to enable worker.",
    );
    logger.warn("worker", "Required env vars: DATABASE_URL_DIRECT, REDIS_URL");
    // Exit gracefully in development to not crash the dev process
    if (process.env.NODE_ENV !== "production") {
      logger.info(
        "worker",
        "Exiting gracefully. Run 'bun dev:web' and 'bun dev:api' separately if worker is not needed.",
      );
      process.exit(0);
    }
    throw new Error("DATABASE_URL_DIRECT environment variable is required for worker");
  }
  const db = createWorkerPoolDb(databaseUrl);
  // Railway pre-deploy applies the committed chain through 0041 before this
  // version starts. Keep every compatibility check before Redis or any poller
  // so no affected job can write first.
  await assertWorkerSchemaCompatibility(db);
  await assertWorkerCanonicalIngestionCompatibility(db);
  await assertWorkerCopyMirrorCompatibility(db);
  await assertWorkerCopyMirrorDestinationsCompatibility(db);
  await assertWorkerCopyTradeLeverageCompatibility(db);
  await assertWorkerWalletCopyCursorCompatibility(db);
  await assertWorkerCopyTradeCapsCompatibility(db);

  // Every order poller uses the same worker pool for linked-X identity. The
  // serverless DB helper reads different env variables and must not be called
  // from this long-lived process.
  const { createDiscordNotificationSender } = await import(
    "./services/discord-notify"
  );
  const discordNotify = createDiscordNotificationSender(db);

  // Initialize Redis connection
  const redis = await getRedisClient(logger);

  // Move the burst-alert suppression window off the heap and into Redis. Held
  // in memory it reset on every restart, so a known error source re-alerted
  // each time the worker came back rather than once a day as documented.
  setAlertCooldownStore(new RedisAlertCooldownStore(redis));

  // Initialize your job queues and handlers here
  // Example with BullMQ:
  // const queue = new Queue('tasks', { connection: redis });
  // const worker = new Worker('tasks', handleJob, { connection: redis });

  // Initialize Discord Poller (stock-calls channel)
  const { DiscordPoller } = await import("./services/discord-poller");
  const discordPoller = new DiscordPoller(db);
  await discordPoller.start();

  // Initialize Order Sync Poller
  const { OrderSyncPoller } = await import("./services/order-sync");
  const orderSyncPoller = new OrderSyncPoller(db, { notify: discordNotify });
  await orderSyncPoller.start();

  // Initialize paste.trade Board Poller (extra signal source).
  //
  // Ships INERT like the optional pollers below: start() does nothing unless
  // PASTE_TRADE_POLLER_ENABLED is exactly the string "true" (no interval, no
  // network, no DB reads). It is READ-ONLY (only inserts into `signals`) and
  // OFF in CI / dev / review by default, so registering it here is safe.
  const { PasteTradePoller } = await import("./services/paste-trade-poller");
  const pasteTradePoller = new PasteTradePoller(db);
  await pasteTradePoller.start();

  // Start the private HTTP server (PNL image generation for the API).
  // No-op unless WORKER_API_SECRET is configured.
  const { startWorkerHttpServer } = await import("./http/server");
  await startWorkerHttpServer(logger);
  
  // Initialize External Discord Signal Poller (Neil Arora channel -> HL perps).
  //
  // This is a direct-execution path, so it is opt-in and fully absent from the
  // startup path unless the exact string gate is enabled. The poller also
  // checks the gate in start() for callers that construct it directly.
  if (process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED === "true") {
    const { ExternalDiscordSignalPoller } = await import("./services/external-discord-signal-poller");
    const externalDiscordSignalPoller = new ExternalDiscordSignalPoller(db, logger);
    await externalDiscordSignalPoller.start();
  } else {
    logger.info("worker", "External Discord signal poller disabled by env gate", {
      EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED:
        process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED ?? "(unset)",
    });
  }

  // Initialize Copy-Mirror Poller (Phase 3 auto-mirror).
  //
  // ⚠️ This service can place REAL broker orders, so it ships INERT: start()
  // does nothing at all unless COPY_TRADE_AUTOMIRROR_ENABLED is exactly the
  // string "true" (no interval scheduled, no DB reads, no orders). It is OFF in
  // CI / dev / review by default — registering it here is safe.
  //
  // Log the copy-mirror and perps gate flag values so Railway deployment logs
  // make it immediately visible whether these guards are active. Values are
  // boolean flags (not secrets) so logging them directly is safe.
  logger.info("worker", "copy-mirror env gate snapshot", {
    COPY_TRADE_AUTOMIRROR_ENABLED:        process.env.COPY_TRADE_AUTOMIRROR_ENABLED         ?? "(unset)",
    COPY_TRADE_AUTOMIRROR_ALLOW_LIVE:     process.env.COPY_TRADE_AUTOMIRROR_ALLOW_LIVE      ?? "(unset)",
    COPY_TRADE_AUTOMIRROR_PERPS_ENABLED:  process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED   ?? "(unset)",
    COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: process.env.COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET ?? "(unset)",
    HYPERLIQUID_SYNC_ENABLED:             process.env.HYPERLIQUID_SYNC_ENABLED              ?? "(unset)",
  });
  const { CopyMirrorPoller } = await import("./services/copy-mirror");
  const copyMirrorPoller = new CopyMirrorPoller(db);
  await copyMirrorPoller.start();

  // Initialize Hyperliquid Perp Order-Sync Poller.
  //
  // Runs by DEFAULT, unlike CopyMirrorPoller. This poller is strictly READ-ONLY:
  // it reconciles open perp orders from HL userFills/openOrders and can never
  // place, cancel, close, or transfer, so there is nothing to ship inert. It is
  // also the only writer of perp fill sizes, so a deployment running it is the
  // only deployment that can size a perp close. Set HYPERLIQUID_SYNC_ENABLED=false
  // to stop it for incident response. With no open perp orders (CI, dev, review)
  // a cycle is one indexed query that returns zero rows and stops.
  const { HyperliquidOrderSyncPoller } = await import("./services/hyperliquid-order-sync");
  const hyperliquidOrderSyncPoller = new HyperliquidOrderSyncPoller(db, {
    notify: discordNotify,
  });
  await hyperliquidOrderSyncPoller.start();

  // Optional once-daily AI summary of the previous 24 hours of signals.
  const { DailySignalDigest } = await import("./services/daily-signal-digest");
  const dailySignalDigest = new DailySignalDigest(db);
  await dailySignalDigest.start();

  // Initialize External Fill Poller (Alpaca-side reconciliation).
  //
  // ⚠️ Ships INERT: start() does nothing at all unless the env flag
  // EXTERNAL_FILL_DETECT_ENABLED is exactly the string "true" (no interval, no
  // DB reads, no Alpaca calls). Even when enabled, the poller is READ + INSERT
  // ONLY — it lists Alpaca orders, inserts previously-unseen fills into
  // `orders` tagged externalOrigin=true, and emits a socialTrades row so the
  // existing CopyMirrorPoller mirrors them. It NEVER places, cancels, or
  // modifies broker orders. Discord notify honors the LIVE-only gating used by
  // OrderSyncPoller. See docs/tasks/COPY-TRADE-EXTERNAL-FILLS-SCOPE.md.
  const { ExternalFillPoller } = await import("./services/external-fill-sync");
  const externalFillPoller = new ExternalFillPoller(db, {
    notify: discordNotify,
  });
  await externalFillPoller.start();

  // Initialize the Hyperliquid External Fill Poller (perp-side counterpart).
  //
  // ⚠️ Ships INERT: start() does nothing unless HYPERLIQUID_EXTERNAL_FILL_ENABLED
  // is exactly the string "true". Closes the gap that let a stop-loss attached
  // in Hyperliquid's own UI fire with no alert at all: the row-driven
  // HyperliquidOrderSyncPoller can only see fills that already have an order
  // row, so a stop placed outside the app is invisible to it by construction.
  // READ-ONLY at the venue (keyless InfoClient, never a signing client) and
  // INSERT-ONLY locally. See the file header for the full guarantee list.
  const { HyperliquidExternalFillPoller } = await import(
    "./services/hyperliquid-external-fill-sync"
  );
  const hyperliquidExternalFillPoller = new HyperliquidExternalFillPoller(db, {
    notify: discordNotify,
  });
  await hyperliquidExternalFillPoller.start();

  // Initialize HL Wallet Copy Poller (copies fills from arbitrary HL wallets).
  //
  // This source watcher is read-only at Hyperliquid. It stages fills into the
  // shared durable copy-mirror inbox; CopyMirrorPoller remains the only order
  // execution owner. It ships INERT unless all source-staging gates are true:
  //   HL_WALLET_COPY_ENABLED=true
  //   COPY_TRADE_AUTOMIRROR_ENABLED=true
  //   COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true
  //   HYPERLIQUID_SYNC_ENABLED=true
  //   HYPERLIQUID_NETWORK is explicit, with the matching network permission.
  // The shared execution path separately repeats live/mainnet/consent checks.
  logger.info("worker", "hl-wallet-copy env gate snapshot", {
    HL_WALLET_COPY_ENABLED: process.env.HL_WALLET_COPY_ENABLED ?? "(unset)",
  });
  const { HlWalletCopyPoller } = await import(
    "./services/hl-wallet-copy-poller"
  );
  const hlWalletCopyPoller = new HlWalletCopyPoller(
    db,
    (candidates) => copyMirrorPoller.stageExternalCandidates(candidates),
  );
  await hlWalletCopyPoller.start();

  // Last-line recovery for source closes missed during a worker outage. It is
  // report-only unless its separate execution gate is explicitly enabled.
  const { CopyMirrorPositionFailsafe } = await import(
    "./services/copy-mirror-position-failsafe"
  );
  const copyMirrorPositionFailsafe = new CopyMirrorPositionFailsafe(
    db,
    (candidates) => copyMirrorPoller.stageExternalCandidates(candidates),
  );
  copyMirrorPositionFailsafe.start();

  logger.info("worker", "Worker started successfully");

  // Handle graceful shutdown
  process.on("SIGTERM", async () => {
    logger.info("worker", "Received SIGTERM, shutting down...");
    // await worker.close();
    await Sentry.flush(2000);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    logger.info("worker", "Received SIGINT, shutting down...");
    // await worker.close();
    await Sentry.flush(2000);
    process.exit(0);
  });
}

main().catch(async (err) => {
  const { errorName, errorMessage } = describeError(err);
  // Skips the logger's Sentry reporter: the raw error is captured below, with
  // its real stack, and one crash should not file two issues.
  logger.error("worker", "Failed to start worker", {
    errorName,
    error: errorMessage,
    [SKIP_ERROR_REPORT]: true,
  });

  // Both sinks, deliberately. Sentry is the durable record with a stack; the
  // webhook is what a human actually sees at 3am. The ErrorBurstAlerter in the
  // logger cannot cover this path either way: it needs 20 errors inside one
  // process in a rolling hour, and a startup failure produces exactly one
  // before the process dies, so every restart resets the counter. That is how
  // this worker crash-looped for 20 hours in silence.
  Sentry.captureException(err);

  // Await BOTH deliveries before exiting: process.exit(1) cancels an in-flight
  // post, which is the other half of why nothing was reported. Each call is
  // independently bounded (FATAL_ALERT_TIMEOUT_MS, and Sentry's own 2s) so a
  // hung endpoint cannot keep a doomed process alive.
  const alerted = await sendFatalStartupAlert(err);
  if (!alerted) {
    logger.warn("worker", "Fatal startup alert was not delivered", {
      reason: process.env.WORKER_ERROR_ALERT_WEBHOOK_URL
        ? "delivery_failed"
        : "webhook_not_configured",
    });
  }
  await Sentry.flush(2000);

  process.exit(1);
});
