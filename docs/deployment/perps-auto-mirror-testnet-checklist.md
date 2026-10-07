# Perps auto-mirror: what a human must confirm on testnet

Copy-trade auto-mirroring of PERP calls is built and hardened but **not enabled**,
and must not be enabled on mainnet until every item below has been confirmed by a
person against a live Hyperliquid testnet account.

Everything the automated tests prove is unit-level. No test in this repo talks to a
real Hyperliquid endpoint, so none of the items here are covered by CI passing.

## Before you start

Set on the worker:

```
COPY_TRADE_AUTOMIRROR_ENABLED=true
COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true
HYPERLIQUID_NETWORK=testnet
HYPERLIQUID_ALLOW_TESTNET=true
```

Do NOT set `HYPERLIQUID_SYNC_ENABLED`. The Hyperliquid reconciler runs by
default and there is nothing to turn on. It is read-only, and it is the only
process that records perp fill sizes and resolves PENDING perp orders against the
venue, so perp mirroring refuses to run while it is off. Setting that variable to
`false` is an incident-response kill switch and will stop perp mirroring too.

Leave `COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET` unset. For the test follower,
keep the saved global automatic-perps maximum at 1x and leave the optional
per-follow maximum inherited until the list below passes; those settings belong
to the follower, not the deployment.

## Do not switch HYPERLIQUID_NETWORK while perp orders are open

Orders do not record which Hyperliquid network they were placed on, and the
reconciler queries whichever network is configured now. So moving a deployment
from testnet to mainnet (or back) while any perp order is still PENDING,
SUBMITTED or PARTIAL makes those orders look, to the reconciler, exactly like
orders that never reached the venue: no fills, nothing resting. Past the 45
second guard it settles them as CANCELLED, and exposure that is still live on the
other network stops being tracked.

Before changing the network:

1. Confirm no perp orders are open: `status IN ('PENDING','SUBMITTED','PARTIAL')`
   with `venue = 'hyperliquid'`.
2. Close or reconcile any that are, on the network they were placed on.
3. Only then change the setting.

The durable fix is to persist the venue network on each order and reconcile
against that, which is a schema change tracked with the exposure-record work in
the PR review threads. Until then this is an operational rule, not something the
code enforces.

## The open question that blocks mainnet

**Does the main-dex cross-margin summary actually back a HIP-3 order?**

Sizing reads `perpAccountSnapshot().crossMargin`, which is the MAIN dex's
`crossMarginSummary`. For a HIP-3 market (a dex-prefixed coin such as
`xyz:GOOGL`, which is what paste.trade stock-backed perps are), we rely on that
figure being the pooled collateral. That holds only if a shared-collateral mode
really does pool it, which this repo cannot prove: it is venue behaviour.

The mirror already refuses any HIP-3 coin unless the account is in
`unifiedAccount`, `portfolioMargin` or `dexAbstraction`, so the assumption is at
least scoped. Confirm it anyway:

1. Put a testnet account into a shared-collateral mode and fund the main dex only.
2. Read `clearinghouseState` and note `crossMarginSummary.accountValue` and
   `totalMarginUsed`.
3. Place a HIP-3 order by hand sized to just under that free figure. It should fill.
4. Place one sized just over it. It should be rejected for margin.

If step 3 fails, sizing is reading the wrong pool for HIP-3 and must be reworked
before mainnet.

## Per-guard confirmation

Each of these is a guard that unit tests cover in isolation and nobody has watched
work end to end.

- [ ] **Coin validation.** A signal whose `hl_ticker` is missing or non-canonical is
      skipped, not mirrored on a guessed coin. Check for `unusable-perp-coin` in the log.
- [ ] **Instrument confirmation.** A row with `platform: hyperliquid` and
      `instrument: spot` is skipped (`unconfirmed-perp-instrument`), not sent as a
      leveraged perp.
- [ ] **Free-collateral sizing.** With most of the account's collateral already
      posted, a mirror sizes against what is FREE, not total, and the margin gate
      refuses rather than pushing the account toward liquidation.
- [ ] **Leverage clamp.** A source call at 20x with the follower's global maximum
      at 1x places at 1x. Confirm the order on the venue, not just the local row.
- [ ] **Existing position.** A mirror that would flip or reduce a position the
      follower opened by hand is refused, and the follower's leverage is not rewritten.
- [ ] **Resume parity.** Interrupt a placement so the row is left PENDING, lower
      the follower's saved global or per-follow maximum, then let it retry. The
      retry must re-clamp to the new user ceiling and re-check the dollar cap, or
      refuse.
- [ ] **Duplicate cloid.** Force a re-place of an order that already filled. The
      local row must never end as REJECTED over a live position. This is the one
      trigger the audit could not determine from code; watch what the venue does.
- [ ] **Close preservation.** Turn auto-mirror off after a position is open, then
      have the source close. The close must still place. Separately, make the open
      fail and confirm its close is not consumed against nothing.
- [ ] **Reconciler kill switch.** Set `HYPERLIQUID_SYNC_ENABLED=false` and confirm two
      things: the worker logs the reconciler as disabled at WARN, and perp mirroring
      refuses to run rather than placing orders it cannot reconcile. Then unset it.

## The exit gap, and what now covers part of it

**A signal-sourced perp mirror still generates no close of its own.** A perp call
from paste.trade or X opens a leveraged position, and only a mirrored SOURCE close
produces a reduce-only exit. A signal has no source that ever closes, so nothing on
the mirroring path will close that position.

**What a follower can now do about it:** set a take-profit and a stop-loss on the
follow, as a percentage of the MARGIN behind the position (return on equity), not
as a price move. The worker converts those to absolute trigger prices at mirror
time, from the entry price and the leverage the venue actually applied, and attaches
them with `setPositionTpSl` (`grouping: "positionTpsl"`) right after the open lands.
Both columns are null by default, and a follow with neither set behaves exactly as
it did before: no extra venue call, no extra row write.

Two rules that must hold and are worth watching for on testnet:

- **A failed attach never closes the position.** After three attempts the position
  is left open, `orders.perp_protection_status` is set to `unprotected`, and the
  worker logs at ERROR plus a once-a-cycle backlog line. Auto-closing on an API
  failure would be a loss the follower did not ask for.
- **The source's own close wins.** When a mirrored source close is placed, the
  mirror's own legs are cancelled, matched by client order id so a stop the
  follower placed by hand on the same coin is untouched.

Do not describe a mirrored perp as having an exit unless the follow it came from
actually carries one. The UI states both cases explicitly and is driven by the
follow's own columns; see `perpMirrorDisclosures` in
`apps/web-v2/src/components/copy-trade/perp-mirror-disclosure.tsx`.

Add to the per-guard confirmations above:

- [ ] **Exit attach.** With a stop configured, open a mirror and confirm two
      reduce-only trigger legs rest on the venue at the derived prices, and that
      the derived prices match the configured percentage of margin at the leverage
      the position actually got (not at the leverage requested).
- [ ] **Exit attach failure.** Make `setPositionTpSl` fail (block it at the network
      level) and confirm the position stays OPEN, the order row reads
      `perp_protection_status = 'unprotected'`, and the backlog line appears.
- [ ] **Exit retirement.** Have the source close a position that carries legs, and
      confirm the legs are gone from the venue afterwards while a hand-placed stop
      on the same coin is still resting.
