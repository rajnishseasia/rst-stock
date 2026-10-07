import { classifySignalInstrument } from "@trade-bot/utils/utils/signal-instrument";

export type ChartSignalVenue = "stocks" | "perps";

interface ChartSignalCandidate {
  symbol: string | null;
  metadata: unknown;
}

export interface ChartSignalPageCursor {
  timestamp: Date;
  id: string;
}

interface CollectChartSignalsInput<T extends ChartSignalPageCursor> {
  limit: number;
  matches: (candidate: T) => boolean;
  fetchPage: (input: {
    cursor: ChartSignalPageCursor | null;
    limit: number;
  }) => Promise<T[]>;
  pageSize?: number;
  maxCandidates?: number;
}

/**
 * Keep paging through same-symbol candidates until the venue-filtered result
 * is full. The hard scan cap prevents a pathological history from creating an
 * unbounded request when almost every row belongs to the other venue.
 */
export async function collectChartSignalsForVenue<
  T extends ChartSignalPageCursor,
>(input: CollectChartSignalsInput<T>): Promise<T[]> {
  const pageSize = Math.max(1, input.pageSize ?? 500);
  const maxCandidates = Math.max(input.limit, input.maxCandidates ?? 5_000);
  const matches: T[] = [];
  let cursor: ChartSignalPageCursor | null = null;
  let scanned = 0;

  while (matches.length < input.limit && scanned < maxCandidates) {
    const batchLimit = Math.min(pageSize, maxCandidates - scanned);
    const page = await input.fetchPage({ cursor, limit: batchLimit });
    if (page.length === 0) break;

    scanned += page.length;
    for (const candidate of page) {
      if (input.matches(candidate)) {
        matches.push(candidate);
        if (matches.length === input.limit) break;
      }
    }

    if (page.length < batchLimit) break;
    const last = page[page.length - 1];
    if (!last) break;
    cursor = { timestamp: last.timestamp, id: last.id };
  }

  return matches;
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canonical(value: string): string {
  return value.trim().toUpperCase();
}

/** Candidate stored symbols used to keep the initial DB query bounded. */
export function chartSignalLookupSymbols(
  chartSymbol: string,
  venue: ChartSignalVenue,
): string[] {
  const chart = canonical(chartSymbol);
  if (venue === "stocks" || !chart.includes(":")) return [chart];
  const underlying = chart.slice(chart.lastIndexOf(":") + 1);
  return underlying === chart ? [chart] : [chart, underlying];
}

/** Keep same-name stock and perp markers isolated to their actual venue. */
export function signalMatchesChartVenue(
  signal: ChartSignalCandidate,
  chartSymbol: string,
  venue: ChartSignalVenue,
): boolean {
  const chart = canonical(chartSymbol);
  const signalSymbol = canonical(signal.symbol ?? "");
  const classification = classifySignalInstrument(signal.metadata);
  const isPerp = classification.perpVenue || classification.perpInstrument;

  if (venue === "stocks") {
    return !isPerp && signalSymbol === chart;
  }
  if (!isPerp) return false;

  const metadata = metadataRecord(signal.metadata);
  const rawHlTicker = metadata?.hlTicker;
  if (typeof rawHlTicker === "string" && rawHlTicker.trim()) {
    return canonical(rawHlTicker) === chart;
  }
  const underlying = chart.includes(":")
    ? chart.slice(chart.lastIndexOf(":") + 1)
    : chart;
  return signalSymbol === underlying;
}
