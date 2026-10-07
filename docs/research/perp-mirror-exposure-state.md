# Perp mirror: where the exposure state should live

Design note, not a plan of record. Written from the review of PR #176, where
eight separate P1 findings turned out to be the same missing thing. It sets out
what is missing, two ways to fix it, and what neither way fixes.

## The problem in one sentence

Nothing records how much mirrored perp exposure a follower currently has, so
every code path that needs to know re-derives it by scanning `orders` and netting
the rows, and each derivation gets a slightly different answer.

`orders` is an event log: one row per order we placed, what we asked for and what
came back. That is the right shape for an audit trail and the wrong shape for a
question asked on a hot path. "How much does this follower still hold in BTC,
which wallet is it on, and how much of it is ours" is state, and state that is
recomputed in six places will disagree in six ways.

## What that cost, concretely

Every one of these was a separate P1 on the PR, and every one is a different
consumer of the same absent number.

| Consumer | What it re-derived | How it went wrong |
|---|---|---|
| Close discovery | which follows have exposure | keys off the follow row, so disabling auto-mirror or unfollowing loses the exit entirely |
| Close routing | which wallet holds the position | four consecutive corrections: failed attempts counted, flattened accounts counted, float residue, address casing |
| Close sizing | how much the mirror opened | partial IOC fills strand a remainder; manual exits never subtract |
| Fill accounting | cumulative executed size | `userFills` is a recent window, so a suffix read as cumulative shrank the record |
| History scans | source and follower order history | 5,000-row caps that never drain, so a busy account wedges permanently |
| Reconciliation | which venue an order lives on | orders do not record the network, so switching it cancels live orders |
| Event classification | was this source fill an open or a close | `reduceOnly` is a user-toggled checkbox defaulting to false, so a source close reads as an open |
| Daily cap | mirrors placed today | counts by row creation, so a resume across midnight is counted on neither day |

The classification row is the worst of them. The others fail to exit a position.
That one can put a follower into a position the source never took, and it is the
reason any fix has to cover the SOURCE side and not only the follower side.

## Option A: keep it on `orders`

Add the missing columns to `orders`, and derive the state exactly once behind a
single accessor that every path calls.

Columns that do not exist today and are the direct cause of a finding above:

- `venue_network` (mainnet / testnet), so reconciliation queries the right chain
- `last_counted_fill_id`, a real cursor instead of inferring cumulative size from
  a recent-fill window
- `placed_at`, distinct from `created_at`, so the daily cap counts placements

Then one function, something like `loadMirroredExposure(follower, coin)`,
returning remaining size, the wallet and credential holding it, and whether the
answer is knowable at all. Every current reconstruction site calls that instead
of writing its own scan.

**For:** no new table, no dual-write, no risk of the two stores disagreeing. The
audit trail stays the single source. Smallest diff.

**Against:** it is still a derivation, so it stays O(order history) and keeps the
scan caps that already wedge. It cannot express an invariant like "this number
only ever decreases", because there is no number, only a fold over rows.

## Option B: a real exposure record

A row per mirrored position: follower, source trader, coin, credential, wallet
address, network, remaining size, last counted fill, and the source position size
at open. Written when the mirror opens, decremented as fills and closes reconcile,
closed out at zero.

**For:** the questions become lookups rather than scans, so the caps and their
wedges disappear. Invariants can be enforced at the write (monotonic decrease,
refuse on unknown) rather than re-argued at each reader. Source-side state has
somewhere to live, which Option A has no natural home for.

**Against:** a second store that can drift from `orders`, a migration, and a
write path that has to be correct on every partial-fill and reconciliation edge.
Drift between an event log and a state table is its own class of bug, and this
system has already shown it can produce those.

## Recommendation

Option A first, Option B only if it is still needed afterwards.

Three of the eight findings (network, fill cursor, placement time) are plain
missing columns and are fixed by Option A alone. Routing and sizing become
correct-by-construction once there is exactly one derivation instead of six, even
if that derivation is still a scan. That leaves the scan caps, which are a
performance and wedge concern rather than a correctness one, and which can be
addressed by paging back to the last flat point without a new table.

The argument for B is real but it is an argument about scale and invariants, and
neither is urgent while the feature is off. Doing A first also makes B cheaper if
it comes: the single accessor is exactly the seam a ledger would slot behind.

## Backfill

None required. Perps auto-mirror has never been enabled in production, so there
are no live mirrored positions to migrate. Whichever option is taken, it starts
empty. This will not be true later, which is an argument for doing it before the
feature is switched on rather than after.

## A consequence worth naming: leverage the row cannot vouch for

A resumed open can end up recording a leverage the venue never applied. The
update is rejected while the position it applies to is missing from the
snapshot, and the clamp has already been written to the row.

Correcting it from the live position was tried and backed out, because a live
position cannot be attributed to the order. Fungibility again: a PENDING row has
no broker order id, so the position may be the follower's own manual one, and
adopting its leverage makes the guard's conflict disappear on the next resume.
The mirror then places onto that manual position at a leverage nobody chose,
which is a money error in place of a reporting one.

So the refusal stands and the row stays wrong. What is missing is the ability to
say "unknown" rather than a number, which is the same shape as everything else
here: a fold over rows has nowhere to record that a value is unproven, and a
state record does.

## What neither option fixes

A perp position is fungible and nets at the venue. One position per coin per
account, no tags.

- Follower opens 0.2 BTC themselves
- Mirror opens 0.3 BTC copying the source
- The chain reports one number: long 0.5

When the source closes, we have to reduce "our" 0.3, and nothing on chain
distinguishes it. Our own fills carry our cloid, so we can sum what we filled,
but if the follower then closes all 0.5 by hand our sum still reads 0.3 while
they hold nothing. There was never a separable share to track.

So attribution is a bookkeeping convention we maintain, not a fact available
anywhere. Any correct design treats the recorded share as an upper bound that
only decreases, and refuses to act when it cannot be established. That is a
genuine improvement over guessing, and it is not a proof. It should not be
described as one in the UI or to followers.
