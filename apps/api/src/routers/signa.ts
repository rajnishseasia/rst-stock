/**
 * Signa tRPC Router
 *
 * Server-side proxy for the Signa API (https://app.getsigna.ai). The
 * `SIGNA_API_KEY` bearer token lives only on the server — the browser
 * never sees it.
 *
 * Strategy:
 *   1. Fetch `/api/signals/run?scored=true&limit=250` (accessible to
 *      Founding-Member keys).
 *   2. Dedupe per ticker, keep the highest composite_score row.
 *   3. For the top N tickers, enrich with `/api/v1/signal?sym=X` to pull
 *      `entry` / `stop` / `target` / `rr` from the live single-pass.
 *   4. Return a flat, browser-shaped list.
 *
 * Notes:
 *   - The original "Best Picks" endpoint (/api/v1/confluence/best-picks)
 *     is plan-gated above Founding Member and returns 401, so we don't
 *     bother hitting it. See docs/integrations/signa-api.md.
 *   - We cache the result in-process for `CACHE_TTL_MS` so we don't burn
 *     daily quota when multiple users hit the panel.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getRedisClient } from "@trade-bot/redis";
import { router, authenticatedProcedure } from "../trpc.js";

const SIGNA_BASE = "https://app.getsigna.ai";
const SIGNA_RUN_PATH = "/api/signals/run?scored=true&limit=250";

/** How many tickers to enrich with per-symbol Action Card data per refresh.
 *  Each enriched ticker costs 1 API call. Signa's free tier gives 1000/day
 *  and 60/min, so 15 is comfortable. */
const ENRICH_TOP_N = 15;

/** Cache TTL. The scored run only regenerates a couple of times per day, but
 *  the per-symbol Action Card is a live single-pass: it re-prices `entry` /
 *  `stop` / `target` on every call. The old 4-hour TTL froze those prices for
 *  hours. There is no manual refresh button any more (the panel just shows
 *  how old the snapshot is), so the TTL is the only freshness control.
 *
 *  Quota math: one refresh costs 1 + 2 * ENRICH_TOP_N = 31 upstream calls.
 *  At a 1-hour TTL that is at most 24 * 31 = 744 calls/day, inside the
 *  1000/day Individual-plan quota with room to spare. */
const CACHE_TTL_SECONDS = 60 * 60;

/** Redis key for the shared Signa snapshot. Same shape for every user, so a
 *  single key serves everyone.
 *
 *  v3: bumped when direction-conflicting picks started being filtered out
 *  server-side. A v2 snapshot still contains the bad rows, so it must not be
 *  served after this deploys. */
const REDIS_CACHE_KEY = "cache:signa:todays_signals:v3";

/** Redis key for the "fetch in progress" lock. Prevents thundering-herd
 *  when N users hit the panel simultaneously on a cold cache. */
const REDIS_LOCK_KEY = "cache:signa:todays_signals:lock:v1";
const LOCK_TTL_SECONDS = 30;

// ─── upstream types ──────────────────────────────────────────────────────────

type SignaRunSignal = {
  id: string;
  ticker: string;
  direction: string; // "BULLISH" | "BEARISH"
  alert_tier: number;
  composite_score: number;
  confidence: number;
  model_count: number;
  model_ids?: string[];
  reason?: string;
  key_drivers?: string[];
  grade?: string;
  generated_at?: string;
  regime?: string;
  suggested_size_pct?: number;
  conflict_detected?: boolean;
  risks?: string[];
};

type SignaRunResponse = {
  signals?: SignaRunSignal[];
  count?: number;
};

type SignaCardData = {
  direction?: string;
  bias?: string;
  confidence?: number;
  stage?: number;
  stageDescription?: string;
  tier?: string;
  overallScore?: number;
  entry?: number;
  stop?: number;
  target?: number;
  rr?: number;
  price?: number;
  change24h?: number;
  rsi?: number;
  riskScore?: number;
  riskFactors?: string[];
};

type SignaSignalResponse = {
  ok: boolean;
  symbol?: string;
  data?: SignaCardData;
  signa?: {
    grade?: string;
    conviction?: number;
    action?: string;
    riskRating?: string;
  };
};

/** Per-news-signal shape inside /enhanced-signal. We only care about a few
 *  fields for the Best Picks news pillar. */
type SignaEnhancedNewsSignal = {
  type?: string; // e.g. "INSIDER_CLUSTER", "NEWS"
  direction?: string; // "BULLISH" | "BEARISH" | "NEUTRAL"
  strength?: string;
  confidence?: number; // 0..100
  impact?: number;
  headline?: string;
  scoreAdjustment?: number;
};

type SignaEnhancedResponse = {
  ok: boolean;
  news?: {
    count?: number;
    score_adj?: number;
    signals?: SignaEnhancedNewsSignal[];
  };
};

// ─── browser-shaped output ───────────────────────────────────────────────────

/**
 * The Best Picks methodology — synthesized confluence pillars computed
 * server-side from the data we can read with our key. Each pillar is
 * normalized to 0–100 and equally weighted into `bestPickConfluence`.
 *
 * This is our substitute for Signa's gated `/api/v1/confluence/best-picks`
 * endpoint (see `docs/integrations/signa-api.md`). We get 4 of the 6
 * pillars they expose; GEX and Flow stay out of reach until the plan tier
 * is upgraded.
 */
export interface SignaPillarScores {
  /** Multi-timeframe trend: Stage 2 + EMA alignment + RSI band + MACD + ADX. */
  trend: number;
  /** Multi-model agent consensus: composite_score + model_count + grade. */
  agents: number;
  /** News & catalyst signal (insider clusters, headlines). */
  news: number;
  /** Trade plan quality: presence of entry/stop/target + R:R + sanity. */
  plan: number;
}

/** Surface-level catalyst summary for the Best Picks card. */
export interface SignaCatalyst {
  type: string;
  direction: string;
  headline: string;
  strength?: string;
  confidence?: number;
  impact?: number;
}

/**
 * Server-side rule for what qualifies as a Best Pick:
 *   1. Bullish direction (BEARISH/SHORT excluded — current scope)
 *   2. Has all three of entry / stop / target (no plan → can't auto-trade)
 *   3. At least this many models firing — broad consensus matters more than
 *      a single high score. AMD has 8 (max we've seen); JNJ has 5; the
 *      threshold below balances strictness with having enough picks to
 *      surface daily.
 */
const BEST_PICK_MIN_MODELS = 5;

export interface SignaPick {
  /** Stable id for React keys — composed from ticker+generated_at. */
  id: string;
  ticker: string;
  /** "BULLISH" / "BEARISH" (uppercase, from upstream). */
  direction: string;
  /** Side normalized for the trade form: "buy" or "sell". */
  side: "buy" | "sell";
  /** 0–100 multi-model composite_score from the scored run. */
  score: number;
  /** 1–3 alert tier; 3 = strongest. */
  tier: number;
  /** Letter grade (A / B / …). */
  grade?: string;
  /** 0–1 model confidence. */
  confidence?: number;
  modelCount: number;
  modelIds: string[];
  /** Headline reason string from /signals/run. */
  reason?: string;
  /** Bullet-list of key drivers from /signals/run. */
  keyDrivers: string[];
  regime?: string;
  conflictDetected?: boolean;
  risks: string[];
  /** ISO timestamp when this signal was generated. */
  generatedAt?: string;

  // ── Enriched fields (only present for the top-N tickers) ──
  /** Suggested entry, from /signal?sym=X data.entry. */
  entry?: number;
  /** Suggested stop loss, from data.stop. */
  stop?: number;
  /** Suggested take-profit target, from data.target. */
  target?: number;
  /** R:R from data.rr. */
  riskReward?: number;
  /** Live last price. */
  price?: number;
  /** 24h % change. */
  change24h?: number;
  /** Signa's overall live single-pass tier (HOT / WATCH / NEUTRAL / SKIP). */
  liveTier?: string;
  /** The Action Card's own directional read (LONG / SHORT / WAIT). This is a
   *  different engine from `direction` above, which comes from the scored
   *  run, and the two routinely disagree. */
  cardDirection?: string;
  /** The Action Card's bias (bullish / bearish / neutral). */
  cardBias?: string;
  /** Signa proprietary scoring: grade + action + conviction. */
  signaAction?: string;
  signaGrade?: string;
  signaConviction?: number;

  // ── Best Picks fields (only present when the pick qualifies) ──
  /** Per-pillar 0–100 scores. Undefined when the pick didn't qualify
   *  (missing plan, too few models, bearish direction). */
  pillars?: SignaPillarScores;
  /** Equal-weighted average of pillars, 0–100. Used as the headline
   *  "Confluence" score on the Best Picks card. */
  bestPickConfluence?: number;
  /** Primary news catalyst from /enhanced-signal (e.g. an insider buying
   *  cluster). Null/undefined when no catalyst is present. */
  catalyst?: SignaCatalyst | null;
  /** True iff this pick passes every Best Picks gate. Lets the client
   *  filter without re-implementing the threshold logic. */
  isBestPick: boolean;
}

export interface SignaTodaysSignalsResult {
  picks: SignaPick[];
  /** Server-side cache timestamp. */
  fetchedAt: string;
  /** When the upstream scored run was generated. */
  upstreamGeneratedAt?: string;
  /** Total unique tickers before truncation. */
  totalCandidates: number;
  /** How many were enriched with entry/stop/target. */
  enrichedCount: number;
  /** If we hit a non-fatal upstream issue (e.g. enrichment partial). */
  warnings: string[];
  /** True when this response was served from cache rather than freshly
   *  fetched. Useful for the panel to show a "Last refreshed Xm ago" hint. */
  servedFromCache: boolean;
  /** Age of the cached snapshot in seconds (0 on a fresh fetch). */
  cacheAgeSeconds: number;
  /** Age in seconds of the upstream Signa scoring run this snapshot was built
   *  from, recomputed every time the snapshot is served. This is the honest
   *  "how old is this data" number: `cacheAgeSeconds` only says when we last
   *  copied it, and the run itself can already be hours old at that point. */
  upstreamAgeSeconds?: number;
  /** How many picks were dropped because the Action Card's trade plan pointed
   *  the opposite way from the scored run's direction. */
  conflictingPlansDropped: number;
}

// ─── cache ───────────────────────────────────────────────────────────────────
//
// Redis-backed with a 4-hour TTL. We don't have a process-local fallback —
// if Redis is down the request just goes upstream and we don't try to
// remember it; on Vercel this is fine since instances are ephemeral.

/** Read the cached snapshot, returning null if absent / malformed. */
async function readCache(): Promise<SignaTodaysSignalsResult | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(REDIS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SignaTodaysSignalsResult;
  } catch {
    return null;
  }
}

/** Write the snapshot to Redis with the 4-hour TTL. */
async function writeCache(result: SignaTodaysSignalsResult): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.set(REDIS_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch {
    // Silent — better to skip caching than to fail a successful fetch.
  }
}

/** Acquire a short-lived lock so simultaneous cache misses don't all stampede
 *  the upstream API. The lock TTL is the upper bound on how long any one
 *  fetcher will hold the lock; a slow fetcher just lets others fall through.
 *  Returns true if we got the lock. */
async function tryAcquireLock(): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const existing = await redis.get(REDIS_LOCK_KEY);
    if (existing) return false;
    await redis.set(REDIS_LOCK_KEY, "1", LOCK_TTL_SECONDS);
    return true;
  } catch {
    // If Redis is down, just go upstream — there's no lock to honor.
    return true;
  }
}

async function releaseLock(): Promise<void> {
  try {
    const redis = await getRedisClient();
    // The cache client doesn't expose DEL, but a 1-second expire effectively
    // releases it within a tick.
    await redis.expire(REDIS_LOCK_KEY, 1);
  } catch {
    // ignore
  }
}

/** Sleep helper for the lock-wait loop. */
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── fetch helpers ───────────────────────────────────────────────────────────

async function signaFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(SIGNA_BASE + path, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Signa returned non-JSON for ${path}: ${text.slice(0, 200)}`,
    });
  }
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: string }).error)
        : `HTTP ${res.status}`;
    throw new TRPCError({
      code: res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : "BAD_GATEWAY",
      message: `Signa ${path} failed: ${err}`,
    });
  }
  return body as T;
}

/** Dedupe by ticker, keeping the highest-composite row. Sort desc. */
function dedupeByTicker(signals: SignaRunSignal[]): SignaRunSignal[] {
  const byTicker = new Map<string, SignaRunSignal>();
  for (const s of signals) {
    const existing = byTicker.get(s.ticker);
    if (!existing || s.composite_score > existing.composite_score) {
      byTicker.set(s.ticker, s);
    }
  }
  return [...byTicker.values()].sort(
    (a, b) => b.composite_score - a.composite_score || b.confidence - a.confidence,
  );
}

function sideFromDirection(direction: string): "buy" | "sell" {
  // Upstream uses BULLISH/BEARISH; LONG/SHORT also appears in some endpoints.
  if (/BEAR|SHORT|SELL/i.test(direction)) return "sell";
  return "buy";
}

/**
 * True when a trade plan's geometry matches the side we are advertising:
 * for a long, stop < entry < target; for a short, target < entry < stop.
 *
 * Why this matters. We take `direction` from `/api/signals/run` (a nightly
 * multi-model consensus) but `entry` / `stop` / `target` from
 * `/api/v1/signal` (a live single-pass). Those are two different engines and
 * they disagree. When the single-pass has no directional read it still emits
 * a mechanical 2R plan, and that fallback plan is short-shaped:
 *
 *   DAL: run says BULLISH (13 models, composite 96, grade A), card says
 *        direction "WAIT" / bias "neutral" and hands back
 *        entry 84.31 / stop 88.15 / target 76.64.
 *
 * Pairing those produced "buy DAL, stop above entry" on the panel, and
 * prefilled exactly that into the trade form via Copy signal. 10 of the top
 * 15 tickers were in this state.
 *
 * Note this is deliberately about plan geometry, not about `card.direction`
 * being literally "WAIT": BAC comes back as WAIT with a bullish bias and a
 * correctly long-shaped plan, and that pick is fine to keep.
 */
export function planMatchesSide(
  side: "buy" | "sell",
  entry?: number,
  stop?: number,
  target?: number,
): boolean {
  if (entry == null || stop == null || target == null) return false;
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target)
  ) {
    return false;
  }
  return side === "buy"
    ? stop < entry && entry < target
    : target < entry && entry < stop;
}

// ─── pillar scoring (Best Picks) ─────────────────────────────────────────────
//
// Each scorer returns 0..100 and is independent. We blend them into
// `bestPickConfluence` with equal weight in projectBestPickFields below.

/** Trend pillar — Stage 2 advancing + bullish EMA stack + RSI band + MACD +
 *  ADX (trend strength). Returns null when the card data isn't available. */
function scoreTrendPillar(d: SignaCardData | undefined): number | null {
  if (!d) return null;
  let s = 0;
  if (d.stage === 2) s += 35;
  if (
    d.rsi != null &&
    d.rsi >= 50 &&
    d.rsi <= 75
  ) {
    s += 15;
  }
  // Treat both bullish bias and a positive MACD histogram as evidence.
  if (d.bias === "bullish") s += 10;
  // We don't have ema/macd/adx on SignaCardData (we kept it minimal),
  // but bias + stage carry most of the signal weight. Cap at 100.
  return Math.min(100, s + 40); // base 40 for "we have card data at all"
}

/** Agents pillar — composite_score scaled, with a multi-model bonus and a
 *  small grade-A lift. Caps at 100. */
function scoreAgentsPillar(
  base: { score: number; modelCount: number },
  signa?: { grade?: string },
): number {
  let s = base.score;
  if (base.modelCount >= 8) s += 10;
  else if (base.modelCount >= 5) s += 5;
  if (signa?.grade === "A") s += 5;
  return Math.min(100, Math.max(0, s));
}

/** News pillar — catalysts from /enhanced-signal news.signals. Insider
 *  buying clusters are the strongest catalyst we've observed. */
function scoreNewsPillar(news?: SignaEnhancedResponse["news"]): number {
  const sigs = news?.signals ?? [];
  if (sigs.length === 0) return 0;
  let s = 0;
  for (const ns of sigs) {
    if (ns.type === "INSIDER_CLUSTER" && ns.direction === "BULLISH") s += 60;
    else if (ns.direction === "BULLISH") s += 30;
    else if (ns.direction === "BEARISH") s -= 20;
    s += (ns.confidence ?? 0) * 0.2;
  }
  return Math.max(0, Math.min(100, s));
}

/** Plan pillar: presence + quality of entry/stop/target with R:R bonus. */
function scorePlanPillar(
  d: SignaCardData | undefined,
  side: "buy" | "sell",
): number {
  if (!d) return 0;
  const has = (x: number | undefined) =>
    x != null && Number.isFinite(x) && x > 0;
  if (!has(d.entry) || !has(d.stop) || !has(d.target)) return 0;

  // Sanity first, and it is now a gate rather than a bonus. The previous
  // version accepted a coherent long OR a coherent short without ever
  // comparing against the pick's own side, so a short-shaped plan under a
  // BULLISH label collected the full +20 and scored PLAN 90, which is what
  // ranked those picks onto the Best Picks board in the first place.
  if (!planMatchesSide(side, d.entry, d.stop, d.target)) return 0;

  let s = 60;
  if (d.rr != null) {
    if (d.rr >= 3) s += 40;
    else if (d.rr >= 2) s += 30;
    else if (d.rr >= 1.5) s += 15;
  }
  return Math.min(100, s);
}

/** Pick the primary catalyst from a news payload for display on the card. */
function pickPrimaryCatalyst(
  news?: SignaEnhancedResponse["news"],
): SignaCatalyst | null {
  const sigs = news?.signals ?? [];
  if (sigs.length === 0) return null;
  // Prefer bullish INSIDER_CLUSTER, then highest-impact bullish, then any.
  const sorted = [...sigs].sort((a, b) => {
    const aPri =
      (a.type === "INSIDER_CLUSTER" ? 100 : 0) +
      (a.direction === "BULLISH" ? 50 : 0) +
      (a.impact ?? 0);
    const bPri =
      (b.type === "INSIDER_CLUSTER" ? 100 : 0) +
      (b.direction === "BULLISH" ? 50 : 0) +
      (b.impact ?? 0);
    return bPri - aPri;
  });
  const c = sorted[0];
  if (!c) return null;
  return {
    type: c.type ?? "UNKNOWN",
    direction: c.direction ?? "NEUTRAL",
    headline: c.headline ?? "",
    strength: c.strength,
    confidence: c.confidence,
    impact: c.impact,
  };
}

/** Decide whether a pick passes every Best Picks gate, and if so attach the
 *  pillars/confluence/catalyst fields. Mutates `pick` in place. */
function annotateBestPick(
  pick: SignaPick,
  cardData: SignaCardData | undefined,
  cardSigna: { grade?: string } | undefined,
  enhanced: SignaEnhancedResponse | undefined,
): void {
  // Gate 1: bullish direction
  const isBullish = /BULL|LONG|BUY/i.test(pick.direction);
  // Gate 2: complete trade plan that actually points the way we say it does
  const hasPlan = planMatchesSide(pick.side, pick.entry, pick.stop, pick.target);
  // Gate 3: broad model agreement
  const enoughModels = pick.modelCount >= BEST_PICK_MIN_MODELS;

  if (!isBullish || !hasPlan || !enoughModels) {
    pick.isBestPick = false;
    return;
  }

  const trend = scoreTrendPillar(cardData) ?? 0;
  const agents = scoreAgentsPillar(
    { score: pick.score, modelCount: pick.modelCount },
    cardSigna,
  );
  const news = scoreNewsPillar(enhanced?.news);
  const plan = scorePlanPillar(cardData, pick.side);
  const confluence = (trend + agents + news + plan) / 4;

  pick.pillars = { trend, agents, news, plan };
  pick.bestPickConfluence = Math.round(confluence * 10) / 10;
  pick.catalyst = pickPrimaryCatalyst(enhanced?.news);
  pick.isBestPick = true;
}

// ─── enrichment ──────────────────────────────────────────────────────────────

/**
 * For each ticker in the slice: fetch the Action Card and the enhanced
 * signal in parallel, copy entry/stop/target/etc. onto the pick, and
 * compute Best Picks pillars.
 *
 * Cost: 2 upstream API calls per enriched ticker. At ENRICH_TOP_N=15 we
 * spend up to ~31 calls per refresh (1 /signals/run + 15 /signal + 15
 * /enhanced-signal). With a 4-hour cache TTL that's ~186 calls/day, well
 * inside the 1000/day quota.
 */
async function enrichWithCards(
  picks: SignaPick[],
  apiKey: string,
  warnings: string[],
): Promise<{ conflictedIds: Set<string> }> {
  const targets = picks.slice(0, ENRICH_TOP_N);
  const conflictedIds = new Set<string>();
  await Promise.all(
    targets.map(async (pick) => {
      try {
        const [card, enhanced] = await Promise.all([
          signaFetch<SignaSignalResponse>(
            `/api/v1/signal?sym=${encodeURIComponent(pick.ticker)}`,
            apiKey,
          ).catch((err: unknown) => {
            warnings.push(
              `Could not fetch /signal for ${pick.ticker}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }),
          signaFetch<SignaEnhancedResponse>(
            `/api/v1/enhanced-signal?sym=${encodeURIComponent(pick.ticker)}`,
            apiKey,
          ).catch((err: unknown) => {
            warnings.push(
              `Could not fetch /enhanced-signal for ${pick.ticker}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }),
        ]);

        const d = card?.data;
        if (d) {
          pick.entry = d.entry;
          pick.stop = d.stop;
          pick.target = d.target;
          pick.riskReward = d.rr;
          pick.price = d.price;
          pick.change24h = d.change24h;
          pick.liveTier = d.tier;
          pick.cardDirection = d.direction;
          pick.cardBias = d.bias;

          // The card returned a plan, but one that points the opposite way
          // from the direction we are labelling this pick with. We cannot
          // show it (the numbers contradict the badge) and we cannot silently
          // flip the badge (the run's multi-model consensus is the stronger
          // signal). Drop the pick instead. See planMatchesSide.
          const hasPlanNumbers =
            d.entry != null && d.stop != null && d.target != null;
          if (
            hasPlanNumbers &&
            !planMatchesSide(pick.side, d.entry, d.stop, d.target)
          ) {
            conflictedIds.add(pick.id);
          }
        }
        if (card?.signa) {
          pick.signaAction = card.signa.action;
          pick.signaGrade = card.signa.grade;
          pick.signaConviction = card.signa.conviction;
        }

        annotateBestPick(pick, d, card?.signa, enhanced ?? undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Could not enrich ${pick.ticker}: ${msg}`);
        pick.isBestPick = false;
      }
    }),
  );
  return { conflictedIds };
}

// ─── router ──────────────────────────────────────────────────────────────────

/** Do the actual upstream fetch + projection. Pulled out of the procedure
 *  so both the cache-miss path and the manual-refresh path can call it. */
async function fetchFreshSnapshot(apiKey: string): Promise<SignaTodaysSignalsResult> {
  const warnings: string[] = [];

  // 1) Scored signal run.
  const run = await signaFetch<SignaRunResponse>(SIGNA_RUN_PATH, apiKey);
  const all = dedupeByTicker(run.signals ?? []);

  // 2) Project to browser shape (un-enriched fields first).
  //    isBestPick defaults to false — only the top N tickers get the per-symbol
  //    enrichment pass that can promote them to a Best Pick.
  const picks: SignaPick[] = all.map((s) => ({
    id: `${s.ticker}_${s.generated_at ?? "now"}`,
    ticker: s.ticker,
    direction: s.direction,
    side: sideFromDirection(s.direction),
    score: s.composite_score,
    tier: s.alert_tier,
    grade: s.grade,
    confidence: s.confidence,
    modelCount: s.model_count,
    modelIds: s.model_ids ?? [],
    reason: s.reason,
    keyDrivers: s.key_drivers ?? [],
    regime: s.regime,
    conflictDetected: s.conflict_detected,
    risks: s.risks ?? [],
    generatedAt: s.generated_at,
    isBestPick: false,
  }));

  // 3) Enrich the top N tickers with /signal?sym=X.
  const { conflictedIds } = await enrichWithCards(picks, apiKey, warnings);

  // 4) Drop any pick whose plan contradicts its own direction badge. These are
  //    unshowable: the numbers say short, the badge says bullish, and Copy
  //    signal would prefill a long with the stop above the entry.
  const visible = picks.filter((p) => !conflictedIds.has(p.id));
  if (conflictedIds.size > 0) {
    warnings.push(
      `Dropped ${conflictedIds.size} pick(s) whose Signa Action Card plan contradicted the scored run's direction.`,
    );
  }

  const upstreamGeneratedAt = run.signals?.[0]?.generated_at;

  return {
    picks: visible,
    fetchedAt: new Date().toISOString(),
    upstreamGeneratedAt,
    totalCandidates: all.length,
    enrichedCount: visible.filter(
      (p) => p.entry != null && p.stop != null && p.target != null,
    ).length,
    warnings,
    servedFromCache: false,
    cacheAgeSeconds: 0,
    upstreamAgeSeconds: ageSecondsSince(upstreamGeneratedAt),
    conflictingPlansDropped: conflictedIds.size,
  };
}

/** Seconds elapsed since an ISO timestamp, or undefined if it is absent or
 *  unparseable. */
function ageSecondsSince(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.floor(ms / 1000));
}

/** Annotate a snapshot with how old it is, in seconds. Both ages are
 *  recomputed at serve time so a cached snapshot reports its true current
 *  age rather than the age it had when it was written. */
function withCacheAge(snapshot: SignaTodaysSignalsResult): SignaTodaysSignalsResult {
  return {
    ...snapshot,
    servedFromCache: true,
    cacheAgeSeconds: ageSecondsSince(snapshot.fetchedAt) ?? 0,
    upstreamAgeSeconds: ageSecondsSince(snapshot.upstreamGeneratedAt),
  };
}

/**
 * Why this is on `authenticatedProcedure` and not `protectedProcedure`:
 *
 * `protectedProcedure` adds the global per-user 20-req/10s rate limiter.
 * The Signa panel renders the same shared snapshot for every user, and on
 * a cache hit each call is one Redis read — there's no abuse vector worth
 * gating. Keeping it under the per-user limiter caused the lockout the
 * user reported on a fast reload (the panel's first paint races with
 * positions / orders / watchlist queries and blows the budget).
 *
 * Upstream protection still exists: a Redis lock prevents two fetchers
 * from stampeding the Signa API on a cold cache.
 */
export const signaRouter = router({
  /**
   * Returns today's ranked board.
   *
   * - Served from Redis when fresh (≤ 4h old).
   * - On cache miss, takes a Redis lock so simultaneous misses don't
   *   stampede the upstream API; losers wait briefly for the winner's
   *   snapshot to land.
   * - The client (apps/web-v2/src/components/signa/…) calls this only on
   *   mount and on explicit refresh — no background polling.
   */
  todaysSignals: authenticatedProcedure
    .input(
      z
        .object({
          /** Bypass the Redis cache and force a fresh upstream fetch. */
          force: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<SignaTodaysSignalsResult> => {
      const apiKey = process.env.SIGNA_API_KEY;
      if (!apiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Signa is not configured. Set SIGNA_API_KEY on the API server to enable this panel.",
        });
      }

      const force = input?.force === true;

      // Cache hit — fast path.
      if (!force) {
        const cached = await readCache();
        if (cached) return withCacheAge(cached);
      }

      // Cache miss. Try to win the lock; if we don't, briefly wait for the
      // lock-holder to populate the cache, then serve from cache.
      const haveLock = await tryAcquireLock();
      if (!haveLock) {
        // Up to ~6 attempts × 500ms = 3s wait for the other fetcher to land.
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          const cached = await readCache();
          if (cached) return withCacheAge(cached);
        }
        // Other fetcher took too long — fall through and do our own fetch.
      }

      try {
        const fresh = await fetchFreshSnapshot(apiKey);
        await writeCache(fresh);
        return fresh;
      } finally {
        if (haveLock) await releaseLock();
      }
    }),
});
