/**
 * PNL Card Types
 *
 * Input/output contract for the shareable PNL image renderer.
 */

export interface PnlCardInput {
  /** Ticker or option symbol displayed on the card. */
  symbol: string;
  /** Position direction. */
  side: "long" | "short";
  /** Shares/contracts; shown under the symbol when provided. */
  qty?: number;
  /** Plural unit label rendered after qty (e.g. "shares", "contracts"). */
  unitLabel?: string;
  /** Average entry price. */
  entryPrice: number;
  /** Current price for open positions, fill price for closed trades. */
  exitPrice: number;
  /** Signed USD P&L. Determines profit/loss styling. */
  pnlUsd: number;
  /** Signed percent return. */
  pnlPercent: number;
  /** Market value for open positions, cost basis for closed trades. */
  totalValueUsd: number;
  /** Controls the "Value:" vs "Cost:" label and the OPEN/CLOSED chip. */
  result?: "open" | "closed";
  /** Hide dollar values and render only the percentage. */
  hideAmount?: boolean;
  /** Optional human duration (e.g. "3d 4h", "2 weeks") shown in the stats row. */
  durationLabel?: string;
  /**
   * Optional leverage descriptor for a perp position (e.g. "10x cross"), shown
   * in the stats row. Omitted entirely for spot/equity cards.
   */
  leverageLabel?: string;
}

export interface PnlCardOutput {
  buffer: Buffer;
  base64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}
