"use client";

import type * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One offer inside an empty state. Exactly one action should be `primary`:
 * the empty state's whole job is to name the single next thing to do.
 *
 * Either `onClick` (in-app navigation the parent owns) or `href` (a real
 * route). `href` renders a Link so it is middle-clickable and crawlable.
 */
export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Typed route, so a renamed page fails the build instead of the click. */
  href?: React.ComponentProps<typeof Link>["href"];
  emphasis?: "primary" | "secondary";
}

/**
 * A dead end that names the next action.
 *
 * We are signal-first: the aggregated feed is the product, so the PRIMARY
 * action out of an empty portfolio, watchlist or positions list is "go read
 * signals", never "go fund an account". Funding is a secondary offer for the
 * user who has already decided what to trade.
 *
 * Actions are 44px tall on touch and collapse to the terminal's compact
 * 28px button from `sm` up, matching the mobile shell's target minimum.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  actions = [],
  fill = false,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  body?: string;
  actions?: EmptyStateAction[];
  /**
   * Grow into a flex-column parent's free space and center vertically, so a
   * short screen's slack is split above and below instead of piling up in
   * one block underneath. Opt-in: in a block parent it does nothing, and a
   * bounded desktop pane that wants a top-aligned state should not pass it.
   */
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-10 text-center",
        fill && "flex-1 justify-center",
        className,
      )}
    >
      {Icon && <Icon className="h-8 w-8 opacity-20" aria-hidden="true" />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body && (
        <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
      )}
      {actions.length > 0 && (
        <div className="mt-1 flex w-full max-w-xs flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          {actions.map((action) => {
            const variant =
              action.emphasis === "secondary" ? "outline" : "default";
            const className =
              "min-h-11 w-full px-3 sm:min-h-0 sm:w-auto sm:px-2";
            if (action.href) {
              return (
                <Button
                  key={action.label}
                  asChild
                  variant={variant}
                  className={className}
                >
                  <Link href={action.href}>{action.label}</Link>
                </Button>
              );
            }
            return (
              <Button
                key={action.label}
                type="button"
                variant={variant}
                onClick={action.onClick}
                className={className}
              >
                {action.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
