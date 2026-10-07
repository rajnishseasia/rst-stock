/**
 * PNL Card Renderer
 *
 * Composites the shareable 1536x1024 JPEG over the bundled trading-room
 * artwork. All statistics render in a column on the clean right side of the
 * frame (the left holds the subject/bull/charts), with a subtle dark-teal
 * veil behind them to guarantee readability without covering the art.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { loadBackground } from "./backgrounds";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  COLORS,
  CONTENT_RIGHT,
  JPEG_QUALITY,
  PANEL_LEFT,
  PANEL_WIDTH,
} from "./constants";
import { ensureFontsRegistered, FONT_FAMILY } from "./fonts";
import type { PnlCardInput, PnlCardOutput } from "./types";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

/**
 * Decimal precision scaled to price magnitude. A perp card has to render both
 * BTC in the tens of thousands and a coin quoted in fractions of a cent, and
 * the fixed 2-decimal `formatUsd` above collapses the latter to "$0.00" so a
 * real entry price reads as missing. Mirrors the web `perp-format.ts` idiom.
 */
function adaptiveMaxFractionDigits(abs: number): number {
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs > 0) return Math.min(12, Math.ceil(-Math.log10(abs)) + 4);
  return 2;
}

/**
 * Entry / current / exit PRICES, with precision scaled to magnitude. Only
 * prices use this: P&L and position value are plain dollar amounts and stay on
 * the 2-decimal `formatUsd`.
 */
export function formatPriceUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: adaptiveMaxFractionDigits(Math.abs(value)),
  }).format(value);
}

function formatSignedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`@trade-bot/pnl-image: ${name} must be a finite number`);
  }
}

function validateInput(input: PnlCardInput): void {
  if (typeof input.symbol !== "string" || input.symbol.trim().length === 0) {
    throw new Error("@trade-bot/pnl-image: symbol is required");
  }
  assertFinite("entryPrice", input.entryPrice);
  assertFinite("exitPrice", input.exitPrice);
  assertFinite("pnlUsd", input.pnlUsd);
  assertFinite("pnlPercent", input.pnlPercent);
  assertFinite("totalValueUsd", input.totalValueUsd);
  if (input.qty !== undefined) assertFinite("qty", input.qty);
}

/** Shrink the font size until the text fits maxWidth (floor at minSize). */
function fitFontSize(
  ctx: SKRSContext2D,
  text: string,
  maxSize: number,
  minSize: number,
  maxWidth: number,
  weight = "bold",
): number {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function roundRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Draw a pill (rounded chip) with centered uppercase label; returns its width. */
function drawChip(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  centerY: number,
  fill: string,
  textColor: string,
  fontSize: number,
): number {
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  const padX = fontSize * 0.7;
  const textWidth = ctx.measureText(text).width;
  const w = textWidth + padX * 2;
  const h = fontSize + fontSize * 0.7;
  ctx.fillStyle = fill;
  roundRectPath(ctx, x, centerY - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, centerY + 1);
  ctx.textBaseline = "alphabetic";
  return w;
}

function withShadow(ctx: SKRSContext2D, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 2;
  draw();
  ctx.restore();
}

export async function generatePnlCard(input: PnlCardInput): Promise<PnlCardOutput> {
  validateInput(input);
  ensureFontsRegistered();

  const isProfit = input.pnlUsd >= 0;
  const isOpen = (input.result ?? "open") === "open";
  const hideAmount = input.hideAmount ?? false;
  const pnlColor = isProfit ? COLORS.profit : COLORS.loss;

  const background = await loadBackground(isProfit ? "profit" : "loss");

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext("2d");

  // Cover-draw the art zoomed and anchored left so its detailed content
  // (subject, charts, city, glow) bleeds across the full frame instead of
  // leaving the right side an empty void that reads as a separate panel.
  const zoom = 1.34;
  const drawW = CARD_WIDTH * zoom;
  const drawH = CARD_HEIGHT * zoom;
  const dx = -(drawW - CARD_WIDTH) * 0.1;
  const dy = -(drawH - CARD_HEIGHT) * 0.5;
  ctx.drawImage(background, dx, dy, drawW, drawH);

  // Frosted continuation behind the numbers. Render a blurred copy of the
  // same art on an offscreen canvas, then mask it with a wide horizontal
  // alpha ramp so the sharp image dissolves gradually into the blur (no hard
  // seam between a "photo half" and a "blurred half").
  const frost = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const fctx = frost.getContext("2d");
  fctx.filter = "blur(26px)";
  fctx.drawImage(background, dx, dy, drawW, drawH);
  fctx.filter = "none";
  fctx.globalCompositeOperation = "destination-in";
  const dissolve = fctx.createLinearGradient(420, 0, 1200, 0);
  dissolve.addColorStop(0, "rgba(0, 0, 0, 0)");
  dissolve.addColorStop(1, "rgba(0, 0, 0, 1)");
  fctx.fillStyle = dissolve;
  fctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.drawImage(frost, 0, 0);
  ctx.restore();

  // Full-width feathered tone: darkens gently everywhere, more on the right,
  // ramping across the whole width so there's no detectable seam.
  const veil = ctx.createLinearGradient(0, 0, CARD_WIDTH, 0);
  veil.addColorStop(0, `rgba(${COLORS.veil}, 0.1)`);
  veil.addColorStop(0.5, `rgba(${COLORS.veil}, 0.32)`);
  veil.addColorStop(1, `rgba(${COLORS.veil}, 0.62)`);
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  ctx.textBaseline = "alphabetic";

  // --- Header: brand (left) + status pill (right) ---
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.brand;
  ctx.font = `bold 34px ${FONT_FAMILY}`;
  ctx.fillText("READY SET TRADE", PANEL_LEFT, 124);
  // Gold accent underline.
  ctx.fillStyle = COLORS.brand;
  ctx.fillRect(PANEL_LEFT, 144, 150, 4);

  const statusText = isOpen ? "● OPEN" : "● CLOSED";
  ctx.font = `bold 28px ${FONT_FAMILY}`;
  const statusWidth = ctx.measureText(statusText).width + 28 * 1.4;
  drawChip(
    ctx,
    statusText,
    CONTENT_RIGHT - statusWidth,
    118,
    COLORS.chipNeutral,
    isOpen ? COLORS.profit : COLORS.textMuted,
    28,
  );
  // Generation date, right-aligned just under the status pill.
  ctx.fillStyle = COLORS.textMuted;
  ctx.font = `26px ${FONT_FAMILY}`;
  ctx.textAlign = "right";
  ctx.fillText(
    new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    CONTENT_RIGHT,
    178,
  );
  ctx.textAlign = "left";

  // --- Symbol title ---
  const symbol = input.symbol.trim().toUpperCase();
  const symbolSize = fitFontSize(ctx, symbol, 90, 48, PANEL_WIDTH);
  ctx.textAlign = "left";
  withShadow(ctx, () => {
    ctx.fillStyle = COLORS.textPrimary;
    ctx.font = `bold ${symbolSize}px ${FONT_FAMILY}`;
    ctx.fillText(symbol, PANEL_LEFT, 302);
  });

  // --- Direction chip + position size ---
  const directionChipWidth = drawChip(
    ctx,
    input.side.toUpperCase(),
    PANEL_LEFT,
    364,
    input.side === "long" ? COLORS.chipLong : COLORS.chipShort,
    input.side === "long" ? COLORS.profit : COLORS.loss,
    36,
  );
  // Position size is part of the "$ size" the hideAmount toggle promises to
  // conceal (share/contract count times the entry/current price recovers the
  // exact cost basis and P&L the VALUE/COST row and headline figure already
  // withhold below), so it must not draw when hideAmount is on.
  if (!hideAmount && input.qty !== undefined && input.qty > 0) {
    const unitLabel = input.unitLabel ?? "units";
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `38px ${FONT_FAMILY}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${input.qty} ${unitLabel}`, PANEL_LEFT + directionChipWidth + 24, 365);
    ctx.textBaseline = "alphabetic";
  }

  // --- Primary focal value: signed dollars (or percent when hidden) ---
  const mainText = hideAmount
    ? formatSignedPercent(input.pnlPercent)
    : formatSignedUsd(input.pnlUsd);
  const mainSize = fitFontSize(ctx, mainText, 64, 40, PANEL_WIDTH);
  // The headline can represent unrealized P&L, realized P&L, or their sum.
  // Let the signed value speak for itself instead of attaching a misleading
  // accounting label to the image.
  ctx.textAlign = "left";
  const mainBaseline = 550;
  withShadow(ctx, () => {
    ctx.fillStyle = pnlColor;
    ctx.font = `bold ${mainSize}px ${FONT_FAMILY}`;
    ctx.fillText(mainText, PANEL_LEFT, mainBaseline);
  });
  if (!hideAmount) {
    withShadow(ctx, () => {
      ctx.fillStyle = pnlColor;
      ctx.font = `bold 30px ${FONT_FAMILY}`;
      ctx.fillText(formatSignedPercent(input.pnlPercent), PANEL_LEFT, mainBaseline + 48);
    });
  }

  // --- Stacked stat rows (label left / value right) ---
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "ENTRY", value: formatPriceUsd(input.entryPrice) });
  rows.push({
    label: isOpen ? "CURRENT" : "EXIT",
    value: formatPriceUsd(input.exitPrice),
  });
  if (!hideAmount) {
    rows.push({
      label: isOpen ? "VALUE" : "COST",
      value: formatUsd(input.totalValueUsd),
    });
  }
  if (input.leverageLabel) {
    rows.push({ label: "LEVERAGE", value: input.leverageLabel });
  }
  if (input.durationLabel) {
    rows.push({ label: "DURATION", value: input.durationLabel });
  }

  if (rows.length > 0) {
    // Thin divider above the rows.
    ctx.fillStyle = "rgba(245, 248, 247, 0.14)";
    ctx.fillRect(PANEL_LEFT, 734, PANEL_WIDTH, 2);

    // Four rows is the ordinary maximum (entry / current / value / leverage);
    // tighten the rhythm rather than run a fifth row off the bottom edge.
    const rowStep = rows.length > 4 ? 52 : 60;
    let rowY = rows.length > 4 ? 774 : 792;
    for (const row of rows) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `30px ${FONT_FAMILY}`;
      ctx.textAlign = "left";
      ctx.fillText(row.label, PANEL_LEFT, rowY);

      withShadow(ctx, () => {
        ctx.fillStyle = COLORS.textPrimary;
        ctx.font = `bold 44px ${FONT_FAMILY}`;
        ctx.textAlign = "right";
        ctx.fillText(row.value, CONTENT_RIGHT, rowY);
      });
      rowY += rowStep;
    }
  }

  const buffer = await canvas.encode("jpeg", JPEG_QUALITY);
  return {
    buffer,
    base64: buffer.toString("base64"),
    mimeType: "image/jpeg",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  };
}
