# Copy-trade audits, August 2026

Four adversarial audits of the copy-trade feature, and the record of what they found.
Roughly 160 raw findings were raised; about half were fixed and about half were
dismissed with reasons. The work landed on `fix/copy-trade-auto-mirror-hardening`.

| Report | Scope |
|---|---|
| [2026-08-auto-mirror.md](./2026-08-auto-mirror.md) | The auto-mirror path end to end: discovery, delivery staging, consent and staleness gates, sizing, execution, reconciliation, and the arming UI. |
| [2026-08-cross-venue.md](./2026-08-cross-venue.md) | The seam where perp copy trading and stock copy trading touch. |
| [2026-08-alpaca.md](./2026-08-alpaca.md) | The Alpaca half, checked against Alpaca's own API documentation. |
| [2026-08-hyperliquid-perps.md](./2026-08-hyperliquid-perps.md) | The Hyperliquid half, checked against Hyperliquid and trade.xyz documentation. |
| [2026-08-dismissals.md](./2026-08-dismissals.md) | Findings that were raised and then dismissed, with the reasoning. |

## Method

Findings were produced by parallel readers working from different lenses, then
adjudicated. Critical and high findings each went to two or three independent verifiers
whose instruction was to REFUTE them, with one verifier specifically tasked with checking
the vendor claim against the live API docs. Medium and low findings went to a single
adjudicator that judged "is it still live" and "is it worth fixing" separately.

Every fix was written test first, with a revert proof: the name of a test that fails when
the fix is removed.

Everything was assessed as if the deployment were fully enabled with real money, with
`COPY_TRADE_AUTOMIRROR_ENABLED`, `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE`, `PERPS_ENABLED`,
`COPY_TRADE_AUTOMIRROR_PERPS_ENABLED` and `PERPS_ALLOW_MAINNET` all true.

## The two things most worth knowing

**Most defects were the same defect.** The dominant class was an exit that never got
placed: a one-shot close consumed by a cap, a retry ceiling, a credential rotation, a
reconciler race or a terminal status, while the log reported success. Roughly a dozen
separate findings were instances of it. The discovery checkpoint advances in the same
transaction that stages a delivery, and both delivery writers are terminal, so any early
return retires the intent permanently. That shape is worth holding in mind before adding
anything to this path: on a close, the safe move is almost always to requeue or defer,
never to swallow.

**The HIP-3 collateral question is answered.** `perps-auto-mirror-testnet-checklist.md`
called it "the open question that blocks mainnet": does the main dex cross-margin summary
actually back a HIP-3 order? The pooling is real under unified account and portfolio
margin, so the account-mode gate was right. But `crossMarginSummary` is the wrong place to
read it: Hyperliquid says on that endpoint's own page to use the spot balances endpoint
under those modes, and that individual perp dex user states are not meaningful. Measured
live on mainnet, the old read returned about -1,146,830 of free collateral on an account
holding about +2,010,430. See the perps report and the commit that fixed it.

## What these audits could not establish

- No test here talks to a real broker or venue. The one exception is the HIP-3 collateral
  measurement above, which was a live mainnet read.
- There is still no runtime record proving the equity mirror has ever placed an order in
  production. `docs/deployment/copy-mirror-env-reference.md` carries the queries that
  answer it against the live database.
- Signal-sourced perp mirrors have no exit. Known, documented at
  `apps/worker/src/services/copy-mirror-perp-execution.ts`, deliberately out of scope, and
  still the highest-value work outstanding on this feature.

## If you are about to audit this feature again

Read [2026-08-dismissals.md](./2026-08-dismissals.md) first. It exists so you do not spend
your budget re-deriving conclusions someone already reached. A dismissal is not a proof;
it is a written argument, and the right response to disagreeing with one is to argue with
the reasoning rather than to file the finding again as if it were new.
