"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { LoaderCircle, UserCheck, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOUCH_HEIGHT_COMPACT } from "@/components/ui/touch-target";
import { toast } from "sonner";
import { StopMirrorDialog } from "./mirror-consent-dialogs";
import {
  buildStopSummary,
  followArmedState,
  unfollowNeedsConfirmation,
  UNFOLLOW_TOAST,
  type FollowArmedState,
} from "./mirror-consent";

type FollowTargetType = "x_author" | "user" | "politician";

/** The NON-PII follow handle carried on every feed item (CopyTradeItem.followTarget)...... */
export interface FollowTarget {
  type: FollowTargetType;
  key: string;
  label: string;
}

export type FollowFeedbackAction = "follow" | "unfollow" | null;

/** Picks feedback from the action that completed most recently. */
export function selectFollowSuccessMessage(
  action: FollowFeedbackAction,
  targetLabel: string,
  followSucceeded: boolean,
  unfollowSucceeded: boolean,
): string | null {
  if (action === "unfollow" && unfollowSucceeded) {
    return `Stopped following ${targetLabel}`;
  }
  if (action === "follow" && followSucceeded) {
    return `Following ${targetLabel}`;
  }
  return null;
}

/**
 * The button and, when the unfollow needs confirming, the shared stop dialog.
 *
 * Hook-free on purpose, in the same way `AutoMirrorSwitch` and `FollowRow` are:
 * this is the piece the tests call directly so they can invoke the handler the
 * component really wired, instead of reading the source back. The property it
 * pins is that clicking "Following" on an armed follow cannot reach
 * `onUnfollow` at all - it can only raise the confirmation, and the dialog's
 * own control is what deletes the follow.
 */
export function FollowButtonView({
  target,
  isFollowing,
  armed,
  pending = false,
  errorMessage = null,
  successMessage = null,
  confirmingUnfollow,
  onConfirmingUnfollowChange,
  onFollow,
  onUnfollow,
}: {
  target: FollowTarget;
  isFollowing: boolean;
  /** Whether this follow has auto-mirror armed, or "unknown" when unproven. */
  armed: FollowArmedState;
  pending?: boolean;
  errorMessage?: string | null;
  successMessage?: string | null;
  confirmingUnfollow: boolean;
  onConfirmingUnfollowChange: (open: boolean) => void;
  onFollow: () => void;
  onUnfollow: () => void;
}) {
  const onClick = () => {
    if (!isFollowing) {
      onFollow();
      return;
    }
    // Unfollow is a hard DELETE that takes the sizing rule and the mirror
    // account with it. When there is automation behind it, or when we cannot
    // prove there isn't, it goes through the same confirmation Manage follows
    // uses rather than firing off a tap.
    if (unfollowNeedsConfirmation(armed)) {
      onConfirmingUnfollowChange(true);
      return;
    }
    onUnfollow();
  };

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant={isFollowing ? "default" : "outline"}
        disabled={pending}
        onClick={onClick}
        aria-pressed={isFollowing}
        aria-busy={pending}
        className={cn(
          // Follow is the leaderboard's primary action and sits between two
          // tappable links in a dense row, so it gets the mobile shell's 44px
          // minimum and drops back to the compact 28px pill from sm up.
          TOUCH_HEIGHT_COMPACT,
          "shrink-0 gap-1 px-3 text-xs sm:px-2",
          isFollowing && "bg-primary/90",
        )}
        title={
          isFollowing ? `Unfollow ${target.label}` : `Follow ${target.label}`
        }
      >
        {pending ? (
          <>
            <LoaderCircle
              className="h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
            Updating
          </>
        ) : isFollowing ? (
          <>
            <UserCheck className="h-3.5 w-3.5" />
            Following
          </>
        ) : (
          <>
            <UserPlus className="h-3.5 w-3.5" />
            Follow
          </>
        )}
      </Button>
      {pending && (
        <span
          className="text-3xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          Updating follow
        </span>
      )}
      {!pending && errorMessage && (
        <span
          className="max-w-full break-words text-3xs text-destructive"
          role="alert"
        >
          {errorMessage}
        </span>
      )}
      {!pending && !errorMessage && successMessage && (
        <span
          className="max-w-full break-words text-3xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {successMessage}
        </span>
      )}

      {/*
        Mounted only while it is open, because this button is rendered once per
        feed and leaderboard row. The dialog portals itself, so a dense row or an
        `overflow-hidden` ancestor cannot clip it.
      */}
      {confirmingUnfollow && (
        <StopMirrorDialog
          open
          onOpenChange={(open) => {
            if (!open) onConfirmingUnfollowChange(false);
          }}
          summary={buildStopSummary({ kind: "unfollow", trader: target.label })}
          pending={pending}
          onConfirm={() => {
            onConfirmingUnfollowChange(false);
            onUnfollow();
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-row Follow / Following control. Reflects followed state (filled vs
 * outline) from the passed-in follow set, and calls
 * copyTradeFollows.follow / .unfollow with the item's followTarget. Both
 * mutations invalidate the follows list so every row + the Following view
 * re-derive their state.
 *
 * Armed-ness is read from the `copyTradeFollows.list` cache at click time, not
 * from a new query: every surface that mounts this button already runs that
 * exact query (the panel, `useFollowedKeys`, the caller profile page) to decide
 * `isFollowing` in the first place, so the row is in the cache whenever the
 * button says "Following". A cache miss resolves to "unknown", which confirms.
 *
 * Render nothing when an item has no followable author (followTarget === null);
 * callers should guard, but we also no-op defensively on a null target.
 */
export function FollowButton({
  target,
  isFollowing,
}: {
  target: FollowTarget | null;
  isFollowing: boolean;
}) {
  const trpcUtils = trpc.useUtils();
  const [confirmingUnfollow, setConfirmingUnfollow] = useState(false);
  const [lastAction, setLastAction] = useState<FollowFeedbackAction>(null);

  const invalidate = () => {
    trpcUtils.copyTradeFollows.list.invalidate();
    trpcUtils.copyTrade.feed.invalidate();
    trpcUtils.leaderboard.xCallers.invalidate();
    trpcUtils.leaderboard.users.invalidate();
    trpcUtils.leaderboard.xCallerProfile.invalidate();
  };

  const followMutation = trpc.copyTradeFollows.follow.useMutation({
    onSuccess: (_data, variables) => {
      setLastAction("follow");
      invalidate();
      toast.success(`Followed ${variables.targetLabel}`);
    },
    onError: (error) => {
      setLastAction("follow");
      toast.error(error.message || "Could not follow");
    },
  });
  const unfollowMutation = trpc.copyTradeFollows.unfollow.useMutation({
    onSuccess: () => {
      setLastAction("unfollow");
      invalidate();
      // The same sentence Manage follows raises, so unfollowing from a feed row
      // does not quietly imply the mirror's positions went with it.
      toast.success(UNFOLLOW_TOAST);
    },
    onError: (error) => {
      setLastAction("unfollow");
      toast.error(error.message || "Could not unfollow");
    },
  });

  if (!target) return null;

  const pending = followMutation.isPending || unfollowMutation.isPending;
  const errorMessage =
    lastAction === "unfollow"
      ? (unfollowMutation.error?.message ?? null)
      : lastAction === "follow"
        ? (followMutation.error?.message ?? null)
        : null;
  const successMessage = selectFollowSuccessMessage(
    lastAction,
    target.label,
    followMutation.isSuccess,
    unfollowMutation.isSuccess,
  );

  return (
    <FollowButtonView
      target={target}
      isFollowing={isFollowing}
      armed={followArmedState(
        trpcUtils.copyTradeFollows.list.getData(),
        target,
      )}
      pending={pending}
      errorMessage={errorMessage}
      successMessage={successMessage}
      confirmingUnfollow={confirmingUnfollow}
      onConfirmingUnfollowChange={setConfirmingUnfollow}
      onFollow={() => {
        setLastAction("follow");
        followMutation.mutate({
          targetType: target.type,
          targetKey: target.key,
          targetLabel: target.label,
        });
      }}
      onUnfollow={() => {
        setLastAction("unfollow");
        unfollowMutation.mutate({
          targetType: target.type,
          targetKey: target.key,
        });
      }}
    />
  );
}
