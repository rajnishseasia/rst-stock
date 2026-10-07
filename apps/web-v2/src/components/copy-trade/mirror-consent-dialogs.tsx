"use client";

import { AlertTriangle, OctagonMinus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PerpMirrorDisclosure } from "./perp-mirror-disclosure";
import type { ArmingSummary, StopSummary } from "./mirror-consent";

/**
 * The one gate between "flipped a switch" and "a worker places orders with my
 * money".
 *
 * Both entry points (the manage-follows row and the panel's inline Mirror
 * switch) mount this, and neither calls the update mutation from its own change
 * handler: the switch raises a request, this dialog is what calls it. The
 * confirm control names the action rather than saying OK, because "OK" to a
 * dialog nobody read is exactly the failure the review found.
 *
 * Hook-free and fully controlled, so a test can call it directly and invoke the
 * handler it wired to the confirm control.
 */
export function ArmMirrorDialog({
  open,
  onOpenChange,
  summary,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ArmingSummary;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        // Matched to the base component's own data-size selectors so the
        // override actually merges: a plain `max-w-*` loses to the
        // attribute-selector default on specificity.
        className="data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-md"
      >
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangle className="text-amber-500" aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>{summary.title}</AlertDialogTitle>
          <AlertDialogDescription>{summary.standingOrder}</AlertDialogDescription>
        </AlertDialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-2xs">
          {summary.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="font-medium text-muted-foreground">{fact.label}</dt>
              <dd className="text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>

        <p className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-2xs text-foreground">
          {summary.stopCaveat}
        </p>

        {summary.showPerpDisclosure && (
          <PerpMirrorDisclosure protection={summary.perpProtection} />
        )}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" aria-label="Cancel, do not place orders automatically">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            disabled={pending}
            onClick={onConfirm}
            aria-label={summary.confirmLabel}
          >
            {summary.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The stop gate, for both switching auto-mirror off and unfollowing.
 *
 * It exists to correct a belief, not to slow the user down: the review found
 * people stopping the mirror expecting it to unwind what the mirror opened.
 * Every line comes from `buildStopSummary`, which documents the worker code
 * each claim is read from.
 */
export function StopMirrorDialog({
  open,
  onOpenChange,
  summary,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: StopSummary;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const [lead, ...rest] = summary.points;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        // Matched to the base component's own data-size selectors so the
        // override actually merges: a plain `max-w-*` loses to the
        // attribute-selector default on specificity.
        className="data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-md"
      >
        <AlertDialogHeader>
          <AlertDialogMedia>
            <OctagonMinus className="text-muted-foreground" aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>{summary.title}</AlertDialogTitle>
          <AlertDialogDescription>{lead}</AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="ml-4 list-disc space-y-1 text-2xs text-foreground">
          {rest.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" aria-label="Cancel, keep this follow as it is">
            Keep it running
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
            aria-label={summary.confirmLabel}
          >
            {summary.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
