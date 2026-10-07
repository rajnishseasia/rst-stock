"use client";

/**
 * SignaInfoDialog
 *
 * "How it works?" explainer that lives in the Signa Signals panel header.
 * Decodes every piece of jargon a fresh user sees in the panel - score,
 * tier, grade, confidence, model count, regime, the trade plan grid, the
 * Copy-signal behaviour, and what data we actually have access to.
 *
 * Modeled on `copy-trade/copy-trade-info-dialog.tsx`. Uses the existing
 * AlertDialog primitive (the only modal in the design system), with the
 * max-width overridden so the explainer has room to breathe and a
 * scrollable body for short viewports.
 */

import { Info } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function SignaInfoDialog() {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-2xs text-muted-foreground hover:text-foreground"
          aria-label="How Signa Signals work"
        >
          <Info className="h-3.5 w-3.5" />
          How it works
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-[640px] sm:max-w-[640px]">
        <AlertDialogHeader className="sm:items-start sm:text-left">
          <AlertDialogTitle className="text-base font-semibold">
            How Signa Signals work
          </AlertDialogTitle>
        </AlertDialogHeader>

        <div className="max-h-[70vh] overflow-y-auto text-left text-sm leading-relaxed">
          <Section title="What you're looking at">
            <p>
              Each row is a stock that a panel of trading agents at{" "}
              <a
                href="https://getsigna.ai"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                getsigna.ai
              </a>{" "}
              currently rate as a bullish (or bearish) setup. We pull their
              scored signal run once every 4 hours and surface it here. The
              trade plan (Entry / Stop / Target / R:R) is the actionable
              part - the rest is the supporting evidence.
            </p>
          </Section>

          <Section title="The numbers, decoded">
            <DefList>
              <Def term="Score">
                0–100. Signa's composite confidence after combining all the
                models that fired on this ticker. <Pill>≥ 90</Pill> is the
                strongest band, <Pill>80–89</Pill> is solid, below 80 is
                background noise. Sorted descending in the list.
              </Def>
              <Def term="Tier (T1 / T2 / T3)">
                Alert tier from the upstream feed. <Pill>T3</Pill> is the
                strongest - high model agreement <em>and</em> meaningful
                edge. <Pill>T2</Pill> still good, <Pill>T1</Pill> weaker /
                more conditional. Use the Tier filter to focus.
              </Def>
              <Def term="Grade (A / B / C / …)">
                Letter grade from Signa's nightly multi-model pipeline,
                independent of the live scoring. <Pill>A</Pill> = high
                conviction.
              </Def>
              <Def term="Conf (confidence)">
                0–100%. Roughly: <em>how sure</em> the models are about the
                direction, weighted by past hit rate. Different from
                Score (which is the magnitude of the edge).
              </Def>
              <Def term="Models">
                How many independent agents fired on this ticker (each
                running a different strategy - Stage 2, momentum, low-vol,
                Minervini, CANSLIM, Wyckoff, etc.). More models firing
                same-direction is usually a stronger signal.
              </Def>
              <Def term="Regime">
                The model's read of the current market environment.{" "}
                <Pill>BULL</Pill>, <Pill>TRANSITIONAL</Pill>, <Pill>BEAR</Pill>.
                A bullish signal in a transitional regime is weaker than the
                same signal in a confirmed bull regime.
              </Def>
            </DefList>
          </Section>

          <Section title="The trade plan grid">
            <Bullets
              items={[
                <>
                  <b>Entry</b> - Signa's suggested entry price. Usually the
                  current price for live setups, sometimes a stop-buy above
                  resistance.
                </>,
                <>
                  <b>Stop</b> - the protective stop. Where Signa thinks the
                  setup is invalidated. <Pill>Copy signal</Pill> pushes this
                  into your trade form.
                </>,
                <>
                  <b>Target</b> - Signa's suggested take-profit. Often the
                  next major resistance or a measured-move target.
                </>,
                <>
                  <b>R/R</b> - risk-to-reward ratio for the plan. A 2.0R
                  setup means the target is twice as far from entry as the
                  stop.
                </>,
              ]}
            />
            <p className="mt-2 text-muted-foreground">
              The plan is only computed for the top {15} tickers per refresh
              (one extra API call each). Rows without a plan still show in
              the list with grey cells.
            </p>
            <p className="mt-2 text-muted-foreground">
              The direction badge and the trade plan come from two different
              Signa engines, and they sometimes disagree. When the plan points
              the opposite way from the badge (a stop above entry on a bullish
              call, for example) the pick is dropped rather than shown, so
              anything you see here has a plan that matches its direction.
            </p>
          </Section>

          <Section title="What Copy signal does">
            <Bullets
              items={[
                <>Sets the symbol and side (buy if bullish, sell if bearish).</>,
                <>
                  Switches the order type to <b>OCO</b> so a real broker stop
                  and take-profit attach to the order.
                </>,
                <>
                  Pushes <b>Stop</b> into <code>Stop Loss Price</code> and{" "}
                  <b>Target</b> into a one-row <code>Take Profit</code> entry.
                </>,
                <>
                  Anchors the R:R calculator with <b>Entry</b> via{" "}
                  <code>Entry Price</code> and pre-fills the Limit Price so
                  the entry can rest at the signal's suggested level.
                </>,
                <>
                  Quantity is <i>not</i> set - use the trade form's existing
                  Max-$ Risk calculator to size, or set it manually.
                </>,
              ]}
            />
          </Section>

          <Section title="Filters">
            <Bullets
              items={[
                <>
                  <Pill>Direction</Pill> - show only bullish, only bearish,
                  or both.
                </>,
                <>
                  <Pill>Tier</Pill> - multi-select. Default shows all
                  tiers; toggle to <Pill>T3</Pill> only when you want just
                  the strongest setups.
                </>,
                <>
                  <Pill>Min Score</Pill> - number input, default 0. Set to{" "}
                  <Pill>80</Pill> to suppress the long tail and only see
                  the high-conviction rows.
                </>,
              ]}
            />
          </Section>

          <Section title="Best Picks (our synthesized confluence)">
            <p>
              The default <b>Best Picks</b> view is our take on Signa's
              gated confluence board - built from the data our API key can
              read. Server-side we blend four pillars per pick, each scored
              0–100, then equally weighted into the headline{" "}
              <b>Confluence</b> number:
            </p>
            <Bullets
              items={[
                <>
                  <b>Trend</b> - Stage 2 advancing, bullish bias, RSI in the
                  50–75 momentum band.
                </>,
                <>
                  <b>Agents</b> - multi-model composite score with broad-
                  consensus bonus (5+ models gets a lift, 8+ a bigger one).
                </>,
                <>
                  <b>News</b> - catalysts from{" "}
                  <code>/enhanced-signal</code>, weighted heavily for{" "}
                  <Pill>INSIDER_CLUSTER</Pill> Form 4 buying.
                </>,
                <>
                  <b>Plan</b> - has all of entry/stop/target with R:R ≥ 2,
                  and the stop sits on the protective side of entry.
                </>,
              ]}
            />
            <p className="mt-2 text-muted-foreground">
              <b>What qualifies:</b> bullish direction, complete trade plan
              (entry + stop + target all present), and at least 5 models in
              consensus. Picks are sorted by confluence desc, with tier and
              raw score as tiebreaks.
            </p>
            <p className="mt-2 text-muted-foreground">
              <b>What we still don't have:</b> Signa's GEX and options-flow
              pillars stay behind the plan-gated{" "}
              <code>/api/v1/confluence/best-picks</code> endpoint. We get 4
              of their 6 pillars; upgrading the API key tier would unlock
              the other two.
            </p>
          </Section>

          <Section title="Freshness">
            <p>
              We cache the snapshot for <b>1 hour</b>, the same shared
              snapshot for every user. The chip in the header (&quot;pulled
              12m ago · signals 3h ago&quot;) shows both numbers that matter:
              when we last pulled from Signa, and how old Signa&apos;s own
              scoring run was when we did. The second one is usually the
              larger of the two.
            </p>
            <p className="mt-2">
              There is no manual refresh button. The one that used to live
              here did not actually bypass the cache, so it showed you the
              same snapshot while implying it had fetched a new one.
            </p>
          </Section>
        </div>

        <AlertDialogFooter>
          <AlertDialogAction>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ─── small inline helpers ──────────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border first:border-t-0 px-1 py-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2 text-foreground">{children}</div>
    </section>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-md border border-border bg-muted px-1.5 text-2xs font-medium text-foreground">
      {children}
    </span>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="ml-4 list-disc space-y-1.5 text-muted-foreground marker:text-muted-foreground/60">
      {items.map((item, idx) => (
        <li key={idx} className="text-foreground/90">
          {item}
        </li>
      ))}
    </ul>
  );
}

function DefList({ children }: { children: React.ReactNode }) {
  return <dl className="space-y-2">{children}</dl>;
}

function Def({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-foreground">{term}</dt>
      <dd className="text-xs leading-snug text-muted-foreground">{children}</dd>
    </div>
  );
}
