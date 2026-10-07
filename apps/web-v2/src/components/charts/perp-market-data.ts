/** Keep Hyperliquid mids queries scoped to the active (possibly HIP-3) coin. */
export function perpMidsQueryInput(symbol: string): { coin: string } {
  return { coin: symbol };
}
