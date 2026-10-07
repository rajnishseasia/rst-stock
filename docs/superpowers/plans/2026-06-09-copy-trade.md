# Copy Trade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a unified, source-filterable Copy Trade feed (X signals + fellow users now; politicians later) where Copy prefills the trade form with symbol, side, and a quantity the client sizes from the user's own buying power.

**Architecture:** A `copyTrade.feed` tRPC procedure maps every source onto the normalized `CopyTradeItem` contract, merges them newest-first in TypeScript, and pages by a composite `{ ts, id }` base64 cursor with per-source try/catch isolation. A new `CopyTradePanel` is added ALONGSIDE the existing X Signals and Community Trades panels; it sizes quantity client-side from `trpc.positions.account` buying power and live quotes, then hands `symbol` / `side` / `qty` to the existing `TradeForm` via its `initialSymbol`, `initialSide`, and `initialQty` props. No order is auto-submitted.

**Tech Stack:** tRPC, Drizzle (PostgreSQL), Zod, React 19, Next.js, TypeScript, Tailwind CSS, shadcn/ui, Bun test runner

---

### Task 1: Copy-trade router — normalize, merge, paginate

**Files:**
- Create: `apps/api/src/routers/copy-trade.ts`
- Modify: `apps/api/src/routers/index.ts`
- Create: `apps/api/src/routers/__tests__/copy-trade.test.ts`

- [ ] **Step 1: Write the failing pure-logic tests**

Cover the DB-free helpers so they can be tested without a database:

```ts
import { describe, expect, it } from "bun:test";
import {
  decodeCursor,
  encodeCursor,
  mapSignalToItem,
  mapUserTradeToItem,
  mergeItems,
} from "../copy-trade.js";
```

- `encodeCursor` / `decodeCursor` round-trip a `{ ts, id }`; `decodeCursor`
  returns `null` for null/undefined/malformed input.
- `mapSignalToItem` yields `source: "x_signal"`, a `x_signal:`-prefixed id,
  uppercase symbol, `side: "buy"`, and `meta.signalId`.
- `mapUserTradeToItem` yields `source: "user"`, a `user:`-prefixed id, the row's
  side, an anonymized `displayName`, and the qty/orderType/fillPrice/limitPrice/
  assetType `meta`.
- `mergeItems` sorts newest-first with an `id` descending tie-break and slices
  to `limit`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/routers/__tests__/copy-trade.test.ts)
```

Expected: FAIL because `copy-trade.ts` does not exist yet.

- [ ] **Step 3: Implement the normalized contract and helpers**

In `apps/api/src/routers/copy-trade.ts`, export `CopyTradeSource`,
`CopyTradeItem`, `encodeCursor`, `decodeCursor`, `mapSignalToItem`,
`mapUserTradeToItem`, and `mergeItems`. Reuse `anonymizeTrader` from
`./social.js` for user-source pseudonyms so a real user id never reaches the
client. All relative imports use the `.js` extension.

- [ ] **Step 4: Implement the `feed` procedure**

```ts
export const copyTradeRouter = router({
  feed: protectedProcedure
    .input(
      z.object({
        sources: z
          .array(z.enum(["x_signal", "user", "politician"]))
          .min(1)
          .default(["x_signal", "user", "politician"]),
        symbol: z.string().min(1).max(10).transform((v) => v.toUpperCase()).optional(),
        limit: z.number().min(1).max(50).default(30),
        cursor: z.string().nullish(),
      }),
    )
    .query(async ({ ctx, input }) => { /* ... */ }),
});
```

- Decode the cursor once. For each requested source, build conditions
  (`timestamp < cursor.ts`, optional `symbol`), query, and map to items inside a
  try/catch that logs and degrades to `[]`.
- `x_signal` reads `schema.signals`; `user` joins `schema.socialTrades` →
  `schema.users` (anonymize) and left-joins `schema.orders` on `brokerOrderId`
  for the executed `fillPrice`.
- `politician` is a Phase 1 no-op: push `[]`.
- Merge with `mergeItems`, slice to `limit`, and return `nextCursor` only when
  the page came back full.

- [ ] **Step 5: Register the router**

Add `import { copyTradeRouter } from "./copy-trade.js";` and `copyTrade:
copyTradeRouter` to `apps/api/src/routers/index.ts`.

- [ ] **Step 6: Run the API test and typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/routers/__tests__/copy-trade.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

Expected: tests pass; TypeScript exits cleanly.

---

### Task 2: Copy Trade panel — filters, sizing, and Copy prefill

**Files:**
- Create: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Create: `apps/web-v2/src/components/copy-trade/__tests__/copy-trade-panel.test.ts`
- Modify: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Write the failing source-string panel tests**

Mirror `apps/web-v2/src/components/watchlist/watchlist-panel.test.ts`: read the
component source via `new URL("../copy-trade-panel.tsx", import.meta.url)` and
assert with `source.toContain(...)`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../copy-trade-panel.tsx", import.meta.url),
  "utf8",
);
```

Assert that the panel:
- queries `trpc.copyTrade.feed`.
- renders source-filter tabs and a disabled Politicians tab with `Soon`.
- reads buying power from `trpc.positions.account`.
- defaults the sizing mode to `"pct"` and computes `Math.floor(targetDollars / price)`.
- passes `initialSymbol`, `initialSide`, and `initialQty` on Copy (or invokes an
  `onCopy` handler with `{ symbol, side, qty }`).
- reuses `useCollapsible` / `CollapseButton`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun test src/components/copy-trade/__tests__/copy-trade-panel.test.ts)
```

Expected: FAIL because `copy-trade-panel.tsx` does not exist yet.

- [ ] **Step 3: Build the panel**

Implement `CopyTradePanel` with shadcn `Card`, `Tabs` (All / X Signals / Users /
Politicians-disabled-"Soon"), `Badge`, `Avatar`, and `ScrollArea`, wrapped in
the shared `useCollapsible("copy-trade")` + `CollapseButton`. Drive the list
from `trpc.copyTrade.feed`, filtering `sources` from the active tab.

- [ ] **Step 4: Add client-side sizing and Copy**

Add a sizing control (mode `pct | usd`, default `pct`; a numeric value). Read
buying power from `trpc.positions.account` and a live price from the quotes
query for the item's symbol, then:

```ts
const targetDollars = mode === "pct" ? (value / 100) * buyingPower : value;
const qty = price > 0 ? Math.max(0, Math.floor(targetDollars / price)) : 0;
```

Copy lifts `{ symbol: item.symbol, side: item.side, qty }` to the trade form via
an `onCopy` callback. Never auto-submit.

- [ ] **Step 5: Mount alongside the existing panels**

In `apps/web-v2/src/app/app/page.tsx`, render `<CopyTradePanel onCopy={...} />`
ALONGSIDE `SignalFeed` and `SocialFeedPanel`, and route its `onCopy` values into
the `TradeForm`'s `initialSymbol` / `initialSide` / `initialQty` props (reuse
the existing selection state). Do not remove or alter the existing panels.

- [ ] **Step 6: Run the web test and typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun test src/components/copy-trade/__tests__/copy-trade-panel.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun run typecheck)
```

Expected: tests pass; TypeScript exits cleanly (web check may take 60–180s).

- [ ] **Step 7: Inspect in the browser**

```bash
bun dev:web
```

Open `http://localhost:4001/app` and verify:

- The Copy Trade panel sits beside X Signals and Community Trades.
- Source filter tabs narrow the feed; the Politicians tab is disabled and shows
  "Soon".
- Changing sizing mode/value updates the previewed quantity from current buying
  power and the live price.
- Clicking Copy prefills the trade form with symbol, side, and the sized
  quantity, and does not submit.
- Collapsing hides only the list body; the collapsed state persists across
  reloads.

---

### Phase 2 (later): Politicians source

Add a `politician_trades` table to `packages/db/src/schema/**` (exported from
`packages/db/src/schema/index.ts`), a worker poller that ingests disclosures
(data source TBD), and a `mapPoliticianTradeToItem` adapter. Then replace the
`politician` no-op in `feed` with a real query and enable the Politicians tab.

### Phase 3 (design-only): Follow / auto-mirror

Let a user follow a source and auto-place sized orders when new items arrive.
Out of scope for implementation here; captured for the roadmap only.
