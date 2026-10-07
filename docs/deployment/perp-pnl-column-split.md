# Deploying the realized-PnL column split

Maintainer instructions for migrations `0027` and `0028` and the worker change
that goes with them. There is a **required follow-up** at the end; this is not
finished when the PR merges.

## What changed

`orders.funding_paid` was named for funding but only ever received Hyperliquid's
`closedPnl`, which is realized trading profit and loss on a closing fill. A
profitable close recorded its whole gain under a column named for a cost.

`orders.realized_pnl` (migration `0027`) is where that value belongs. Real
funding has never been recorded anywhere; it would need the `userFunding`
stream, which fills do not carry.

## Why both columns are still written

Migrations run in the Railway worker's `preDeployCommand` (configured in the
Railway service settings), and the API deploys separately on Vercel. The pre-deploy applies
the journal before the new worker starts, so there is still a window in which the
new schema is live and a worker running the **previous revision** is finishing
its in-flight reconciliation.

That old worker uses `funding_paid` as its **accumulation base**. If anything
empties it during the window:

1. its next fill writes back only that fill's suffix, not the running total, and
2. any reader preferring the legacy column adopts the suffix as the whole.

The total is then permanently reduced, and unrecoverably so, because the shared
fill cursor has already moved past those fills.

So `0027` copies without clearing, and the new worker keeps the two columns
identical: the transition writes the same cumulative to both, and a sweep at the
top of each poll copies into `realized_pnl` wherever they disagree. Correct
whichever revision touches a row next.

`orders_hl_legacy_pnl_idx` (migration `0028`) is a partial index over exactly the
rows where they still disagree, so the sweep costs one empty index scan once they
converge.

## Deploy order

**Normal deploys need nothing to run by hand.** The Railway worker service's `preDeployCommand`
(stored in Railway's settings, not this repo) validates the journal, applies it to Supabase, and
verifies the worker schema contract before the new worker container starts. If
any of the three fails, Railway aborts the deploy and the previous worker keeps
running.

Note the ordering consequence: the API deploys on Vercel without a schema guard,
and the Vercel build does not apply migrations. A production API deploy can land
**before** Railway has applied a migration that the new API code depends on, so
deploy the worker first whenever a change spans both.

Two things that guard does NOT cover, and they are why this page exists:

- **Vercel preview and production builds skip migrations.** A green preview
  says nothing about schema, and a green API deployment does not prove the
  worker's required migration has run.
- **The worker deploys separately on Railway**, and it must be deployed first.
  Its pre-deploy sequence validates the journal, applies the forward migration,
  and verifies the worker schema before the new process starts. Watch all three
  markers in the Railway logs before treating the worker as healthy.

This is a property of the deploy topology rather than of this change, and it
applies to every migration in the repo. It is written down here because the
PnL columns' "either order is safe" is about the DATA, not the schema, and the
two are easy to conflate.

Manual application is the emergency escape hatch, not the normal plan. Run the
journal yourself against the **direct** Supabase URL, never the pooler, only
when the Railway deployment is blocked and the maintainer has confirmed the
release ordering.

```bash
bun run db:validate
```

```bash
bun run db:migrate:production
```

```bash
bun run db:verify-worker-schema
```

Then confirm `orders.realized_pnl` and `orders_hl_legacy_pnl_idx` exist.

## Required follow-up

Once no worker on the old revision can still be running (one full deploy cycle
past this one, with Railway showing a single active revision), retire the
scaffolding in one change:

- [ ] Drop the dual-write in `hyperliquid-order-sync.ts`: the transition should
      write `realized_pnl` only.
- [ ] Drop the `order.fundingPaid ?? order.realizedPnl` fallback in the same
      file's reconcile view.
- [ ] Delete `absorbLegacyRealizedPnl()` and its call at the top of `poll()`.
- [ ] Drop `orders_hl_legacy_pnl_idx`.
- [ ] `UPDATE orders SET funding_paid = NULL WHERE funding_paid IS NOT NULL;`
      once, in that migration, after confirming `realized_pnl` matches it
      everywhere.

Verify before the last step:

```sql
SELECT count(*) FROM orders
WHERE venue = 'hyperliquid'
  AND funding_paid IS NOT NULL
  AND realized_pnl IS DISTINCT FROM funding_paid;
```

That must be `0`. If it is not, a worker is still writing the legacy column and
the follow-up is early.

## Do not

- Do not null `funding_paid` in any migration or worker change before the
  follow-up above. That is the trap this whole arrangement exists to avoid, and
  it has been reached for twice already.
- Do not run migrations through the pooled URL. `db:migrate` refuses, but the
  refusal is the guard, not the plan.
