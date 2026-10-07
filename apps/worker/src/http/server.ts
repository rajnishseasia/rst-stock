/**
 * Worker HTTP Server
 *
 * Small private Hono server exposed by the long-lived worker process so the
 * serverless API can offload native-module work (PNL image rendering).
 *
 * Auth: every route except /health requires the shared X-Worker-Secret
 * header. The server is skipped entirely when WORKER_API_SECRET is unset so
 * an unauthenticated server can never be exposed by accident.
 */

import { Hono } from "hono";
import type { createProductionLogger } from "@trade-bot/logger";

type Logger = ReturnType<typeof createProductionLogger>;

export async function startWorkerHttpServer(logger: Logger): Promise<void> {
  const secret = process.env.WORKER_API_SECRET;
  if (!secret) {
    logger.warn(
      "worker-http",
      "WORKER_API_SECRET not set. Worker HTTP server (PNL images) disabled.",
    );
    return;
  }

  // Imported lazily so the @trade-bot/pnl-image package (and its native canvas
  // dep + assets) is only loaded when the feature is actually enabled. With no
  // secret set, the worker never touches it — nothing extra to build/install.
  const { pnlImageRoutes } = await import("./pnl-image.routes");

  const port = Number(process.env.WORKER_HTTP_PORT ?? 3002);
  const app = new Hono();

  // Health stays open for load balancers; registered before the auth gate.
  app.get("/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() }),
  );

  app.use("*", async (c, next) => {
    if (c.req.header("x-worker-secret") !== secret) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.route("/pnl-image", pnlImageRoutes);

  app.onError((err, c) => {
    logger.error("worker-http", "Request failed", { error: err.message });
    return c.json({ error: "Internal server error" }, 500);
  });

  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  });

  logger.info("worker-http", `Worker HTTP server listening on port ${port}`);
}
