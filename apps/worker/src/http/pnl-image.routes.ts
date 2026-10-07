/**
 * PNL Image Routes
 *
 * Private HTTP route the API proxies to for shareable PNL card generation.
 * The API does all data lookup/derivation; this route only validates the
 * already-normalized card values and renders.
 */

import { Hono } from "hono";
import { z } from "zod";
import { generatePnlCard } from "@trade-bot/pnl-image";

// Reject NaN/Infinity and absurd magnitudes (handoff §11).
const cardNumber = z.number().finite().gt(-1e12).lt(1e12);

const generateSchema = z.object({
  symbol: z.string().min(1).max(50),
  side: z.enum(["long", "short"]),
  qty: cardNumber.positive().optional(),
  unitLabel: z.string().max(20).optional(),
  entryPrice: cardNumber,
  exitPrice: cardNumber,
  pnlUsd: cardNumber,
  pnlPercent: cardNumber,
  totalValueUsd: cardNumber,
  result: z.enum(["open", "closed"]).default("open"),
  hideAmount: z.boolean().optional(),
  durationLabel: z.string().max(40).optional(),
  leverageLabel: z.string().max(40).optional(),
});

function summarizePayload(payload: z.infer<typeof generateSchema>) {
  return {
    symbol: payload.symbol,
    side: payload.side,
    result: payload.result,
    hideAmount: payload.hideAmount ?? false,
    hasQty: payload.qty !== undefined,
    hasDurationLabel: payload.durationLabel !== undefined,
  };
}

export const pnlImageRoutes = new Hono();

pnlImageRoutes.get("/health", (c) => c.json({ status: "ok" }));

pnlImageRoutes.post("/generate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[worker-http] Invalid PNL image request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
    return c.json({ error: "Invalid request body" }, 400);
  }

  const startedAt = Date.now();
  try {
    const card = await generatePnlCard(parsed.data);
    console.info("[worker-http] Generated PNL image", {
      ...summarizePayload(parsed.data),
      durationMs: Date.now() - startedAt,
      width: card.width,
      height: card.height,
    });
    return c.json({
      base64: card.base64,
      mimeType: card.mimeType,
      width: card.width,
      height: card.height,
    });
  } catch (error) {
    console.error("[worker-http] Failed to generate PNL image", {
      ...summarizePayload(parsed.data),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json({ error: "Failed to generate PNL image" }, 500);
  }
});
