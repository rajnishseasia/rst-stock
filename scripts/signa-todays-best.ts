/**
 * Pull Signa's "today's best" signals and pretty-print the ranked list.
 *
 * Primary endpoint:
 *   GET https://app.getsigna.ai/api/v1/confluence/best-picks
 *     — the Best Trades board on dashboard.signa.ai
 *     — gated above Founding Member plan; returns 401 with API key auth
 *
 * Fallback endpoint (accessible with our API key):
 *   GET https://app.getsigna.ai/api/signals/run?scored=true&limit=250
 *     — the live scored multi-agent signal run
 *
 * Auth: Authorization: Bearer cmts_…   (from Signa dashboard → API Keys)
 *
 * Usage:
 *   SIGNA_API_KEY=cmts_xxx bun run scripts/signa-todays-best.ts
 *
 * Optional flags:
 *   --json      dump raw JSON instead of the table
 *   --runonly   skip the confluence endpoint, use signals/run only
 *   --topN N    show top N rows in the fallback table (default 10)
 *
 * See docs/integrations/signa-api.md for the full endpoint catalogue.
 */

const BASE = "https://app.getsigna.ai";
const PATH_CONFLUENCE = "/api/v1/confluence/best-picks";
const PATH_RUN = "/api/signals/run?scored=true&limit=250";

const apiKey = process.env.SIGNA_API_KEY;
if (!apiKey) {
  console.error(
    "Missing SIGNA_API_KEY env var.\n\n" +
      "  SIGNA_API_KEY=cmts_xxxx bun run scripts/signa-todays-best.ts\n",
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const wantsJson = args.has("--json");
const runOnly = args.has("--runonly");
const topNArg = process.argv.findIndex((a) => a === "--topN");
const topN =
  topNArg > -1 && process.argv[topNArg + 1] ? Number(process.argv[topNArg + 1]) : 10;

// ─── shared types ────────────────────────────────────────────────────────────

type Pillar = {
  score?: number;
  direction?: string;
  summary?: string;
  freshness_status?: string;
  supports_final?: boolean;
  age_minutes?: number;
  details?: Record<string, unknown>;
};

type ConfluencePick = {
  id: string;
  ticker: string;
  direction: string;
  confluence_score: number;
  tier: string;
  pillar_scores?: Record<string, number>;
  evidence?: Record<string, Pillar>;
  trade_plan?: {
    entry?: number;
    stop?: number;
    target?: number;
    risk_reward?: number;
    source_signal?: string;
  } | null;
  explanation?: string;
  status?: string;
  spot_price_at_generation?: number;
};

type ConfluenceResponse = {
  ok: boolean;
  source?: string;
  stable?: boolean;
  generated_at?: string;
  age_minutes?: number;
  next_refresh_after_minutes?: number;
  picks?: ConfluencePick[];
  error?: string;
};

type RunSignal = {
  id: string;
  ticker: string;
  direction: string;
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

type RunResponse = {
  signals: RunSignal[];
  count: number;
  tier3_gated?: boolean;
};

// ─── http ────────────────────────────────────────────────────────────────────

async function fetchJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(BASE + path, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining) {
    console.error(`[${path}] rate-limit remaining: ${remaining}`);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ─── rendering ───────────────────────────────────────────────────────────────

function usd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
function directionColor(dir: string): string {
  if (/BULL|LONG|BUY/i.test(dir)) return green(dir);
  if (/BEAR|SHORT|SELL/i.test(dir)) return red(dir);
  return yellow(dir);
}

function renderConfluence(resp: ConfluenceResponse) {
  const picks = resp.picks ?? [];
  const banner = [
    resp.source ? `source=${resp.source}` : null,
    resp.stable ? "stable" : null,
    resp.generated_at ? `generated ${resp.generated_at}` : null,
    resp.age_minutes != null ? `age ${resp.age_minutes}m` : null,
    resp.next_refresh_after_minutes != null
      ? `refresh in ${resp.next_refresh_after_minutes}m`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  console.log(dim(banner));
  console.log();
  console.log(bold("Today's Best Picks — Signa confluence board"));
  console.log("─".repeat(72));
  picks.forEach((p, idx) => {
    const header = `${bold("#" + (idx + 1)).padEnd(4)} ${bold(p.ticker.padEnd(6))} ${directionColor(p.direction)}   confluence ${bold(String(p.confluence_score))} · tier ${bold(p.tier)} · ${p.status ?? "?"}`;
    console.log(header);
    if (p.pillar_scores) {
      console.log(
        "    " +
          dim("pillars: ") +
          Object.entries(p.pillar_scores).map(([k, v]) => `${k}=${v.toFixed(1)}`).join("  "),
      );
    }
    if (p.trade_plan) {
      const tp = p.trade_plan;
      console.log(
        "    " +
          dim("plan:    ") +
          `entry ${usd(tp.entry)} · stop ${usd(tp.stop)} · target ${usd(tp.target)} · R:R ${tp.risk_reward ?? "—"}` +
          (tp.source_signal ? dim(`  (${tp.source_signal})`) : ""),
      );
    }
    if (p.explanation) console.log("    " + dim("why:     ") + p.explanation);
    if (p.spot_price_at_generation != null)
      console.log("    " + dim("ref:     ") + `spot at gen ${usd(p.spot_price_at_generation)}`);
    console.log();
  });
}

/** Collapse duplicate-ticker rows (different model families can emit the same
 *  ticker twice in a single run). Keep the highest composite_score row per
 *  ticker so the ranking is a clean leaderboard. */
function dedupeByTicker(signals: RunSignal[]): RunSignal[] {
  const byTicker = new Map<string, RunSignal>();
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

function renderRun(resp: RunResponse) {
  const all = dedupeByTicker(resp.signals);
  const top = all.slice(0, topN);
  console.log(
    bold("Today's Best Signals — fallback from /api/signals/run?scored=true"),
  );
  console.log(
    dim(
      `(confluence/best-picks was gated. ` +
        `${resp.count} raw signals · ${all.length} unique tickers · top ${topN} shown)`,
    ),
  );
  console.log("─".repeat(72));
  top.forEach((s, idx) => {
    const header = `${bold("#" + (idx + 1)).padEnd(4)} ${bold(s.ticker.padEnd(8))} ${directionColor(s.direction)}   score ${bold(String(s.composite_score))} · tier ${bold(String(s.alert_tier))} · conf ${(s.confidence * 100).toFixed(0)}% · ${s.model_count} models${s.regime ? dim(`  [${s.regime}]`) : ""}`;
    console.log(header);
    if (s.reason) {
      const reason = s.reason.length > 200 ? s.reason.slice(0, 197) + "…" : s.reason;
      console.log("    " + dim("why:    ") + reason);
    }
    if (s.key_drivers && s.key_drivers.length > 0) {
      console.log(
        "    " +
          dim("drivers: ") +
          s.key_drivers.slice(0, 3).join("  ·  "),
      );
    }
    console.log();
  });

  // Show where AMD landed even if not in top N — this is the headline
  // ticker the user is checking against the dashboard.
  const amdIdx = all.findIndex((s) => s.ticker === "AMD");
  if (amdIdx >= 0 && amdIdx >= topN) {
    const amd = all[amdIdx];
    console.log(
      dim(
        `AMD position: #${amdIdx + 1} of ${all.length} · score ${amd.composite_score} · ${amd.model_count} models bullish`,
      ),
    );
  } else if (amdIdx >= 0) {
    console.log(cyan(`AMD is #${amdIdx + 1} in this list.`));
  } else {
    console.log(dim("AMD did not appear in today's scored run."));
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Try the confluence board first (unless --runonly).
  if (!runOnly) {
    const { status, body } = await fetchJson(PATH_CONFLUENCE);
    if (status === 200 && body && typeof body === "object" && "picks" in body) {
      if (wantsJson) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      renderConfluence(body as ConfluenceResponse);
      return;
    }
    // 401 = plan-gated; anything else is unexpected but still falls back.
    const err = body && typeof body === "object" ? (body as { error?: string }).error : String(body);
    console.error(
      yellow(`confluence/best-picks unavailable (HTTP ${status}: ${err ?? "unknown"}).`) +
        dim(" Falling back to /api/signals/run."),
    );
    console.error();
  }

  // 2. Fall back to the scored signal run.
  const { status, body } = await fetchJson(PATH_RUN);
  if (status !== 200 || !body || typeof body !== "object" || !("signals" in body)) {
    const err = body && typeof body === "object" ? (body as { error?: string }).error : String(body);
    throw new Error(`signals/run failed: HTTP ${status} — ${err ?? "unknown"}`);
  }
  if (wantsJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  renderRun(body as RunResponse);
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
