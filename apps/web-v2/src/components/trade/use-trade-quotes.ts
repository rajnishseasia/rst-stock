/**
 * Market-data queries for the trade ticket (audit H7: second extraction from
 * the trade-form god component; behavior moved verbatim).
 *
 * Owns every polled tRPC query the ticket needs (stock quote, option quote,
 * option contracts, positions, account balance) plus the derived values the
 * form consumes: symbol-matched quotes, the active long equity position, the
 * option expiration/strike lists, and the portfolio value that seeds the
 * risk-budget default.
 *
 * The raw query objects are returned too because the form reads their
 * isLoading/error/isFetching flags for UI states.
 */

import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { selectMatchingMarketData } from "./trade-form-market-data";

export function useTradeQuotes(params: {
  /** Raw symbol input (may lag the committed market-data symbol). */
  symbol: string;
  /** Debounced, uppercased symbol actually queried. */
  marketDataSymbol: string;
  /** Uppercased trim of the raw input, for position matching. */
  normalizedSymbol: string;
  activeCredentialId?: string;
  assetType: "EQUITY" | "OPTION";
  // The option fields are optional in the form schema, so watch() yields
  // string | undefined. The queries gate on their truthiness, matching the
  // original inline behavior exactly.
  optionsDateYear: string | undefined;
  optionsDateMonth: string | undefined;
  optionsDateDay: string | undefined;
  optionsStrike: string | undefined;
  optionTypeWatched: "call" | "put";
}) {
  const {
    symbol,
    marketDataSymbol,
    normalizedSymbol,
    activeCredentialId,
    assetType,
    optionsDateYear,
    optionsDateMonth,
    optionsDateDay,
    optionsStrike,
    optionTypeWatched,
  } = params;

  const quoteQuery = trpc.quotes.getStockQuote.useQuery(
    { symbol: marketDataSymbol, credentialId: activeCredentialId },
    {
      enabled: !!(activeCredentialId && marketDataSymbol),
      refetchInterval: 30000,
      staleTime: 10000,
      retry: false,
    },
  );

  const optionQuoteQuery = trpc.quotes.getOptionQuote.useQuery(
    {
      symbol: marketDataSymbol,
      expiration: `${optionsDateYear}${optionsDateMonth}${optionsDateDay}`,
      strike: parseFloat(optionsStrike || "0") || 0,
      optionType: optionTypeWatched,
      credentialId: activeCredentialId,
    },
    {
      enabled: !!(
        assetType === "OPTION" &&
        activeCredentialId &&
        marketDataSymbol &&
        optionsDateYear &&
        optionsDateMonth &&
        optionsDateDay &&
        optionsStrike &&
        optionsStrike.length > 0
      ),
      refetchInterval: 30000,
      staleTime: 10000,
      retry: false,
    },
  );

  const positionsQuery = trpc.positions.list.useQuery(
    { credentialId: activeCredentialId },
    {
      enabled: !!(
        assetType === "EQUITY" &&
        activeCredentialId &&
        marketDataSymbol
      ),
      refetchInterval: 30000,
      staleTime: 10000,
      retry: false,
    },
  );

  // Account balance - used to default Max $ Risk to RISK_BUDGET_PCT of the
  // portfolio. Same source as the Account Summary card in positions-panel.
  const accountQuery = trpc.positions.account.useQuery(
    { credentialId: activeCredentialId },
    {
      enabled: !!activeCredentialId,
      refetchInterval: 30000,
      staleTime: 10000,
      retry: false,
    },
  );
  const portfolioValue = accountQuery.data?.portfolioValue ?? null;

  // Discover available option contracts (expirations + strikes) for the symbol.
  // Used to populate the expiration + strike dropdowns when trading options.
  const contractsQuery = trpc.quotes.listOptionContracts.useQuery(
    {
      symbol: marketDataSymbol,
      optionType: optionTypeWatched,
      credentialId: activeCredentialId,
    },
    {
      enabled: !!(
        assetType === "OPTION" &&
        activeCredentialId &&
        marketDataSymbol
      ),
      staleTime: 60000,
      retry: false,
    },
  );

  const stockQuote = selectMatchingMarketData(
    symbol,
    marketDataSymbol,
    quoteQuery.data,
  );
  const optionQuote = selectMatchingMarketData(
    symbol,
    marketDataSymbol,
    optionQuoteQuery.data ?? undefined,
  );
  const optionContracts = selectMatchingMarketData(
    symbol,
    marketDataSymbol,
    contractsQuery.data,
  );

  const activeEquityPosition = useMemo(
    () =>
      positionsQuery.data?.find(
        (position) =>
          position.symbol.toUpperCase() === normalizedSymbol &&
          position.assetClass !== "us_option" &&
          position.side === "long" &&
          position.qtyAvailable > 0,
      ),
    [normalizedSymbol, positionsQuery.data],
  );
  // What the account actually HOLDS in this market, for display only.
  //
  // Deliberately NOT `activeEquityPosition`: that is a sell-availability
  // predicate (long, and with unreserved shares), and reusing it to answer "what
  // do I hold?" told a user with a short position, or a long whose shares are
  // all reserved by open orders, that they held nothing. On a ticket they are
  // about to trade from, that is the wrong thing to be wrong about.
  const heldEquityPosition = useMemo(
    () =>
      positionsQuery.data?.find(
        (position) =>
          position.symbol.toUpperCase() === normalizedSymbol &&
          position.assetClass !== "us_option",
      ),
    [normalizedSymbol, positionsQuery.data],
  );
  // Whether the held-position lookup is KNOWLEDGE. Mirrors
  // `equitySellAvailabilityKnown` below: with no credential or no symbol the
  // query never runs, and "you hold nothing" is then correct rather than
  // unknown. Otherwise only a successful response counts, since with retry off
  // a failure is fetched too.
  const heldEquityPositionKnown =
    !activeCredentialId || !normalizedSymbol || positionsQuery.isSuccess;
  const canSellLongEquity = !!activeEquityPosition;
  const equitySellAvailabilityKnown =
    !activeCredentialId ||
    !normalizedSymbol ||
    Array.isArray(positionsQuery.data);

  // The expiration currently selected in the form, reconstructed as YYYY-MM-DD
  // from the persisted optionsDateYear/Month/Day fields so we can match contracts.
  const selectedExpirationYYYYMMDD = useMemo(() => {
    if (!optionsDateYear || !optionsDateMonth || !optionsDateDay) return "";
    return `20${optionsDateYear.padStart(2, "0")}-${optionsDateMonth.padStart(2, "0")}-${optionsDateDay.padStart(2, "0")}`;
  }, [optionsDateYear, optionsDateMonth, optionsDateDay]);

  // Distinct, sorted expirations (YYYY-MM-DD) for the expiration dropdown.
  const expirations = useMemo(
    () =>
      Array.from(
        new Set((optionContracts || []).map((c) => c.expiration)),
      ).sort(),
    [optionContracts],
  );

  // Strikes filtered by the chosen expiration + selected call/put, sorted ascending.
  const strikes = useMemo(
    () =>
      (optionContracts || [])
        .filter(
          (c) =>
            c.expiration === selectedExpirationYYYYMMDD &&
            c.type === optionTypeWatched,
        )
        .map((c) => c.strike)
        .sort((a, b) => a - b),
    [optionContracts, selectedExpirationYYYYMMDD, optionTypeWatched],
  );

  return {
    quoteQuery,
    optionQuoteQuery,
    positionsQuery,
    accountQuery,
    contractsQuery,
    portfolioValue,
    stockQuote,
    optionQuote,
    optionContracts,
    activeEquityPosition,
    heldEquityPosition,
    heldEquityPositionKnown,
    canSellLongEquity,
    equitySellAvailabilityKnown,
    selectedExpirationYYYYMMDD,
    expirations,
    strikes,
  };
}
