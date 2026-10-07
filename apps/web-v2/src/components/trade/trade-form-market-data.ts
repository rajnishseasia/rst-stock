export function selectMatchingMarketData<T>(
  inputSymbol: string,
  requestedSymbol: string,
  data: T | undefined
): T | undefined {
  return requestedSymbol === inputSymbol.trim().toUpperCase() ? data : undefined;
}
