# Copy Trade Design

## Goal

Add a single Copy Trade feed that merges every "copy-able" source into one
source-filterable list. Phase 1 covers two existing sources — X signals and
fellow users — with a disabled Politicians tab marked "Soon". Clicking Copy on
any item prefills the trade form with the item's symbol and side, plus a
quantity the client sizes from the user's own buying power.

## Design

### Normalized item contract

Every source maps onto one `CopyTradeItem` shape so the panel renders a single
list regardless of origin:

```ts
type CopyTradeSource = "x_signal" | "user" | "politician";
interface CopyTradeItem {
  source: CopyTradeSource;        // discriminator
  id: string;                     // SOURCE-PREFIXED, e.g. "x_signal:<uuid>", "user:<uuid>"
  symbol: string;                 // UPPERCASE
  side: "buy" | "sell";           // x_signal => "buy"; user => row.side
  displayName: string;            // author name / anonymized pseudonym
  avatar: string | null;
  timestamp: string;              // ISO — the merge/sort/cursor key
  content: string | null;         // tweet text (x_signal) / null (user)
  url: string | null;             // tweet permalink (x_signal) / null (user)
  meta: Record<string, unknown>;  // x_signal: { signalId } ; user: { qty, orderType, fillPrice, limitPrice, assetType }
}
```

### Merge across sources

`copyTrade.feed` reads each requested source independently, maps every row onto
`CopyTradeItem`, then concatenates the per-source arrays and sorts them
newest-first in TypeScript. The sort is `timestamp` descending with `id`
descending as a tie-break, giving a stable total order across heterogeneous
rows. Each source's DB read is wrapped so one failing source degrades to `[]`
rather than emptying the whole feed. Source-prefixed ids (`x_signal:<uuid>`,
`user:<uuid>`) stay unique across the merge.

### Composite cursor

Paging keys on a composite `{ ts, id }` cursor, base64-encoded as JSON. Each
source filters its own query by `timestamp < cursor.ts`, the merged page is
sliced to `limit`, and a non-null `nextCursor` is returned only when the page
came back full (more may exist). Encoding both `ts` and `id` keeps the cursor
stable when several items share a timestamp.

### Client-side sizing

The panel computes quantity on the client so each user sizes against their own
account, never the original author's. It reads buying power from
`trpc.positions.account` and a live price from the quotes query for the item's
symbol. A sizing rule controls the dollar target:

```ts
targetDollars = mode === "pct" ? (value / 100) * buyingPower : value;
qty = price > 0 ? Math.max(0, Math.floor(targetDollars / price)) : 0;
```

`% of buying power` is the default mode; a fixed `$` mode is also offered. The
control is presentation-only sizing math — it never trusts a quantity from the
source row.

### Manual prefill into the trade form

Copy is a manual handoff: clicking it lifts the item's `symbol`, `side`, and the
client-sized `qty` into the existing `TradeForm`, which already accepts
`initialSymbol`, `initialSide`, and `initialQty`. The form remains the single
place an order is reviewed and submitted — Copy never auto-submits.

### Placement

The Copy Trade panel is added ALONGSIDE the existing X Signals and Community
Trades panels rather than replacing either. It reuses the shared
`useCollapsible` hook and `CollapseButton`, plus the existing `card`, `badge`,
`avatar`, and `scroll-area` primitives, so it matches the other dashboard cards.

## Scope

- **Phase 1:** Two existing sources only — `x_signal` (from `schema.signals`)
  and `user` (anonymized `schema.socialTrades`). The Politicians tab renders
  disabled with a "Soon" label and the `politician` source is a no-op that
  returns `[]`.
- **Phase 2:** A `politician_trades` table, a worker poller, and an adapter that
  maps disclosures onto `CopyTradeItem`. The underlying data source is TBD.
- **Phase 3:** Follow / auto-mirror (subscribe to a source and auto-place sized
  orders). Design-only for now; no implementation.

## Verification

- Run the API TypeScript check and `bun test` (cursor round-trip, per-source
  mappers, and merge ordering).
- Run the web TypeScript check and `bun test` (source-string assertions on the
  panel: filter tabs, disabled Politicians "Soon" state, sizing-mode default,
  and Copy prefill wiring).
- Manually confirm in the browser: the panel sits beside X Signals and Community
  Trades; source filters narrow the feed; the Politicians tab is disabled;
  clicking Copy prefills the trade form with symbol, side, and a quantity sized
  from the current buying power and live price.
