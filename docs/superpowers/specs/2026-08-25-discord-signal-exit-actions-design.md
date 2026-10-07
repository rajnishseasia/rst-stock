# Discord Signal Exit Actions — Design

Date: 2026-08-25
Status: Implemented (Approach A — extend existing stream with an `action` field)

Implemented against the hardened 1107-line poller on `origin/main`, not the
496-line version this spec was first drafted against. Two requirements were
discovered during implementation and are folded in below: shorts are real, and
`authorId` / `messageTimestamp` are mandatory on every stream entry.

## Problem

The Discord signal pipeline is entry-only. When the source account posts an exit
— "Closing ENA early here before the 1H close, we've been eating hard this month
not gonna get caught in a liq cascade" — nothing happens. The position stays
open and no alert is raised.

Two independent gates cause this:

1. **Producer.** `run_prof_discord_rst_copying.py::parse_signal()` returns a
   signal only when the message matches `_ENTRY_RES` (going long / longing /
   long X here). Exit phrasing matches nothing and falls through to `return
   None`. The only side effect for a non-entry message is a `log.info` line.
2. **Consumer.** `external-discord-signal-poller.ts::parseStreamEntry()` hard
   gates on `fields.isNewEntry !== "true"` and returns `null`. The wire format
   has no way to express anything but "open a position".

Because the consumer silently drops non-actionable entries and advances its
cursor, an exit is unrecoverable once missed.

A separate class of misses affects entries themselves. Three parser defects
drop or corrupt real entry signals (see "Entry-path defects" below).

## Goals

1. Act on **full closes** — market-sell the entire position, reduce-only.
2. Act on **partial exits** (TP hits, trims, explicit percentages).
3. Act on **stop-to-breakeven** instructions.
4. Fix the three entry-path defects that currently lose valid entries.
5. Trade entries that carry no stop loss, using a **-10% fallback stop**.
6. Preserve the existing v1 wire format so nothing in flight breaks.

## Non-goals

- **Add-to-position.** "Added to MON", "Adding to my HYPE spot bags here at
  $54.5" are recognised as a class and logged, but never executed. Sizing a
  scale-in against an existing average entry is a separate design.
- **Coinless messages.** "Take TP1 guys good move it's the weekend too" and
  "1H close under 2.13 for stops" carry their ticker only in an attached chart
  image. These are logged and dropped. No most-recent-coin inference, no
  "apply if exactly one position open" heuristic.
- **Spot vs perp distinction.** Unchanged from today: spot calls are traded as
  the perp.
- **Image/OCR parsing.** Out of scope.
### Correction: shorts are in scope

This spec originally excluded shorts on the premise that the source account only
calls longs. The March–August message corpus disproves it:

> "Giving this short a try on SOL @ CMP. 15min close **above** 90.16 for stops,
> TPs in white. No dca."

The parser hardcoded `side: "long"` and matched only "close under", so that call
would have opened a **long into a short setup with the stop on the wrong side** —
the worst failure this pipeline can produce. Side is now detected from the
message, and stop phrasing matches both directions (`close under|below|above`,
`stops above X`), with commas stripped so `stops above 67,500` parses.

Exits still derive their side from the live position, never from the message.

## Approach

Three approaches were considered.

**A. Extend the existing stream with an `action` field.** (Chosen.) One stream,
one cursor, one follower-resolution path, one idempotency scheme. The consumer
branches on `action`. Cost: the wire format needs a version bump and the poller
grows three handlers.

**B. A second Redis stream for exits.** Isolates exit risk from the entry path
entirely. Rejected: duplicates cursor management, follower config, dedup, and
webhook logic, and introduces cross-stream ordering questions (an exit could be
processed before the entry it closes).

**C. Replace regex with an LLM classifier.** Handles the long tail — "we hit our
first trim level, profits taken on ETH" — that regex will miss. Rejected for the
hot path: adds network latency and nondeterminism to trade execution, and fails
open in a way that is hard to reason about. Revisit as an offline backfill that
flags parser misses.

## Wire format v2

```
v:            "2"                   # consumer accepts "1" and "2"
action:       "open" | "close" | "reduce" | "stop_be"
coin:         "ENA"
side:         "long" | "short"      # entries only; exits derive side from position
messageId, channelId, authorName, rawMessage, parsedAt, confidence

# REQUIRED by the consumer on every action - it silently drops entries missing
# either, so without these nothing the bot writes is ever executed.
authorId:         "424242424242424242"    # Discord author snowflake
messageTimestamp: "2026-08-25T09:14:00Z"  # Discord-side time; drives the freshness gate

# action=open only
entryPrice:   "" | "0.4312"         # "" means market/CMP
stopLoss:     "0.05747" | ""        # "" triggers the -10% fallback consumer-side
takeProfits:  "[]"
slFallback:   "true" | "false"      # true when stopLoss was left empty deliberately
isNewEntry:   "true"                # retained for v1 back-compat

# action=reduce only
reducePct:    "25"                  # 0 < pct <= 100
```

Back-compat rule in `parseStreamEntry`:

```ts
if (fields.v !== "1" && fields.v !== "2") return null;
const action = fields.action ?? (fields.isNewEntry === "true" ? "open" : null);
if (action === null) return null;
```

A v1 entry therefore behaves exactly as it does today. A v1 non-entry is still
dropped.

## Producer design (Python)

`parse_signal()` is replaced by `parse_message()`, returning
`Optional[dict]` with an `action` key. Classification is **ordered; first match
wins**. Order is load-bearing — "Closing ENA early here before the 1H close"
contains the substring "close", which must not be read as a stop-loss level.

| # | Class | Representative triggers | Result |
|---|---|---|---|
| 1 | Noise | `youtube.com`, `youtu.be`, `x.com`, `discord.com/events`, `im live`, `going live`, `premiering` | `None` |
| 2 | Close | `closing <COIN>`, `stopped on <COIN>`, `fully closed`, `out of <COIN>`, `selling 100%` | `action=close` |
| 3 | Reduce | `taking TP\d ... <COIN>`, `TP\d hit ... <COIN>`, `trimming N%`, `selling N% of my position`, `taking a little more off <COIN>`, `profits taken on <COIN>` | `action=reduce` + `reducePct` |
| 4 | Stop→BE | `stops? BE`, `moving stops BE`, `moved stops BE`, `stops? to BE` | `action=stop_be` |
| 5 | Open | existing `_ENTRY_RES` plus `longed`, `jumped in <COIN> long`, `<COIN> long` | `action=open` |
| 6 | Unmatched | — | `None`, logged at INFO with the message prefix |

A resolved `coin` is mandatory for every action. A close/reduce/BE that cannot
resolve a ticker is logged and dropped (per Non-goals).

### Reduce ladder

Explicit percentages always win. When the message states no percentage:

| Phrasing | Percent |
|---|---|
| `TP1` | 25 |
| any other vague trim (`another trim`, `a little more off`, `trimming`, later TPs) | 15 |

### Entry-path defects fixed

1. **Filler word captured as ticker.** `_COIN_RE` takes the first
   `[A-Z]{2,10}` after the keyword, so `"Longing some INJ here at CMP"` resolves
   `coin="SOME"`. Fix: a `_COIN_FILLER` set (`SOME`, `A`, `AN`, `INTO`, `ON`,
   `MY`, `MORE`, `BACK`) skipped during resolution, scanning on to the next
   candidate token. `_COIN_STOPWORDS` remains for rejection; filler words are
   *skipped past*, not rejected outright.
2. **`longed` unsupported.** `"Longed KAITO here at CMP"` and `"Longed ETH
   again guys"` match no entry pattern. Fix: add `\blonged\b` to `_ENTRY_RES`
   and to the `_COIN_RE` keyword alternation.
3. **Skip patterns unconditionally beat entry patterns.** `parse_signal()`
   checks `_SKIP_RES` first and returns immediately. `"Longed ETH again guys
   same setup got stopped BE. 1H close under 1860 for stops, TPs above"` is a
   genuine re-entry killed by `\bstopped\s+(out|BE)\b`. Fix: the ordered
   classifier resolves this structurally — class 5 (Open) is evaluated against
   the full message, and a message carrying both an entry phrase and a stop
   level classifies as an entry. Skip patterns become class-6 fallthrough
   rather than a pre-emptive gate.

### Coin resolution for exits

Exit messages name the coin in varied positions: `closing ENA`, `stopped on
XRP`, `profits taken on ETH`, `Taking TP1 here on SWARMS`, `Our TUT long is up`.
A shared `_resolve_coin(text, keyword_pattern)` helper resolves the ticker by
**adjacency to the matched keyword**, not by scanning the whole message:

1. Start at the end of the keyword match.
2. Skip up to two filler tokens (`_COIN_FILLER`: `SOME`, `A`, `AN`, `INTO`,
   `ON`, `MY`, `MORE`, `BACK`, `HERE`, `OUR`).
3. Accept the next `[A-Za-z]{2,10}` token if it is not in `_COIN_STOPWORDS`.
4. Otherwise return no coin.

Adjacency is what keeps incidental tickers out. In `"Market longing AAVE here
for a scalp at CMP. Looking for a push up off the 15min 200MA, BTC also looks
ready for a bounce"` the keyword is `market longing`, so resolution stops at
`AAVE`; `BTC` is never a candidate because it is not adjacent to any matched
keyword. No context-sensitive BTC rule is needed, and none is specified.

`_COIN_STOPWORDS` additionally gains the non-ticker jargon that can appear
adjacent to a keyword: `TP`, `SL`, `MA`, `VAH`, `SR`, `CMP`, `FOMC`, `CPI`,
`USDT`, `USDTD`, `PA`, `BE`.

## Consumer design (TypeScript)

### Shared prerequisite

`processEntry` currently discards the wallet address:

```ts
({ client } = await createHyperliquidExchangeClient(this.db, user.id));
```

All three exit handlers need it to read live positions. Change to capture both
`client` and `walletAddress`.

### `close`

1. `client.listPositions(walletAddress)` → find `p.coin === coin`.
2. No match → log at INFO, no-op, return. (A close for a coin we never entered
   is normal and must never open a short.)
3. `PerpPosition.size` is **absolute** with a separate `side`;
   `MarketCloseRequest.positionSize` expects a **signed** `szi`. Reconstruct:
   `signedSize = p.side === "long" ? +size : -size`.
4. `client.marketClose({ coin, positionSize: signedSize, markPrice, clientOrderId })`.
   `marketClose` derives the closing side from the sign and sets
   `reduceOnly: true` internally.
5. Cancel any resting TP/SL trigger legs for the coin so they cannot fire
   against a flat book.

### `reduce`

1. Resolve the live position as above; no position → no-op.
2. `size = round(p.size * reducePct / 100, szDecimals)` via
   `client.resolveAsset(coin).szDecimals`.
3. If the rounded size is `0`, or `>= p.size`, clamp: `0` → skip with a log,
   `>= p.size` → treat as a full close.
4. `client.placeOrder({ coin, side: opposite(p.side), size, orderType: "Market", reduceOnly: true, markPrice, clientOrderId })`.

Reduce-only is non-negotiable here: it is the guarantee that a mis-parsed
percentage can shrink a position but never flip it.

### `stop_be`

1. Resolve the live position; no position, or `p.entryPx === null` → no-op.
2. **Guard.** Only proceed when the stop would sit on the profitable side of
   mark: for a long, `markPx > entryPx`; for a short, `markPx < entryPx`.
   Otherwise log and skip. Without this, a BE instruction on an underwater
   position places a stop the wrong side of market and triggers an immediate
   market exit at a loss.
3. Cancel the existing SL trigger leg.
4. `client.setPositionTpSl({ coin, positionSide: p.side, size: p.size, stopLossPx: p.entryPx, isMarket: true, clientOrderId })`.

### Fallback stop loss

When an `open` arrives with `slFallback === "true"` and an empty `stopLoss`, the
consumer computes the stop after resolving the entry price (the `allMids` call
already present in `processEntry`):

```
stopLoss = entryPrice * 0.90     // long; 1.10 for short
```

No additional size reduction is applied. `computeSizeCoin` is
`riskPerTradeUsd / |entry - stopLoss|`, so a wider stop already yields a
proportionally smaller position at constant dollar risk. The resulting trade
risks the same `riskPerTradeUsd` as any other, with a smaller notional.

The `slFallback` flag is persisted on the signal row and included in the Discord
webhook text so a fallback-stopped trade is visually distinguishable.

## Idempotency

The existing deterministic cloid is
`discord-signal:${user.id}:${signal.messageId}`. Extend with the action:

```
discord-signal:${user.id}:${messageId}:${action}
```

Hyperliquid rejects duplicate cloids, which makes replay after a crash safe: a
re-processed `close` is rejected rather than double-executed. A single message
can only ever produce one action, so there is no intra-message collision.

## Error handling

- Exit handlers never throw out of `processEntry`; failures are logged at ERROR
  and the cursor still advances. A retried exit on the next message is not
  desirable — a stale close firing minutes later is worse than a missed one.
- `marketClose` failure logs at ERROR with `POSITION MAY STILL BE OPEN` (mirrors
  the existing `POSITION IS OPEN WITHOUT STOP LOSS` convention).
- Trigger-leg cancellation failure is non-fatal and logged at WARN; a stale
  reduce-only trigger on a flat position is harmless.
- Unresolvable coin, absent position, and guard rejections are INFO, not
  warnings — they are expected steady-state outcomes.

## Testing

The parser's only existing coverage is `scripts/tests/test_discord_signal_bot.py`
(387 lines, 59 cases) in this repo, testing the *duplicate* bot copy by path.
The deployed bot in `nft-relay-group` has no tests.

1. **Move** the suite to the deployed bot's repo, re-pointing its loader at
   `run_prof_discord_rst_copying.py`.
2. **Invert** the ~20 cases that currently assert `None` for closes and TP hits
   (`test_fully_closed`, `test_taking_little_more_off`, `test_full_tp_hit`,
   `test_take_tp1_tut`, `test_tp1_hit_vvv`, `test_tp2_hit_lit`,
   `test_out_of_lit`, `test_tp1_on_pixel_overnight`, `test_ondo_tp1_early`,
   `test_tp1_already_done_on_lit`, `test_tp1_here_on_saga`, and siblings) to
   assert the correct `action` and `reducePct`.
3. **Retain** as `None`: `test_still_long_lit`, `test_still_holding_vvv`,
   `test_market_analysis_usdt_dominance`, `test_youtube_link`,
   `test_live_stream_announcement`, `test_discord_event_link`,
   `test_x_twitter_link_only`.
4. **Add** cases from the 2026-05 → 2026-08 message corpus, one per row of the
   classification table, plus regression cases for each of the three
   entry-path defects and for the ENA message that motivated this work.
5. Consumer-side: unit tests for `parseStreamEntry` v1/v2 back-compat, the
   signed-size reconstruction, the reduce rounding clamps, and the BE guard.

## Deletion

`scripts/discord-signal-bot.py` is a fork of the deployed bot — parsers are
byte-identical, differing only in transport (`discord.py` + bot token vs
`discum` + user token), env var names, and channel IDs. Only the
`nft-relay-group` copy is deployed.

Delete `scripts/discord-signal-bot.py` after the test suite is moved, and update
the stale reference in the poller header comment (line 4, "Consumes a Redis
stream written by scripts/discord-signal-bot.py").

## Risks

1. **No position-state verification at parse time.** The bot trusts the message.
   A "take TP1" on a coin where our fill differed reduces blind. Bounded by
   reduce-only and by percentage clamps, but real.
2. **Regex will miss long-tail phrasing.** Unmatched messages are logged, so
   misses are diagnosable after the fact, but they are silent in the moment.
   Mitigation: review the unmatched-message log after the first week.
3. **Cross-repo coupling.** Producer and consumer live in separate repos with no
   shared schema artifact. The `v` field is the only contract guard. A producer
   deploy that outruns the consumer emits `v: "2"` entries that the old consumer
   drops silently — deploy the consumer first.
