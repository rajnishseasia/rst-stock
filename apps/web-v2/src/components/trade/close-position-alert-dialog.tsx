"use client";

/**
 * ClosePositionAlertDialog -- shared confirmation dialog for quick
 * full-position closes used by both the equity and perp positions panels.
 *
 * Callers pass a pre-formatted display name and an optional description to
 * accommodate the asset-specific copy ("reduce-only market order" for perps
 * vs. plain "market order" for equities). Confirm fires `onConfirm`; dismiss
 * or backdrop-click fires `onCancel` (only when not pending).
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ClosePositionAlertDialogProps {
  open: boolean;
  /** Ticker / coin name already formatted for display, e.g. "AAPL" or "ETH". */
  displayName: string;
  /**
   * Full description sentence. When omitted a generic equity-style sentence is
   * used. Pass a custom string for perps ("reduce-only" language, etc.).
   */
  description?: string;
  isPending: boolean;
  pendingDescription?: string;
  allowPendingDismiss?: boolean;
  pendingDismissLabel?: string;
  pendingActionLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ClosePositionAlertDialog({
  open,
  displayName,
  description,
  isPending,
  pendingDescription,
  allowPendingDismiss = false,
  pendingDismissLabel = "Hide",
  pendingActionLabel = "Closing...",
  onCancel,
  onConfirm,
}: ClosePositionAlertDialogProps) {
  const defaultDescription = `This submits a market order to close your full ${displayName} position. The final fill price may differ from the current price.`;
  const canDismiss = !isPending || allowPendingDismiss;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && canDismiss) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {displayName} position?</AlertDialogTitle>
          <AlertDialogDescription>
            {isPending && pendingDescription
              ? pendingDescription
              : description ?? defaultDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!canDismiss}>
            {isPending && allowPendingDismiss
              ? pendingDismissLabel
              : "Keep position"}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {isPending ? pendingActionLabel : "Close position"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
