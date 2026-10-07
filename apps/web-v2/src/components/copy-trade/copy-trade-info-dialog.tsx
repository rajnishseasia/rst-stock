"use client";

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
import { Button } from "@/components/ui/button";
import { PERP_MIRROR_DISCLOSURES } from "./perp-mirror-disclosure";
import { ARMING_STOP_CAVEAT } from "./mirror-consent";

const GENERAL_PERP_EXIT_DISCLOSURE = {
  title: "Per-follow exits are optional.",
  body:
    "You can configure a take-profit and/or stop-loss for each perp follow, but they are not guaranteed to attach or execute. Source signals do not inherently provide exits; without an effective exit, a position can remain open and can be liquidated.",
};

const GENERAL_PERP_MIRROR_DISCLOSURES = PERP_MIRROR_DISCLOSURES.map(
  (item, index) =>
    // The shared list's third item is the follow-specific exit disclosure;
    // this general dialog cannot know which exits a follow has configured.
    index === 2 ? GENERAL_PERP_EXIT_DISCLOSURE : item,
);

/** Explains the distinct Copy, Follow, and Mirror workflows in user terms. */
export function CopyTradeInfoDialog() {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 gap-1.5 text-xs xl:h-7"
          aria-label="How Copy Trade works"
        >
          <Info className="h-3.5 w-3.5" />
          How it works
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-[640px] sm:max-w-[640px]">
        <CopyTradeInfoContent />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The dialog's body, extracted from `CopyTradeInfoDialog` so it is directly
 * renderable (and its text directly assertable) without the `AlertDialog`
 * wrapper. `react-dom/server` cannot render through a Radix Portal (an
 * `AlertDialogContent` mounts one), and an uncontrolled `AlertDialog` starts
 * closed, so `renderToStaticMarkup(<CopyTradeInfoDialog />)` never reaches
 * this text at all - only the trigger button. Rendering this component
 * directly sidesteps both problems.
 */
export function CopyTradeInfoContent() {
  return (
    <>
      <AlertDialogHeader className="sm:items-start sm:text-left">
        <AlertDialogTitle className="text-base font-semibold">
          Copy, Follow, and Mirror
        </AlertDialogTitle>
      </AlertDialogHeader>

      <div className="max-h-[70vh] overflow-y-auto text-left text-sm leading-relaxed">
        <Section title="Choose the level of automation">
          <Numbered
            n={1}
            title="Copy - review every order"
            body={
              <>
                <b>Copy</b> prefills the Trade module with the detected
                symbol, side, and size. You review the ticket and submit it;
                Copy never sends an order automatically.
              </>
            }
          />
          <Numbered
            n={2}
            title="Follow - curate your feed"
            body={
              <>
                <b>Follow</b> adds a trader or caller to your Following
                feed. Following alone never places an order.
              </>
            }
          />
          <Numbered
            n={3}
            title="Mirror - automate a follow"
            body={
              <>
                Turn <b>Mirror</b> on for a followed trader to have
                matching trades placed automatically on your behalf.
                Mirroring is off by default and only runs when enabled for
                this deployment.
              </>
            }
          />
        </Section>

        <Section title="Sizing and account targeting">
          <Bullets
            items={[
              <>
                The sizing controls in the main Copy feed apply to{" "}
                <b>manual Copy only</b>.
              </>,
              <>
                Every Mirror keeps its own size rule and exact saved Alpaca
                account. Change either one in <b>Manage follows</b>.
              </>,
              <>
                The destination label beside a mirrored row identifies the
                saved account and venue that will receive eligible orders:
                Alpaca <Pill>Paper</Pill>/<Pill>Live</Pill> for stocks or
                Hyperliquid perps for perpetuals.
              </>,
              <>
                Changing the terminal&apos;s Paper/Live mode does not retarget
                an existing Mirror. Update that follow in Manage follows.
              </>,
            ]}
          />
        </Section>

        <Section title="What can be mirrored">
          <Bullets
            items={[
              <>
                User rows show orders placed by other Ready Set Trade users.
                Caller rows show published <b>signals</b>. Neither is a
                confirmed fill: an order may still be open or later canceled.
              </>,
              <>
                <b>Stocks are long-only.</b> Manual Copy only pre-fills stock
                buys, and stock auto-mirror sells only to close shares you
                already hold; it never opens a stock short. Confirmed
                Hyperliquid perp opens can be long or short: Manual Copy can
                prefill either direction, and auto-mirror can open either
                direction and mirror source closes.
              </>,
              <>
                Stocks and <b>single-leg options</b> are supported. Options
                must have a clear <b>Buy to Open</b> or{" "}
                <b>Sell to Close</b> action to be mirrored.
              </>,
              <>
                Incomplete trades and multi-leg options are skipped.
              </>,
              <>
                Perp signals are not stock orders.{" "}
                <b>A perp trade is never converted into an Alpaca equity order.</b>
              </>,
              <>
                <b>User and caller follows</b> can mirror. Politician
                mirroring is not available yet.
              </>,
            ]}
          />
        </Section>

        <Section title="Safety controls">
          <Bullets
            items={[
              <>
                A Mirror requires a saved destination account. Stock mirrors
                use an Alpaca <Pill>Paper</Pill> or <Pill>Live</Pill> account;
                perp mirrors use a Hyperliquid account.
              </>,
              <>
                Per-order and daily limits are enforced automatically.
                Duplicate signals are filtered so the same trade is never
                placed twice.
              </>,
              <>
                For stock mirrors, sell quantities are capped to what you
                already hold, so a stock Mirror cannot create a short position.
              </>,
              <>
                Review each follow&apos;s account, sizing, and limits in{" "}
                <b>Manage follows</b> before enabling Mirror.
              </>,
              <>
                {/*
                  Read from the same constant the arming confirmation shows,
                  so the two can never end up telling different stories about
                  what stopping does.
                */}
                <b>Stopping is not an exit.</b> {ARMING_STOP_CAVEAT}
              </>,
            ]}
          />
        </Section>

        {/*
          The sections above describe the Alpaca equity path. A follow pointed
          at Hyperliquid is a different instrument with a different downside,
          and none of it was stated anywhere in this UI.
        */}
        <Section title="Mirroring to Hyperliquid (perps)">
          <Bullets
            items={GENERAL_PERP_MIRROR_DISCLOSURES.map((item) => (
              <>
                <b>{item.title}</b> {item.body}
              </>
            ))}
          />
        </Section>

        <Section title="Performance and privacy">
          <p>
            Leaderboard returns and hit rates are estimates built from
            observed activity and available market data, not audited
            performance. User identities are shown under deterministic
            pseudonyms rather than exposing raw account IDs.
          </p>
        </Section>
      </div>

      <AlertDialogFooter>
        <AlertDialogAction>Got it</AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border px-1 py-3 first:border-t-0">
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

function Numbered({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-xs font-bold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
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
