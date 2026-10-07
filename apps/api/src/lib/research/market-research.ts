import { createProductionLogger } from "@trade-bot/logger";
import { env } from "../../config/index.js";
import {
  buildSecUserAgent,
  classifySymbol,
  coinMarketWarning,
  describeSecFailure,
  HttpError,
  newsUnavailableWarning,
  noCompanyMatchWarning,
  noFilingsWarning,
  noNewsWarning,
} from "./market-research-helpers.js";

// Re-export the pure helpers so existing importers keep a single entry point.
export {
  buildSecUserAgent,
  classifySymbol,
  coinMarketWarning,
  describeSecFailure,
  hasContactEmail,
  HttpError,
  newsUnavailableWarning,
  noCompanyMatchWarning,
  noFilingsWarning,
  noNewsWarning,
} from "./market-research-helpers.js";
export type {
  SymbolClassification,
  SymbolKind,
} from "./market-research-helpers.js";

const logger = createProductionLogger();

type SecTickerEntry = {
  cik_str: number;
  ticker: string;
  title: string;
};

type RecentFiling = {
  form: string;
  filingDate: string;
  reportDate: string | null;
  accessionNumber: string;
  primaryDocument: string;
  description: string | null;
  url: string;
};

type NewsArticle = {
  title: string;
  url: string;
  domain: string | null;
  publishedAt: string | null;
  language: string | null;
  sourceCountry: string | null;
};

type MarketResearch = {
  company: { ticker: string; title: string; cik: string } | null;
  filings: RecentFiling[];
  news: NewsArticle[];
  warnings: string[];
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const SEC_TICKERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_RESEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
// When a fetch soft-fails (SEC error, GDELT rate limit/timeout) we cache the
// partial result briefly so the next lookup retries instead of serving a
// stale "unavailable" answer for the full 5 minutes.
const MARKET_RESEARCH_PARTIAL_CACHE_TTL_MS = 60 * 1000;

// GDELT asks callers to limit themselves to roughly one request every 5s and
// its doc API legitimately takes longer than the shared 8s timeout, so news
// gets its own longer timeout plus a module-level throttle gate.
const GDELT_TIMEOUT_MS = 12_000;
const GDELT_MIN_INTERVAL_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

const secTickersCache: CacheEntry<SecTickerEntry[]> = { expiresAt: 0, value: [] };
const marketResearchCache = new Map<string, CacheEntry<MarketResearch>>();

let gdeltLastCallAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function secHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": buildSecUserAgent({
      userAgent: env.SEC_USER_AGENT,
      contactEmail: env.SEC_CONTACT_EMAIL,
      webUrl: env.WEB_URL,
    }),
  };
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(response.status, response.statusText);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function getSecTickers() {
  const now = Date.now();
  if (secTickersCache.expiresAt > now && secTickersCache.value.length > 0) {
    return secTickersCache.value;
  }

  const data = await fetchJson<Record<string, SecTickerEntry>>(
    "https://www.sec.gov/files/company_tickers.json",
    { headers: secHeaders() }
  );

  const entries = Object.values(data);
  secTickersCache.value = entries;
  secTickersCache.expiresAt = now + SEC_TICKERS_CACHE_TTL_MS;
  return entries;
}

async function findCompanyByTicker(symbol: string) {
  const tickers = await getSecTickers();
  const normalized = symbol.trim().toUpperCase();
  const company = tickers.find((entry) => entry.ticker.toUpperCase() === normalized);
  if (!company) return null;

  const cik = String(company.cik_str).padStart(10, "0");
  return {
    ticker: company.ticker.toUpperCase(),
    title: company.title,
    cik,
  };
}

async function fetchRecentFilings(company: NonNullable<MarketResearch["company"]>) {
  type SubmissionsResponse = {
    filings?: {
      recent?: Record<string, Array<string | null>>;
    };
  };

  const data = await fetchJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${company.cik}.json`,
    { headers: secHeaders() }
  );

  const recent = data.filings?.recent;
  if (!recent) return [];

  const forms = recent.form || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const accessionNumbers = recent.accessionNumber || [];
  const primaryDocuments = recent.primaryDocument || [];
  const descriptions = recent.primaryDocDescription || [];
  const cikPath = String(Number.parseInt(company.cik, 10));

  const interestingForms = new Set([
    "10-K",
    "10-Q",
    "8-K",
    "6-K",
    "20-F",
    "S-1",
    "S-3",
    "DEF 14A",
    "DEFA14A",
    "SC 13D",
    "SC 13G",
    "4",
  ]);

  return forms
    .map((form, index) => {
      const accessionNumber = accessionNumbers[index];
      const primaryDocument = primaryDocuments[index];
      if (!form || !accessionNumber || !primaryDocument) return null;

      return {
        form,
        filingDate: filingDates[index] || "",
        reportDate: reportDates[index] || null,
        accessionNumber,
        primaryDocument,
        description: descriptions[index] || null,
        url: `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionNumber.replace(
          /-/g,
          ""
        )}/${primaryDocument}`,
      };
    })
    .filter((filing): filing is RecentFiling => Boolean(filing))
    .filter((filing) => interestingForms.has(filing.form))
    .slice(0, 6);
}

function escapeGdeltPhrase(value: string) {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

type NewsResult = {
  articles: NewsArticle[];
  /** Informational note (empty results or a soft rate-limit/timeout). */
  note: string | null;
  /** True when the fetch soft-failed (429 / timeout / transport). */
  failed: boolean;
};

async function fetchNews(symbol: string, companyTitle?: string): Promise<NewsResult> {
  type GdeltArticle = {
    title?: string;
    url?: string;
    domain?: string;
    seendate?: string;
    language?: string;
    sourcecountry?: string;
  };
  type GdeltResponse = {
    articles?: GdeltArticle[];
  };

  const label = symbol.toUpperCase();
  const queryTarget = escapeGdeltPhrase(companyTitle || label);
  if (!queryTarget) {
    return { articles: [], note: null, failed: false };
  }

  // Respect GDELT's ~1 request / 5s guidance with a module-level gate. The
  // wait is bounded by the interval, and same-symbol repeats hit the cache.
  const sinceLast = Date.now() - gdeltLastCallAt;
  if (sinceLast >= 0 && sinceLast < GDELT_MIN_INTERVAL_MS) {
    await sleep(GDELT_MIN_INTERVAL_MS - sinceLast);
  }
  gdeltLastCallAt = Date.now();

  const query = `"${queryTarget}" sourcelang:English`;
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    maxrecords: "5",
    timespan: "1week",
    sort: "datedesc",
    format: "json",
  });

  try {
    const data = await fetchJson<GdeltResponse>(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
      undefined,
      GDELT_TIMEOUT_MS
    );

    const articles = (data.articles || [])
      .filter((article) => article.title && article.url)
      .slice(0, 5)
      .map((article) => ({
        title: article.title!,
        url: article.url!,
        domain: article.domain || null,
        publishedAt: article.seendate || null,
        language: article.language || null,
        sourceCountry: article.sourcecountry || null,
      }));

    return {
      articles,
      note: articles.length > 0 ? null : noNewsWarning(label),
      failed: false,
    };
  } catch (error) {
    // 429 (rate limit), abort/timeout, or transport error. News is
    // best-effort: treat as a soft "temporarily unavailable" note so that
    // filings still surface, rather than a scary "Could not fetch" error.
    logger.info("market-research", "GDELT news fetch soft-failed", {
      symbol: label,
      error: String(error),
    });
    return {
      articles: [],
      note: newsUnavailableWarning(label),
      failed: true,
    };
  }
}

export async function getMarketResearchForSymbol(symbol: string): Promise<MarketResearch> {
  const raw = symbol.trim();
  if (!raw) {
    return { company: null, filings: [], news: [], warnings: [] };
  }

  const classification = classifySymbol(raw);
  const cacheKey = classification.normalized;

  const cached = marketResearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const warnings: string[] = [];
  let company: MarketResearch["company"] = null;
  let filings: RecentFiling[] = [];
  let news: NewsArticle[] = [];
  let partialFailure = false;

  // Crypto/coin perps have no SEC filings or equity news. Skip both providers
  // and return a clear, non-alarming note so the chat leans on signals and
  // portfolio context instead of dead-ending on missing sources.
  if (classification.kind === "coin") {
    warnings.push(coinMarketWarning(classification.normalized));
    const value = { company, filings, news, warnings };
    marketResearchCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + MARKET_RESEARCH_CACHE_TTL_MS,
    });
    return value;
  }

  const researchSymbol = classification.researchSymbol;

  try {
    company = await findCompanyByTicker(researchSymbol);
    if (!company) {
      warnings.push(noCompanyMatchWarning(researchSymbol));
    }
  } catch (error) {
    partialFailure = true;
    const message = describeSecFailure(error, "index");
    warnings.push(message);
    logger.warn("market-research", message, {
      symbol: researchSymbol,
      error: String(error),
    });
  }

  if (company) {
    try {
      filings = await fetchRecentFilings(company);
      if (filings.length === 0) {
        warnings.push(noFilingsWarning(company.ticker));
      }
    } catch (error) {
      partialFailure = true;
      const message = describeSecFailure(error, "filings");
      warnings.push(message);
      logger.warn("market-research", message, {
        symbol: researchSymbol,
        error: String(error),
      });
    }
  }

  const newsResult = await fetchNews(researchSymbol, company?.title);
  news = newsResult.articles;
  if (newsResult.failed) partialFailure = true;
  if (newsResult.note) warnings.push(newsResult.note);

  const value = { company, filings, news, warnings };
  marketResearchCache.set(cacheKey, {
    value,
    expiresAt:
      Date.now() +
      (partialFailure ? MARKET_RESEARCH_PARTIAL_CACHE_TTL_MS : MARKET_RESEARCH_CACHE_TTL_MS),
  });

  return value;
}
